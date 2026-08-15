export interface TicketResponse {
    ticketId: number;
    ticketCode: string | null;
    orderNo: string;
    event: {
        title: string;
        venue: string | null;
    };
    session: {
        sessionDate: Date;
        sessionTime: string;
    };
    seat: {
        rowName: string;
        seatNumber: string;
    };
    ticketType: {
        name: string;
    };
    price: string;
}

export interface TicketQrCodeResponse {
    ticketCode: string;
    qrPayload: string;
}
