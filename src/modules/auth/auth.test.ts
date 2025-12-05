import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../app.js';
import { FastifyInstance } from 'fastify';
import prisma from '../../config/database.js';
import redis, { redisUtils, closeRedis } from '../../config/redis.js';

describe('Auth Module', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        await prisma.$disconnect();
        await closeRedis();
    });

    beforeEach(async () => {
        // 清除測試用戶
        await prisma.user.deleteMany({
            where: {
                email: {
                    contains: 'test',
                },
            },
        });
        // 清除 Redis 測試資料
        const keys = await redis.keys('test:*');
        if (keys.length > 0) {
            await redis.del(...keys);
        }
    });

    describe('POST /api/auth/register', () => {
        it('should register a new user', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                    phone: '1234567890',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(201);
            expect(body.success).toBe(true);
            expect(body.message).toBe('註冊成功');
            expect(body.data.email).toBe('test@example.com');
            expect(body.data.id).toBeDefined();
            // 確保不回傳密碼
            expect(body.data.passwordHash).toBeUndefined();
        });

        it('should return an error if email already exists', async () => {
            // 先註冊一次
            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                    phone: '1234567890',
                },
            });

            // 再註冊一次（相同 email）
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'test@example.com',
                    password: 'password123',
                    phone: '0998888888',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(409);
            expect(body.success).toBe(false);
            expect(body.code).toBe('EMAIL_EXISTS');
        });

        it('should reject invalid email format', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'invalid-email',
                    password: '12345678',
                },
            });

            expect(response.statusCode).toBe(400);
        });
    });

    describe('POST /api/auth/login', () => {
        // 每次測試前先建立用戶
        beforeEach(async () => {
            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                    phone: '1234567890',
                },
            });
        });
        it('should login success and return token', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.token).toBeDefined();
            expect(body.data.user.email).toBe('test@example.com');
        });

        it('should reject wrong password', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'test@example.com',
                    password: 'wrong-password',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(401);
            expect(body.success).toBe(false);
            expect(body.code).toBe('INVALID_CREDENTIALS');
        });

        it('should reject not exist user', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'no@example.com',
                    password: 'password',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(401);
            expect(body.success).toBe(false);
            expect(body.code).toBe('INVALID_CREDENTIALS');
        });
    });

    describe('POST /api/auth/me', () => {
        let token: string;

        // 每次測試前先註冊並登入
        beforeEach(async () => {
            await app.inject({
                method: 'POST',
                url: '/api/auth/register',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                    phone: '1234567890',
                },
            });

            const loginResponse = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    email: 'test@example.com',
                    password: 'password',
                },
            });

            const loginBody = JSON.parse(loginResponse.body);
            token = loginBody.data.token;
        });

        it('should return user info', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.email).toBe('test@example.com');
        });

        it('should reject without token', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/auth/me',
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(401);
            expect(body.success).toBe(false);
            expect(body.code).toBe('UNAUTHORIZED');
        });

        it('should reject invalid token', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                headers: {
                    Authorization: 'Bearer invalid-token',
                },
            });

            const body = JSON.parse(response.body);

            expect(response.statusCode).toBe(401);
            expect(body.success).toBe(false);
            expect(body.code).toBe('UNAUTHORIZED');
        })
    });
});
