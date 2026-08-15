import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenvConfig({ path: path.resolve(process.cwd(), envFile), override: true });

export interface AppConfig {
    env: string;
    isDev: boolean;
    isProd: boolean;
    isTest: boolean;
    server: {
        port: number;
        host: string;
    };
    database: {
        url: string;
    };
    redis: {
        url: string;
    };
    jwt: {
        secret: string;
        expiresIn: string;
    };
    ticket: {
        seatLockDurationSeconds: number;
        maxTicketsPerOrder: number;
    };
    order: {
        paymentTimeoutMinutes: number;
    };
    payment: {
        mockSecret: string;
        callbackBaseUrl: string;
    };
    refund: {
        deadlineDays: number;
    };
    worker: {
        orderExpiryIntervalMs: number;
        leaderLockTtlSeconds: number;
        batchSize: number;
    };
}

export const config: AppConfig = {
    // 環境
    env: process.env.NODE_ENV || 'development',
    isDev: process.env.NODE_ENV === 'development',
    isProd: process.env.NODE_ENV === 'production',
    isTest: process.env.NODE_ENV === 'test',

    // 伺服器
    server: {
        port: parseInt(process.env.PORT || '3000', 10),
        host: process.env.HOST || '0.0.0.0',
    },

    // 資料庫
    database: {
        url: process.env.DATABASE_URL || 'postgres://localhost:5432/tickets',
    },

    // Redis
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    },

    // JWT
    // 注意：secret 沒有預設值——這是簽發 JWT 與票券 QR 的唯一防線，
    // 不可退回任何硬編碼常數（見下方 assertSecretsConfigured）。
    jwt: {
        secret: process.env.JWT_SECRET || '',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },

    // 搶票設定
    ticket: {
        seatLockDurationSeconds: parseInt(
            process.env.SEAT_LOCK_DURATION_SECONDS || '600',
            10
        ),
        maxTicketsPerOrder: parseInt(
            process.env.MAX_TICKETS_PER_ORDER || '4',
            10
        ),
    },

    // 訂單設定
    order: {
        paymentTimeoutMinutes: parseInt(
            process.env.ORDER_PAYMENT_TIMEOUT_MINUTES || '10',
            10
        ),
    },

    // 金流設定（作品集使用 mock provider）
    // 注意：mockSecret 沒有預設值——POST /api/payments/callback/mock 沒有掛
    // JWT 認證，HMAC 簽章是唯一的門檻，退回任何硬編碼常數等同讓任何人都能
    // 偽造回調（見下方 assertSecretsConfigured）。
    payment: {
        mockSecret: process.env.PAYMENT_MOCK_SECRET || '',
        callbackBaseUrl:
            process.env.PAYMENT_CALLBACK_BASE_URL || 'http://localhost:3000',
    },

    // 退票設定
    refund: {
        deadlineDays: parseInt(process.env.REFUND_DEADLINE_DAYS || '7', 10),
    },

    // 背景 worker 設定
    worker: {
        orderExpiryIntervalMs: parseInt(
            process.env.ORDER_EXPIRY_INTERVAL_MS || '30000',
            10
        ),
        leaderLockTtlSeconds: parseInt(
            process.env.ORDER_EXPIRY_LOCK_TTL_SECONDS || '25',
            10
        ),
        batchSize: parseInt(process.env.ORDER_EXPIRY_BATCH_SIZE || '100', 10),
    },
};

/**
 * 檢查沒有預設值的必要 secret 是否已設定。
 * 這兩個值一旦退回任何硬編碼常數，都會讓沒有 JWT 認證保護的
 * `POST /api/payments/callback/mock` 或票券 QR 簽章形同虛設。
 * 正式環境（`NODE_ENV=production`）缺少時直接讓啟動失敗；
 * 開發／測試環境只印出警告，不阻斷 CI 與本機開發。
 */
export function assertSecretsConfigured(
    cfg: Pick<AppConfig, 'isProd' | 'jwt' | 'payment'>
): void {
    const missing: string[] = [];

    if (!cfg.jwt.secret) {
        missing.push('JWT_SECRET');
    }
    if (!cfg.payment.mockSecret) {
        missing.push('PAYMENT_MOCK_SECRET');
    }

    if (missing.length === 0) {
        return;
    }

    const message = `缺少必要的環境變數：${missing.join(', ')}（沒有預設值）。JWT 簽發與 mock 金流回調的 HMAC 簽章都依賴這些值，正式環境必須設定，否則等同無認證。`;

    if (cfg.isProd) {
        throw new Error(message);
    }

    // eslint-disable-next-line no-console
    console.warn(`[config] ${message}`);
}

assertSecretsConfigured(config);

export default config;