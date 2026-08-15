import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import config from '../../config/index.js';
import { cancelOrder } from './orders.service.js';

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

        it('已付款訂單不應該能取消，且不得動到座位與票券（可兌現雙賣回歸測試）', async () => {
            // 直接把資料組成「已付款」狀態：座位 sold、OrderItem 已簽發
            // ticketCode/qrCode。比等待真正的付款流程更穩定地重現
            // 「cancel 讀到 pending 之後、commit 之前剛好有付款成功」的後果。
            const order = await prisma.order.create({
                data: {
                    orderNo: `TKT-PAID-${Date.now()}`,
                    userId,
                    sessionId,
                    status: 'paid',
                    totalAmount: 1000,
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                    paidAt: new Date(),
                },
            });
            await prisma.seat.update({
                where: { id: seatIds[0] },
                data: { status: 'sold', lockedBy: null, lockedUntil: null },
            });
            await prisma.orderItem.create({
                data: {
                    orderId: order.id,
                    seatId: seatIds[0],
                    ticketTypeId,
                    price: 1000,
                    ticketCode: 'TIX-ALREADY-ISSUED',
                    qrCode: 'QR-ALREADY-ISSUED',
                },
            });

            const cancelRes = await app.inject({
                method: 'POST',
                url: `/api/orders/${order.id}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(cancelRes.statusCode).toBe(400);
            expect(JSON.parse(cancelRes.body).code).toBe('ORDER_CANNOT_CANCEL');

            const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
            expect(dbOrder?.status).toBe('paid');

            const dbSeat = await prisma.seat.findUnique({ where: { id: seatIds[0] } });
            expect(dbSeat?.status).toBe('sold');

            const dbItem = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
            expect(dbItem?.ticketCode).not.toBeNull();
            expect(dbItem?.qrCode).not.toBeNull();
        });

        it('讀取當下是 pending、交易前才被改成 paid 的取消也必須失敗（不能只靠交易外的前置檢查）', async () => {
            // 先走正常流程建立一筆貨真價實的 pending 訂單，取得 orderId
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

            // 在同一個測試內模擬「取消讀到 pending 之後、交易 commit 之前，
            // 付款搶先 commit」：直接把它改成已付款
            await prisma.seat.update({
                where: { id: seatIds[0] },
                data: { status: 'sold', lockedBy: null, lockedUntil: null },
            });
            const orderItem = await prisma.orderItem.findFirstOrThrow({
                where: { orderId },
            });
            await prisma.orderItem.update({
                where: { id: orderItem.id },
                data: { ticketCode: 'TIX-RACE', qrCode: 'QR-RACE' },
            });
            await prisma.order.update({
                where: { id: orderId },
                data: { status: 'paid', paidAt: new Date() },
            });

            const cancelRes = await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(cancelRes.statusCode).toBe(400);
            expect(JSON.parse(cancelRes.body).code).toBe('ORDER_CANNOT_CANCEL');

            const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
            expect(dbOrder?.status).toBe('paid');

            const dbSeat = await prisma.seat.findUnique({ where: { id: seatIds[0] } });
            expect(dbSeat?.status).toBe('sold');

            const dbItem = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
            expect(dbItem?.ticketCode).not.toBeNull();
            expect(dbItem?.qrCode).not.toBeNull();
        });

        it('service 層 cancelOrder 必須靠交易內的 where 守衛擋下已付款訂單（拿掉守衛此測試必須變紅）', async () => {
            // 繞過 HTTP 層，直接呼叫 service，確保守衛真的長在交易內部，
            // 而不是恰好被前面某一層的前置檢查擋下
            const order = await prisma.order.create({
                data: {
                    orderNo: `TKT-PAID-SVC-${Date.now()}`,
                    userId,
                    sessionId,
                    status: 'pending',
                    totalAmount: 1000,
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
                },
            });
            await prisma.orderItem.create({
                data: {
                    orderId: order.id,
                    seatId: seatIds[0],
                    ticketTypeId,
                    price: 1000,
                },
            });

            // 呼叫 cancelOrder 之前才把訂單改成 paid（模擬讀取後才 commit 的付款）
            await prisma.seat.update({
                where: { id: seatIds[0] },
                data: { status: 'sold', lockedBy: null, lockedUntil: null },
            });
            await prisma.orderItem.updateMany({
                where: { orderId: order.id },
                data: { ticketCode: 'TIX-SVC-DIRECT', qrCode: 'QR-SVC-DIRECT' },
            });
            await prisma.order.update({
                where: { id: order.id },
                data: { status: 'paid', paidAt: new Date() },
            });

            await expect(cancelOrder(userId, order.id)).rejects.toMatchObject({
                code: 'ORDER_CANNOT_CANCEL',
            });

            const dbOrder = await prisma.order.findUnique({ where: { id: order.id } });
            expect(dbOrder?.status).toBe('paid');

            const dbSeat = await prisma.seat.findUnique({ where: { id: seatIds[0] } });
            expect(dbSeat?.status).toBe('sold');
        });
    });

});
