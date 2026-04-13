import bcrypt from 'bcryptjs';
import prisma from '../../config/database.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';

interface RegisterInput {
    email: string;
    password: string;
    phone?: string;
}

export async function register(input: RegisterInput) {
    const { email, password, phone } = input;

    const existing = await prisma.user.findUnique({
        where: {
            email
        }
    });

    if (existing) {
        throw Errors.EMAIL_EXISTS;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
        data: {
            email,
            passwordHash,
            phone
        },
        select: {
            id: true,
            email: true,
            phone: true,
            createdAt: true
        }
    })

    return user
}

interface LoginInput {
    email: string;
    password: string;
}

export async function login(input: LoginInput) {
    const { email, password } = input;

    const user = await prisma.user.findUnique({
        where: {
            email
        }
    })

    if (!user) {
        throw Errors.INVALID_CREDENTIALS;
    }
    
    const isValid = await bcrypt.compare(password, user.passwordHash)

    if (!isValid) {
        throw Errors.INVALID_CREDENTIALS;
    }

    return {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role
    }
}

export async function getUserById(userId: string) {
    const user = await prisma.user.findUnique({
        where: {
            id: userId
        },
        select: {
            id: true,
            email: true,
            phone: true,
            realName: true,
            isVerified: true,
            role: true,
            createdAt: true
        }
    })

    if(!user) {
        throw Errors.USER_NOT_FOUND;
    }

    return user
}