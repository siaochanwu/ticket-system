import { buildApp } from './src/app.js';

const app = await buildApp();
await app.ready();

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

console.log('Status:', response.statusCode);
console.log('Body:', response.body);
console.log('Parsed:', JSON.parse(response.body));

await app.close();
process.exit(0);
