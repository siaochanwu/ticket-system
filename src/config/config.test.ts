import { describe, it, expect } from 'vitest';
import config from './index.js';

describe('Config', () => {
    it('應該載入購票閉環相關設定並帶有預設值', () => {
        expect(config.order.paymentTimeoutMinutes).toBe(10);
        expect(config.refund.deadlineDays).toBe(7);
        expect(config.worker.orderExpiryIntervalMs).toBe(30000);
        expect(config.worker.leaderLockTtlSeconds).toBe(25);
        expect(config.worker.batchSize).toBe(100);
    });

    it('付款設定不應為空字串', () => {
        expect(config.payment.mockSecret.length).toBeGreaterThan(0);
        expect(config.payment.callbackBaseUrl).toMatch(/^https?:\/\//);
    });
});
