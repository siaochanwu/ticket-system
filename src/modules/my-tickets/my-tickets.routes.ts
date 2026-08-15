import { FastifyInstance } from 'fastify';
import * as myTicketsService from './my-tickets.service.js';
import {
    TicketsResponseSchema,
    TicketResponseSchema,
    TicketParamsSchema,
    TicketQrCodeResponseSchema,
} from './my-tickets.schema.js';

export default async function myTicketsRoutes(app: FastifyInstance) {
    // 我的票券列表
    app.get(
        '/',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['my-tickets'],
                summary: '我的票券',
                description: '取得所有已付款訂單的電子票券',
                security: [{ Bearer: [] }],
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: TicketsResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const tickets = await myTicketsService.getMyTickets(
                request.user.id
            );

            reply.status(200).send({ success: true, data: tickets });
        }
    );

    // 票券詳情
    app.get<{ Params: { ticketId: number } }>(
        '/:ticketId',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['my-tickets'],
                summary: '票券詳情',
                description: '取得單張電子票券的詳細資訊',
                security: [{ Bearer: [] }],
                params: TicketParamsSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: TicketResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const ticket = await myTicketsService.getMyTicketById(
                request.user.id,
                request.params.ticketId
            );

            reply.status(200).send({ success: true, data: ticket });
        }
    );

    // 取得 QR payload（已簽章字串，由前端自行繪製 QR Code）
    app.get<{ Params: { ticketId: number } }>(
        '/:ticketId/qrcode',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['my-tickets'],
                summary: '取得票券 QR 內容',
                description:
                    '回傳已簽章的 QR payload（格式 ticketCode.signature），可離線驗簽防偽造',
                security: [{ Bearer: [] }],
                params: TicketParamsSchema,
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: TicketQrCodeResponseSchema,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const qrcode = await myTicketsService.getTicketQrCode(
                request.user.id,
                request.params.ticketId
            );

            reply.status(200).send({ success: true, data: qrcode });
        }
    );
}
