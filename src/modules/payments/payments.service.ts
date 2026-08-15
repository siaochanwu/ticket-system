import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import config from '../../config/index.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import { generateTicketCode, signTicket } from '../../utils/ticketCode.js';
import { verifyCallbackSignature } from './payments.signature.js';
import { releaseSeatLockIfOwnedBy } from '../../workers/orderExpiry.service.js';
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

    let payment = existing;

    if (!payment) {
        try {
            payment = await prisma.payment.create({
                data: {
                    orderId,
                    paymentMethod: paymentMethod ?? 'mock',
                    // 128 bits 熵：避免 transactionId 在 callback 沒有任何
                    // 認證保護的情況下被猜到（見 Errors.INVALID_SIGNATURE
                    // 的威脅模型：唯一門檻是簽章 + 猜對 transactionId）
                    transactionId: `MOCK-${Date.now()}-${crypto
                        .randomBytes(16)
                        .toString('hex')}`,
                    amount: order.totalAmount,
                    status: 'pending',
                },
            });
        } catch (error) {
            // 上面「讀取既有 pending 付款」與這裡的 create 之間有競態：
            // 兩個併發請求都可能讀到「沒有」再各自嘗試建立。DB 端的
            // partial unique index（payments_order_id_pending_key）會讓
            // 其中一個 create 撞上 P2002，這裡改成重新查詢、回同一筆，
            // 而不是把這個競態暴露成一個隨機的 500。
            const isUniqueViolation =
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002';

            if (!isUniqueViolation) {
                throw error;
            }

            payment = await prisma.payment.findFirst({
                where: { orderId, status: 'pending' },
                orderBy: { createdAt: 'desc' },
            });

            if (!payment) {
                // 理論上不會發生：撞到 unique 約束代表一定有一筆 pending
                // 付款存在，重新查詢卻找不到只能是更深層的資料異常
                throw error;
            }
        }
    }

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

    const payment = await prisma.payment.findUnique({
        where: { transactionId },
        include: { order: { include: { items: true } } },
    });

    if (!payment) {
        throw Errors.PAYMENT_NOT_FOUND;
    }

    // 快速路徑：非 pending 表示循序重放（最常見的重複回調情境），
    // 直接回報現況、不做任何寫入。併發重放的真正防線是下面交易內的
    // 原子 claim（payment.updateMany where status='pending'），這裡
    // 只是省下不必要的金額檢查與交易開銷。
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
    const seatIds = order.items.map((item) => item.seatId);

    if (status === 'failed') {
        // 把「宣告這筆回調由我處理」當成交易，用 count 判斷輸贏，
        // 避免兩個併發的失敗回調都以為自己是第一個而重複回報
        const claimed = await prisma.payment.updateMany({
            where: { id: payment.id, status: 'pending' },
            data: { status: 'failed', rawResponse },
        });

        if (claimed.count !== 1) {
            const latest = await mustFindPaymentWithOrder(payment.id);
            return {
                success: true,
                duplicated: true,
                orderStatus: latest.order.status,
                paymentStatus: latest.status,
            };
        }

        return {
            success: true,
            orderStatus: order.status,
            paymentStatus: 'failed',
        };
    }

    // 成功路徑：整批寫入都在同一個交易內，且每一步都帶著期望的狀態
    // 當 where 條件並比對筆數，任一步筆數不符就丟錯讓整個交易 rollback
    // （包含已經寫進去的 payment claim）。這樣可以同時擋下兩個問題：
    //
    // 1. 併發的相同回調重複套用（Critical 2）：把「payment 從 pending
    //    轉成 success」放在交易的第一步，當成對這次回調的原子宣告——
    //    只有搶到 count===1 的那個回調可以繼續往下走並簽發票券，輸家
    //    直接視為 duplicated，走跟循序重放一模一樣的路徑，不會再改動
    //    任何欄位、更不會重新簽發 ticketCode/qrCode。
    // 2. 訂單在讀取與寫入之間被 worker（expireOverdueOrders）回收或被
    //    使用者取消（Critical 1）：order.updateMany 的 where 重新要求
    //    status='pending' 且未逾期，seat.updateMany 的 where 要求座位
    //    仍是這張訂單持有的 locked 狀態，任一個條件在交易當下不成立，
    //    都代表訂單已經被別的流程搶先處理，必須整批放棄。
    let outcome: { claimed: boolean };
    try {
        outcome = await prisma.$transaction(async (tx) => {
            const claimed = await tx.payment.updateMany({
                where: { id: payment.id, status: 'pending' },
                data: { status: 'success', rawResponse },
            });

            if (claimed.count !== 1) {
                // 另一個併發的相同回調已經贏得這次 claim
                return { claimed: false };
            }

            const paidOrder = await tx.order.updateMany({
                where: {
                    id: order.id,
                    status: 'pending',
                    expiresAt: { gt: new Date() },
                },
                data: { status: 'paid', paidAt: new Date() },
            });

            if (paidOrder.count !== 1) {
                const current = await tx.order.findUnique({
                    where: { id: order.id },
                    select: { status: true },
                });
                throw current?.status === 'paid'
                    ? Errors.ORDER_ALREADY_PAID
                    : Errors.ORDER_EXPIRED;
            }

            const sold = await tx.seat.updateMany({
                where: {
                    id: { in: seatIds },
                    status: 'locked',
                    lockedBy: order.userId,
                },
                data: { status: 'sold', lockedBy: null, lockedUntil: null },
            });

            if (sold.count !== seatIds.length) {
                throw Errors.ORDER_EXPIRED;
            }

            // write-once：只在尚未簽發過（ticketCode 仍是 null）時才寫入，
            // 就算未來出現讓這段程式碼被重複執行的 bug，也不可能覆寫
            // 已經交付給使用者的票券
            for (const item of order.items) {
                const ticketCode = generateTicketCode();
                await tx.orderItem.updateMany({
                    where: { id: item.id, ticketCode: null },
                    data: {
                        ticketCode,
                        qrCode: signTicket(ticketCode, item.id),
                    },
                });
            }

            return { claimed: true };
        });
    } catch (error) {
        // 只有訂單／座位守衛沒過（交易內明確 throw 的這兩種已知終局錯誤）
        // 才需要在交易外把付款標記 failed；其他非預期錯誤（例如 DB 連線
        // 中斷）不應該被誤判成「訂單不可付款」而覆寫付款狀態
        const isOrderNoLongerPayable =
            error === Errors.ORDER_ALREADY_PAID ||
            error === Errors.ORDER_EXPIRED;

        if (isOrderNoLongerPayable) {
            // 已經 claim 成功（payment 一度要被標成 success），但訂單／
            // 座位守衛沒過，交易已整批 rollback（payment 也回到 pending）。
            // 在交易外把付款標記 failed，避免它卡在 pending 又被
            // createPayment 的冪等分支或下一次回調重複處理。
            await prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: 'failed',
                    rawResponse: {
                        ...input,
                        reason: `order is no longer payable (${(error as AppError).code})`,
                    } as unknown as Prisma.InputJsonObject,
                },
            });
        }
        throw error;
    }

    if (!outcome.claimed) {
        const latest = await mustFindPaymentWithOrder(payment.id);
        return {
            success: true,
            duplicated: true,
            orderStatus: latest.order.status,
            paymentStatus: latest.status,
        };
    }

    // 付款完成，Redis 座位鎖不再需要：比對持有者後才刪，避免刪掉
    // commit 之後才由別人合法取得的新鎖（與 orderExpiry worker 的
    // releaseSeatLockIfOwnedBy／tickets.service.ts 的 unlockSeats 同一原則）
    for (const seatId of seatIds) {
        await releaseSeatLockIfOwnedBy(seatId, order.userId);
    }

    return { success: true, orderStatus: 'paid', paymentStatus: 'success' };
}

async function mustFindPaymentWithOrder(paymentId: string) {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { order: true },
    });

    if (!payment) {
        throw Errors.PAYMENT_NOT_FOUND;
    }

    return payment;
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
