import prisma from '../config/database.js';
import redis from '../config/redis.js';
import config from '../config/index.js';

export const LEADER_LOCK_KEY = 'worker:lock:order-expiry';

/**
 * 比對 Redis 座位鎖目前的持有者是否仍是這張訂單的使用者，是才刪除。
 * 與 tickets.service.ts 的 unlockSeats／lockSeats 回滾用的是同一個原則：
 * 只比對後才刪，避免刪掉這段空窗期間別人合法取得的新鎖
 * （DB 交易 commit 之後、這裡執行之前，若原 key 剛好自然過期，
 *  別人是可以完整跑完一次 lockSeats 拿到新鎖的）。
 */
async function releaseSeatLockIfOwnedBy(
    seatId: number,
    ownerUserId: string
): Promise<void> {
    const key = `seat:lock:${seatId}`;
    const raw = await redis.get(key);

    if (!raw) {
        return;
    }

    try {
        const lock = JSON.parse(raw);
        if (lock.userId === ownerUserId) {
            await redis.del(key);
        }
    } catch (error) {
        // 鎖的內容不是預期的 JSON 格式，保守起見不刪除
        console.error(`[orderExpiry] 無法解析座位 ${seatId} 的 Redis 鎖內容`, error);
    }
}

/**
 * 回收逾期未付款的訂單：標記 expired、釋放座位、清除 Redis 座位鎖。
 * 單筆失敗只記 log 不中斷整批，漏掉的訂單下一輪會再被掃到。
 * @param batchSize 單次最多處理的筆數，預設讀 config；測試可傳入較小的值。
 * @returns 成功回收的訂單筆數
 */
export async function expireOverdueOrders(
    batchSize: number = config.worker.batchSize
): Promise<number> {
    const overdue = await prisma.order.findMany({
        where: {
            status: 'pending',
            expiresAt: { lt: new Date() },
        },
        include: { items: true },
        orderBy: { expiresAt: 'asc' },
        take: batchSize,
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

                // 只釋放仍屬於這張訂單使用者的座位：pending 期間 lockedBy
                // 必然等於 order.userId，多帶這個條件是零成本但嚴格更強的守衛，
                // 避免在座位已被別人（合法）搶走的異常情況下誤放對方的鎖。
                await tx.seat.updateMany({
                    where: {
                        id: { in: seatIds },
                        status: 'locked',
                        lockedBy: order.userId,
                    },
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
                await releaseSeatLockIfOwnedBy(seatId, order.userId);
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

// 座位仍被視為「有效佔用」而不能被孤兒鎖回收器放掉的訂單狀態。
// pending 交給 expireOverdueOrders 處理；paid 則是防禦性排除——
// 目前 repo 還沒有付款模組，一旦加入後若 order→paid 與 seat→sold
// 沒有包在同一個交易內，中間態就會是 order.status='paid' 但
// seat.status 仍是 'locked'，此時 lockedUntil 也早已過期（見下方
// reclaimAbandonedSeatLocks 的說明），不能被這個 worker 誤放。
const SEAT_PROTECTED_ORDER_STATUSES = ['pending', 'paid'];

function buildAbandonedSeatFilter(now: Date) {
    return {
        status: 'locked',
        lockedUntil: { lt: now },
        orderItems: {
            none: {
                order: { status: { in: SEAT_PROTECTED_ORDER_STATUSES } },
            },
        },
    };
}

/**
 * 回收「選了位但沒下單」的孤兒座位鎖。
 *
 * Task 2 為 lockSeats 加上 DB 狀態守衛後，這種座位不再能靠 Redis TTL 自癒：
 * Redis 鎖過期了，但 seats.status 永遠停在 locked，導致座位永久賣不掉。
 *
 * 判斷條件是「鎖定期限已過」且「沒有任何 pending／paid 訂單依附」——有效訂單
 * 交給 expireOverdueOrders（或未來的付款流程）處理，避免兩邊搶同一批座位。
 * 這個 filter 同時用在查詢（findMany）與寫入（updateMany），刻意共用同一個
 * 物件：曾經發生過 updateMany 少帶了關聯條件，讓 findMany 執行完、
 * 訂單剛好在這個當下被建立（createOrder commit）的座位，在 updateMany
 * 那一步仍會被放掉——即使那張訂單其實還活著。共用同一個 filter 讓兩處
 * 不可能再次各自漂移。
 *
 * 注意：「lockedUntil 已過」不代表「Redis 鎖已經消失」。createOrder 下單時
 * 會把 Redis TTL 延長到付款期限，但不會同步更新 seats.lockedUntil，
 * 所以「lockedUntil 已過、但 Redis 鎖仍活著、訂單仍是 pending」在付款期間
 * 中段是常態而非邊角案例。真正保護這些座位不被誤放的，是上面的
 * pending／paid 訂單 filter，不是 lockedUntil 與 Redis TTL 之間的任何推論。
 *
 * 這裡刻意不刪 Redis 的 seat:lock：符合條件的座位可能根本沒有存活的
 * Redis 鎖（早已自然過期），盲目刪除反而可能誤刪別的使用者剛合法取得的新鎖。
 *
 * @param batchSize 單次最多處理的筆數，預設讀 config。
 * @returns 實際釋放的座位數
 */
export async function reclaimAbandonedSeatLocks(
    batchSize: number = config.worker.batchSize
): Promise<number> {
    const now = new Date();
    const filter = buildAbandonedSeatFilter(now);

    const abandoned = await prisma.seat.findMany({
        where: filter,
        select: { id: true },
        take: batchSize,
    });

    if (abandoned.length === 0) {
        return 0;
    }

    // 寫入時重帶與查詢時完全相同的 filter（含關聯條件），把「判斷」與
    // 「寫入」變成同一個條件式，杜絕 findMany 之後、updateMany 之前
    // 才出現的 pending／paid 訂單被無視的 TOCTOU 窗口。
    const released = await prisma.seat.updateMany({
        where: {
            id: { in: abandoned.map((seat) => seat.id) },
            ...filter,
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
