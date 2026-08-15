import crypto from 'crypto';
import config from '../../config/index.js';

/**
 * 金流回調的驗簽字串。真實金流通常也是把欄位串成 canonical string 後簽章。
 */
export function buildSignaturePayload(
    transactionId: string,
    status: string,
    amount: string
): string {
    return `${transactionId}|${status}|${amount}`;
}

export function signCallback(
    transactionId: string,
    status: string,
    amount: string
): string {
    return crypto
        .createHmac('sha256', config.payment.mockSecret)
        .update(buildSignaturePayload(transactionId, status, amount))
        .digest('hex');
}

export function verifyCallbackSignature(
    transactionId: string,
    status: string,
    amount: string,
    signature: string
): boolean {
    // 這個函式是 export 出去的，不能只依賴呼叫端（route schema）保證型別；
    // 自己也要能安全拒絕非字串輸入，而不是讓 Buffer.from 拋例外
    if (typeof signature !== 'string') {
        return false;
    }

    const expected = signCallback(transactionId, status, amount);

    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (actualBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
