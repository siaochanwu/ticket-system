import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import config from '../../config/index.js';

describe('Orders Module', () => {
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

        await cleanupTestData();

        // 建立測試用戶
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'orderuser@example.com',
                password: 'password123',
            },
        });

        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'orderuser@example.com',
                password: 'password123',
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
        // 清除 Redis 與 DB
        const keys = await redis.keys('*');
        if (keys.length > 0) await redis.del(...keys);

        await prisma.orderItem.deleteMany({});
        await prisma.order.deleteMany({});
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});

        // 準備基礎資料
        const event = await prisma.event.create({
            data: {
                title: 'Order Test Event',
                saleStartAt: new Date('2026-01-01T00:00:00Z'),
                status: 'published',
            },
        });
        eventId = event.id;

        const session = await prisma.session.create({
            data: {
                eventId,
                sessionDate: new Date('2026-05-01'),
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

        const seat = await prisma.seat.create({
            data: {
                ticketTypeId,
                rowName: 'B',
                seatNumber: '1',
            },
        });
        seatIds = [seat.id];
    });

    async function cleanupTestData() {
        await prisma.orderItem.deleteMany({});
        await prisma.order.deleteMany({});
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
        await prisma.user.deleteMany({ where: { email: 'orderuser@example.com' } });
    }

    describe('POST /api/orders', () => {
        it('應該能成功建立訂單', async () => {
            // 1. 先鎖定座位
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            // 刻意把選位鎖的 TTL 縮短，模擬「鎖快過期」的情境：
            // 如果 createOrder 只是延長（expire）舊 TTL 而非主動重設，
            // 這裡量到的殘餘 TTL 就會停留在很小的數字，測試就會抓到退化
            const lockKey = `seat:lock:${seatIds[0]}`;
            const shortenedTtl = 5;
            await redis.expire(lockKey, shortenedTtl);

            // 2. 建立訂單
            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });

            const body = JSON.parse(orderRes.body);
            expect(orderRes.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.id).toBeDefined();
            expect(body.data.totalAmount).toBe('1000');

            // 3. 檢查 DB 狀態
            const dbOrder = await prisma.order.findUnique({
                where: { id: body.data.id },
                include: { items: true },
            });
            expect(dbOrder).toBeDefined();
            expect(dbOrder?.items.length).toBe(1);

            // 4. 訂單 pending 期間，Redis 座位鎖必須仍存在，
            //    且 TTL 必須被 createOrder 主動重設回付款期限附近
            //   （遠大於我們剛剛人為縮短的 5 秒，證明不是單純殘留的舊 TTL）
            const exists = await redis.exists(lockKey);
            expect(exists).toBe(1);
            const ttl = await redis.ttl(lockKey);
            expect(ttl).toBeGreaterThan(shortenedTtl);
            expect(ttl).toBeLessThanOrEqual(
                config.order.paymentTimeoutMinutes * 60
            );
        });

        it('鎖定過期後建立訂單應該失敗', async () => {
            const lockId = '00000000-0000-0000-0000-000000000000';
            const response = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });

            expect(response.statusCode).toBe(400);
            const body = JSON.parse(response.body);
            expect(body.code).toBe('LOCK_EXPIRED');
        });

        it('建立訂單時應該把座位的 lockedUntil 同步延長到訂單的付款期限（回歸測試）', async () => {
            // 1. 先鎖定座位
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            // 2. 建立訂單
            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });
            const orderId = JSON.parse(orderRes.body).data.id;

            const dbOrder = await prisma.order.findUnique({
                where: { id: orderId },
            });
            const dbSeat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });

            // 必須精確等於訂單的付款期限，而不只是「還沒過期」——
            // 選位當下寫入的舊 lockedUntil（10 分鐘後）若測試跑得夠快，
            // 此時也還沒過期，用「還沒過期」這種寬鬆斷言會漏掉
            // createOrder 忘記同步這個欄位的迴歸（見 Task 3 re-review 第 2 點）
            expect(dbSeat?.lockedUntil).not.toBeNull();
            expect(dbSeat?.lockedUntil?.getTime()).toBe(
                dbOrder?.expiresAt.getTime()
            );
        });
    })

    describe('GET /api/orders', () => {
        it('應該能成功取得訂單列表', async () => {
            // 1. 先鎖定座位
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            // 2. 建立訂單
            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });

            const body = JSON.parse(orderRes.body);
            expect(orderRes.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.id).toBeDefined();
            expect(body.data.totalAmount).toBe('1000');

            // 3. 檢查 DB 狀態
            const dbOrder = await prisma.order.findUnique({
                where: { id: body.data.id },
                include: { items: true },
            });
            expect(dbOrder).toBeDefined();
            expect(dbOrder?.items.length).toBe(1);

            // 4. 訂單 pending 期間，Redis 座位鎖必須仍存在
            const lockKey = `seat:lock:${seatIds[0]}`;
            const exists = await redis.exists(lockKey);
            expect(exists).toBe(1);

            // 5. 取得訂單列表
            const getRes = await app.inject({
                method: 'GET',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
            });

            const getBody = JSON.parse(getRes.body);
            expect(getRes.statusCode).toBe(200);
            expect(getBody.success).toBe(true);
            expect(getBody.data.length).toBe(1);
        })

        it('查無訂單', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.body);
            expect(body.success).toBe(true);
            expect(body.data).toEqual([]); // 應該收到空陣列
        })
    })

    describe('GET /api/orders/:id', () => {
        it('應該能成功取得訂單明細', async () => {
            // 1. 先鎖定座位
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            // 2. 建立訂單
            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });

            const body = JSON.parse(orderRes.body);
            expect(orderRes.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.id).toBeDefined();
            expect(body.data.totalAmount).toBe('1000');

            // 3. 檢查 DB 狀態
            const dbOrder = await prisma.order.findUnique({
                where: { id: body.data.id },
                include: { items: true },
            });
            expect(dbOrder).toBeDefined();
            expect(dbOrder?.items.length).toBe(1);

            // 4. 訂單 pending 期間，Redis 座位鎖必須仍存在
            const lockKey = `seat:lock:${seatIds[0]}`;
            const exists = await redis.exists(lockKey);
            expect(exists).toBe(1);

            // 5. 取得訂單明細
            const orderId = body.data.id;
            const getRes = await app.inject({
                method: 'GET',
                url: `/api/orders/${orderId}`,
                headers: {
                    Authorization: `Bearer ${userToken}`,
                }
            })

            const getBody = JSON.parse(getRes.body);
            expect(getRes.statusCode).toBe(200);
            expect(getBody.success).toBe(true);
            expect(getBody.data.id).toBe(orderId);

        })
    })

    describe('POST /api/orders/:orderId/cancel', () => {
        it('應該能取消 pending 訂單並釋放座位與 Redis 鎖', async () => {
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });
            const orderId = JSON.parse(orderRes.body).data.id;

            const cancelRes = await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(cancelRes.statusCode).toBe(200);
            expect(JSON.parse(cancelRes.body).data.status).toBe('cancelled');

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('available');
            expect(seat?.lockedBy).toBeNull();

            const exists = await redis.exists(`seat:lock:${seatIds[0]}`);
            expect(exists).toBe(0);
        });

        it('非 pending 的訂單不應該能取消', async () => {
            const lockRes = await app.inject({
                method: 'POST',
                url: '/api/tickets/lock',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { sessionId, seatIds },
            });
            const lockId = JSON.parse(lockRes.body).data.lockId;

            const orderRes = await app.inject({
                method: 'POST',
                url: '/api/orders',
                headers: { Authorization: `Bearer ${userToken}` },
                payload: { lockId },
            });
            const orderId = JSON.parse(orderRes.body).data.id;

            await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            const secondRes = await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(secondRes.statusCode).toBe(400);
            expect(JSON.parse(secondRes.body).code).toBe('ORDER_CANNOT_CANCEL');
        });
    });

});
