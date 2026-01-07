import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        env: {
            NODE_ENV: 'test',
        },
        coverage: {
            reporter: ['text', 'html'],
        },
        // 測試檔案依序執行（避免資料庫衝突）
        sequence: {
            concurrent: false,
        },
        // 每個測試檔案的超時時間
        testTimeout: 10000,
        // 禁用文件內並行執行
        fileParallelism: false,
        // 禁用測試內並行執行
        maxConcurrency: 1,
    },
});
