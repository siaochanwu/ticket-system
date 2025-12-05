import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';

import config from './config/index.js';
import prisma from './config/database.js';
import redis, { redisUtils, closeRedis } from './config/redis.js';

// 路由
import errorHandlerPlugin from './plugins/errorHandler.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/auth.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: {
            level: config.isDev ? 'info' : 'error',
            transport: config.isDev
                ? {
                      target: 'pino-pretty',
                      options: {
                          colorize: true,
                      },
                  }
                : undefined,
        },
    });

    // CORS
    await app.register(cors, {
        origin: true,
        credentials: true,
    });

    // JWT
    await app.register(jwt, {
        secret: config.jwt.secret,
        sign: {
            expiresIn: config.jwt.expiresIn,
        },
    });

    // 全域錯誤處理
    await app.register(errorHandlerPlugin);

    // Auth Plugin (註冊 authenticate 裝飾器，要在 JWT 插件之後)
    await app.register(authPlugin);

    // 裝飾器
    app.decorate('prisma', prisma);
    app.decorate('redis', redis);
    app.decorate('redisUtils', redisUtils);
    app.decorate('config', config);

    // check DB
    app.get('/health', async () => {
        const dbHealthy = await prisma.$queryRaw`SELECT 1`
            .then(() => true)
            .catch(() => false);
        const redisHealthy = await redisUtils.healthCheck();

        const status = dbHealthy && redisHealthy ? 'healthy' : 'unhealthy';

        return {
            status,
            timestamp: Date.now(),
            service: {
                database: dbHealthy ? 'up' : 'down',
                redis: redisHealthy ? 'up' : 'down',
            },
        };
    });

    // 載入路由
    app.get('/', async (request, reply) => {
        return { message: 'Welcome to Ticket System API! 🎫' };
    });

    // Auth 路由
    await app.register(authRoutes, { prefix: '/api/auth' });

    return app;
}

async function start() {
    const app = await buildApp();

    try {
        const address = await app.listen({
            port: config.server.port,
            host: config.server.host,
        });

        console.log(`🚀 Server is running at ${address}`);
        console.log(`📋 Health check: ${address}/health`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    async function shutdown(signal: string) {
        console.log(`\n📴 Received ${signal}. Shutting down...`);

        await app.close();
        await prisma.$disconnect();
        await closeRedis();

        console.log('👋 Server closed');
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
