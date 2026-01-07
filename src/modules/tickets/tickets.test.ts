import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';

describe('Tickets Module', () => {
    let app: FastifyInstance;
    let userToken: string;
    let userId: string;
    let eventId: number;
    let sessionId: number;
    let ticketTypeId: number;
    let seatIds: number[];

    beforeAll(async () => {
        app = await buildApp();
        await app.ready();

        // 清除測試資料
        await cleanupTestData();

        // 建立測試用戶
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'ticketuser@example.com',
                password: '12345678',
            },
        });

        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'ticketuser@example.com',
                password: '12345678',
            },
        });

        const loginBody = JSON.parse(loginRes.body);
        userToken = loginBody.data.token;
        userId = loginBody.data.user.id;
    });

    afterAll(async () => {
        await cleanupTestData();
        await app.close();
        await prisma.$disconnect();
        await closeRedis();
    });

    beforeEach(async () => {
        // 清除 Redis 鎖定
        const keys = await redis.keys('seat:lock:*');
        if (keys.length > 0) {
            await redis.del(...keys);
        }
        const userLockKeys = await redis.keys('user:locks:*');
        if (userLockKeys.length > 0) {
            await redis.del(...userLockKeys);
        }

        // 清除並重建測試資料
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});

        // 建立測試活動（已開賣）
        const event = await prisma.event.create({
            data: {
                title: 'Test Event',
                saleStartAt: new Date('2026-01-01T10:00:00Z'),
                saleEndAt: new Date('2026-12-01T10:00:00Z'),
                status: 'published',
            },
        });
        eventId = event.id;

        // 建立場次
        const session = await prisma.session.create({
            data: {
                eventId: eventId,
                sessionDate: new Date('2026-03-01'),
                sessionTime: '19:00',
                status: 'active',
            },
        });
        sessionId = session.id;

        // 建立票種
        const ticketType = await prisma.ticketType.create({
            data: {
                name: 'VIP區',
                price: 5800,
                totalQuantity: 100,
                maxPerOrder: 4,
                sessionId: sessionId,
            },
        });
        ticketTypeId = ticketType.id;

        // 建立座位（A排 1-10）
        const seats = await prisma.seat.createMany({
            data: Array.from({ length: 10 }, (_, i) => ({
                ticketTypeId: ticketTypeId,
                rowName: 'A',
                seatNumber: (i + 1).toString(),
                status: 'available',
            })),
        });

        // 取得座位 ID
        const createdSeats = await prisma.seat.findMany({
            where: {
                ticketTypeId: ticketTypeId,
            },
            orderBy: { seatNumber: 'asc' },
        });
        seatIds = createdSeats.map((seat) => seat.id);
    });

    async function cleanupTestData() {
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
        await prisma.user.deleteMany({
            where: {
                email: {
                    contains: 'ticketuser',
                },
            },
        });
    }

    // 手動選位測試
    describe('POST /api/tickets/lock (手動選位)', () => {
        it('應該成功鎖定選位', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [seatIds[0], seatIds[1]], // 選擇 A1, A2
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.lockId).toBeDefined();
            expect(body.data.seats.length).toBe(2);
            expect(body.data.expiresAt).toBeDefined();
        });

        it('已被鎖定的座位應該無法再次鎖定', async () => {
            // 先鎖定
            await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [seatIds[0]],
                },
            });

            // 建立另一個用戶
            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'ticketuser2@example.com',
                    password: '12345678',
                },
            });
            const login2 = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'ticketuser2@example.com',
                    password: '12345678',
                },
            });
            const user2Token = JSON.parse(login2.body).data.token;

            // 另一個用戶嘗試鎖定相同座位
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${user2Token}`,
                },
                payload: {
                    sessionId,
                    seatIds: [seatIds[0]],
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(409);
            expect(body.code).toBe('SEAT_LOCKED');

            // 清除測試數據
            await prisma.user.deleteMany({
                where: {
                    email: 'ticketuser2@example.com',
                },
            });
        });

        it('超過購買上限應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [
                        seatIds[0],
                        seatIds[1],
                        seatIds[2],
                        seatIds[3],
                        seatIds[4],
                    ], // 5 張，超過上限 4 張
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(400);
            expect(body.code).toBe('EXCEED_LIMIT');
        });

        it('未登入應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                payload: {
                    sessionId,
                    seatIds: [seatIds[0]],
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(401);
            expect(body.code).toBe('UNAUTHORIZED');
        });

        it('不存在的座位應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [999999], // 不存在的座位 ID
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(400);
            expect(body.code).toBe('INVALID_SEATS');
        });

        it('不存在的場次應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId: 999999, // 不存在的場次 ID
                    seatIds: [seatIds[0]],
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(404);
            expect(body.code).toBe('SESSION_NOT_FOUND');
        });
    });

    // 自動選位測試
    describe('POST /api/tickets/auto-select (自動選位)', () => {
        it('應該自動選擇連續座位', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/auto-select',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    ticketTypeId,
                    quantity: 3,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.seats.length).toBe(3);

            // 檢查是否連續
            const seatNumbers = body.data.seats
                .map((s: { seatNumber: string }) => parseInt(s.seatNumber))
                .sort((a: number, b: number) => a - b);

            expect(seatNumbers[1] - seatNumbers[0]).toBe(1);
            expect(seatNumbers[2] - seatNumbers[1]).toBe(1);
        });

        it('庫存不足應該失敗', async () => {
            // 先鎖定大部分座位
            await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: seatIds.slice(0, 4), // 鎖定前4張座位
                },
            });

            // 建立另一個用戶嘗試選 8 張
            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'ticketuser3@example.com',
                    password: '12345678',
                },
            });
            const login3 = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'ticketuser3@example.com',
                    password: '12345678',
                },
            });
            const userToken3 = JSON.parse(login3.body).data.token;

            // 更新票種上限以便測試
            await prisma.ticketType.update({
                where: {
                    id: ticketTypeId,
                },
                data: {
                    maxPerOrder: 10,
                },
            });

            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/auto-select',
                headers: {
                    Authorization: `Bearer ${userToken3}`,
                },
                payload: {
                    sessionId,
                    ticketTypeId,
                    quantity: 8, // 只剩 6 張可用
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(409);
            expect(body.code).toBe('INSUFFICIENT_STOCK');

            // 清理
            await prisma.user.deleteMany({
                where: {
                    email: 'ticketuser3@example.com',
                },
            });
        });

        it('超過購買上限應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/auto-select',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    ticketTypeId,
                    quantity: 5, // 超過上限4
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(400);
            expect(body.code).toBe('EXCEED_LIMIT');
        });

        it('不存在的票種應該失敗', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/auto-select',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    ticketTypeId: 999999, // 不存在的票種 ID
                    quantity: 3,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(404);
            expect(body.code).toBe('TICKET_TYPE_NOT_FOUND');
        });
    });

    // 釋放座位測試
    describe('POST /api/tickets/unlock (釋放座位)', () => {
        it('應該成功釋放座位', async () => {
            // 先鎖定座位
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [seatIds[0], seatIds[1]], // 鎖定 A1, A2
                },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            // 釋放座位
            const response = await app.inject({
                method: 'DELETE',
                url: `/api/tickets/lock/${lockId}`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);

            // 確認座位狀態已恢復
            const seats = await prisma.seat.findMany({
                where: {
                    id: { in: [seatIds[0], seatIds[1]] },
                },
            });

            expect(seats.every((s) => s.status === 'available')).toBe(true);
        });

        it('不存在的鎖定記錄應該失敗', async () => {
            const response = await app.inject({
                method: 'DELETE',
                url: '/api/tickets/lock/999999',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(404);
            expect(body.code).toBe('LOCK_NOT_FOUND');
        });
    });

    // 取得我的鎖定座位測試
    describe('GET /api/tickets/my-locks（我的鎖定座位）', () => {
        it('應該成功取得用戶的鎖定座位', async () => {
            // 鎖定一些座位
            await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId,
                    seatIds: [seatIds[0], seatIds[1]], // 鎖定 A1, A2
                },
            });

            // 取得鎖定列表
            const response = await app.inject({
                method: 'GET',
                url: '/api/tickets/my-locks',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.length).toBe(1);
            expect(body.data[0].seats.length).toBe(2);
        });

        it('沒有鎖定應該返回空陣列', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/tickets/my-locks',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.data).toEqual([]);
        });
    });

    // 尚未開賣測試
    describe('開賣時間驗證', () => {
        it('尚未開賣應該失敗', async () => {
            // 建立尚未開賣的活動
            const futureEvent = await prisma.event.create({
                data: {
                    title: 'Future Event',
                    saleStartAt: new Date('2099-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            const futureSession = await prisma.session.create({
                data: {
                    eventId: futureEvent.id,
                    sessionDate: new Date('2099-03-01'),
                    sessionTime: '19:00',
                },
            });
            const futureTicketType = await prisma.ticketType.create({
                data: {
                    name: 'VIP區',
                    price: 5800,
                    totalQuantity: 100,
                    maxPerOrder: 4,
                    sessionId: futureSession.id,
                },
            });
            const futureSeat = await prisma.seat.create({
                data: {
                    ticketTypeId: futureTicketType.id,
                    rowName: 'A',
                    seatNumber: '1',
                },
            });

            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId: futureSession.id,
                    seatIds: [futureSeat.id],
                },
            });

            const body = await JSON.parse(response.body);

            expect(response.statusCode).toBe(400);
            expect(body.code).toBe('SALE_NOT_STARTED');
        });

        it('已結束售票應該失敗', async () => {
            // 建立已結束售票的活動
            const pastEvent = await prisma.event.create({
                data: {
                    title: 'Past Event',
                    saleStartAt: new Date('2022-01-01T10:00:00Z'),
                    saleEndAt: new Date('2022-12-01T10:00:00Z'), // 已過期
                    status: 'published',
                },
            });
            const pastSession = await prisma.session.create({
                data: {
                    eventId: pastEvent.id,
                    sessionDate: new Date('2022-03-01'),
                    sessionTime: '19:00',
                },
            });
            const pastTicketType = await prisma.ticketType.create({
                data: {
                    name: 'VIP區',
                    price: 5800,
                    totalQuantity: 100,
                    maxPerOrder: 4,
                    sessionId: pastSession.id,
                },
            });
            const pastSeat = await prisma.seat.create({
                data: {
                    ticketTypeId: pastTicketType.id,
                    rowName: 'A',
                    seatNumber: '1',
                },
            });

            const response = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionId: pastSession.id,
                    seatIds: [pastSeat.id],
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(400);
            expect(body.code).toBe('SALE_ENDED');
        });
    });
});
