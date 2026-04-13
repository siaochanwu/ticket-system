import { FastifyInstance } from 'fastify';
import * as eventService from './events.service.js';
import {
    GetEventsQuery,
    EventParams,
    SessionParams,
    TicketTypeParams,
    CreateEventBody,
    CreateSessionBody,
    CreateTicketTypeBody,
    CreateSeatsBody,
} from './events.type.js';

export default async function eventsRoutes(app: FastifyInstance) {
    app.get<{ Querystring: GetEventsQuery }>(
        '/',
        {
            schema: {
                tags: ['events'],
                summary: '取得活動列表',
                description: '取得所有活動的分頁列表',
                querystring: {
                    type: 'object',
                    properties: {
                        page: { type: 'integer', minimum: 1, default: 1, description: '頁碼' },
                        limit: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 50,
                            default: 10,
                            description: '每頁數量',
                        },
                        status: { type: 'string', description: '活動狀態（draft, published, ended）' },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await eventService.getEvents(request.query);

            reply.send({
                success: true,
                ...result,
            });
        }
    );

    app.get<{ Params: EventParams }>(
        '/:id',
        {
            schema: {
                tags: ['events'],
                summary: '取得活動詳情',
                description: '根據 ID 取得單一活動的詳細資訊',
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'integer', description: '活動 ID' },
                    },
                },
            },
        },
        async (request, reply) => {
            const event = await eventService.getEventById(request.params.id);

            reply.send({
                success: true,
                data: event,
            });
        }
    );

    app.get<{ Params: SessionParams }>(
        '/sessions/:sessionId',
        {
            schema: {
                tags: ['events'],
                summary: '取得場次詳情',
                description: '根據 ID 取得單一場次的詳細資訊',
                params: {
                    type: 'object',
                    required: ['sessionId'],
                    properties: {
                        sessionId: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const session = await eventService.getSessionById(
                request.params.sessionId
            );

            reply.send({
                success: true,
                data: session,
            });
        }
    );

    app.get<{ Params: SessionParams }>(
        '/sessions/:sessionId/seats',
        {
            schema: {
                tags: ['events'],
                summary: '取得場次座位',
                description: '根據 ID 取得單一場次的座位資訊',
                params: {
                    type: 'object',
                    required: ['sessionId'],
                    properties: {
                        sessionId: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const seats = await eventService.getSeatMap(
                request.params.sessionId
            );

            reply.send({
                success: true,
                data: seats,
            });
        }
    );

    app.get<{ Params: SessionParams }>(
        '/sessions/:sessionId/availability',
        {
            schema: {
                tags: ['events'],
                summary: '取得單一場次每個票種的剩餘數量',
                description: '根據 ID 取得單一場次的每個票種的剩餘數量',
                params: {
                    type: 'object',
                    required: ['sessionId'],
                    properties: {
                        sessionId: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const availability = await eventService.getAvailability(
                request.params.sessionId
            );

            reply.send({
                success: true,
                data: availability,
            });
        }
    );

    // 管理員 API（需要管理員權限）
    // 建立活動
    app.post<{ Body: CreateEventBody }>(
        '/',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '建立活動',
                description: '建立新的活動',
                security: [{ Bearer: [] }],
                body: {
                    type: 'object',
                    required: ['title', 'saleStartAt', 'venue'],
                    properties: {
                        title: { type: 'string', minLength: 1 },
                        description: { type: 'string' },
                        venue: { type: 'string' },
                        coverImage: { type: 'string' },
                        saleStartAt: { type: 'string', format: 'date-time' },
                        saleEndAt: { type: 'string', format: 'date-time' },
                        status: {
                            type: 'string',
                            enum: ['draft', 'published', 'ended'],
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const event = await eventService.createEvent(request.body);

            reply.status(201).send({
                success: true,
                data: event,
            });
        }
    );

    // 更新活動
    app.put<{ Params: EventParams; Body: Partial<CreateEventBody> }>(
        '/:id',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '更新活動',
                description: '更新指定的活動',
                security: [{ Bearer: [] }],
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const event = await eventService.updateEvent(
                request.params.id,
                request.body
            );

            reply.send({
                success: true,
                data: event,
            });
        }
    );

    // 刪除活動
    app.delete<{ Params: EventParams }>(
        '/:id',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '刪除活動',
                description: '刪除指定的活動',
                security: [{ Bearer: [] }],
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await eventService.deleteEvent(request.params.id);
            reply.send({
                success: true,
            });
        }
    );

    // 建立場次
    app.post<{ Params: EventParams; Body: CreateSessionBody }>(
        '/:id/sessions',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '建立場次',
                description: '建立新的場次',
                security: [{ Bearer: [] }],
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                        id: { type: 'integer' },
                    }
                },
                body: {
                    type: 'object',
                    required: ['sessionDate', 'sessionTime'],
                    properties: {
                        sessionDate: { type: 'string', format: 'date' },
                        sessionTime: { type: 'string' },
                        status: { type: 'string' },
                    },
                },
            },
        },
        async (request, reply) => {
            const session = await eventService.createSession({
                eventId: request.params.id,
                ...request.body,
            });

            reply.status(201).send({
                success: true,
                data: session,
            });
        }
    );

    // 建立票種
    app.post<{ Params: SessionParams; Body: CreateTicketTypeBody }>(
        '/sessions/:sessionId/ticket-types',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '建立票種',
                description: '建立新的票種',
                security: [{ Bearer: [] }],
                params: {
                    type: 'object',
                    required: ['sessionId'],
                    properties: {
                        sessionId: { type: 'integer' },
                    }
                },
                body: {
                    type: 'object',
                    required: ['name', 'price', 'totalQuantity'],
                    properties: {
                        name: { type: 'string', minLength: 1 },
                        price: { type: 'number', minimum: 0 },
                        totalQuantity: { type: 'integer', minimum: 1 },
                        maxPerOrder: {
                            type: 'integer',
                            minimum: 1,
                            default: 4,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const ticketType = await eventService.createTicketType({
                sessionId: request.params.sessionId,
                ...request.body,
            });

            reply.status(201).send({
                success: true,
                data: ticketType,
            });
        }
    );

    // 批次建立座位
    app.post<{ Params: TicketTypeParams; Body: CreateSeatsBody }>(
        '/ticket-types/:ticketTypeId/seats',
        {
            onRequest: [app.authenticateAdmin],
            schema: {
                tags: ['events'],
                summary: '批次建立座位',
                description: '批次建立座位',
                security: [{ Bearer: [] }],
                params: {
                    type: 'object',
                    required: ['ticketTypeId'],
                    properties: {
                        ticketTypeId: { type: 'integer' },
                    }
                },
                body: {
                    type: 'object',
                    required: ['rows'],
                    properties: {
                        rows: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['rowName', 'seatCount'],
                                properties: {
                                    rowName: { type: 'string', minLength: 1 },
                                    seatCount: { type: 'integer', minimum: 1 },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await eventService.createSeats({
                ticketTypeId: request.params.ticketTypeId,
                ...request.body,
            });

            reply.status(201).send({
                success: true,
                data: result,
            });
        }
    );
}
