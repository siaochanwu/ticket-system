export const CreatePaymentSchema = {
    type: 'object',
    required: ['orderId'],
    properties: {
        orderId: { type: 'string', format: 'uuid', description: '訂單 ID' },
        paymentMethod: { type: 'string', description: '付款方式' },
    },
};

export const CreatePaymentResponseSchema = {
    type: 'object',
    properties: {
        paymentId: { type: 'string' },
        transactionId: { type: 'string' },
        amount: { type: 'string' },
        paymentUrl: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
    },
};

export const CallbackSchema = {
    type: 'object',
    required: ['transactionId', 'status', 'amount', 'signature'],
    properties: {
        transactionId: { type: 'string', description: '金流交易序號' },
        status: {
            type: 'string',
            enum: ['success', 'failed'],
            description: '付款結果',
        },
        amount: { type: 'string', description: '付款金額' },
        signature: {
            type: 'string',
            description: 'HMAC-SHA256(transactionId|status|amount)',
        },
    },
};

export const CallbackResponseSchema = {
    type: 'object',
    properties: {
        duplicated: { type: 'boolean' },
        orderStatus: { type: 'string' },
        paymentStatus: { type: 'string' },
    },
};

export const PaymentStatusParamsSchema = {
    type: 'object',
    required: ['paymentId'],
    properties: {
        paymentId: { type: 'string', format: 'uuid' },
    },
};

export const PaymentStatusResponseSchema = {
    type: 'object',
    properties: {
        paymentId: { type: 'string' },
        transactionId: { type: 'string' },
        status: { type: 'string' },
        amount: { type: 'string' },
        orderNo: { type: 'string' },
        orderStatus: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
    },
};
