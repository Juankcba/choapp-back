import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const adminEmail = process.env.ADMIN_EMAIL || 'cho.live.app@gmail.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChoAdmin2026!';

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const admin = await prisma.user.upsert({
        where: { email: adminEmail },
        update: {
            role: 'admin',
            password: hashedPassword,
            name: 'CHO Admin',
            firstName: 'CHO',
            lastName: 'Admin',
        },
        create: {
            email: adminEmail,
            password: hashedPassword,
            role: 'admin',
            name: 'CHO Admin',
            firstName: 'CHO',
            lastName: 'Admin',
        },
    });

    console.log(`✅ Admin account created/updated: ${admin.email} (ID: ${admin.id})`);
}

main()
    .catch((e) => {
        console.error('❌ Seed error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
