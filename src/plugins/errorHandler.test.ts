import { describe, it, expect } from 'vitest';
import { Errors, AppError } from './errorHandler.js';

describe('Errors 字典', () => {
    const expected: Record<string, number> = {
        PAYMENT_NOT_FOUND: 404,
        INVALID_SIGNATURE: 401,
        AMOUNT_MISMATCH: 400,
        ORDER_NOT_PAID: 400,
        TICKET_NOT_FOUND: 404,
        REFUND_ALREADY_REQUESTED: 409,
        REFUND_DEADLINE_PASSED: 400,
        REFUND_NOT_FOUND: 404,
        REFUND_ALREADY_PROCESSED: 409,
    };

    it('購票閉環新增的錯誤碼都應存在且 statusCode 正確', () => {
        for (const [code, statusCode] of Object.entries(expected)) {
            const error = (Errors as Record<string, AppError>)[code];
            expect(error, `缺少 ${code}`).toBeInstanceOf(AppError);
            expect(error.code).toBe(code);
            expect(error.statusCode).toBe(statusCode);
        }
    });
});
