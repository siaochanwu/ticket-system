export const CreateOrderSchema = {
    type: 'object',
    required: ['lockId'],
    properties: {
        lockId: { type: 'string', format: 'uuid' },
        paymentMethod: { type: 'string' }
    }
}

export const OrderResponse = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        orderNo: { type: 'string' },
        status: { type: 'string' },
        totalAmount: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'number' },
                    seat: {
                        type: 'object',
                        properties: {
                            rowName: { type: 'string' },
                            seatNumber: { type: 'string' },
                        }
                    },
                    ticketType: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                        }
                    },
                    price: { type: 'string' }
                }
            }
        }
    }
}

export const OrdersResponse = {
    type: 'array',
    items: OrderResponse
}

export const GetOrderByIdParamsSchema = {
    type: 'object',
    required: ['orderId'],
    properties: {
        orderId: { type: 'string', format: 'uuid' }
    }
}

export const CancelOrderParamsSchema = {
    type: 'object',
    required: ['orderId'],
    properties: {
        orderId: { type: 'string', format: 'uuid' }
    }
}