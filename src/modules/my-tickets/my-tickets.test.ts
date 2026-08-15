import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import { signCallback } from '../payments/payments.signature.js';
import { verifyTicket } from '../../utils/ticketCode.js';

describe('My Tickets Module', () => {
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
                email: 'ticketowner@example.com',
                password: 'password123',
            },
        });

        const loginRes = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'ticketowner@example.com',
                password: 'password123',
            },
        });
        userToken = JSON.parse(loginRes.body).data.token;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.user.deleteMany({
            where: { email: { contains: 'ticketowner' } },
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
                title: 'Ticket Test Event',
                venue: 'Taipei Arena',
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
                name: 'VIP',
                price: 3000,
                totalQuantity: 100,
            },
        });

        const seat = await prisma.seat.create({
            data: {
                ticketTypeId: ticketType.id,
                rowName: 'D',
                seatNumber: '5',
            },
        });
        seatIds = [seat.id];
    });

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

    // 走完整流程直到訂單付款成功
    async function createPaidOrder(): Promise<string> {
        const orderId = await createPendingOrder();

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

    it('未付款訂單的票券不應該出現在列表', async () => {
        await createPendingOrder();

        const res = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data).toEqual([]);
    });

    it('付款後列表應該含完整活動、場次與座位資訊', async () => {
        await createPaidOrder();

        const res = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });

        expect(res.statusCode).toBe(200);
        const tickets = JSON.parse(res.body).data;
        expect(tickets.length).toBe(1);
        expect(tickets[0].ticketCode).toMatch(/^TKT-[0-9A-F]{12}$/);
        expect(tickets[0].event.title).toBe('Ticket Test Event');
        expect(tickets[0].event.venue).toBe('Taipei Arena');
        expect(tickets[0].session.sessionTime).toBe('20:00');
        expect(tickets[0].seat.rowName).toBe('D');
        expect(tickets[0].seat.seatNumber).toBe('5');
        expect(tickets[0].ticketType.name).toBe('VIP');
        expect(tickets[0].price).toBe('3000');
    });

    it('應該能取得單張票券詳情', async () => {
        await createPaidOrder();

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const ticketId = JSON.parse(listRes.body).data[0].ticketId;

        const res = await app.inject({
            method: 'GET',
            url: `/api/my-tickets/${ticketId}`,
            headers: { Authorization: `Bearer ${userToken}` },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data.ticketId).toBe(ticketId);
    });

    it('他人的票券應該回 404', async () => {
        await createPaidOrder();

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const ticketId = JSON.parse(listRes.body).data[0].ticketId;

        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'ticketowner2@example.com',
                password: 'password123',
            },
        });
        const login = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'ticketowner2@example.com',
                password: 'password123',
            },
        });
        const otherToken = JSON.parse(login.body).data.token;

        const res = await app.inject({
            method: 'GET',
            url: `/api/my-tickets/${ticketId}`,
            headers: { Authorization: `Bearer ${otherToken}` },
        });

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body).code).toBe('TICKET_NOT_FOUND');
    });

    it('他人已付款的票券不應該出現在自己的列表中', async () => {
        // 先讓 userToken 擁有一張已付款票券，確保資料庫裡真的存在
        // 「別人的票」——否則拿掉 ownership 過濾條件也不會被抓到。
        await createPaidOrder();

        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'ticketowner3@example.com',
                password: 'password123',
            },
        });
        const login = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'ticketowner3@example.com',
                password: 'password123',
            },
        });
        const otherToken = JSON.parse(login.body).data.token;

        const res = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${otherToken}` },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data).toEqual([]);
    });

    it('他人票券的 qrcode 端點應該回 404 而不是回傳簽章內容', async () => {
        // 同樣先確保資料庫裡有一張「別人的」已付款票券（含 ticketCode/qrCode），
        // 這樣如果 ownership 過濾被拿掉，這張票的簽章就會外洩給別人。
        await createPaidOrder();

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const ticketId = JSON.parse(listRes.body).data[0].ticketId;

        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
                email: 'ticketowner4@example.com',
                password: 'password123',
            },
        });
        const login = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                email: 'ticketowner4@example.com',
                password: 'password123',
            },
        });
        const otherToken = JSON.parse(login.body).data.token;

        const res = await app.inject({
            method: 'GET',
            url: `/api/my-tickets/${ticketId}/qrcode`,
            headers: { Authorization: `Bearer ${otherToken}` },
        });

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body).code).toBe('TICKET_NOT_FOUND');
    });

    it('qrcode 端點回傳的簽章應該可驗證通過，且內容與資料庫儲存值一致', async () => {
        await createPaidOrder();

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const ticketId = JSON.parse(listRes.body).data[0].ticketId;

        const res = await app.inject({
            method: 'GET',
            url: `/api/my-tickets/${ticketId}/qrcode`,
            headers: { Authorization: `Bearer ${userToken}` },
        });

        expect(res.statusCode).toBe(200);
        const { ticketCode, qrPayload } = JSON.parse(res.body).data;
        expect(qrPayload.startsWith(`${ticketCode}.`)).toBe(true);
        expect(verifyTicket(qrPayload, ticketId)).toBe(true);

        // 只驗 verifyTicket 不夠：verifyTicket 只證明 payload 自洽，
        // 無法證明它就是「目前這張票」被發出的那組碼（例如退票作廢後
        // 若程式碼改成當場重簽，verifyTicket 一樣會回 true）。
        // 因此這裡額外比對資料庫實際持久化的 ticketCode / qrCode，
        // 確保端點回傳的是「已核發並儲存」的那組值，而非臨時簽出的。
        const stored = await prisma.orderItem.findUniqueOrThrow({
            where: { id: ticketId },
        });
        expect(stored.ticketCode).toBe(ticketCode);
        expect(stored.qrCode).toBe(qrPayload);
    });

    it('篡改過的 QR payload 應該驗證失敗', async () => {
        await createPaidOrder();

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/my-tickets',
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const ticketId = JSON.parse(listRes.body).data[0].ticketId;

        const res = await app.inject({
            method: 'GET',
            url: `/api/my-tickets/${ticketId}/qrcode`,
            headers: { Authorization: `Bearer ${userToken}` },
        });
        const { qrPayload } = JSON.parse(res.body).data;

        const [code, signature] = qrPayload.split('.');
        const tampered = `${code.replace(/.$/, 'X')}.${signature}`;

        expect(verifyTicket(tampered, ticketId)).toBe(false);
    });
});
