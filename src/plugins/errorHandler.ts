import { FastifyInstance, FastifyError } from 'fastify';

export class AppError extends Error {
    statusCode: number;
    code: string;

    constructor(
        message: string,
        statusCode: number = 400,
        code: string = 'BAD_REQUEST'
    ) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.name = 'AppError';
    }
}

export const Errors = {
    // 認證相關
    UNAUTHORIZED: new AppError('請先登入', 401, 'UNAUTHORIZED'),
    INVALID_CREDENTIALS: new AppError(
        '帳號或密碼錯誤',
        401,
        'INVALID_CREDENTIALS'
    ),
    FORBIDDEN: new AppError('沒有權限', 403, 'FORBIDDEN'),

    // 用戶相關
    EMAIL_EXISTS: new AppError('Email 已被註冊', 409, 'EMAIL_EXISTS'),
    USER_NOT_FOUND: new AppError('用戶不存在', 404, 'USER_NOT_FOUND'),

    // 活動相關
    EVENT_NOT_FOUND: new AppError('活動不存在', 404, 'EVENT_NOT_FOUND'),
    SESSION_NOT_FOUND: new AppError('場次不存在', 404, 'SESSION_NOT_FOUND'),

    // 票券相關
    SEAT_NOT_AVAILABLE: new AppError('座位已被選走', 409, 'SEAT_NOT_AVAILABLE'),
    SEAT_LOCKED: new AppError('座位已被鎖定', 409, 'SEAT_LOCKED'),
    INSUFFICIENT_STOCK: new AppError('票券庫存不足', 409, 'INSUFFICIENT_STOCK'),
    EXCEED_LIMIT: new AppError('超過購買上限', 400, 'EXCEED_LIMIT'),

    // 訂單相關
    ORDER_NOT_FOUND: new AppError('訂單不存在', 404, 'ORDER_NOT_FOUND'),
    ORDER_EXPIRED: new AppError('訂單已過期', 410, 'ORDER_EXPIRED'),
    ORDER_ALREADY_PAID: new AppError('訂單已付款', 409, 'ORDER_ALREADY_PAID'),

    // 系統相關
    INTERNAL_ERROR: new AppError('系統錯誤，請稍後再試', 500, 'INTERNAL_ERROR'),
};

export default async function errorHandlerPlugin(app: FastifyInstance) {
    // 全域錯誤處理
    app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
        // 記錄錯誤
        request.log.error(error);

        // 自定義錯誤（AppError）
        if (error instanceof AppError) {
            return reply.status(error.statusCode).send({
                success: false,
                code: error.code,
                message: error.message,
            });
        }

        // Fastify 驗證錯誤
        if (error.validation) {
            return reply.status(400).send({
                success: false,
                code: 'VALIDATION_ERROR',
                message: '輸入資料格式錯誤',
                details: error.validation,
            });
        }

        // JWT 錯誤
        if (
            error.code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER' ||
            error.code === 'FST_JWT_AUTHORIZATION_TOKEN_INVALID'
        ) {
            return reply.status(401).send({
                success: false,
                code: 'UNAUTHORIZED',
                message: '請先登入',
            });
        }

        // 其他錯誤
        return reply.status(500).send({
            success: false,
            code: 'INTERNAL_ERROR',
            message: '系統錯誤，請稍後再試',
        });
    });

    // 404 處理
    app.setNotFoundHandler((request, reply) => {
        reply.status(404).send({
            success: false,
            code: 'NOT_FOUND',
            message: `找不到 ${request.method} ${request.url}`,
        });
    });
}
