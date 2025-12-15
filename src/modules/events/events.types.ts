export interface GetEventOptions {
    page?: number;
    limit?: number;
    status?: string;
}

export interface CreateEventInput {
    title: string;
    description?: string;
    venue?: string;
    coverImage?: string;
    saleStartAt: Date;
    saleEndAt?: Date;
    status?: string;
}

export interface UpdateEventInput {
    title?: string;
    description?: string;
    venue?: string;
    coverImage?: string;
    saleStartAt?: Date;
    saleEndAt?: Date;
    status?: string;
}

export interface CreateSessionInput {
    eventId: number;
    sessionDate: Date;
    sessionTime: string;
    status?: string;
}

export interface CreateTicketTypeInput {
    sessionId: number;
    name: string;
    price: number;
    totalQuantity: number;
    reservedQuantity?: number;
    maxPerOrder?: number;
}

export interface CreateSeatsInput {
    ticketTypeId: number;
    rows: {
        rowName: string;
        seatCount: number;
    }[];
}

// Route 參數和請求
export interface GetEventsQuery {
    page?: number;
    limit?: number;
    status?: string;
}

export interface EventParams {
    id: number;
}

export interface SessionParams {
    sessionId: number;
}

export interface TicketTypeParams {
    ticketTypeId: number;
}

export interface CreateEventBody {
    title: string;
    description?: string;
    venue?: string;
    coverImage?: string;
    saleStartAt: Date;
    saleEndAt?: Date;
    status?: string;
}

export interface CreateSessionBody {
    sessionDate: Date;
    sessionTime: string;
    status?: string;
}

export interface CreateTicketTypeBody {
    name: string;
    price: number;
    totalQuantity: number;
    reservedQuantity?: number;
    maxPerOrder?: number;
}

export interface CreateSeatsBody {
    rows: {
        rowName: string;
        seatCount: number;
    }[];
}
