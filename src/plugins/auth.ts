import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from './errorHandler.js';

export interface UserPayload {
    id: string;
    email: string;
    role: string;
}

// 擴展 Fastify 型別
declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (
            request: FastifyRequest,
            reply: FastifyReply
        ) => Promise<void>;
        authenticateAdmin: (
            request: FastifyRequest,
            reply: FastifyReply
        ) => Promise<void>;
    }
}

// 擴展 @fastify/jwt 型別（重點！）
declare module '@fastify/jwt' {
    interface FastifyJWT {
        payload: UserPayload; // JWT 內容的型別
        user: UserPayload; // request.user 的型別
    }
}

async function authPlugin(app: FastifyInstance) {
    // 一般用戶驗證
    app.decorate(
        'authenticate',
        async (request: FastifyRequest, reply: FastifyReply) => {
            try {
                await request.jwtVerify();
            } catch (error) {
                throw new AppError('請先登入', 401, 'UNAUTHORIZED');
            }
        }
    );

    // 管理員驗證
    app.decorate(
        'authenticateAdmin',
        async (request: FastifyRequest, reply: FastifyReply) => {
            try {
                await request.jwtVerify();
                if (request.user.role !== 'ADMIN') {
                    throw new AppError('需要管理員權限', 403, 'FORBIDDEN');
                }
            } catch (error) {
                if (error instanceof AppError) throw error;
                throw new AppError('請先登入', 401, 'UNAUTHORIZED');
            }
        }
    );
}

// 使用 fastify-plugin 包裝，讓裝飾器可以在父層使用
export default fp(authPlugin);
