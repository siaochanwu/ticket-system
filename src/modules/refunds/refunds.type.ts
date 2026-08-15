export interface CreateRefundInput {
    userId: string;
    orderId: string;
    reason?: string;
}

export interface RefundResponse {
    id: string;
    orderId: string;
    orderNo: string;
    userId: string;
    status: string;
    reason: string | null;
    totalAmount: string;
    processedAt: Date | null;
    processedBy: string | null;
    createdAt: Date;
}
