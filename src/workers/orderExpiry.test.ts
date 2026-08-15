import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    beforeEach,
    vi,
} from 'vitest';
import prisma from '../config/database.js';
import redis, { closeRedis } from '../config/redis.js';
import config from '../config/index.js';
import {
    expireOverdueOrders,
    reclaimAbandonedSeatLocks,
    withLeaderLock,
    LEADER_LOCK_KEY,
} from './orderExpiry.service.js';

describe('orderExpiry worker', () => {
    let userId: string;
    let sessionId: number;
    let ticketTypeId: number;

    beforeAll(async () => {
        const user = await prisma.user.create({
            data: {
                email: 'workeruser@example.com',
                passwordHash: 'not-used',
            },
        });
        userId = user.id;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.user.deleteMany({
            where: { email: 'workeruser@example.com' },
        });
        await prisma.$disconnect();
        await closeRedis();
    });

    async function cleanup() {
        await prisma.orderItem.deleteMany({});
        await prisma.order.deleteMany({});
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
    }

    beforeEach(async () => {
        const keys = await redis.keys('*');
        if (keys.length > 0) await redis.del(...keys);

        await cleanup();

        const event = await prisma.event.create({
            data: {
                title: 'Worker Test Event',
                saleStartAt: new Date('2026-01-01T00:00:00Z'),
                status: 'published',
            },
        });

        const session = await prisma.session.create({
            data: {
                eventId: event.id,
                sessionDate: new Date('2026-12-01'),
                sessionTime: '20:00',
            },
        });
        sessionId = session.id;

        const ticketType = await prisma.ticketType.create({
            data: {
                sessionId,
                name: 'Standard',
                price: 1000,
                totalQuantity: 100,
            },
        });
        ticketTypeId = ticketType.id;
    });

    // 建立一筆訂單與其座位，expiresAt 由參數決定
    async function createOrder(
        expiresAt: Date,
        status = 'pending',
        seatStatus = 'locked'
    ) {
        const seat = await prisma.seat.create({
            data: {
                ticketTypeId,
                rowName: 'A',
                seatNumber: `${Math.floor(Math.random() * 100000)}`,
                status: seatStatus,
                lockedBy: userId,
                lockedUntil: expiresAt,
            },
        });

        const order = await prisma.order.create({
            data: {
                orderNo: `TKT-TEST-${Math.floor(Math.random() * 1000000)}`,
                userId,
                sessionId,
                status,
                totalAmount: 1000,
                expiresAt,
                items: {
                    create: {
                        seatId: seat.id,
                        ticketTypeId,
                        price: 1000,
                    },
                },
            },
        });

        await redis.set(
            `seat:lock:${seat.id}`,
            JSON.stringify({ userId, sessionId }),
            'EX',
            600
        );

        return { order, seat };
    }

    it('逾期的 pending 訂單應該被標記 expired 並釋放座位', async () => {
        const { order, seat } = await createOrder(new Date(Date.now() - 1000));

        const count = await expireOverdueOrders();

        expect(count).toBe(1);

        const dbOrder = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(dbOrder?.status).toBe('expired');

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('available');
        expect(dbSeat?.lockedBy).toBeNull();
        expect(dbSeat?.lockedUntil).toBeNull();
    });

    it('應該清除逾期訂單的 Redis 座位鎖', async () => {
        const { seat } = await createOrder(new Date(Date.now() - 1000));

        await expireOverdueOrders();

        const exists = await redis.exists(`seat:lock:${seat.id}`);
        expect(exists).toBe(0);
    });

    it('座位若已被別人合法搶走（lockedBy 不同），不應該釋放它（Important 3 回歸）', async () => {
        const otherUserId = 'other-user-id';
        const { order, seat } = await createOrder(new Date(Date.now() - 1000));

        // 模擬在 worker 掃到與實際 release 之間，座位已經被別人合法鎖走
        await prisma.seat.update({
            where: { id: seat.id },
            data: { lockedBy: otherUserId },
        });

        const count = await expireOverdueOrders();

        // 訂單本身的狀態轉換與座位是否成功釋放是獨立判斷，訂單仍應標記過期
        expect(count).toBe(1);

        const dbOrder = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(dbOrder?.status).toBe('expired');

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
        expect(dbSeat?.lockedBy).toBe(otherUserId);
    });

    it('座位的 Redis 鎖若已經是別人重新取得的，不應該被刪除（Important 4 回歸）', async () => {
        const { seat } = await createOrder(new Date(Date.now() - 1000));

        // 模擬 DB 交易 commit 之後、redis.del 之前，Redis 鎖已被別的使用者合法取得
        await redis.set(
            `seat:lock:${seat.id}`,
            JSON.stringify({ userId: 'other-user-id', sessionId }),
            'EX',
            600
        );

        await expireOverdueOrders();

        const exists = await redis.exists(`seat:lock:${seat.id}`);
        expect(exists).toBe(1);
    });

    it('未逾期的 pending 訂單不應受影響', async () => {
        const { order, seat } = await createOrder(
            new Date(Date.now() + 10 * 60 * 1000)
        );

        const count = await expireOverdueOrders();

        expect(count).toBe(0);

        const dbOrder = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(dbOrder?.status).toBe('pending');

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
    });

    it('已付款的訂單即使超過 expiresAt 也不應受影響', async () => {
        const { order, seat } = await createOrder(
            new Date(Date.now() - 1000),
            'paid',
            'sold'
        );

        const count = await expireOverdueOrders();

        expect(count).toBe(0);

        const dbOrder = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(dbOrder?.status).toBe('paid');

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('sold');
    });

    it('應該只計算真正回收成功的筆數，而不是撈到的逾期訂單數', async () => {
        const { order } = await createOrder(new Date(Date.now() - 1000));

        // 外層 findMany 撈到這筆訂單（此時仍是 pending）之後、
        // 交易真正開始之前，模擬使用者剛好完成付款（狀態搶先變成 paid）——
        // 交易內的二次確認應該讓這筆變成 no-op，不能被計入成功筆數
        const originalTransaction = prisma.$transaction.bind(prisma);
        const spy = vi
            .spyOn(prisma, '$transaction')
            .mockImplementationOnce(async (...args: unknown[]) => {
                await prisma.order.update({
                    where: { id: order.id },
                    data: { status: 'paid' },
                });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (originalTransaction as any)(...args);
            });

        const count = await expireOverdueOrders();

        spy.mockRestore();

        expect(count).toBe(0);

        const dbOrder = await prisma.order.findUnique({
            where: { id: order.id },
        });
        expect(dbOrder?.status).toBe('paid');
    });

    it('批次中有一筆處理失敗，不應該中斷其餘訂單的回收', async () => {
        // 刻意讓「插入順序」與「expiresAt 順序」相反：先插入的 later 比較新，
        // 後插入的 early 比較舊。若拿掉 orderBy: { expiresAt: 'asc' }，
        // Postgres 對小表通常照插入順序（heap scan）回傳，此時第一筆會是
        // later 而不是 early，下面對 early／later 最終狀態的斷言就會失敗——
        // 藉此讓「orderBy 真的有依 expiresAt 排序」這件事被測出來，
        // 而不是像插入序＝到期序時，拿掉 orderBy 也可能剛好照樣通過。
        const later = await createOrder(new Date(Date.now() - 1000));
        const early = await createOrder(new Date(Date.now() - 5000));

        const originalTransaction = prisma.$transaction.bind(prisma);
        let callCount = 0;
        const spy = vi
            .spyOn(prisma, '$transaction')
            .mockImplementation((...args: unknown[]) => {
                callCount += 1;
                if (callCount === 1) {
                    return Promise.reject(new Error('模擬資料庫暫時性錯誤'));
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (originalTransaction as any)(...args);
            });

        const count = await expireOverdueOrders();

        spy.mockRestore();

        // 只有沒被模擬故障影響的那一筆算成功
        expect(count).toBe(1);

        const dbEarly = await prisma.order.findUnique({
            where: { id: early.order.id },
        });
        const dbLater = await prisma.order.findUnique({
            where: { id: later.order.id },
        });

        expect(dbEarly?.status).toBe('pending');
        expect(dbLater?.status).toBe('expired');
    });

    it('一次最多只處理指定的 batchSize 筆，且依 expiresAt 由舊到新處理', async () => {
        // 用較小的 batchSize（而非 config 預設的 100）大幅降低本測試的
        // fixture 成本，避免在 CI 上跟 testTimeout 賽跑
        const batchSize = 3;
        const total = batchSize + 2;
        const created: Awaited<ReturnType<typeof createOrder>>[] = [];

        for (let i = 0; i < total; i += 1) {
            // 插入順序刻意與 expiresAt 順序相反：先插入的 i 越小、expiresAt
            // 越晚（越新、越不逾期）；後插入的 i 越大、expiresAt 越早
            // （越舊、越該優先被回收）。如果拿掉 orderBy: { expiresAt: 'asc' }，
            // 沒有其他排序線索時 Postgres 對小表通常照插入順序（heap scan）
            // 回傳，此時「前 batchSize 筆」會是插入順序最前面、也就是最新
            // 的幾筆，跟下面斷言預期的「最舊優先」矛盾，藉此讓拿掉 orderBy
            // 這件事真的會被測出來（插入序＝到期序時，拿掉 orderBy 也可能
            // 剛好照樣通過，就沒有鑑別力）。
            created.push(
                await createOrder(new Date(Date.now() - (i + 1) * 1000))
            );
        }

        const first = await expireOverdueOrders(batchSize);
        expect(first).toBe(batchSize);

        const statuses = await Promise.all(
            created.map(({ order }) =>
                prisma.order.findUnique({ where: { id: order.id } })
            )
        );

        // 插入順序的「最後 batchSize 筆」才是真正最舊（expiresAt 最早）的，
        // orderBy: asc 應該優先處理它們；「最前面」的幾筆則是最新、還沒輪到
        const oldest = statuses.slice(total - batchSize);
        const newest = statuses.slice(0, total - batchSize);

        expect(oldest.every((o) => o?.status === 'expired')).toBe(true);
        expect(newest.every((o) => o?.status === 'pending')).toBe(true);

        const second = await expireOverdueOrders(batchSize);
        expect(second).toBe(2);
    });

    // 建立「選了位但沒下單」的孤兒座位鎖（沒有任何 order 依附）
    async function createAbandonedSeat(lockedUntil: Date) {
        return prisma.seat.create({
            data: {
                ticketTypeId,
                rowName: 'Z',
                seatNumber: `${Math.floor(Math.random() * 100000)}`,
                status: 'locked',
                lockedBy: userId,
                lockedUntil,
            },
        });
    }

    it('選位未下單且鎖定期限已過的座位應該被釋放', async () => {
        const seat = await createAbandonedSeat(new Date(Date.now() - 1000));

        const count = await reclaimAbandonedSeatLocks();

        expect(count).toBe(1);

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('available');
        expect(dbSeat?.lockedBy).toBeNull();
        expect(dbSeat?.lockedUntil).toBeNull();
    });

    it('鎖定期限未到的座位不應該被釋放', async () => {
        const seat = await createAbandonedSeat(
            new Date(Date.now() + 10 * 60 * 1000)
        );

        const count = await reclaimAbandonedSeatLocks();

        expect(count).toBe(0);

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
        expect(dbSeat?.lockedBy).toBe(userId);
    });

    it('仍有 pending 訂單佔用的座位不應該被釋放，即使 lockedUntil 已過', async () => {
        // createOrder 建立的座位有 pending 訂單依附，應交由 expireOverdueOrders 處理
        const { seat } = await createOrder(new Date(Date.now() - 1000));

        const count = await reclaimAbandonedSeatLocks();

        expect(count).toBe(0);

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
    });

    it('已付款但座位仍卡在 locked 的座位不應該被釋放（Important 2 回歸）', async () => {
        // 目前 repo 還沒有付款模組，這裡模擬未來付款流程若非單一交易，
        // order 已經 paid 但 seat 還沒被同步為 sold 的中間態
        const { seat } = await createOrder(
            new Date(Date.now() - 1000),
            'paid',
            'locked'
        );

        const count = await reclaimAbandonedSeatLocks();

        expect(count).toBe(0);

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
    });

    it('findMany 之後、updateMany 之前才建立的 pending 訂單不應該被放掉（Critical 1 回歸）', async () => {
        const seat = await createAbandonedSeat(new Date(Date.now() - 1000));

        // Prisma model delegate（prisma.seat）的方法是透過 Proxy 動態產生的，
        // 它的 property descriptor 回報 value: undefined，導致 vi.spyOn()
        // 誤判成「不是函式」而拋錯；直接覆寫屬性則不受影響（已用獨立腳本驗證），
        // 故這裡改用手動替換＋finally 還原，而非 vi.spyOn／mockRestore。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const seatDelegate = prisma.seat as any;
        const originalFindMany = seatDelegate.findMany.bind(prisma.seat);

        seatDelegate.findMany = async (args: unknown) => {
            const result = await originalFindMany(args);

            // 模擬 race：findMany 執行完之後、updateMany 執行之前，
            // 使用者剛好對這顆座位送出訂單
            await prisma.order.create({
                data: {
                    orderNo: `TKT-RACE-${Math.floor(Math.random() * 1000000)}`,
                    userId,
                    sessionId,
                    status: 'pending',
                    totalAmount: 1000,
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                    items: {
                        create: {
                            seatId: seat.id,
                            ticketTypeId,
                            price: 1000,
                        },
                    },
                },
            });

            return result;
        };

        let count: number;
        try {
            count = await reclaimAbandonedSeatLocks();
        } finally {
            seatDelegate.findMany = originalFindMany;
        }

        expect(count).toBe(0);

        const dbSeat = await prisma.seat.findUnique({ where: { id: seat.id } });
        expect(dbSeat?.status).toBe('locked');
    });

    it('leader lock 被佔用時第二個呼叫者應該取不到鎖', async () => {
        const results: (string | null)[] = [];

        const firstDone = withLeaderLock('instance-1', async () => {
            // 持有鎖的期間讓第二個實例嘗試搶鎖
            const second = await withLeaderLock('instance-2', async () => 'ran');
            results.push(second);
            return 'first';
        });

        const firstResult = await firstDone;

        expect(firstResult).toBe('first');
        expect(results).toEqual([null]);

        // 離開後鎖必須被釋放
        const exists = await redis.exists(LEADER_LOCK_KEY);
        expect(exists).toBe(0);
    });

    it('鎖若在持有期間被別人重新取得，釋放時不應該刪掉別人的鎖', async () => {
        const result = await withLeaderLock('instance-1', async () => {
            // 模擬鎖在 fn 執行期間已經自然過期，並被另一個實例合法取得
            await redis.set(
                LEADER_LOCK_KEY,
                'instance-2',
                'EX',
                config.worker.leaderLockTtlSeconds
            );
            return 'first-done';
        });

        expect(result).toBe('first-done');

        // instance-1 的 finally 應該發現目前持有者不是自己，不能刪除
        const current = await redis.get(LEADER_LOCK_KEY);
        expect(current).toBe('instance-2');
    });

    it('取得 leader lock 時應該帶有 TTL，避免 worker crash 後鎖永久卡死', async () => {
        const result = await withLeaderLock('instance-1', async () => {
            const ttl = await redis.ttl(LEADER_LOCK_KEY);
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(config.worker.leaderLockTtlSeconds);
            return 'done';
        });

        expect(result).toBe('done');
    });
});
