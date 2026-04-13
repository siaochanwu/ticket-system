import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as authService from './auth.service.js';

interface RegisterBody {
    email: string;
    password: string;
    phone?: string;
}

interface LoginBody {
    email: string;
    password: string;
}

export default async function authRoutes(app: FastifyInstance) {
    app.post<{ Body: RegisterBody }>(
        '/register',
        {
            schema: {
                tags: ['auth'],
                summary: '用戶註冊',
                description: '註冊新用戶帳號',
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email', description: '電子郵件' },
                        password: { type: 'string', minLength: 8, description: '密碼（至少8個字元）' },
                        phone: { type: 'string', description: '電話號碼（選填）' },
                    },
                },
                response: {
                    201: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            message: { type: 'string' },
                            data: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    email: { type: 'string' },
                                    role: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const user = await authService.register(request.body);
            reply.status(201).send({
                success: true,
                message: '註冊成功',
                data: user,
            });
        }
    );

    app.post<{ Body: LoginBody }>(
        '/login',
        {
            schema: {
                tags: ['auth'],
                summary: '用戶登入',
                description: '使用帳號密碼登入系統',
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email', description: '電子郵件' },
                        password: { type: 'string', description: '密碼' },
                    },
                },
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            message: { type: 'string' },
                            data: {
                                type: 'object',
                                properties: {
                                    user: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string' },
                                            email: { type: 'string' },
                                            role: { type: 'string' },
                                        },
                                    },
                                    token: { type: 'string', description: 'JWT Token' },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const user = await authService.login(request.body);

            const token = app.jwt.sign({
                id: user.id,
                email: user.email,
                role: user.role,
            });

            reply.send({
                success: true,
                message: '登入成功',
                data: {
                    user,
                    token,
                },
            });
        }
    );

    app.get(
        '/me',
        {
            onRequest: [app.authenticate],
            schema: {
                tags: ['auth'],
                summary: '取得當前用戶資訊',
                description: '取得已登入用戶的個人資訊',
                security: [{ Bearer: [] }],
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            success: { type: 'boolean' },
                            data: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    email: { type: 'string' },
                                    role: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { id } = request.user as { id: string };
            const user = await authService.getUserById(id);

            if (!user) {
                reply.send({
                    success: false,
                    message: '用戶不存在',
                });
                return;
            }
            reply.send({
                success: true,
                data: user,
            });
        }
    );
}
