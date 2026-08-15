import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import { signCallback } from '../payments/payments.signature.js';

describe('Refunds Module', () => {
    let app: FastifyInstance;
    let userToken: string;
    let adminToken: string;
    let sessionId: number;
    let seatIds: number[];

    beforeAll(async () => {
        app = await buildApp();
        await app.ready();

        await cleanup();
        await prisma.user.deleteMany({
            where: { email: { contains: 'refund' } },
        });

        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'refunduser@example.com',
                password: 'password123',
            },
        });

        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'refunduser@example.com',
                password: 'password123',
            },
        });
        userToken = JSON.parse(loginRes.body).data.token;

        // 管理員：註冊後直接把 role 改成 ADMIN 再登入
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'refundadmin@example.com',
                password: 'password123',
            },
        });
        await prisma.user.update({
            where: { email: 'refundadmin@example.com' },
            data: { role: 'ADMIN' },
        });
        const adminLoginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'refundadmin@example.com',
                password: 'password123',
            },
        });
        adminToken = JSON.parse(adminLoginRes.body).data.token;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.user.deleteMany({
            where: { email: { contains: 'refund' } },
        });
        await app.close();
        await prisma.$disconnect();
        await closeRedis();
    });

    async function cleanup() {
        await prisma.refundRequest.deleteMany({});
        await prisma.payment.deleteMany({});
        await prisma.orderItem.deleteMany({});
        await prisma.order.deleteMany({});
        await prisma.seat.deleteMany({});
        await prisma.ticketType.deleteMany({});
        await prisma.session.deleteMany({});
        await prisma.event.deleteMany({});
    }

    // sessionDate 預設在遠期（可退票）；傳入近期日期可測退票期限
    async function seedEvent(sessionDate: Date) {
        const event = await prisma.event.create({
            data: {
                title: 'Refund Test Event',
                saleStartAt: new Date('2026-01-01T00:00:00Z'),
                status: 'published',
            },
        });

        const session = await prisma.session.create({
            data: {
                eventId: event.id,
                sessionDate,
                sessionTime: '20:00',
            },
        });
        sessionId = session.id;

        const ticketType = await prisma.ticketType.create({
            data: {
                sessionId,
                name: 'Standard',
                price: 2000,
                totalQuantity: 100,
            },
        });

        const seat = await prisma.seat.create({
            data: {
                ticketTypeId: ticketType.id,
                rowName: 'E',
                seatNumber: '9',
            },
        });
        seatIds = [seat.id];
    }

    beforeEach(async () => {
        const keys = await redis.keys('*');
        if (keys.length > 0) await redis.del(...keys);

        await cleanup();
        await seedEvent(new Date('2026-12-01'));
    });

    async function createPaidOrder(): Promise<string> {
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

        const payRes = await app.inject({
            method: 'POST',
            url: '/api/payments',
            headers: { Authorization: `Bearer ${userToken}` },
            payload: { orderId },
        });
        const { transactionId, amount } = JSON.parse(payRes.body).data;

        await app.inject({
            method: 'POST',
            url: '/api/payments/callback/mock',
            payload: {
                transactionId,
                status: 'success',
                amount,
                signature: signCallback(transactionId, 'success', amount),
            },
        });

        return orderId;
    }

    async function requestRefund(orderId: string, reason = '臨時有事') {
        const res = await app.inject({
            method: 'POST',
            url: '/api/refunds',
            headers: { Authorization: `Bearer ${userToken}` },
            payload: { orderId, reason },
        });
        return { res, body: JSON.parse(res.body) };
    }

    describe('POST /api/refunds', () => {
        it('已付款的訂單應該能申請退票', async () => {
            const orderId = await createPaidOrder();
            const { res, body } = await requestRefund(orderId);

            expect(res.statusCode).toBe(201);
            expect(body.data.status).toBe('pending');
            expect(body.data.orderId).toBe(orderId);
            expect(body.data.reason).toBe('臨時有事');
        });

        it('未付款的訂單不應該能申請退票', async () => {
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

            const { res } = await requestRefund(orderId);

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.body).code).toBe('ORDER_NOT_PAID');
        });

        it('他人的訂單不應該能申請退票', async () => {
            const orderId = await createPaidOrder();

            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'refundother@example.com',
                    password: 'password123',
                },
            });
            const login = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'refundother@example.com',
                    password: 'password123',
                },
            });
            const otherToken = JSON.parse(login.body).data.token;

            const res = await app.inject({
                method: 'POST',
                url: '/api/refunds',
                headers: { Authorization: `Bearer ${otherToken}` },
                payload: { orderId },
            });

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.body).code).toBe('ORDER_NOT_FOUND');
        });

        it('重複申請應該回 409', async () => {
            const orderId = await createPaidOrder();
            await requestRefund(orderId);

            const { res } = await requestRefund(orderId);

            expect(res.statusCode).toBe(409);
            expect(JSON.parse(res.body).code).toBe(
                'REFUND_ALREADY_REQUESTED'
            );
        });

        it('超過退票期限應該回 400', async () => {
            // 場次在 3 天後，退票期限為 7 天前，已超過
            await cleanup();
            await seedEvent(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));

            const orderId = await createPaidOrder();
            const { res } = await requestRefund(orderId);

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.body).code).toBe('REFUND_DEADLINE_PASSED');
        });
    });

    describe('GET /api/refunds', () => {
        it('使用者只應該看到自己的申請', async () => {
            const orderId = await createPaidOrder();
            await requestRefund(orderId);

            const res = await app.inject({
                method: 'GET',
                url: '/api/refunds',
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(res.statusCode).toBe(200);
            const list = JSON.parse(res.body).data;
            expect(list.length).toBe(1);
            expect(list[0].orderId).toBe(orderId);
        });
    });

    describe('後台退票審核', () => {
        it('核准退票應該讓訂單轉 refunded、座位釋放、票券作廢', async () => {
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/approve`,
                headers: { Authorization: `Bearer ${adminToken}` },
            });

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).data.status).toBe('approved');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('refunded');
            for (const item of order!.items) {
                expect(item.ticketCode).toBeNull();
                expect(item.qrCode).toBeNull();
            }

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('available');
            expect(seat?.lockedBy).toBeNull();

            const refund = await prisma.refundRequest.findUnique({
                where: { id: refundId },
            });
            expect(refund?.processedAt).not.toBeNull();
            expect(refund?.processedBy).not.toBeNull();
        });

        it('重複核准應該回 409', async () => {
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/approve`,
                headers: { Authorization: `Bearer ${adminToken}` },
            });

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/approve`,
                headers: { Authorization: `Bearer ${adminToken}` },
            });

            expect(res.statusCode).toBe(409);
            expect(JSON.parse(res.body).code).toBe(
                'REFUND_ALREADY_PROCESSED'
            );
        });

        it('拒絕退票時訂單維持 paid 且票券保留', async () => {
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/reject`,
                headers: { Authorization: `Bearer ${adminToken}` },
                payload: { reason: '不符退票條件' },
            });

            expect(res.statusCode).toBe(200);
            const rejected = JSON.parse(res.body).data;
            expect(rejected.status).toBe('rejected');
            // 使用者原本填的理由必須保留
            expect(rejected.reason).toContain('臨時有事');
            expect(rejected.reason).toContain('不符退票條件');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('paid');
            expect(order!.items[0].ticketCode).not.toBeNull();
        });

        it('admin 應該能看到全部退票申請', async () => {
            const orderId = await createPaidOrder();
            await requestRefund(orderId);

            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/refunds',
                headers: { Authorization: `Bearer ${adminToken}` },
            });

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).data.length).toBe(1);
        });

        it('一般使用者呼叫後台端點應該回 403', async () => {
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${body.data.id}/approve`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(res.statusCode).toBe(403);
            expect(JSON.parse(res.body).code).toBe('FORBIDDEN');
        });

        it('核准退票後，該訂單票券的 QR code 端點應該失效（票券已作廢，而非重新簽出一組新的）', async () => {
            const orderId = await createPaidOrder();

            const orderBefore = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            const ticketId = orderBefore!.items[0].id;

            // 核准前：qrcode 端點應該正常回應，確保待會的失敗斷言
            // 真的是因為核准退票造成的，而不是這張票券本來就拿不到 QR code
            const beforeRes = await app.inject({
                method: 'GET',
                url: `/api/my-tickets/${ticketId}/qrcode`,
                headers: { Authorization: `Bearer ${userToken}` },
            });
            expect(beforeRes.statusCode).toBe(200);
            const beforeBody = JSON.parse(beforeRes.body).data;
            expect(beforeBody.ticketCode).toBeTruthy();
            expect(beforeBody.qrPayload).toBeTruthy();

            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            const approveRes = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/approve`,
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            expect(approveRes.statusCode).toBe(200);

            // 核准後：同一張票券的 QR code 端點必須失敗（ticketCode/qrCode
            // 已被作廢清為 null，訂單也已轉 refunded），而不是重新簽出一組
            // 「看起來一樣」的簽章 payload——這是唯一能證明「票券真的被作廢」
            // 而非「端點只是重新推導出相同結果」的測試。
            const afterRes = await app.inject({
                method: 'GET',
                url: `/api/my-tickets/${ticketId}/qrcode`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(afterRes.statusCode).toBe(400);
            expect(JSON.parse(afterRes.body).code).toBe('ORDER_NOT_PAID');
        });
    });
});
