import { FastifyInstance } from "fastify";
import { CreateOrderInput } from "./orders.type.js";
import { createOrder, getOrders, getOrderById, cancelOrder } from "./orders.service.js";
import { CreateOrderSchema, OrderResponse, OrdersResponse, GetOrderByIdParamsSchema, CancelOrderParamsSchema } from "./orders.schema.js";


export default async function ordersRoutes(app: FastifyInstance) {
    app.post<{ Body: CreateOrderInput }>(
        '/',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['orders'],
                summary: '建立訂單',
                description: '建立新的訂單',
                security: [{ Bearer: [] }],
                body: CreateOrderSchema,
                response: {
                    201: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: OrderResponse
                        }
                    }
                }
            },
            handler: async (request, reply) => {
                const { id: userId } = request.user as { id: string };
                const order = await createOrder({
                    ...request.body,
                    userId,
                });
                reply.status(201).send({
                    success: true,
                    data: order,
                });
            },
        }
    )

    app.get('/', {
        onRequest: [app.authenticate],
        schema: {
            tags: ['orders'],
            summary: '取得訂單列表',
            description: '取得登入使用者的所有訂單',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: OrdersResponse
                    }
                }
            }
        },
        handler: async (request, reply) => {
            const { id: userId } = request.user as { id: string };
            const orders = await getOrders(userId);
            reply.status(200).send({
                success: true,
                data: orders,
            });
        },
    })

    app.get('/:orderId', {
        onRequest: [app.authenticate],
        schema: {
            tags: ['orders'],
            summary: '取得訂單詳細資訊',
            description: '取得單一訂單的詳細資訊',
            security: [{ Bearer: [] }],
            params: GetOrderByIdParamsSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: OrderResponse
                    }
                }
            }
        },
        handler: async (request, reply) => {
            const { id: userId } = request.user as { id: string };
            const { orderId } = request.params as { orderId: string };
            const order = await getOrderById(userId, orderId);
            reply.status(200).send({
                success: true,
                data: order,
            });
        },
    })

    app.post('/:orderId/cancel', {
        onRequest: [app.authenticate],
        schema: {
            tags: ['orders'],
            summary: '取消訂單',
            description: '取消訂單並釋放座位',
            security: [{ Bearer: [] }],
            params: CancelOrderParamsSchema,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: OrderResponse
                    }
                }
            }
        },
        handler: async (request, reply) => {
            const { id: userId } = request.user as { id: string };
            const { orderId } = request.params as { orderId: string };
            const order = await cancelOrder(userId, orderId);
            reply.status(200).send({
                success: true,
                data: order,
            });
        },
    })
}