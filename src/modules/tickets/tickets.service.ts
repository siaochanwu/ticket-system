import prisma from '../../config/database.js';
import redis from '../../config/redis.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import config from '../../config/index.js';
import { v4 as uuidv4 } from 'uuid';
import {
    LockSeatsInput,
    AutoSelectInput,
    UnlockSeatsInput,
    LockResult,
    UserLock,
} from './tickets.type.js';

const LOCK_DURATION = config.ticket.seatLockDurationSeconds;

// 鎖定座位
export async function lockSeats(input: LockSeatsInput): Promise<LockResult> {
    const { userId, sessionId, seatIds } = input;

    // 1. 驗證場次
    const session = await prisma.session.findUnique({
        where: {
            id: sessionId,
        },
        include: {
            event: true,
        },
    });

    if (!session) {
        throw Errors.SESSION_NOT_FOUND;
    }

    // 檢查是否開賣
    const now = new Date();
    if (now < session.event.saleStartAt) {
        throw new AppError('尚未開賣', 400, 'SALE_NOT_STARTED');
    }

    if (session.event.saleEndAt && now > session.event.saleEndAt) {
        throw new AppError('已結束售票', 400, 'SALE_ENDED');
    }

    // 2. 驗證座位
    const seats = await prisma.seat.findMany({
        where: {
            id: {
                in: seatIds,
            },
            ticketType: {
                sessionId,
            },
        },
        include: {
            ticketType: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    maxPerOrder: true,
                },
            },
        },
    });

    if (seats.length != seatIds.length) {
        throw new AppError(
            '部分座位不存在或不屬於此場次',
            400,
            'INVALID_SEATS'
        );
    }

    // 3. 檢查購買上限
    if (seatIds.length > seats[0].ticketType.maxPerOrder) {
        throw Errors.EXCEED_LIMIT;
    }

    // 4. 檢查座位狀態（使用 Redis 分散式鎖）
    const lockId = uuidv4();
    const expiresAt = new Date(Date.now() + LOCK_DURATION * 1000);
    const lockedSeats: number[] = [];

    try {
        for (const seat of seats) {
            const lockKey = `seat:lock:${seat.id}`;

            // 嘗試鎖定（NX = 只在不存在時設定，EX = 過期時間）
            const locked = await redis.set(
                lockKey,
                JSON.stringify({
                    lockId,
                    userId,
                    sessionId,
                }),
                'EX',
                LOCK_DURATION,
                'NX'
            );

            if (!locked) {
                // 鎖定失敗，檢查是否是自己鎖的
                const existing = await redis.get(lockKey);
                if (existing) {
                    const data = JSON.parse(existing);
                    if (data.userId !== userId) {
                        // 別人鎖的，回滾已鎖定的座位
                        throw Errors.SEAT_LOCKED;
                    }
                }
            } else {
                lockedSeats.push(seat.id);
            }
        }
        // 5. 更新資料庫座位狀態
        await prisma.seat.updateMany({
            where: {
                id: {
                    in: lockedSeats,
                },
            },
            data: {
                status: 'locked',
                lockedBy: userId,
                lockedUntil: expiresAt,
            },
        });
        // 6. 儲存用戶鎖定資訊到 Redis
        const userLockKey = `user:locks:${userId}`;
        await redis.hset(
            userLockKey,
            lockId,
            JSON.stringify({
                sessionId,
                seatIds,
                expiresAt: expiresAt.toISOString(),
            })
        );
        await redis.expire(userLockKey, LOCK_DURATION + 60); // 多保留 1 分鐘

        return {
            lockId,
            seats: seats.map((s) => ({
                id: s.id,
                rowName: s.rowName,
                seatNumber: s.seatNumber,
                ticketType: {
                    id: s.ticketType.id,
                    name: s.ticketType.name,
                    price: s.ticketType.price,
                },
            })),
            expiresAt: expiresAt,
        };
    } catch (error) {
        // 回滾已鎖定的座位
        for (const seatId of lockedSeats) {
            await redis.del(`seat:lock:${seatId}`);
        }
        throw error;
    }
}

// 自動選位
export async function autoSelect(input: AutoSelectInput): Promise<LockResult> {
    const { userId, sessionId, ticketTypeId, quantity } = input;

    // 1. 驗證票種
    const ticketType = await prisma.ticketType.findUnique({
        where: {
            id: ticketTypeId,
        },
        include: {
            session: {
                include: {
                    event: true,
                },
            },
        },
    });

    if (!ticketType || ticketType.sessionId !== sessionId) {
        throw new AppError('票種不存在', 400, 'TICKET_TYPE_NOT_FOUND');
    }

    // 2. 檢查購買上限
    if (quantity > ticketType.maxPerOrder) {
        throw Errors.EXCEED_LIMIT;
    }

    // 3. 查詢可用座位
    const availableSeats = await prisma.seat.findMany({
        where: {
            ticketTypeId,
            status: 'available',
        },
        orderBy: [{ rowName: 'asc' }, { seatNumber: 'asc' }],
    });

    // 4. 過濾 Redis 中已被鎖定的座位
    const trulyAvailable: typeof availableSeats = [];

    for (const seat of availableSeats) {
        const lockKey = `seat:lock:${seat.id}`;
        const isLocked = await redis.exists(lockKey);
        if (!isLocked) {
            trulyAvailable.push(seat);
        }
    }

    if (quantity > trulyAvailable.length) {
        throw Errors.INSUFFICIENT_STOCK;
    }

    // 5. 嘗試找連續座位
    const selectSeats = findConsecutiveSeats(trulyAvailable, quantity);

    // 6. 鎖定座位
    return lockSeats({
        userId,
        sessionId,
        seatIds: selectSeats.map((s) => s.id),
    });
}

function findConsecutiveSeats(
    seats: { id: number; rowName: string; seatNumber: string }[],
    quantity: number
): { id: number; rowName: string; seatNumber: string }[] {
    // 按排分組
    const rowMap = new Map<string, typeof seats>();

    for (const seat of seats) {
        const row = rowMap.get(seat.rowName) || [];
        row.push(seat);
        rowMap.set(seat.rowName, row);
    }

    // 在每排中尋找連續座位
    for (const [rowName, rowSeats] of rowMap) {
        // 按座位號排序
        rowSeats.sort(
            (a, b) => parseInt(a.seatNumber) - parseInt(b.seatNumber)
        );

        // 尋找連續座位
        for (let i = 0; i <= rowSeats.length - quantity; i++) {
            let isConsecutive = true;

            for (let j = 0; j < quantity - 1; j++) {
                const current = parseInt(rowSeats[i + j].seatNumber);
                const next = parseInt(rowSeats[i + j + 1].seatNumber);
                if (next !== current + 1) {
                    isConsecutive = false;
                    break;
                }
            }
            if (isConsecutive) {
                console.log(rowName, rowSeats.slice(i, i + quantity));
                return rowSeats.slice(i, i + quantity);
            }
        }
    }

    // 找不到連續座位，返回前 N 個可用座位
    return seats.slice(0, quantity);
}

// 釋放座位
export async function unlockSeats(input: UnlockSeatsInput): Promise<void> {
    const { userId, lockId } = input;

    // 1. 取得鎖定資訊
    const userLockKey = `user:locks:${userId}`;
    const lockData = await redis.hget(userLockKey, lockId);

    if (!lockData) {
        throw new AppError('找不到鎖定記錄', 404, 'LOCK_NOT_FOUND');
    }

    const { seatIds } = JSON.parse(lockData);

    // 2. 釋放 Redis 鎖
    for (const seatId of seatIds) {
        const lockKey = `seat:lock:${seatId}`;
        const existing = await redis.get(lockKey);

        if (existing) {
            const data = JSON.parse(existing);
            // 只能釋放自己的鎖
            if (data.userId === userId && data.lockId === lockId) {
                await redis.del(lockKey);
            }
        }
    }

    // 3. 更新資料庫
    await prisma.seat.updateMany({
        where: {
            id: {
                in: seatIds,
            },
            lockedBy: userId,
        },
        data: {
            status: 'available',
            lockedUntil: null,
            lockedBy: null,
        },
    });

    // 4. 移除用戶鎖定記錄
    await redis.hdel(userLockKey, lockId);
}

// 取得用戶的鎖定座位
export async function getUserLocks(userId: string): Promise<UserLock[]> {
    const userLockKey = `user:locks:${userId}`;
    const locks = await redis.hgetall(userLockKey);

    const result: UserLock[] = [];

    for (const [lockId, data] of Object.entries(locks)) {
        const { sessionId, seatIds, expiresAt } = JSON.parse(data);

        // 檢查是否過期
        if (new Date(expiresAt) < new Date()) {
            // 過期了，清除
            await redis.hdel(userLockKey, lockId);
            continue;
        }

        // 取得座位資訊
        const seats = await prisma.seat.findMany({
            where: { id: { in: seatIds } },
            select: { id: true, rowName: true, seatNumber: true },
        });

        result.push({
            lockId,
            sessionId,
            seats,
            expiresAt,
        });

    }
    return result;
}
