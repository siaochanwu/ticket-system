import prisma from '../config/database.js';
import redis from '../config/redis.js';
import config from '../config/index.js';

export const LEADER_LOCK_KEY = 'worker:lock:order-expiry';

/**
 * 回收逾期未付款的訂單：標記 expired、釋放座位、清除 Redis 座位鎖。
 * 單筆失敗只記 log 不中斷整批，漏掉的訂單下一輪會再被掃到。
 * @returns 成功回收的訂單筆數
 */
export async function expireOverdueOrders(): Promise<number> {
    const overdue = await prisma.order.findMany({
        where: {
            status: 'pending',
            expiresAt: { lt: new Date() },
        },
        include: { items: true },
        orderBy: { expiresAt: 'asc' },
        take: config.worker.batchSize,
    });

    let expired = 0;

    for (const order of overdue) {
        const seatIds = order.items.map((item) => item.seatId);

        try {
            const didExpire = await prisma.$transaction(async (tx) => {
                // 再次確認狀態，避免與使用者的付款／取消動作互相覆寫
                const updated = await tx.order.updateMany({
                    where: { id: order.id, status: 'pending' },
                    data: { status: 'expired' },
                });

                if (updated.count === 0) {
                    return false;
                }

                await tx.seat.updateMany({
                    where: { id: { in: seatIds }, status: 'locked' },
                    data: {
                        status: 'available',
                        lockedBy: null,
                        lockedUntil: null,
                    },
                });

                return true;
            });

            if (!didExpire) {
                continue;
            }

            for (const seatId of seatIds) {
                await redis.del(`seat:lock:${seatId}`);
            }

            expired += 1;
        } catch (error) {
            console.error(
                `[orderExpiry] 訂單 ${order.orderNo} 回收失敗`,
                error
            );
        }
    }

    return expired;
}

/**
 * 回收「選了位但沒下單」的孤兒座位鎖。
 *
 * Task 2 為 lockSeats 加上 DB 狀態守衛後，這種座位不再能靠 Redis TTL 自癒：
 * Redis 鎖過期了，但 seats.status 永遠停在 locked，導致座位永久賣不掉。
 * 條件是「鎖定期限已過」且「沒有任何 pending 訂單依附」—— 有訂單的
 * 交給 expireOverdueOrders 處理，避免兩個函式互相搶同一批座位。
 *
 * 這裡刻意不刪 Redis 的 seat:lock：seat:lock 的 TTL 與 lockedUntil 在
 * 同一時刻寫入且長度相同，lockedUntil 已過就代表 Redis 鎖早已自然過期。
 * 若硬要刪，反而可能誤刪別的使用者剛取得的新鎖。
 *
 * @returns 實際釋放的座位數
 */
export async function reclaimAbandonedSeatLocks(): Promise<number> {
    const now = new Date();

    const abandoned = await prisma.seat.findMany({
        where: {
            status: 'locked',
            lockedUntil: { lt: now },
            orderItems: {
                none: {
                    order: { status: 'pending' },
                },
            },
        },
        select: { id: true },
        take: config.worker.batchSize,
    });

    if (abandoned.length === 0) {
        return 0;
    }

    // 更新時重帶條件，避免與剛好在此刻重新鎖定的請求互相覆寫
    const released = await prisma.seat.updateMany({
        where: {
            id: { in: abandoned.map((seat) => seat.id) },
            status: 'locked',
            lockedUntil: { lt: now },
        },
        data: {
            status: 'available',
            lockedBy: null,
            lockedUntil: null,
        },
    });

    return released.count;
}

/**
 * 以 Redis SET NX 取得 leader lock 後執行 fn，讓多個 worker 實例只有一個在掃。
 * @returns fn 的回傳值；取不到鎖時回 null
 */
export async function withLeaderLock<T>(
    instanceId: string,
    fn: () => Promise<T>
): Promise<T | null> {
    const acquired = await redis.set(
        LEADER_LOCK_KEY,
        instanceId,
        'EX',
        config.worker.leaderLockTtlSeconds,
        'NX'
    );

    if (!acquired) {
        return null;
    }

    try {
        return await fn();
    } finally {
        // 只釋放自己持有的鎖（避免刪掉已過期後由他人取得的鎖）
        const current = await redis.get(LEADER_LOCK_KEY);
        if (current === instanceId) {
            await redis.del(LEADER_LOCK_KEY);
        }
    }
}
