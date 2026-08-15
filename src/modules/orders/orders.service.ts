import prisma from '../../config/database.js';
import redis from '../../config/redis.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import config from '../../config/index.js';
import { CreateOrderInput, OrderResponse, OrdersResponse } from './orders.type.js';
import { releaseSeatLockIfOwnedBy } from '../../workers/orderExpiry.service.js';

export async function createOrder(input: CreateOrderInput): Promise<OrderResponse> {
    const { userId, lockId } = input;

    // 1. 從 Redis 取得先前的選位鎖定資訊 (Double Check)
    const userLockKey = `user:locks:${userId}`;
    const lockData = await redis.hget(userLockKey, lockId);

    if (!lockData) {
        throw new AppError('選位鎖定已過期或不存在', 400, 'LOCK_EXPIRED');
    }

    const { sessionId, seatIds, expiresAt } = JSON.parse(lockData);

    // 1.5 單次性原子宣告：把消費這筆 lockId 的動作搬到這裡，並比對 HDEL
    // 實際刪除的欄位數。HDEL 是原子操作，這裡與 unlockSeats 對同一個
    // lockId 競爭同一把 hash 欄位——只有先搶到的一方能拿到 1，另一方拿到
    // 0 就必須在這裡失敗，不能繼續用剛剛讀到的 lockData 建立訂單。這是
    // N2 的根源：DELETE /api/tickets/lock/:lockId 與 POST /api/orders
    // 若各自只用 hget 判斷，兩者可能都讀到刪除前的同一筆記錄，各自以為
    // 自己合法持有這批座位，其中一個就會在一個座位其實仍是 pending
    // 訂單持有時把它放回 available。
    const claimed = await redis.hdel(userLockKey, lockId);
    if (claimed === 0) {
        throw new AppError('選位鎖定已過期或不存在', 400, 'LOCK_EXPIRED');
    }

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
        //
        // 帶上與上面查詢相同的 status／lockedBy 條件並比對筆數：如果在
        // 「查詢座位」與「這次更新」之間，座位已經被 worker 的
        // reclaimAbandonedSeatLocks 搶先放掉（時間窗極窄，但仍是同一種
        // TOCTOU），這裡會偵測到筆數不符並讓交易整批回滾，而不是在一顆
        // 已經 available 的座位上寫入沒有意義的 lockedUntil。
        const relocked = await tx.seat.updateMany({
            where: { id: { in: seatIds }, status: 'locked', lockedBy: userId },
            data: { lockedUntil: orderExpiresAt },
        });

        if (relocked.count !== seatIds.length) {
            throw new AppError('座位狀態變更，請重新選擇', 400, 'SEAT_UNAVAILABLE')
        }

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
    //    改成無條件覆寫，同時把內容換成訂單身分
    //    （原本的選位 lockId 在步驟 1.5 已經 hdel 消費掉了）
    const lockTtlSeconds = Math.ceil(paymentTimeoutMs / 1000);
    for (const seatId of seatIds) {
        await redis.set(
            `seat:lock:${seatId}`,
            JSON.stringify({ orderId: result.id, userId, sessionId }),
            'EX',
            lockTtlSeconds
        );
    }

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
    // 這裡的讀取只是為了取得 items（釋放座位要用的 seatId）與確認訂單
    // 存在／屬於這個 user，讀到的 status 不能當成唯一防線——如果取消請求
    // 在讀取之後、交易 commit 之前，剛好有一筆付款 commit 成功，這個讀取結果
    // 就已經是過期的了。真正擋雙賣的守衛在下面交易內的 updateMany where 條件
    // （見 task-4.5：可兌現雙賣 Critical）。
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

    const seatIds = order.items.map(item => item.seatId);

    // 取消訂單與釋放座位
    const result = await prisma.$transaction(async (tx) => {
        // 1. 更新訂單狀態：where 重新斷言 status: 'pending' 並比對 count，
        //    與 expireOverdueOrders／付款成功路徑同一個模式。count 不是 1
        //    代表訂單在交易外的讀取之後已經被別的流程（最主要是付款）
        //    改動過，必須整批放棄，否則會把 paid 覆寫成 cancelled，
        //    座位翻回 available，但已簽發的 ticketCode/qrCode 仍然有效
        //    ——可兌現的雙重銷售。
        const cancelled = await tx.order.updateMany({
            where: {
                id: orderId,
                userId,
                status: 'pending',
            },
            data: {
                status: 'cancelled',
            },
        })

        if (cancelled.count !== 1) {
            throw new AppError('只能取消待付款的訂單', 400, 'ORDER_CANNOT_CANCEL')
        }

        // 2. 解鎖座位：只釋放仍是 locked 且 lockedBy 為本人的座位，避免動到
        //    已經被付款流程改成 sold 的座位（與 orderExpiry 的
        //    expireOverdueOrders 同一個守衛模式）
        await tx.seat.updateMany({
            where: {
                id: { in: seatIds },
                status: 'locked',
                lockedBy: userId,
            },
            data: {
                status: 'available',
                lockedBy: null,
                lockedUntil: null,
            }
        })

        return tx.order.findUniqueOrThrow({
            where: { id: orderId },
            include: {
                items: {
                    include: {
                        seat: true,
                        ticketType: true,
                    }
                }
            }
        })
    })

    // 訂單已取消，釋放 Redis 座位鎖：比對持有者後才刪，與 worker
    // （releaseSeatLockIfOwnedBy）／付款成功路徑一致，避免刪掉 commit 之後
    // 才由別人合法取得的新鎖
    for (const seatId of seatIds) {
        await releaseSeatLockIfOwnedBy(seatId, userId);
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
