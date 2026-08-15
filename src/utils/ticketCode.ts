import crypto from 'crypto';
import config from '../config/index.js';

/**
 * 產生不可猜測的票券碼。
 */
export function generateTicketCode(): string {
    return `TKT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

// 與 JWT 簽發共用同一把 secret，但加上固定的 domain 前綴做隔離：
// 就算未來這把 secret 在其他用途下外洩，票券簽章與其他訊息之間
// 也不可能互相偽造成對方（不同 domain 前綴 → 不同的 HMAC 輸入）。
const TICKET_SIGNATURE_DOMAIN = 'ticket:v1:';

/**
 * 對票券碼簽章，產出可離線驗證的 QR payload：`{ticketCode}.{signature}`
 */
export function signTicket(ticketCode: string, orderItemId: number): string {
    const signature = crypto
        .createHmac('sha256', config.jwt.secret)
        .update(`${TICKET_SIGNATURE_DOMAIN}${ticketCode}:${orderItemId}`)
        .digest('base64url');

    return `${ticketCode}.${signature}`;
}

/**
 * 驗證 QR payload 是否為本系統簽發且未被篡改。
 */
export function verifyTicket(qrPayload: string, orderItemId: number): boolean {
    const separatorIndex = qrPayload.lastIndexOf('.');
    if (separatorIndex <= 0) {
        return false;
    }

    const ticketCode = qrPayload.slice(0, separatorIndex);
    const expected = signTicket(ticketCode, orderItemId);

    const actualBuffer = Buffer.from(qrPayload);
    const expectedBuffer = Buffer.from(expected);

    if (actualBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
