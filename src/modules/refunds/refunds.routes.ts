import { FastifyInstance } from 'fastify';
import * as refundsService from './refunds.service.js';
import {
    CreateRefundSchema,
    RefundResponseSchema,
    RefundsResponseSchema,
    RefundParamsSchema,
    RejectRefundSchema,
    ListRefundsQuerySchema,
} from './refunds.schema.js';

// 使用者端：/api/refunds
export default async function refundsRoutes(app: FastifyInstance) {
    app.post<{ Body: { orderId: string; reason?: string } }>(
        '/',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['refunds'],
                summary: '申請退票',
                description: '為已付款訂單申請退票，需在退票期限內且無重複申請',
                security: [{ Bearer: [] }],
                body: CreateRefundSchema,
                response: {
                    201: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: RefundResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const refund = await refundsService.createRefundRequest({
                userId: request.user.id,
                orderId: request.body.orderId,
                reason: request.body.reason,
            });

            reply.status(201).send({ success: true, data: refund });
        }
    );

    app.get(
        '/',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['refunds'],
                summary: '我的退票申請',
                description: '取得自己的所有退票申請',
                security: [{ Bearer: [] }],
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: RefundsResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const refunds = await refundsService.getMyRefundRequests(
                request.user.id
            );

            reply.status(200).send({ success: true, data: refunds });
        }
    );
}

// 後台：/api/admin/refunds
export async function adminRefundsRoutes(app: FastifyInstance) {
    app.get<{ Querystring: { status?: string } }>(
        '/',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['admin'],
                summary: '退票申請列表（後台）',
                description: '取得所有退票申請，可依狀態篩選',
                security: [{ Bearer: [] }],
                querystring: ListRefundsQuerySchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: RefundsResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const refunds = await refundsService.listRefundRequests(
                request.query.status
            );

            reply.status(200).send({ success: true, data: refunds });
        }
    );

    app.post<{ Params: { refundId: string } }>(
        '/:refundId/approve',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['admin'],
                summary: '核准退票',
                description:
                    '核准退票申請：訂單轉為 refunded、座位釋放、票券作廢',
                security: [{ Bearer: [] }],
                params: RefundParamsSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: RefundResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const refund = await refundsService.approveRefund(
                request.user.id,
                request.params.refundId
            );

            reply.status(200).send({ success: true, data: refund });
        }
    );

    app.post<{ Params: { refundId: string }; Body: { reason?: string } }>(
        '/:refundId/reject',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['admin'],
                summary: '拒絕退票',
                description: '拒絕退票申請，訂單與票券維持原狀',
                security: [{ Bearer: [] }],
                params: RefundParamsSchema,
                body: RejectRefundSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: RefundResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const refund = await refundsService.rejectRefund(
                request.user.id,
                request.params.refundId,
                request.body?.reason
            );

            reply.status(200).send({ success: true, data: refund });
        }
    );
}
