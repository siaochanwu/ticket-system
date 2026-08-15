import { describe, it, expect, vi, afterEach } from 'vitest';
import config, { assertSecretsConfigured } from './index.js';

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

    it('JWT_SECRET 與 PAYMENT_MOCK_SECRET 不應退回任何硬編碼常數', () => {
        // .env.test 有設定這兩個值；這裡額外釘住「不是某個已知的
        // 硬編碼字串」，避免未來有人不小心把 fallback 加回去
        expect(config.jwt.secret).not.toBe('default-secret');
        expect(config.jwt.secret).not.toBe('');
        expect(config.payment.mockSecret).not.toBe('mock-payment-secret');
        expect(config.payment.mockSecret).not.toBe('');
    });

    describe('assertSecretsConfigured', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('正式環境缺少必要 secret 時應該讓啟動失敗', () => {
            expect(() =>
                assertSecretsConfigured({
                    isProd: true,
                    jwt: { secret: '', expiresIn: '7d' },
                    payment: { mockSecret: '', callbackBaseUrl: '' },
                })
            ).toThrow(/JWT_SECRET/);
        });

        it('非正式環境缺少必要 secret 時只警告、不拋錯', () => {
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);

            expect(() =>
                assertSecretsConfigured({
                    isProd: false,
                    jwt: { secret: '', expiresIn: '7d' },
                    payment: { mockSecret: '', callbackBaseUrl: '' },
                })
            ).not.toThrow();

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain('PAYMENT_MOCK_SECRET');
        });

        it('兩個 secret 都齊全時不拋錯也不警告', () => {
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);

            expect(() =>
                assertSecretsConfigured({
                    isProd: true,
                    jwt: { secret: 'a', expiresIn: '7d' },
                    payment: { mockSecret: 'b', callbackBaseUrl: '' },
                })
            ).not.toThrow();

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
