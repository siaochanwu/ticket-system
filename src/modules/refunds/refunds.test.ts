import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { closeRedis } from '../../config/redis.js';
import { signCallback } from '../payments/payments.signature.js';
import * as refundsService from './refunds.service.js';

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

    // token／orderSeatIds 預設為 userToken／seatIds，其他測試需要「別人」的
    // 已付款訂單時（例如 F2 的 scoping 測試）可以傳入別的使用者與座位
    async function createPaidOrder(
        token: string = userToken,
        orderSeatIds: number[] = seatIds
    ): Promise<string> {
        const lockRes = await app.inject({
            method: 'POST',
            url: '/api/tickets/lock',
            headers: { Authorization: `Bearer ${token}` },
            payload: { sessionId, seatIds: orderSeatIds },
        });
        const lockId = JSON.parse(lockRes.body).data.lockId;

        const orderRes = await app.inject({
            method: 'POST',
            url: '/api/orders',
            headers: { Authorization: `Bearer ${token}` },
            payload: { lockId },
        });
        const orderId = JSON.parse(orderRes.body).data.id;

        const payRes = await app.inject({
            method: 'POST',
            url: '/api/payments',
            headers: { Authorization: `Bearer ${token}` },
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

    // 註冊並登入一個全新的使用者，回傳其 token（用於跨使用者的 scoping 測試）
    async function registerAndLogin(email: string): Promise<string> {
        await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: { email, password: 'password123' },
        });
        const login = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email, password: 'password123' },
        });
        return JSON.parse(login.body).data.token;
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

        it('併發的重複申請只能有一筆成功（DB 的 partial unique index 兜底）', async () => {
            // 這個測試要驗證的正是 read-then-create 之後、真正擋住多餘
            // 申請的 refund_requests partial unique index（否則會全部成功
            // 建立）。兩個實測過的教訓都寫在這裡，避免未來的人重蹈覆轍：
            //
            // 1. 用兩個併發的 `app.inject` POST /api/refunds 無法可靠重現
            //    這個競態——Fastify 那一層的前置開銷（JWT 驗證、schema
            //    驗證、路由）足以讓其中一個請求整個流程（含 create）先跑
            //    完，另一個請求的前置檢查本身就先攔下了，測不到 DB 層的
            //    index 是否存在。改成繞過 HTTP 層直接呼叫 service 兩次
            //    仍然一樣：只有 2 個併發呼叫時，前置檢查依然可靠地贏得
            //    競態（拿掉 index 這個測試仍然維持綠燈，實測過）。
            // 2. 把併發數拉高到 10 個以上，才能可靠地逼出真正的 DB 層
            //    競態：多個呼叫真的會同時通過「沒有既有 pending/approved
            //    申請」的檢查，最後只有一個能贏得 partial unique index、
            //    其餘全部撞上 P2002。已實測驗證：拿掉 index 時 20 個併發
            //    呼叫會全部成功（20 筆重複資料）；index 存在時剛好 1 個
            //    成功、其餘全部被 catch 轉成 REFUND_ALREADY_REQUESTED。
            const orderId = await createPaidOrder();
            const user = await prisma.user.findUniqueOrThrow({
                where: { email: 'refunduser@example.com' },
            });

            const attempt = () =>
                refundsService
                    .createRefundRequest({
                        userId: user.id,
                        orderId,
                        reason: '併發測試',
                    })
                    .then(() => ({ ok: true as const }))
                    .catch((e) => ({ ok: false as const, code: e.code }));

            const concurrency = 10;
            const results = await Promise.all(
                Array.from({ length: concurrency }, () => attempt())
            );

            const oks = results.filter((r) => r.ok);
            const fails = results.filter((r) => !r.ok);
            expect(oks.length).toBe(1);
            expect(fails.length).toBe(concurrency - 1);
            expect(
                fails.every(
                    (f) =>
                        (f as { code: string }).code ===
                        'REFUND_ALREADY_REQUESTED'
                )
            ).toBe(true);

            const rows = await prisma.refundRequest.findMany({
                where: { orderId },
            });
            expect(rows.length).toBe(1);
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
            const { body } = await requestRefund(orderId);
            const ownUserId = body.data.userId;

            // 建立「別人」的已付款訂單與退票申請：如果拿掉
            // getMyRefundRequests 的 where: { userId } 過濾，下面的斷言
            // 會從 1 筆變成 2 筆——沒有這一步，這個測試在只有一筆退票申請
            // 存在的情況下，不論有沒有 scoping 都會通過
            const otherToken = await registerAndLogin(
                'refundscopeother@example.com'
            );
            const ticketType = await prisma.ticketType.findFirstOrThrow({
                where: { sessionId },
            });
            const otherSeat = await prisma.seat.create({
                data: {
                    ticketTypeId: ticketType.id,
                    rowName: 'F',
                    seatNumber: '1',
                },
            });
            const otherOrderId = await createPaidOrder(otherToken, [
                otherSeat.id,
            ]);
            await app.inject({
                method: 'POST',
                url: '/api/refunds',
                headers: { Authorization: `Bearer ${otherToken}` },
                payload: { orderId: otherOrderId, reason: '別人的理由' },
            });

            const res = await app.inject({
                method: 'GET',
                url: '/api/refunds',
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(res.statusCode).toBe(200);
            const list = JSON.parse(res.body).data;
            expect(list.length).toBe(1);
            expect(list[0].orderId).toBe(orderId);
            expect(
                list.every((r: { userId: string }) => r.userId === ownUserId)
            ).toBe(true);
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

        it('兩個併發的核准請求只能有一個成功，另一個回 409（座位與票券只被處理一次）', async () => {
            // 上面「重複核准應該回 409」是循序呼叫，第二次呼叫在進入交易
            // 之前，交易外的讀取就已經看到 status !== 'pending' 了——只測到
            // approveRefund 交易「外」的檢查，測不到交易「內」
            // updateMany({ where: { status: 'pending' } }) 這個原子 claim
            // 本身有沒有真的在擋。這裡改成兩個真正併發的請求，兩者都會
            // 通過交易外的讀取（都看到 pending），只有交易內的 claim
            // 才能分出勝負。
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            const approveOnce = () =>
                app.inject({
                    method: 'POST',
                    url: `/api/admin/refunds/${refundId}/approve`,
                    headers: { Authorization: `Bearer ${adminToken}` },
                });

            const [resA, resB] = await Promise.all([
                approveOnce(),
                approveOnce(),
            ]);

            const statusCodes = [resA.statusCode, resB.statusCode].sort();
            expect(statusCodes).toEqual([200, 409]);

            const loser = resA.statusCode === 409 ? resA : resB;
            expect(JSON.parse(loser.body).code).toBe(
                'REFUND_ALREADY_PROCESSED'
            );

            // 訂單轉 refunded、座位釋放、票券作廢都只發生一次（不是被
            // 兩個併發的贏家/輸家各自重複套用）
            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('refunded');
            expect(order!.items[0].ticketCode).toBeNull();

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('available');

            const refund = await prisma.refundRequest.findUnique({
                where: { id: refundId },
            });
            expect(refund?.status).toBe('approved');
        });

        it('核准當下訂單若已不是 paid（狀態在核准前被改變），應該回 400 且整批 rollback', async () => {
            // approveRefund 交易外的讀取只確認「退票申請本身是 pending」，
            // 完全不會檢查訂單狀態——guard 2（tx.order.updateMany 的
            // where: { status: 'paid' }）是唯一會檢查這件事的地方。這裡
            // 直接繞過正常流程竄改訂單狀態，製造「退票申請仍是 pending，
            // 但訂單已經不是 paid」的分歧，藉此單獨驗證 guard 2。
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            await prisma.order.update({
                where: { id: orderId },
                data: { status: 'cancelled' },
            });

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/refunds/${refundId}/approve`,
                headers: { Authorization: `Bearer ${adminToken}` },
            });

            expect(res.statusCode).toBe(400);
            expect(JSON.parse(res.body).code).toBe('ORDER_NOT_PAID');

            // 整批 rollback：退票申請維持 pending、座位維持 sold、票券保留
            const refund = await prisma.refundRequest.findUnique({
                where: { id: refundId },
            });
            expect(refund?.status).toBe('pending');

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('sold');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('cancelled');
            expect(order!.items[0].ticketCode).not.toBeNull();
        });

        it('核准當下座位若已不是 sold（狀態在核准前被改變），應該回 409 且整批 rollback', async () => {
            // 同上，但這次讓「訂單仍是 paid、退票申請仍是 pending」，
            // 只竄改座位狀態——approveRefund 交易外的讀取完全不會檢查
            // 座位狀態，guard 3（tx.seat.updateMany 的 where: { status: 'sold' }）
            // 是唯一會檢查這件事的地方。
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;

            await prisma.seat.update({
                where: { id: seatIds[0] },
                data: { status: 'locked', lockedBy: 'someone-else' },
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

            // 整批 rollback：退票申請維持 pending、訂單維持 paid、票券保留、
            // 座位維持我們竄改後的狀態（沒有被 approve 覆寫掉）
            const refund = await prisma.refundRequest.findUnique({
                where: { id: refundId },
            });
            expect(refund?.status).toBe('pending');

            const order = await prisma.order.findUnique({
                where: { id: orderId },
                include: { items: true },
            });
            expect(order?.status).toBe('paid');
            expect(order!.items[0].ticketCode).not.toBeNull();

            const seat = await prisma.seat.findUnique({
                where: { id: seatIds[0] },
            });
            expect(seat?.status).toBe('locked');
            expect(seat?.lockedBy).toBe('someone-else');
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

        it('併發的拒絕請求只能有一個成功，理由只會被附加一次', async () => {
            // 跟核准的 guard 1 同一個理由：rejectRefund 交易外的讀取跟
            // updateMany({ where: { status: 'pending' } }) 檢查的是同一個
            // 欄位。實測過：只用兩個併發的 `app.inject` POST
            // .../reject 無法可靠重現這個競態——原因跟 F1 的教訓一樣，
            // 交易外的前置讀取可靠地贏得競態，測不到 updateMany 本身有沒有
            // 在擋（拿掉這個 guard，兩個併發的 HTTP 呼叫測試仍然維持
            // 綠燈，實測過）。改成繞過 HTTP 層、把併發數拉高到 10 個
            // 直接呼叫 service，才能可靠地逼出真正的競態。
            const orderId = await createPaidOrder();
            const { body } = await requestRefund(orderId);
            const refundId = body.data.id;
            const adminUser = await prisma.user.findUniqueOrThrow({
                where: { email: 'refundadmin@example.com' },
            });

            const rejectOnce = (reason: string) =>
                refundsService
                    .rejectRefund(adminUser.id, refundId, reason)
                    .then((r) => ({ ok: true as const, data: r }))
                    .catch((e) => ({ ok: false as const, code: e.code }));

            const concurrency = 10;
            const results = await Promise.all(
                Array.from({ length: concurrency }, (_, i) =>
                    rejectOnce(`理由${i}`)
                )
            );

            const oks = results.filter((r) => r.ok);
            const fails = results.filter((r) => !r.ok);
            expect(oks.length).toBe(1);
            expect(fails.length).toBe(concurrency - 1);
            expect(
                fails.every(
                    (f) =>
                        (f as { code: string }).code ===
                        'REFUND_ALREADY_PROCESSED'
                )
            ).toBe(true);

            const refund = await prisma.refundRequest.findUnique({
                where: { id: refundId },
            });
            expect(refund?.status).toBe('rejected');

            // 只有贏家的理由被附加一次：不會兩個理由都寫進去，
            // 也不會因為兩次寫入而被附加兩次
            const winnerReason = (
                oks[0] as { data: { reason: string | null } }
            ).data.reason;
            expect(refund?.reason).toBe(winnerReason);
            expect(
                (refund?.reason?.match(/\[審核備註\]/g) ?? []).length
            ).toBe(1);
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

            // 核准後：同一張票券的 QR code 端點必須失敗。注意
            // getTicketQrCode 的判斷式是「訂單不是 paid *或* ticketCode/
            // qrCode 缺失」的 OR 條件，所以光是這一個斷言無法單獨證明
            // 是「票券被作廢」造成失敗，也可能只是「訂單狀態被改變」
            // 造成失敗——下面的 isolation 步驟才會真正拆解這兩者。
            const afterRes = await app.inject({
                method: 'GET',
                url: `/api/my-tickets/${ticketId}/qrcode`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(afterRes.statusCode).toBe(400);
            expect(JSON.parse(afterRes.body).code).toBe('ORDER_NOT_PAID');

            // Isolation：把訂單狀態直接改回 paid（繞過正常流程），
            // 讓 OR 條件的第一個 disjunct（order.status !== 'paid'）不成立。
            // 這時 ticketCode/qrCode 仍然是 null（approve 核准時已作廢），
            // 如果端點還是失敗，唯一可能的原因就是票券真的被作廢、而不是
            // 端點重新推導出一組「看起來一樣」的簽章 payload——這正是
            // verifyTicket 的決定性在整個分支裡唯一能被隔離驗證的地方。
            await prisma.order.update({
                where: { id: orderId },
                data: { status: 'paid' },
            });

            const isolatedRes = await app.inject({
                method: 'GET',
                url: `/api/my-tickets/${ticketId}/qrcode`,
                headers: { Authorization: `Bearer ${userToken}` },
            });

            expect(isolatedRes.statusCode).toBe(400);
            expect(JSON.parse(isolatedRes.body).code).toBe('ORDER_NOT_PAID');
        });
    });
});
