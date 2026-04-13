import prisma from '../../config/database.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import {
    GetEventOptions,
    CreateEventInput,
    UpdateEventInput,
    CreateSessionInput,
    CreateTicketTypeInput,
    CreateSeatsInput,
} from './events.types.js';

// 取得活動列表
export async function getEvents(options: GetEventOptions = {}) {
    const { page = 1, limit = 10, status } = options;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) {
        where.status = status;
    }

    const [events, total] = await Promise.all([
        prisma.event.findMany({
            where,
            skip,
            take: limit,
            orderBy: { saleStartAt: 'asc' },
            include: {
                sessions: {
                    select: {
                        id: true,
                        sessionDate: true,
                        sessionTime: true,
                    },
                    orderBy: { sessionDate: 'asc' },
                },
            },
        }),
        prisma.event.count({
            where,
        }),
    ]);

    return {
        data: events,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

// 取得單一活動詳情
export async function getEventById(eventId: number) {
    const event = await prisma.event.findUnique({
        where: {
            id: eventId,
        },
        include: {
            sessions: {
                include: {
                    ticketTypes: {
                        select: {
                            id: true,
                            name: true,
                            price: true,
                            totalQuantity: true,
                            reservedQuantity: true,
                            maxPerOrder: true,
                        },
                    },
                },
                orderBy: {
                    sessionDate: 'asc',
                },
            },
        },
    });

    if (!event) {
        throw Errors.EVENT_NOT_FOUND;
    }

    return event;
}

// 取得場次詳情
export async function getSessionById(sessionId: number) {
    const session = await prisma.session.findUnique({
        where: {
            id: sessionId,
        },
        include: {
            event: true,
            ticketTypes: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    totalQuantity: true,
                    reservedQuantity: true,
                    maxPerOrder: true,
                },
            },
        },
    });

    if (!session) {
        throw Errors.SESSION_NOT_FOUND;
    }

    return session;
}

// 取得座位圖
export async function getSeatMap(sessionId: number) {
    // 先確認場次存在
    const session = await prisma.session.findUnique({
        where: {
            id: sessionId,
        },
        include: {
            ticketTypes: true,
        },
    });

    if (!session) {
        throw Errors.SESSION_NOT_FOUND;
    }

    // 取得所有座位，按票種分組
    const seats = await prisma.seat.findMany({
        where: {
            ticketType: {
                sessionId: sessionId,
            },
        },
        include: {
            ticketType: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                },
            },
        },
        orderBy: [
            { ticketTypeId: 'asc' },
            { rowName: 'asc' },
            { seatNumber: 'asc' },
        ],
    });

    return {
        sessionId,
        seats,
    };
}

// 取得各票種剩餘數量
export async function getAvailability(sessionId: number) {
    const session = await prisma.session.findUnique({
        where: {
            id: sessionId,
        },
        include: {
            ticketTypes: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    totalQuantity: true,
                    reservedQuantity: true,
                    maxPerOrder: true,
                },
            },
        },
    });

    if (!session) {
        throw Errors.SESSION_NOT_FOUND;
    }

    // 計算每個票種的剩餘數量
    const availability = session.ticketTypes.map((ticketType) => ({
        ticketTypeId: ticketType.id,
        name: ticketType.name,
        price: ticketType.price,
        total: ticketType.totalQuantity,
        reserved: ticketType.reservedQuantity,
        available: ticketType.totalQuantity - ticketType.reservedQuantity,
        maxPerOrder: ticketType.maxPerOrder,
    }));

    return availability;
}

// 建立活動
export async function createEvent(input: CreateEventInput) {
    const event = await prisma.event.create({
        data: {
            title: input.title,
            description: input.description,
            venue: input.venue,
            coverImage: input.coverImage,
            saleStartAt: new Date(input.saleStartAt),
            saleEndAt: input.saleEndAt ? new Date(input.saleEndAt) : null,
            status: input.status || 'draft',
        },
    });

    return event;
}

// 更新活動
export async function updateEvent(eventId: number, input: UpdateEventInput) {
    const existing = await prisma.event.findUnique({
        where: {
            id: eventId,
        },
    });

    if (!existing) {
        throw Errors.EVENT_NOT_FOUND;
    }

    const event = await prisma.event.update({
        where: {
            id: eventId,
        },
        data: {
            ...input,
            saleStartAt: input.saleStartAt
                ? new Date(input.saleStartAt)
                : existing.saleStartAt,
            saleEndAt: input.saleEndAt
                ? new Date(input.saleEndAt)
                : existing.saleEndAt,
        },
    });

    return event;
}

// 刪除活動
export async function deleteEvent(eventId: number) {
    const existing = await prisma.event.findUnique({
        where: {
            id: eventId,
        },
    });

    if (!existing) {
        throw Errors.EVENT_NOT_FOUND;
    }

    await prisma.event.delete({
        where: {
            id: eventId,
        },
    });

    return true;
}

// 建立場次
export async function createSession(input: CreateSessionInput) {
    const event = await prisma.event.findUnique({
        where: {
            id: input.eventId,
        },
    });

    if (!event) {
        throw Errors.EVENT_NOT_FOUND;
    }

    const session = await prisma.session.create({
        data: {
            eventId: input.eventId,
            sessionDate: new Date(input.sessionDate),
            sessionTime: input.sessionTime,
            status: input.status || 'active',
        },
    });

    return session;
}

// 建立票種
export async function createTicketType(input: CreateTicketTypeInput) {
    const session = await prisma.session.findUnique({
        where: {
            id: input.sessionId,
        },
    });

    if (!session) {
        throw Errors.SESSION_NOT_FOUND;
    }

    const ticketType = await prisma.ticketType.create({
        data: {
            sessionId: input.sessionId,
            name: input.name,
            price: input.price,
            totalQuantity: input.totalQuantity,
            reservedQuantity: input.reservedQuantity || 0,
            maxPerOrder: input.maxPerOrder || 4,
        },
    });

    return ticketType;
}

// 批次建立座位
export async function createSeats(input: CreateSeatsInput) {
    return await prisma.$transaction(async (tx) => {
        const ticketType = await tx.ticketType.findUnique({
            where: {
                id: input.ticketTypeId,
            },
        });

        if (!ticketType) {
            throw new AppError('票種不存在', 404, 'TICKET_TYPE_NOT_FOUND');
        }

        const seats = input.rows.flatMap((row) =>
            Array.from({ length: row.seatCount }, (_, i) => ({
                ticketTypeId: input.ticketTypeId,
                rowName: row.rowName,
                seatNumber: (i + 1).toString(),
            }))
        );

        const BATCH_SIZE = 1000;
        for (let i = 0; i < seats.length; i += BATCH_SIZE) {
            const batch = seats.slice(i, i + BATCH_SIZE);
            await tx.seat.createMany({
                data: batch,
            });
        }

        return {
            message: '座位建立成功',
            count: seats.length,
        };
    });
}
