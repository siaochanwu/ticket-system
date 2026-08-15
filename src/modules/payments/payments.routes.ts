import { FastifyInstance } from 'fastify';
import * as paymentsService from './payments.service.js';
import { CallbackInput } from './payments.type.js';
import {
    CreatePaymentSchema,
    CreatePaymentResponseSchema,
    CallbackSchema,
    CallbackResponseSchema,
    PaymentStatusParamsSchema,
    PaymentStatusResponseSchema,
} from './payments.schema.js';

export default async function paymentsRoutes(app: FastifyInstance) {
    // 建立付款
    app.post<{ Body: { orderId: string; paymentMethod?: string } }>(
        '/',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['payments'],
                summary: '建立付款',
                description:
                    '為 pending 訂單建立付款單並取得 mock 金流付款連結。同一訂單重複呼叫會回傳同一筆付款。',
                security: [{ Bearer: [] }],
                body: CreatePaymentSchema,
                response: {
                    201: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: CreatePaymentResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const payment = await paymentsService.createPayment({
                userId: request.user.id,
                orderId: request.body.orderId,
                paymentMethod: request.body.paymentMethod,
            });

            reply.status(201).send({ success: true, data: payment });
        }
    );

    // 金流回調（模擬金流伺服器呼叫，不掛 JWT）
    app.post<{ Body: CallbackInput }>(
        '/callback/mock',
        {
            schema: {
                tags: ['payments'],
                summary: 'mock 金流回調',
                description:
                    '模擬金流伺服器的 webhook。需帶 HMAC 簽章，重複回調具冪等性。',
                body: CallbackSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: CallbackResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await paymentsService.handleCallback(request.body);

            reply.status(200).send({
                success: true,
                data: {
                    duplicated: result.duplicated ?? false,
                    orderStatus: result.orderStatus,
                    paymentStatus: result.paymentStatus,
                },
            });
        }
    );

    // 查詢付款狀態
    app.get<{ Params: { paymentId: string } }>(
        '/:paymentId/status',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['payments'],
                summary: '查詢付款狀態',
                description: '查詢自己訂單的付款狀態',
                security: [{ Bearer: [] }],
                params: PaymentStatusParamsSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: PaymentStatusResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const status = await paymentsService.getPaymentStatus(
                request.user.id,
                request.params.paymentId
            );

            reply.status(200).send({ success: true, data: status });
        }
    );
}
