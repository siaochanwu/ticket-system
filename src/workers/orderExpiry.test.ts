import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

    it('一次最多只處理 batchSize 筆', async () => {
        const total = config.worker.batchSize + 2;
        for (let i = 0; i < total; i += 1) {
            await createOrder(new Date(Date.now() - 1000));
        }

        const first = await expireOverdueOrders();
        expect(first).toBe(config.worker.batchSize);

        const second = await expireOverdueOrders();
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
});
