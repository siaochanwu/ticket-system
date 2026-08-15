import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import { Errors } from '../../plugins/errorHandler.js';
import { TicketResponse, TicketQrCodeResponse } from './my-tickets.type.js';

// 查詢已付款票券時共用的 include，確保回應欄位齊全
const ticketInclude = {
    order: {
        include: {
            session: {
                include: {
                    event: true,
                },
            },
        },
    },
    seat: true,
    ticketType: true,
} as const;

type TicketWithRelations = Prisma.OrderItemGetPayload<{
    include: typeof ticketInclude;
}>;

function toTicketResponse(item: TicketWithRelations): TicketResponse {
    return {
        ticketId: item.id,
        ticketCode: item.ticketCode,
        orderNo: item.order.orderNo,
        event: {
            title: item.order.session.event.title,
            venue: item.order.session.event.venue,
        },
        session: {
            sessionDate: item.order.session.sessionDate,
            sessionTime: item.order.session.sessionTime,
        },
        seat: {
            rowName: item.seat.rowName,
            seatNumber: item.seat.seatNumber,
        },
        ticketType: {
            name: item.ticketType.name,
        },
        price: item.price.toString(),
    };
}

export async function getMyTickets(userId: string): Promise<TicketResponse[]> {
    const items = await prisma.orderItem.findMany({
        where: {
            order: { userId, status: 'paid' },
        },
        include: ticketInclude,
        orderBy: { id: 'asc' },
    });

    return items.map(toTicketResponse);
}

export async function getMyTicketById(
    userId: string,
    ticketId: number
): Promise<TicketResponse> {
    const item = await prisma.orderItem.findFirst({
        where: {
            id: ticketId,
            order: { userId, status: 'paid' },
        },
        include: ticketInclude,
    });

    if (!item) {
        throw Errors.TICKET_NOT_FOUND;
    }

    return toTicketResponse(item);
}

export async function getTicketQrCode(
    userId: string,
    ticketId: number
): Promise<TicketQrCodeResponse> {
    const item = await prisma.orderItem.findFirst({
        where: { id: ticketId, order: { userId } },
        include: { order: true },
    });

    if (!item) {
        throw Errors.TICKET_NOT_FOUND;
    }

    // 未付款或退票作廢後票券碼會是 null
    if (item.order.status !== 'paid' || !item.ticketCode || !item.qrCode) {
        throw Errors.ORDER_NOT_PAID;
    }

    return {
        ticketCode: item.ticketCode,
        qrPayload: item.qrCode,
    };
}
