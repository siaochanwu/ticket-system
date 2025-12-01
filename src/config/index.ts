import "dotenv/config";

export interface AppConfig {
  env: string;
  isDev: boolean;
  isProd: boolean;
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
}

export const config: AppConfig = {
  // 環境
  env: process.env.NODE_ENV || "development",
  isDev: process.env.NODE_ENV === "development",
  isProd: process.env.NODE_ENV === "production",

  // 伺服器
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
  },

  // 資料庫
  database: {
    url: process.env.DATABASE_URL || "postgres://localhost:5432/tickets",
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || "default-secret",
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },

  // 搶票設定
  ticket: {
    seatLockDurationSeconds: parseInt(
      process.env.SEAT_LOCK_DURATION_SECONDS || "600",
      10
    ),
    maxTicketsPerOrder: parseInt(process.env.MAX_TICKETS_PER_ORDER || "4", 10),
  },
};

export default config;