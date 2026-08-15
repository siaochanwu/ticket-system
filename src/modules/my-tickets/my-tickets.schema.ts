export const TicketResponseSchema = {
    type: 'object',
    properties: {
        ticketId: { type: 'number' },
        ticketCode: { type: 'string', nullable: true },
        orderNo: { type: 'string' },
        event: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                venue: { type: 'string', nullable: true },
            },
        },
        session: {
            type: 'object',
            properties: {
                sessionDate: { type: 'string', format: 'date-time' },
                sessionTime: { type: 'string' },
            },
        },
        seat: {
            type: 'object',
            properties: {
                rowName: { type: 'string' },
                seatNumber: { type: 'string' },
            },
        },
        ticketType: {
            type: 'object',
            properties: {
                name: { type: 'string' },
            },
        },
        price: { type: 'string' },
    },
};

export const TicketsResponseSchema = {
    type: 'array',
    items: TicketResponseSchema,
};

export const TicketParamsSchema = {
    type: 'object',
    required: ['ticketId'],
    properties: {
        ticketId: { type: 'integer' },
    },
};

export const TicketQrCodeResponseSchema = {
    type: 'object',
    properties: {
        ticketCode: { type: 'string' },
        qrPayload: { type: 'string' },
    },
};
