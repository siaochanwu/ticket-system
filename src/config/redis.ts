import Redis from "ioredis";
import config from "./index.js";

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3, // 每個請求最多重試 3 次
  retryStrategy: (times) => {
    // 重試策略
    const delay = Math.min(times * 50, 2000); // 最多等待 2 秒
    return delay;
  },
});

redis.on("connect", () => {
  console.log("Redis connected");
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

redis.on("ready", () => {
  console.log("Redis ready");
});

export const redisUtils = {
  /**
   * 取得庫存
   */
  async getStock(ticketTypeId: number): Promise<number> {
    const stock = await redis.get(`inventory: ${ticketTypeId}`);
    return parseInt(stock || "0", 10);
  },

  /**
   * 設定庫存
   */
  async setStock(ticketTypeId:number, quantity: number): Promise<void> {
    await redis.set(`inventory: ${ticketTypeId}`, quantity);
  },

  /**
   * 扣減庫存（原子操作）
   * 返回扣減後的庫存，如果庫存不足返回 -1
   */
  async decrementStock(ticketTypeId: number, quantity: number): Promise<number> {
    const key = `inventory: ${ticketTypeId}`;

    // 使用 Lua Script 確保原子性
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or 0)
      if current >= tonumber(ARGV[1]) then
       return redis.call('DECRBY', KEYS[1], ARGV[1])
      else
       return -1
      end
    `;

    const result = await redis.eval(script, 1, key, quantity);
    return result;
  },

  /**
   * 增加庫存（退票時使用）
   */
  async incrementStock(ticketTypeId: number, quantity: number): Promise<number> {
    const key = `inventory: ${ticketTypeId}`;
    return await redis.incrby(key, quantity);
  },

  /**
   * 健康檢查
   */
  async healthCheck(): Promise<boolean> {
    try {
        const result = await redis.ping();
        return result === 'PONG';
    } catch (err) {
        return false;
    }
  }
};

// 關閉連線（程式結束時呼叫）
export async function closeRedis(): Promise<void> {
    await redis.quit();
    console.log("Redis connection closed");
}

export default redis;