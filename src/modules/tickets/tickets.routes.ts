import { FastifyInstance } from 'fastify';
import * as ticketsService from './tickets.service.js';
import { LockSeatsBody, AutoSelectBody, UnlockParams } from './tickets.type.js';
import { request } from 'http';

export default async function ticketsRoutes(app: FastifyInstance) {
    // 鎖定座位
    app.post<{ Body: LockSeatsBody }>(
        '/lock',
        {
            onRequest: [app.authenticate],
            schema: {
                body: {
                    type: 'object',
                    required: ['sessionId', 'seatIds'],
                    properties: {
                        sessionId: { type: 'integer' },
                        seatIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            minItems: 1,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await ticketsService.lockSeats({
                userId: request.user.id,
                sessionId: request.body.sessionId,
                seatIds: request.body.seatIds,
            });

            reply.send({
                success: true,
                message: '鎖定成功',
                data: result,
            });
        }
    );

    // 自動選位
    app.post<{ Body: AutoSelectBody }>(
        '/auto-select',
        {
            onRequest: [app.authenticate],
            schema: {
                body: {
                    type: 'object',
                    required: ['sessionId', 'ticketTypeId', 'quantity'],
                    properties: {
                        sessionId: { type: 'integer' },
                        ticketTypeId: { type: 'integer' },
                        quantity: { type: 'integer', minimum: 1, maximum: 10 },
                    },
                },
            },
        },
        async (request, reply) => {
            const result = await ticketsService.autoSelect({
                userId: request.user.id,
                sessionId: request.body.sessionId,
                ticketTypeId: request.body.ticketTypeId,
                quantity: request.body.quantity,
            });

            reply.send({
                success: true,
                message: '自動選位成功',
                data: result,
            });
        }
    );

    // 釋放座位
    app.delete<{ Params: UnlockParams }>(
        '/lock/:lockId',
        {
            onRequest: [app.authenticate],
            schema: {
                params: {
                    type: 'object',
                    required: ['lockId'],
                    properties: {
                        lockId: { type: 'string' },
                    },
                },
            },
        },
        async (request, reply) => {
            await ticketsService.unlockSeats({
                userId: request.user.id,
                lockId: request.params.lockId,
            });

            reply.send({
                success: true,
                message: '座位已釋放',
            });
        }
    );

    // 取得我的鎖定座位
    app.get(
        '/my-locks',
        {
            onRequest: [app.authenticate],
        },
        async (request, reply) => {
            const locks = await ticketsService.getUserLocks(request.user.id);

            reply.send({
                success: true,
                data: locks,
            });
        }
    );
}
