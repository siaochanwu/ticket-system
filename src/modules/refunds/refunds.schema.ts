export const CreateRefundSchema = {
    type: 'object',
    required: ['orderId'],
    properties: {
        orderId: { type: 'string', format: 'uuid', description: '訂單 ID' },
        reason: { type: 'string', description: '退票原因' },
    },
};

export const RefundResponseSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        orderId: { type: 'string' },
        orderNo: { type: 'string' },
        userId: { type: 'string' },
        status: { type: 'string' },
        reason: { type: 'string', nullable: true },
        totalAmount: { type: 'string' },
        processedAt: { type: 'string', format: 'date-time', nullable: true },
        processedBy: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
    },
};

export const RefundsResponseSchema = {
    type: 'array',
    items: RefundResponseSchema,
};

export const RefundParamsSchema = {
    type: 'object',
    required: ['refundId'],
    properties: {
        refundId: { type: 'string', format: 'uuid' },
    },
};

export const RejectRefundSchema = {
    type: 'object',
    properties: {
        reason: { type: 'string', description: '拒絕原因（會附加在原申請理由後）' },
    },
};

export const ListRefundsQuerySchema = {
    type: 'object',
    properties: {
        status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected'],
            description: '依狀態篩選',
        },
    },
};
