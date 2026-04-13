import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import { closeRedis } from '../../config/redis.js';

describe('Events Module', () => {
    let app: FastifyInstance;
    let adminToken: string;
    let userToken: string;

    beforeAll(async () => {
        app = await buildApp();
        await app.ready();

        // 清除測試用戶（使用專屬的 email 前綴避免與 auth.test.ts 衝突）
        await prisma.user.deleteMany({
            where: {
                email: {
                    contains: 'events-test',
                },
            },
        });

        // 建立一般用戶
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'events-test-user@example.com',
                password: '12345678',
            },
        });

        const userLogin = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'events-test-user@example.com',
                password: '12345678',
            },
        });
        const userLoginBody = JSON.parse(userLogin.body);
        if (!userLoginBody.success || !userLoginBody.data?.token) {
            throw new Error(
                `User login failed: ${JSON.stringify(userLoginBody, null, 2)}`
            );
        }
        userToken = userLoginBody.data.token;

        // 建立管理員
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'events-test-admin@example.com',
                password: '12345678',
            },
        });
        // 手動更新為管理員
        await prisma.user.update({
            where: {
                email: 'events-test-admin@example.com',
            },
            data: {
                role: 'ADMIN',
            },
        });

        const adminLogin = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'events-test-admin@example.com',
                password: '12345678',
            },
        });
        const adminLoginBody = JSON.parse(adminLogin.body);
        if (!adminLoginBody.success || !adminLoginBody.data?.token) {
            throw new Error(
                `Admin login failed: ${JSON.stringify(adminLoginBody, null, 2)}`
            );
        }
        adminToken = adminLoginBody.data.token;
    });

    afterAll(async () => {
        // 清除測試資料
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
        await prisma.user.deleteMany({
            where: {
                email: {
                    contains: 'events-test',
                },
            },
        });

        await app.close();
        await prisma.$disconnect();
        await closeRedis();
    });

    beforeEach(async () => {
        // 每個測試前清除活動資料
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
    });

    // 建立活動測試
    describe('POST /api/events', () => {
        it('管理員應該可以建立活動', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/events',
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: '2026-01-01T10:00:00Z',
                    status: 'published',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.title).toBe('Test Event');
            expect(body.data.venue).toBe('Test Venue');
        });

        it('一般用戶不應該可以建立活動', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/events',
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: '2026-01-01T10:00:00Z',
                    status: 'published',
                },
            });
            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(403);
            expect(body.success).toBe(false);
        });

        it('未登入不能建立活動', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/events',
                payload: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: '2026-01-01T10:00:00Z',
                    status: 'published',
                },
            });

            expect(response.statusCode).toBe(401);
        });

        it('缺少必填欄位應該回傳錯誤', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/events',
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    title: 'Test Event',
                    saleStartAt: '2026-01-01T10:00:00Z',
                    status: 'published',
                },
            });

            expect(response.statusCode).toBe(400);
        });
    });

    // 取得活動列表測試
    describe('GET /api/events', () => {
        beforeEach(async () => {
            // 建立測試資料
            await prisma.event.createMany({
                data: [
                    {
                        title: 'Test Event 1',
                        venue: 'Test Venue 1',
                        saleStartAt: new Date('2026-01-01T10:00:00Z'),
                        status: 'published',
                    },
                    {
                        title: 'Test Event 2',
                        venue: 'Test Venue 2',
                        saleStartAt: new Date('2026-01-01T10:00:00Z'),
                        status: 'published',
                    },
                    {
                        title: 'Test Event 3',
                        venue: 'Test Venue 3',
                        saleStartAt: new Date('2026-01-01T10:00:00Z'),
                        status: 'draft',
                    },
                ],
            });
        });

        it('應該可以取得活動列表', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/events',
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.length).toBe(3);
        });

        it('應該支援分頁', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/events?page=1&limit=2',
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.data.length).toBe(2);
            expect(body.pagination.page).toBe(1);
            expect(body.pagination.limit).toBe(2);
            expect(body.pagination.totalPages).toBe(2);
        });

        it('應該支援狀態篩選', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/events?status=published',
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.data.length).toBe(2);
            expect(
                body.data.every((event: any) => event.status === 'published')
            ).toBe(true);
        });
    });

    // 取得活動詳情測試
    describe('GET /api/events/:id', () => {
        let eventId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            eventId = event.id;
        });

        it('應該可以取得活動詳情', async () => {
            const response = await app.inject({
                method: 'GET',
                url: `/api/events/${eventId}`,
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.id).toBe(eventId);
            expect(body.data.title).toBe('Test Event');
        });

        it('應該回傳404當活動不存在', async () => {
            const response = await app.inject({
                method: 'GET',
                url: `/api/events/99999`,
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(404);
            expect(body.success).toBe(false);
            expect(body.code).toBe('EVENT_NOT_FOUND');
        });
    });

    // 更新活動測試
    describe('PUT /api/events/:id', () => {
        let eventId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            eventId = event.id;
        });

        it('管理員應該可以更新活動', async () => {
            const response = await app.inject({
                method: 'PUT',
                url: `/api/events/${eventId}`,
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    title: 'Updated Event',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.data.title).toBe('Updated Event');
        });

        it('一般用戶不應該可以更新活動', async () => {
            const response = await app.inject({
                method: 'PUT',
                url: `/api/events/${eventId}`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    title: 'Updated Event',
                },
            });

            expect(response.statusCode).toBe(403);
        });
    });

    // 刪除活動測試
    describe('DELETE /api/events/:id', () => {
        let eventId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            eventId = event.id;
        });

        it('管理員應該可以刪除活動', async () => {
            const response = await app.inject({
                method: 'DELETE',
                url: `/api/events/${eventId}`,
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);

            // 確認已刪除
            const deletedEvent = await prisma.event.findUnique({
                where: {
                    id: eventId,
                },
            });
            expect(deletedEvent).toBeNull();
        });

        it('一般用戶不應該可以刪除活動', async () => {
            const response = await app.inject({
                method: 'DELETE',
                url: `/api/events/${eventId}`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
            });

            expect(response.statusCode).toBe(403);
        });
    });

    // 建立場次測試
    describe('POST /api/events/:id/sessions', () => {
        let eventId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            eventId = event.id;
        });

        it('管理員應該可以建立場次', async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/events/${eventId}/sessions`,
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    sessionDate: '2026-03-01',
                    sessionTime: '19:00',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.sessionTime).toBe('19:00');
        });

        it('一般用戶不應該可以建立場次', async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/events/${eventId}/sessions`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    sessionDate: '2026-03-01',
                    sessionTime: '19:00',
                },
            });

            expect(response.statusCode).toBe(403);
        });
    });

    // 建立票種測試
    describe('POST /api/events/sessions/:sessionId/ticket-types', () => {
        let sessionId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            const session = await prisma.session.create({
                data: {
                    eventId: event.id,
                    sessionDate: new Date('2026-03-01'),
                    sessionTime: '19:00',
                },
            });
            sessionId = session.id;
        });

        it('管理員應該可以建立票種', async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/events/sessions/${sessionId}/ticket-types`,
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    name: 'VIP區',
                    price: 5800,
                    totalQuantity: 100,
                    maxPerOrder: 4,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(201);
            expect(body.data.name).toBe('VIP區');
            expect(Number(body.data.price)).toBe(5800);
            expect;
        });
    });

    // 批次建立座位測試
    describe('POST /api/events/ticket-types/:ticketTypeId/seats', () => {
        let ticketTypeId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            const session = await prisma.session.create({
                data: {
                    eventId: event.id,
                    sessionDate: new Date('2026-03-01'),
                    sessionTime: '19:00',
                },
            });
            const ticketType = await prisma.ticketType.create({
                data: {
                    name: 'VIP區',
                    price: 5800,
                    totalQuantity: 100,
                    maxPerOrder: 4,
                    sessionId: session.id,
                },
            });
            ticketTypeId = ticketType.id;
        });

        it('管理員應該可以批次建立座位', async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/events/ticket-types/${ticketTypeId}/seats`,
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    rows: [
                        {
                            rowName: 'A',
                            seatCount: 10,
                        },
                        {
                            rowName: 'B',
                            seatCount: 10,
                        },
                    ],
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.count).toBe(20);

            // 確認座位已建立
            const seats = await prisma.seat.findMany({
                where: { ticketTypeId },
            });
            expect(seats.length).toBe(20);
        });

        it('一般用戶不應該可以建立座位', async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/api/events/ticket-types/${ticketTypeId}/seats`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                },
                payload: {
                    rows: [
                        {
                            rowName: 'A',
                            seatCount: 10,
                        },
                        {
                            rowName: 'B',
                            seatCount: 10,
                        },
                    ],
                },
            });

            expect(response.statusCode).toBe(403);
        });
    });

    // 取得座位圖測試
    describe('GET /api/events/sessions/:sessionId/seats', () => {
        let sessionId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event2',
                    venue: 'Test Venue2',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            const session = await prisma.session.create({
                data: {
                    eventId: event.id,
                    sessionDate: new Date('2026-03-01'),
                    sessionTime: '19:00',
                },
            });
            const ticketType = await prisma.ticketType.create({
                data: {
                    name: 'VIP區',
                    price: 5800,
                    totalQuantity: 100,
                    maxPerOrder: 4,
                    sessionId: session.id,
                },
            });
            await prisma.seat.createMany({
                data: [
                    {
                        ticketTypeId: ticketType.id,
                        rowName: 'A',
                        seatNumber: '1',
                    },
                    {
                        ticketTypeId: ticketType.id,
                        rowName: 'A',
                        seatNumber: '2',
                    },
                    {
                        ticketTypeId: ticketType.id,
                        rowName: 'A',
                        seatNumber: '3',
                    },
                ],
            });
            sessionId = session.id;
        });

        it('應該可以取得座位圖', async () => {
            console.log('sessionId', sessionId);
            const response = await app.inject({
                method: 'GET',
                url: `/api/events/sessions/${sessionId}/seats`,
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.seats.length).toBe(3);
        });
    });

    // 取得票種剩餘數量測試
    describe('GET /api/events/sessions/:sessionId/availability', () => {
        let sessionId: number;

        beforeEach(async () => {
            const event = await prisma.event.create({
                data: {
                    title: 'Test Event',
                    venue: 'Test Venue',
                    saleStartAt: new Date('2026-01-01T10:00:00Z'),
                    status: 'published',
                },
            });
            const session = await prisma.session.create({
                data: {
                    eventId: event.id,
                    sessionDate: new Date('2026-03-01'),
                    sessionTime: '19:00',
                },
            });
            const ticketType = await prisma.ticketType.createMany({
                data: [
                    {
                        name: 'VIP區',
                        price: 5800,
                        totalQuantity: 100,
                        reservedQuantity: 20,
                        sessionId: session.id,
                    },
                    {
                        name: '普通區',
                        price: 3800,
                        totalQuantity: 500,
                        reservedQuantity: 100,
                        sessionId: session.id,
                    },
                ],
            });
            sessionId = session.id;
        });

        it('應該可以取得票種剩餘數量', async () => {
            const response = await app.inject({
                method: 'GET',
                url: `/api/events/sessions/${sessionId}/availability`,
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.length).toBe(2);

            const vip = body.data.find((item: any) => item.name === 'VIP區');
            expect(vip.total).toBe(100);
            expect(vip.available).toBe(80);
            expect(vip.reserved).toBe(20);

            const normal = body.data.find(
                (item: any) => item.name === '普通區'
            );
            expect(normal.total).toBe(500);
            expect(normal.available).toBe(400);
            expect(normal.reserved).toBe(100);
        });
    });
});
