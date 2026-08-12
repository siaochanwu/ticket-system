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
    jwt: {
        secret: process.env.JWT_SECRET || 'default-secret',
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
    payment: {
        mockSecret: process.env.PAYMENT_MOCK_SECRET || 'mock-payment-secret',
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

export default config;