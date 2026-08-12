import prisma from '../../config/database.js';
import redis from '../../config/redis.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import config from '../../config/index.js';
import { CreateOrderInput, OrderResponse, OrdersResponse } from './orders.type.js';

export async function createOrder(input: CreateOrderInput): Promise<OrderResponse> {
    const { userId, lockId } = input;

    // 1. 從 Redis 取得先前的選位鎖定資訊 (Double Check)
    const userLockKey = `user:locks:${userId}`;
    const lockData = await redis.hget(userLockKey, lockId);

    if (!lockData) {
        throw new AppError('選位鎖定已過期或不存在', 400, 'LOCK_EXPIRED');
    }

    const { sessionId, seatIds, expiresAt } = JSON.parse(lockData);

    const paymentTimeoutMs = config.order.paymentTimeoutMinutes * 60 * 1000;

    // 2. 資料庫交易：建立訂單 + 更新座位狀態
    const result = await prisma.$transaction(async (tx) => {
        // 驗證座位是否真的被該用戶鎖定，且選位鎖定尚未過期。
        // lockedUntil 若已過，即使 DB 狀態還沒被 worker 的
        // reclaimAbandonedSeatLocks 回收也不能再讓訂單成立，
        // 否則會跟 worker 之間出現 TOCTOU 競態（見 Task 3 review Critical 1）：
        // worker 讀到「已過期、無訂單依附」的座位之後、這裡才 commit 建立訂單，
        // 兩者都以為自己是對的，結果座位被 worker 放掉但訂單仍是 pending。
        const seats = await tx.seat.findMany({
            where: {
                id: { in: seatIds },
                lockedBy: userId,
                status: 'locked',
                lockedUntil: { gt: new Date() },
            },
            include: {
                ticketType: true,
            }
        })

        if (seats.length !== seatIds.length) {
            throw new AppError('座位狀態變更，請重新選擇', 400, 'SEAT_UNAVAILABLE')
        }

        const totalAmount = seats.reduce((sum, seat) => sum + Number(seat.ticketType.price), 0);
        const orderNo = `TKT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const orderExpiresAt = new Date(Date.now() + paymentTimeoutMs); // 付款時限

        const order = await tx.order.create({
            data: {
                orderNo,
                userId,
                sessionId,
                status: 'pending',
                totalAmount,
                expiresAt: orderExpiresAt,
            }
        })

        const orderItems = await Promise.all(seats.map(seat => {
            return tx.orderItem.create({
                data: {
                    orderId: order.id,
                    seatId: seat.id,
                    ticketTypeId: seat.ticketTypeId,
                    price: seat.ticketType.price,
                },
                include: {
                    seat: true,
                    ticketType: true,
                }
            })
        }))

        // 把座位的 lockedUntil 同步延長到訂單的付款期限，讓 DB 欄位
        // 與 Redis TTL／訂單 expiresAt 三者保持一致（同一個交易內完成，
        // 不會有介於「建立訂單」與「更新 lockedUntil」之間的空窗）。
        // 這是 reclaimAbandonedSeatLocks 能安全判斷「鎖定期限是否已過」的前提，
        // 否則 lockedUntil 會停在選位當下的舊值，跟訂單實際的保護期完全脫節。
        await tx.seat.updateMany({
            where: { id: { in: seatIds } },
            data: { lockedUntil: orderExpiresAt },
        });

        return {
            id: order.id,
            orderNo: order.orderNo,
            status: order.status,
            totalAmount: order.totalAmount.toString(),
            expiresAt: order.expiresAt,
            items: orderItems.map(item => ({
                id: item.id,
                seat: {
                    rowName: item.seat.rowName,
                    seatNumber: item.seat.seatNumber,
                },
                ticketType: {
                    name: item.ticketType.name,
                },
                price: item.price.toString()
            }))
        }
    })

    // 3. 保留 seat:lock 並把 TTL 延長到付款期限
    //    訂單 pending 期間 Redis 與 DB 兩層防護必須一致，
    //    只有付款成功、使用者取消、worker 判定逾期時才刪除
    //    用 set 而非 expire：expire 對已經過期消失的 key 是 no-op，
    //    若原本的選位鎖剛好在這個時間點過期，不變式就會悄悄失效；
    //    改成無條件覆寫，同時把內容換成訂單身分（原本的選位 lockId 已經 hdel 失效）
    const lockTtlSeconds = Math.ceil(paymentTimeoutMs / 1000);
    for (const seatId of seatIds) {
        await redis.set(
            `seat:lock:${seatId}`,
            JSON.stringify({ orderId: result.id, userId, sessionId }),
            'EX',
            lockTtlSeconds
        );
    }
    await redis.hdel(userLockKey, lockId);

    return result;
}

export async function getOrders(userId: string): Promise<OrdersResponse> {
    if (!userId) {
        throw Errors.UNAUTHORIZED;
    }

    const orders = await prisma.order.findMany({
        where: {
            userId,
        },
        include: {
            session: {
                include: {
                    event: true, // 關聯至場次與活動
                }
            },
            items: {
                include: {
                    seat: true, // 關聯至座位 (取得排/號)
                    ticketType: true, // 關聯至座位 (取得排/號)
                }
            },
        },
        orderBy: {
            createdAt: 'desc',
        }
    })

    const now = new Date();

    return orders.map(order => {
        // 若已超時且依然是 pending，前端顯示過期
        const isExpired = order.status === 'pending' && order.expiresAt < now;
        const finalStatus = isExpired ? 'expired' : order.status;

        return {
            id: order.id,
            orderNo: order.orderNo,
            status: finalStatus,
            totalAmount: order.totalAmount.toString(),
            expiresAt: order.expiresAt,
            items: order.items.map(item => ({
                id: item.id,
                seat: {
                    rowName: item.seat.rowName,
                    seatNumber: item.seat.seatNumber,
                },
                ticketType: {
                    name: item.ticketType.name,
                },
                price: item.price.toString()
            }))
        }
    })
}

export async function getOrderById(userId: string, orderId: string): Promise<OrderResponse> {
    const order = await prisma.order.findUnique({
        where: {
            id: orderId,
            userId,
        },
        include: {
            session: {
                include: {
                    event: true,
                }
            },
            items: {
                include: {
                    seat: true,
                    ticketType: true,
                }
            }
        }
    })

    if (!order) {
        throw Errors.ORDER_NOT_FOUND;
    }

    const now = new Date();
    const isExpired = order.status === 'pending' && order.expiresAt < now;
    const finalStatus = isExpired ? 'expired' : order.status;

    return {
        id: order.id,
        orderNo: order.orderNo,
        status: finalStatus,
        totalAmount: order.totalAmount.toString(),
        expiresAt: order.expiresAt,
        items: order.items.map(item => ({
            id: item.id,
            seat: {
                rowName: item.seat.rowName,
                seatNumber: item.seat.seatNumber,
            },
            ticketType: {
                name: item.ticketType.name,
            },
            price: item.price.toString()
        }))
    }
}

export async function cancelOrder(userId: string, orderId: string): Promise<OrderResponse> {
    // 只有pending 狀態可以取消
    // 改狀態 -> cancelled
    // 解鎖座位
    const order = await prisma.order.findFirst({
        where: {
            id: orderId,
            userId,
        },
        include: {
            items: true // 把關聯的 items 撈出來，這樣才知道要釋放哪些座位
        }
    })

    if (!order) {
        throw Errors.ORDER_NOT_FOUND;
    }

    if (order.status !== 'pending') {
        throw new AppError('只能取消待付款的訂單', 400, 'ORDER_CANNOT_CANCEL')
    }

    // 取消訂單與釋放座位
    const result = await prisma.$transaction(async (tx) => {
        // 1. 更新訂單狀態
        const updatedOrder = await tx.order.update({
            where: {
                id: orderId,
            },
            data: {
                status: 'cancelled',
            },
            include: {
                session: {
                    include: {
                        event: true
                    }
                },
                items: {
                    include: {
                        seat: true,
                        ticketType: true,
                    }
                }
            }
        })
        // 2. 取出所有這個訂單佔用的座位 ID
        const seatIds = order.items.map(item => item.seatId);

        // 3. 解鎖座位
        await tx.seat.updateMany({
            where: {
                id: {
                    in: seatIds
                }
            },
            data: {
                status: 'available',
                lockedBy: null,
                lockedUntil: null,
            }
        })

        return updatedOrder;
    })

    // 訂單已取消，釋放 Redis 座位鎖
    for (const item of order.items) {
        await redis.del(`seat:lock:${item.seatId}`);
    }

    return {
        id: result.id,
        orderNo: result.orderNo,
        status: result.status,
        totalAmount: result.totalAmount.toString(),
        expiresAt: result.expiresAt,
        items: result.items.map(item => ({
            id: item.id,
            seat: {
                rowName: item.seat.rowName,
                seatNumber: item.seat.seatNumber,
            },
            ticketType: {
                name: item.ticketType.name,
            },
            price: item.price.toString()
        }))
    }
}
