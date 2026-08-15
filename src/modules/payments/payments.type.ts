export interface CreatePaymentInput {
    userId: string;
    orderId: string;
    paymentMethod?: string;
}

export interface CreatePaymentResponse {
    paymentId: string;
    transactionId: string;
    amount: string;
    paymentUrl: string;
    expiresAt: Date;
}

export interface CallbackInput {
    transactionId: string;
    status: 'success' | 'failed';
    amount: string;
    signature: string;
}

export interface CallbackResponse {
    success: true;
    duplicated?: boolean;
    orderStatus: string;
    paymentStatus: string;
}

export interface PaymentStatusResponse {
    paymentId: string;
    transactionId: string;
    status: string;
    amount: string;
    orderNo: string;
    orderStatus: string;
    createdAt: Date;
    updatedAt: Date;
}
