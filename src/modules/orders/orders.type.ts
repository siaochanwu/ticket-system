export interface CreateOrderInput {
    userId: string;
    lockId: string;
    paymentMethod?: string;
}

export interface OrderResponse {
    id: string;
    orderNo: string;
    status: string;
    totalAmount: string;
    expiresAt: Date;
    items: {
        id: number;
        seat: {
            rowName: string;
            seatNumber: string;
        };
        ticketType: {
            name: string;
        };
        price: string;
    }[];
}

export type OrdersResponse = OrderResponse[];


