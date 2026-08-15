import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import redis from '../../config/redis.js';
import config from '../../config/index.js';
import { Errors } from '../../plugins/errorHandler.js';
import { generateTicketCode, signTicket } from '../../utils/ticketCode.js';
import { verifyCallbackSignature } from './payments.signature.js';
import {
    CreatePaymentInput,
    CreatePaymentResponse,
    CallbackInput,
    CallbackResponse,
    PaymentStatusResponse,
} from './payments.type.js';

export async function createPayment(
    input: CreatePaymentInput
): Promise<CreatePaymentResponse> {
    const { userId, orderId, paymentMethod } = input;

    const order = await prisma.order.findFirst({
        where: { id: orderId, userId },
    });

    if (!order) {
        throw Errors.ORDER_NOT_FOUND;
    }

    if (order.status === 'paid') {
        throw Errors.ORDER_ALREADY_PAID;
    }

    if (order.status !== 'pending' || order.expiresAt < new Date()) {
        throw Errors.ORDER_EXPIRED;
    }

    // 冪等：同一訂單已有進行中的付款就回同一筆，避免重複建立
    const existing = await prisma.payment.findFirst({
        where: { orderId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
    });

    const payment =
        existing ??
        (await prisma.payment.create({
            data: {
                orderId,
                paymentMethod: paymentMethod ?? 'mock',
                transactionId: `MOCK-${Date.now()}-${crypto
                    .randomBytes(4)
                    .toString('hex')}`,
                amount: order.totalAmount,
                status: 'pending',
            },
        }));

    return {
        paymentId: payment.id,
        transactionId: payment.transactionId!,
        amount: payment.amount.toString(),
        paymentUrl: `${config.payment.callbackBaseUrl}/mock-pay?transactionId=${payment.transactionId}`,
        expiresAt: order.expiresAt,
    };
}

export async function handleCallback(
    input: CallbackInput
): Promise<CallbackResponse> {
    const { transactionId, status, amount, signature } = input;

    if (!verifyCallbackSignature(transactionId, status, amount, signature)) {
        throw Errors.INVALID_SIGNATURE;
    }

    const payment = await prisma.payment.findFirst({
        where: { transactionId },
        include: { order: { include: { items: true } } },
    });

    if (!payment) {
        throw Errors.PAYMENT_NOT_FOUND;
    }

    // 冪等：非 pending 表示這筆回調已處理過，不再變更任何狀態
    if (payment.status !== 'pending') {
        return {
            success: true,
            duplicated: true,
            orderStatus: payment.order.status,
            paymentStatus: payment.status,
        };
    }

    if (Number(amount) !== Number(payment.amount)) {
        throw Errors.AMOUNT_MISMATCH;
    }

    const order = payment.order;
    const rawResponse = { ...input } as unknown as Prisma.InputJsonObject;

    // 訂單已不可付款：先讓這筆付款失敗，再依原因回報
    if (order.status !== 'pending' || order.expiresAt < new Date()) {
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: 'failed',
                rawResponse: {
                    ...input,
                    reason: `order status is ${order.status}, expiresAt ${order.expiresAt.toISOString()}`,
                } as unknown as Prisma.InputJsonObject,
            },
        });

        throw order.status === 'paid'
            ? Errors.ORDER_ALREADY_PAID
            : Errors.ORDER_EXPIRED;
    }

    if (status === 'failed') {
        await prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'failed', rawResponse },
        });

        return {
            success: true,
            orderStatus: order.status,
            paymentStatus: 'failed',
        };
    }

    const seatIds = order.items.map((item) => item.seatId);

    await prisma.$transaction(async (tx) => {
        await tx.order.update({
            where: { id: order.id },
            data: { status: 'paid', paidAt: new Date() },
        });

        await tx.seat.updateMany({
            where: { id: { in: seatIds } },
            data: { status: 'sold', lockedBy: null, lockedUntil: null },
        });

        // 每張票各自簽發，票券碼有 unique 約束
        for (const item of order.items) {
            const ticketCode = generateTicketCode();
            await tx.orderItem.update({
                where: { id: item.id },
                data: {
                    ticketCode,
                    qrCode: signTicket(ticketCode, item.id),
                },
            });
        }

        await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'success', rawResponse },
        });
    });

    // 付款完成，Redis 座位鎖不再需要
    for (const seatId of seatIds) {
        await redis.del(`seat:lock:${seatId}`);
    }

    return { success: true, orderStatus: 'paid', paymentStatus: 'success' };
}

export async function getPaymentStatus(
    userId: string,
    paymentId: string
): Promise<PaymentStatusResponse> {
    const payment = await prisma.payment.findFirst({
        where: { id: paymentId, order: { userId } },
        include: { order: true },
    });

    if (!payment) {
        throw Errors.PAYMENT_NOT_FOUND;
    }

    return {
        paymentId: payment.id,
        transactionId: payment.transactionId!,
        status: payment.status,
        amount: payment.amount.toString(),
        orderNo: payment.order.orderNo,
        orderStatus: payment.order.status,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
    };
}
