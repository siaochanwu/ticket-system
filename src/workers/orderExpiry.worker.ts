import crypto from 'crypto';
import config from '../config/index.js';
import prisma from '../config/database.js';
import { closeRedis } from '../config/redis.js';
import {
    expireOverdueOrders,
    reclaimAbandonedSeatLocks,
    withLeaderLock,
} from './orderExpiry.service.js';

const instanceId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// tick() 整批失敗（例如 DB／Redis 斷線）連續達到這個次數，
// 就視為系統性故障、直接結束程序讓 docker 的 restart policy 接手，
// 避免進程「活著」但什麼都做不了、卻沒有任何訊號能被發現。
const MAX_CONSECUTIVE_FAILURES = 5;

let running = true;
let currentTick: Promise<unknown> = Promise.resolve();
let consecutiveFailures = 0;

async function tick() {
    // 兩種回收共用同一把 leader lock，確保同一輪只有一個實例在動座位
    const result = await withLeaderLock(instanceId, async () => {
        const expiredOrders = await expireOverdueOrders();
        const releasedSeats = await reclaimAbandonedSeatLocks();
        return { expiredOrders, releasedSeats };
    });

    if (result === null) {
        // 其他實例正在處理這一輪
        return;
    }

    if (result.expiredOrders > 0) {
        console.log(
            `[orderExpiry] 已回收 ${result.expiredOrders} 筆逾期訂單`
        );
    }

    if (result.releasedSeats > 0) {
        console.log(
            `[orderExpiry] 已釋放 ${result.releasedSeats} 個孤兒座位鎖`
        );
    }
}

async function loop() {
    while (running) {
        currentTick = tick()
            .then(() => {
                // 單筆訂單失敗已經在 expireOverdueOrders 內部吞掉，
                // 能跑到這裡代表整個 tick（取鎖＋兩個回收函式）沒有整批失敗
                consecutiveFailures = 0;
            })
            .catch((error) => {
                consecutiveFailures += 1;
                console.error(
                    `[orderExpiry] tick 失敗（連續第 ${consecutiveFailures} 次）`,
                    error
                );

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.error(
                        `[orderExpiry] 連續失敗達 ${MAX_CONSECUTIVE_FAILURES} 次，判定為系統性故障，結束程序讓 restart policy 接手`
                    );
                    process.exit(1);
                }
            });
        await currentTick;

        if (!running) break;

        await new Promise((resolve) =>
            setTimeout(resolve, config.worker.orderExpiryIntervalMs)
        );
    }
}

async function shutdown(signal: string) {
    console.log(`\n📴 [orderExpiry] 收到 ${signal}，準備關閉`);

    running = false;
    await currentTick;

    await prisma.$disconnect();
    await closeRedis();

    console.log('👋 [orderExpiry] worker 已關閉');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(
    `🔁 [orderExpiry] worker 啟動 (instance=${instanceId}, interval=${config.worker.orderExpiryIntervalMs}ms)`
);

loop();
