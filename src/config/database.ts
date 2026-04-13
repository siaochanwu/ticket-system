import { PrismaClient } from '@prisma/client';
import config from './index.js';

const prisma = new PrismaClient({
    //建立資料庫連線
    log: config.isDev ? ['query', 'info', 'warn', 'error'] : ['error'],
});

prisma
    .$connect()
    .then(() => console.log('Database connected'))
    .catch((err) => {
        console.error('❌ Database connection failed:', err);
        process.exit(1);
    });

export default prisma; 