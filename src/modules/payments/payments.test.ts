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

        it('已付款完成的訂單不應該能再建立付款', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'success',
                    '1000'
                ),
            });

            const { res } = await createPayment(orderId);

            expect(res.statusCode).toBe(409);
            expect(JSON.parse(res.body).code).toBe('ORDER_ALREADY_PAID');
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

        it('正確長度但錯誤的簽章應該回 401（確保真的有跑 timingSafeEqual 比較，不只是長度早退）', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            const good = signCallback(body.data.transactionId, 'success', '1000');
            // 長度不變，只改最後一個字元，確保會進到 timingSafeEqual 那一行
            const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: {
                    transactionId: body.data.transactionId,
                    status: 'success',
                    amount: '1000',
                    signature: bad,
                },
            });

            expect(res.statusCode).toBe(401);
            expect(JSON.parse(res.body).code).toBe('INVALID_SIGNATURE');
        });

        it('簽章綁定的欄位被竄改應該回 401（證明簽章真的綁定了 status／amount）', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            // 用 amount='1' 算出來的合法簽章，套用在 amount='1000' 的 body 上
            const signatureForDifferentAmount = signCallback(
                body.data.transactionId,
                'success',
                '1'
            );

            const res = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: {
                    transactionId: body.data.transactionId,
                    status: 'success',
                    amount: '1000',
                    signature: signatureForDifferentAmount,
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
                include: { items: true },
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
                include: { items: true },
            });
            expect(second?.paidAt?.toISOString()).toBe(
                first?.paidAt?.toISOString()
            );

            // 重複套用最貴的副作用是重新簽發票券：確保每個 orderItem 的
            // ticketCode／qrCode 在兩次回調之間完全沒變，而不是恰巧簽出
            // 同一組值
            const firstCodes = first!.items
                .map((item) => `${item.id}:${item.ticketCode}:${item.qrCode}`)
                .sort();
            const secondCodes = second!.items
                .map((item) => `${item.id}:${item.ticketCode}:${item.qrCode}`)
                .sort();
            expect(secondCodes).toEqual(firstCodes);
        });

        it('併發抵達的相同成功回調應該只有一個真正套用，另一個走冪等路徑（不重複簽發票券）', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);
            const payload = callbackPayload(
                body.data.transactionId,
                'success',
                '1000'
            );

            const [resA, resB] = await Promise.all([
                app.inject({
                    method: 'POST',
                    url: '/api/payments/callback/mock',
                    payload,
                }),
                app.inject({
                    method: 'POST',
                    url: '/api/payments/callback/mock',
                    payload,
                }),
            ]);

            expect(resA.statusCode).toBe(200);
            expect(resB.statusCode).toBe(200);

            const duplicatedFlags = [resA, resB].map(
                (r) => JSON.parse(r.body).data.duplicated
            );
            // 兩個併發回調剛好一個是真正套用（false）、一個是冪等重放（true）：
            // 若原子 claim 失效，兩個都可能是 false，各自重新簽發一次票券
            expect(duplicatedFlags.filter((d) => d === false)).toHaveLength(1);
            expect(duplicatedFlags.filter((d) => d === true)).toHaveLength(1);

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('paid');

            for (const item of order!.items) {
                expect(item.ticketCode).toMatch(/^TKT-[0-9A-F]{12}$/);
                expect(verifyTicket(item.qrCode!, item.id)).toBe(true);
            }

            const payment = await prisma.payment.findUnique({
                where: { id: body.data.paymentId },
            });
            expect(payment?.status).toBe('success');
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

        it('已取消的訂單收到成功回調時，付款應標記 failed 並回 410', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            await app.inject({
                method: 'POST',
                url: `/api/orders/${orderId}/cancel`,
                headers: { Authorization: `Bearer ${userToken}` },
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
            expect(order?.status).toBe('cancelled');
        });

        it('訂單已被另一筆付款完成時，另一筆付款收到成功回調應標記 failed 並回 409', async () => {
            const orderId = await createPendingOrder();
            const paymentA = await createPayment(orderId);

            const resA = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    paymentA.body.data.transactionId,
                    'success',
                    '1000'
                ),
            });
            expect(resA.statusCode).toBe(200);

            // 訂單付款完成之後才直接寫入另一筆孤兒 pending 付款（例如舊版
            // createPayment 沒有防併發保護時留下的紀錄）。此時 payment A
            // 已經轉成 success，partial unique index
            // （payments_order_id_pending_key：同一訂單同時只能有一筆
            // pending 付款）不會擋下這筆 insert。
            const paymentB = await prisma.payment.create({
                data: {
                    orderId,
                    paymentMethod: 'mock',
                    transactionId: `MOCK-TEST-ORPHAN-${Date.now()}`,
                    amount: 1000,
                    status: 'pending',
                },
            });

            const resB = await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    paymentB.transactionId!,
                    'success',
                    '1000'
                ),
            });

            expect(resB.statusCode).toBe(409);
            expect(JSON.parse(resB.body).code).toBe('ORDER_ALREADY_PAID');

            const updatedB = await prisma.payment.findUnique({
                where: { id: paymentB.id },
            });
            expect(updatedB?.status).toBe('failed');
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

        it('查詢別人的付款狀態應該回 404', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'payuser3@example.com',
                    password: 'password123',
                },
            });
            const login = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'payuser3@example.com',
                    password: 'password123',
                },
            });
            const otherToken = JSON.parse(login.body).data.token;

            const res = await app.inject({
                method: 'GET',
                url: `/api/payments/${body.data.paymentId}/status`,
                headers: { Authorization: `Bearer ${otherToken}` },
            });

            expect(res.statusCode).toBe(404);
            expect(JSON.parse(res.body).code).toBe('PAYMENT_NOT_FOUND');

            await prisma.user.deleteMany({
                where: { email: 'payuser3@example.com' },
            });
        });
    });

    describe('verifyTicket 的否定案例', () => {
        it('不同的 orderItemId 或被竄改的 payload 都不應該通過驗證', async () => {
            const orderId = await createPendingOrder();
            const { body } = await createPayment(orderId);

            await app.inject({
                method: 'POST',
                url: '/api/payments/callback/mock',
                payload: callbackPayload(
                    body.data.transactionId,
                    'success',
                    '1000'
                ),
            });

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            const item = order!.items[0];

            // 一位使用者的 QR 不應該通過另一張票（不同 orderItemId）的驗證
            expect(verifyTicket(item.qrCode!, item.id + 999999)).toBe(false);
            // 竄改過的 payload 不應該通過驗證
            expect(verifyTicket(`${item.qrCode!}tampered`, item.id)).toBe(
                false
            );
        });
    });
});
