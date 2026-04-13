import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Hash password
  const passwordHash = await bcrypt.hash('password123', 10);

  console.log('Seeding data...');

  // 1. Create Users
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      passwordHash,
      realName: 'Administrator',
      role: 'ADMIN',
      isVerified: true,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'user@example.com' },
    update: {},
    create: {
      email: 'user@example.com',
      passwordHash,
      realName: 'Test User',
      role: 'USER',
      isVerified: true,
    },
  });

  console.log('Users created:', { adminEmail: admin.email, userEmail: user.email });

  // 2. Create Event, Session and Ticket Types
  const event = await prisma.event.create({
    data: {
      title: '2026 泰勒絲巡迴演唱會 - 台北站',
      description: '泰勒絲即將來到台北大巨蛋開唱！萬眾矚目的巡迴演唱會，錯過不再。',
      venue: '台北大巨蛋',
      saleStartAt: new Date(),
      status: 'active',
      sessions: {
        create: [
          {
            sessionDate: new Date('2026-05-01'),
            sessionTime: '19:00',
            status: 'active',
            ticketTypes: {
              create: [
                {
                  name: 'VIP 搖滾區',
                  price: 8800,
                  totalQuantity: 100,
                  maxPerOrder: 2,
                },
                {
                  name: '一般看台區',
                  price: 4800,
                  totalQuantity: 500,
                  maxPerOrder: 4,
                },
                {
                  name: '身障優待票',
                  price: 2400,
                  totalQuantity: 20,
                  maxPerOrder: 2,
                }
              ],
            },
          },
        ],
      },
    },
  });

  console.log('Event created:', event.title);
  console.log('Seed data created successfully! 🎫');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
