import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import { signCallback } from './payments.signature.js';
import { verifyTicket } from '../../utils/ticketCode.js';

describe('Payments Module', () => {
    let app: FastifyInstance;
    let userToken: string;
    let sessionId: number;
    let seatIds: number[];

    beforeAll(async () => {
        app = await buildApp();
        await app.ready();

        await cleanup();

        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'payuser@example.com',
                password: 'password123',
            },
        });

        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'payuser@example.com',
                password: 'password123',
            },
        });
        userToken = JSON.parse(loginRes.body).data.token;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.user.deleteMany({
            where: { email: 'payuser@example.com' },
        });
        await app.close();
        await prisma.$disconnect();
        await closeRedis();
    });

    async function cleanup() {
        await prisma.payment.deleteMany({});
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
                title: 'Payment Test Event',
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

        const seat = await prisma.seat.create({
            data: {
                ticketTypeId: ticketType.id,
                rowName: 'C',
                seatNumber: '1',
            },
        });
        seatIds = [seat.id];
    });

    // 走完「鎖位 → 下單」並回傳 orderId
    async function createPendingOrder(): Promise<string> {
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

        return JSON.parse(orderRes.body).data.id;
    }

    async function createPayment(orderId: string) {
        const res = await app.inject({
            method: 'POST',
            url: '/api/payments',
            headers: { Authorization: `Bearer ${userToken}` },
            payload: { orderId, paymentMethod: 'credit_card' },
        });
        return { res, body: JSON.parse(res.body) };
    }

    function callbackPayload(
        transactionId: string,
        status: 'success' | 'failed',
        amount: string
    ) {
        return {
            transactionId,
            status,
            amount,
            signature: signCallback(transactionId, status, amount),
        };
    }

    describe('POST /api/payments', () => {
        it('應該能為 pending 訂單建立付款', async () => {
            const orderId = await createPendingOrder();
            const { res, body } = await createPayment(orderId);

            expect(res.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.data.paymentId).toBeDefined();
            expect(body.data.transactionId).toMatch(/^MOCK-/);
            expect(body.data.amount).toBe('1000');
            expect(body.data.paymentUrl).toContain(body.data.transactionId);
        });

        it('重複建立付款應該回傳同一筆（冪等）', async () => {
            const orderId = await createPendingOrder();
            const first = await createPayment(orderId);
            const second = await createPayment(orderId);

            expect(second.res.statusCode).toBe(201);
            expect(second.body.data.paymentId).toBe(first.body.data.paymentId);

            const count = await prisma.payment.count({ where: { orderId } });
            expect(count).toBe(1);
        });

        it('他人的訂單應該回 404', async () => {
            const orderId = await createPendingOrder();

            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'payuser2@example.com',
                    password: 'password123',
                },
            });
            const login = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'payuser2@example.com',
                    password: 'password123',
                },
            });
            const otherToken = JSON.parse(login.body).data.token;

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments',
                headers: { Authorization: `Bearer ${otherToken}` },
                payload: { orderId },
            });

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.body).code).toBe('ORDER_NOT_FOUND');

            await prisma.user.deleteMany({
                where: { email: 'payuser2@example.com' },
            });
        });

        it('已取消的訂單不應該能建立付款', async () => {
            const orderId = await createPendingOrder();

            await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            const { res } = await createPayment(orderId);

            expect(res.statusCode).toBe(410);
            expect(JSON.parse(res.body).code).toBe('ORDER_EXPIRED');
        });

        it('已逾期的訂單不應該能建立付款', async () => {
            const orderId = await createPendingOrder();
            await prisma.order.update({
                where: { id: orderId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });

            const { res } = await createPayment(orderId);

            expect(res.statusCode).toBe(410);
            expect(JSON.parse(res.body).code).toBe('ORDER_EXPIRED');
        });
    });

    describe('POST /api/payments/callback/mock', () => {
        it('簽章錯誤應該回 401', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: {
                    transactionId: body.data.transactionId,
                    status: 'success',
                    amount: '1000',
                    signature: 'deadbeef',
                },
            });

            expect(res.statusCode).toBe(401);
            expect(JSON.parse(res.body).code).toBe('INVALID_SIGNATURE');
        });

        it('金額不符應該回 400', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'success',
                    '999'
                ),
            });

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.body).code).toBe('AMOUNT_MISMATCH');
        });

        it('不存在的 transactionId 應該回 404', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload('MOCK-does-not-exist', 'success', '1000'),
            });

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.body).code).toBe('PAYMENT_NOT_FOUND');
        });

        it('成功回調應該讓訂單付款完成、座位售出並簽發票券', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'success',
                    '1000'
                ),
            });

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).data.orderStatus).toBe('paid');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('paid');
            expect(order?.paidAt).not.toBeNull();

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('sold');
            expect(seat?.lockedBy).toBeNull();

            for (const item of order!.items) {
                expect(item.ticketCode).toMatch(/^TKT-[0-9A-F]{12}$/);
                expect(verifyTicket(item.qrCode!, item.id)).toBe(true);
            }

            const payment = await prisma.payment.findUnique({
                where: { id: body.data.paymentId },
            });
            expect(payment?.status).toBe('success');
            expect(payment?.rawResponse).not.toBeNull();

            const lockExists = await redis.exists(`seat:lock:${seatIds[0]}`);
            expect(lockExists).toBe(0);
        });

        it('重複的成功回調應該冪等且不改變 paidAt', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);
            const payload = callbackPayload(
                body.data.transactionId,
                'success',
                '1000'
            );

            await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload,
            });

            const first = await prisma.order.findUnique({
                where: { id: orderId },
            });

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload,
            });

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).data.duplicated).toBe(true);

            const second = await prisma.order.findUnique({
                where: { id: orderId },
            });
            expect(second?.paidAt?.toISOString()).toBe(
                first?.paidAt?.toISOString()
            );
        });

        it('失敗回調應該把付款標記 failed 且訂單維持 pending', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'failed',
                    '1000'
                ),
            });

            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body).data.paymentStatus).toBe('failed');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
            });
            expect(order?.status).toBe('pending');

            const payment = await prisma.payment.findUnique({
                where: { id: body.data.paymentId },
            });
            expect(payment?.status).toBe('failed');
        });

        it('付款失敗後應該能重新建立付款', async () => {
            const orderId = await createPendingOrder();
            const first = await createPayment(orderId);

            await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    first.body.data.transactionId,
                    'failed',
                    '1000'
                ),
            });

            const second = await createPayment(orderId);

            expect(second.res.statusCode).toBe(201);
            expect(second.body.data.paymentId).not.toBe(
                first.body.data.paymentId
            );
        });

        it('訂單已逾期才收到成功回調時，付款應標記 failed 並回 410', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            await prisma.order.update({
                where: { id: orderId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'success',
                    '1000'
                ),
            });

            expect(res.statusCode).toBe(410);
            expect(JSON.parse(res.body).code).toBe('ORDER_EXPIRED');

            const payment = await prisma.payment.findUnique({
                where: { id: body.data.paymentId },
            });
            expect(payment?.status).toBe('failed');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
            });
            expect(order?.status).toBe('pending');
        });
    });

    describe('GET /api/payments/:paymentId/status', () => {
        it('應該能查詢自己的付款狀態', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const res = await app.inject({
                method: 'GET',
                url: `/api/payments/${body.data.paymentId}/status`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(res.statusCode).toBe(200);
            const statusBody = JSON.parse(res.body);
            expect(statusBody.data.status).toBe('pending');
            expect(statusBody.data.orderStatus).toBe('pending');
            expect(statusBody.data.amount).toBe('1000');
        });
    });
});
