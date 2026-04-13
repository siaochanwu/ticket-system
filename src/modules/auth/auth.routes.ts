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
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email' },
                        password: { type: 'string' },
                        phone: { type: 'string' },
                    },
                },
            },
        },
        async (request, reply) => {
            try {
                const user = await authService.register(request.body);
                reply.status(201).send({
                    success: true,
                    message: '註冊成功',
                    data: user,
                });
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message === 'EMAIL_EXISTS'
                ) {
                    reply.status(400).send({
                        success: false,
                        message: '此 Email 已被註冊',
                    });
                    return;
                }
                throw error;
            }
        }
    );

    app.post<{ Body: LoginBody }>(
        '/login',
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email' },
                        password: { type: 'string' },
                    },
                },
            },
        },
        async (request, reply) => {
            try {
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
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message === 'INVALID_CREDENTIALS'
                ) {
                    reply.status(401).send({
                        success: false,
                        message: '帳號或密碼錯誤',
                    });
                    return;
                }
                throw error;
            }
        }
    );

    app.get(
        '/me',
        {
            onRequest: [app.authenticate],
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
