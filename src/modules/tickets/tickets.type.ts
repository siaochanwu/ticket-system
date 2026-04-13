import { Decimal } from "@prisma/client/runtime/library";

export interface LockSeatsInput {
    userId: string;
    sessionId: number;
    seatIds: number[];
}

export interface AutoSelectInput {
    userId: string;
    sessionId: number;
    ticketTypeId: number;
    quantity: number;
}

export interface UnlockSeatsInput {
    userId: string;
    lockId: string;
}

export interface LockResult {
    lockId: string;
    seats: {
        id: number;
        rowName: string;
        seatNumber: string;
        ticketType: {
            id: number;
            name: string;
            price: Decimal;
        };
    }[];
    expiresAt: Date;
}

export interface UserLock {
    lockId: string;
    sessionId: string;
    seats: {
        id: number;
        rowName: string;
        seatNumber: string;
    }[];
    expiresAt: string;
}

export interface LockSeatsBody {
    sessionId: number;
    seatIds: number[];
}

export interface AutoSelectBody {
    sessionId: number;
    ticketTypeId: number;
    quantity: number;
}

export interface UnlockParams {
    lockId: string;
}
