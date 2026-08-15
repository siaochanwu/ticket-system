import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import config from '../../config/index.js';
import { Errors } from '../../plugins/errorHandler.js';
import { CreateRefundInput, RefundResponse } from './refunds.type.js';

const refundInclude = {
    order: true,
} as const;

type RefundWithOrder = Prisma.RefundRequestGetPayload<{
    include: typeof refundInclude;
}>;

function toRefundResponse(refund: RefundWithOrder): RefundResponse {
    return {
        id: refund.id,
        orderId: refund.orderId,
        orderNo: refund.order.orderNo,
        userId: refund.userId,
        status: refund.status,
        reason: refund.reason,
        totalAmount: refund.order.totalAmount.toString(),
        processedAt: refund.processedAt,
        processedBy: refund.processedBy,
        createdAt: refund.createdAt,
    };
}

export async function createRefundRequest(
    input: CreateRefundInput
): Promise<RefundResponse> {
    const { userId, orderId, reason } = input;

    const order = await prisma.order.findFirst({
        where: { id: orderId, userId },
        include: { session: true },
    });

    if (!order) {
        throw Errors.ORDER_NOT_FOUND;
    }

    if (order.status !== 'paid') {
        throw Errors.ORDER_NOT_PAID;
    }

    const existing = await prisma.refundRequest.findFirst({
        where: { orderId, status: { in: ['pending', 'approved'] } },
    });

    if (existing) {
        throw Errors.REFUND_ALREADY_REQUESTED;
    }

    // 退票期限：必須在場次日期前 deadlineDays 天之前提出
    const deadline = new Date(order.session.sessionDate);
    deadline.setDate(deadline.getDate() - config.refund.deadlineDays);

    if (new Date() >= deadline) {
        throw Errors.REFUND_DEADLINE_PASSED;
    }

    // 上面的 findFirst 只是先做一次友善的檢查，不是唯一防線：兩個併發請求
    // 都可能通過「沒有既有 pending/approved 申請」的檢查後同時 create。
    // 真正的守衛是 refund_requests(order_id) 上的 partial unique index
    // （WHERE status IN ('pending','approved')，見 prisma/schema.prisma
    // 的說明與對應 migration），輸家在這裡會撞上 P2002，同一模式見
    // payments.service.ts 的 createPayment。
    try {
        const refund = await prisma.refundRequest.create({
            data: {
                orderId,
                userId,
                reason,
                status: 'pending',
            },
            include: refundInclude,
        });

        return toRefundResponse(refund);
    } catch (error) {
        const isUniqueViolation =
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002';

        if (!isUniqueViolation) {
            throw error;
        }

        throw Errors.REFUND_ALREADY_REQUESTED;
    }
}

export async function getMyRefundRequests(
    userId: string
): Promise<RefundResponse[]> {
    const refunds = await prisma.refundRequest.findMany({
        where: { userId },
        include: refundInclude,
        orderBy: { createdAt: 'desc' },
    });

    return refunds.map(toRefundResponse);
}

export async function listRefundRequests(
    status?: string
): Promise<RefundResponse[]> {
    const refunds = await prisma.refundRequest.findMany({
        where: status ? { status } : undefined,
        include: refundInclude,
        orderBy: { createdAt: 'desc' },
    });

    return refunds.map(toRefundResponse);
}

/**
 * 核准退票：訂單轉 refunded、座位釋放、票券作廢。
 *
 * 這裡的讀取（refund 是否存在／是否仍是 pending、要釋放哪些座位）
 * 跟本專案其他交易一樣，不能當成唯一防線——如果核准請求在讀取之後、
 * 交易 commit 之前，剛好有另一個併發的核准/拒絕請求先 commit，這個讀取
 * 結果就已經過期了。真正的守衛是交易內每一步 updateMany 的 where 條件
 * 加上比對筆數，任一步筆數不符就丟錯讓整個交易 rollback（同一模式見
 * expireOverdueOrders／payments.service.ts 付款成功路徑／
 * orders.service.ts 的 cancelOrder）：
 *
 * 1. refundRequest：where 重新斷言 status='pending'，避免核准一筆
 *    已經被處理過的退票申請（Critical：REFUND_ALREADY_PROCESSED 的唯一防線）。
 * 2. order：where 重新斷言 status='paid'，避免把非 paid 訂單誤轉 refunded。
 * 3. seat：where 重新斷言 status='sold'，避免釋放已經不屬於「這張已付款
 *    訂單」的座位（例如座位已經因為其他流程變成其他狀態）。
 */
export async function approveRefund(
    adminId: string,
    refundId: string
): Promise<RefundResponse> {
    const refund = await prisma.refundRequest.findUnique({
        where: { id: refundId },
        include: { order: { include: { items: true } } },
    });

    if (!refund) {
        throw Errors.REFUND_NOT_FOUND;
    }

    if (refund.status !== 'pending') {
        throw Errors.REFUND_ALREADY_PROCESSED;
    }

    const seatIds = refund.order.items.map((item) => item.seatId);

    const updated = await prisma.$transaction(async (tx) => {
        // 1. 搶下這筆退票申請的處理權：與另一個併發的核准/拒絕請求競爭
        //    同一筆退票時，只有比對到 count===1 的那個能繼續往下走。
        const claimedRefund = await tx.refundRequest.updateMany({
            where: { id: refundId, status: 'pending' },
            data: {
                status: 'approved',
                processedAt: new Date(),
                processedBy: adminId,
            },
        });

        if (claimedRefund.count !== 1) {
            throw Errors.REFUND_ALREADY_PROCESSED;
        }

        // 2. 訂單必須仍是 paid 才能轉 refunded。
        const refundedOrder = await tx.order.updateMany({
            where: { id: refund.orderId, status: 'paid' },
            data: { status: 'refunded' },
        });

        if (refundedOrder.count !== 1) {
            throw Errors.ORDER_NOT_PAID;
        }

        // 3. 只釋放仍屬於這張訂單、狀態為 sold 的座位。
        const releasedSeats = await tx.seat.updateMany({
            where: { id: { in: seatIds }, status: 'sold' },
            data: { status: 'available', lockedBy: null, lockedUntil: null },
        });

        if (releasedSeats.count !== seatIds.length) {
            // 座位數與預期不符，代表座位狀態在外層讀取之後已被其他流程
            // 改變過。這個分支沒有專屬錯誤碼，沿用 REFUND_ALREADY_PROCESSED
            // 表達「這筆退票已經不在可以核准的狀態」，並讓交易整批回滾。
            throw Errors.REFUND_ALREADY_PROCESSED;
        }

        // 4. 票券作廢：訂單已在同一交易內確定轉為 refunded，這裡是收尾寫入。
        await tx.orderItem.updateMany({
            where: { orderId: refund.orderId },
            data: { ticketCode: null, qrCode: null },
        });

        return tx.refundRequest.findUniqueOrThrow({
            where: { id: refundId },
            include: refundInclude,
        });
    });

    return toRefundResponse(updated);
}

/**
 * 拒絕退票：只改退票申請本身的狀態，訂單與票券維持原狀。
 *
 * 跟 approveRefund 同一個理由：外層讀取到的 status 不能當唯一防線，
 * 真正的守衛是 updateMany 的 where 重新斷言 status='pending' 並比對
 * 筆數——避免跟另一個併發的核准/拒絕請求競爭同一筆退票時，把已經
 * 核准（訂單已轉 refunded、座位已釋放、票券已作廢）的申請覆寫回
 * rejected，讓退票申請的狀態跟訂單實際狀態互相矛盾。
 */
export async function rejectRefund(
    adminId: string,
    refundId: string,
    reason?: string
): Promise<RefundResponse> {
    const refund = await prisma.refundRequest.findUnique({
        where: { id: refundId },
    });

    if (!refund) {
        throw Errors.REFUND_NOT_FOUND;
    }

    if (refund.status !== 'pending') {
        throw Errors.REFUND_ALREADY_PROCESSED;
    }

    // RefundRequest 只有一個 reason 欄位（使用者填的），
    // 審核備註以附加方式寫入，避免覆寫使用者原文
    const mergedReason = reason
        ? `${refund.reason ?? ''}\n[審核備註] ${reason}`.trim()
        : refund.reason;

    const claimed = await prisma.refundRequest.updateMany({
        where: { id: refundId, status: 'pending' },
        data: {
            status: 'rejected',
            processedAt: new Date(),
            processedBy: adminId,
            reason: mergedReason,
        },
    });

    if (claimed.count !== 1) {
        throw Errors.REFUND_ALREADY_PROCESSED;
    }

    const updated = await prisma.refundRequest.findUniqueOrThrow({
        where: { id: refundId },
        include: refundInclude,
    });

    return toRefundResponse(updated);
}
