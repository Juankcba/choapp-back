import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateUsers() {
  console.log('Starting user update with raw MongoDB query...');
  try {
    const result = await prisma.$runCommandRaw({
      update: 'User',
      updates: [
        {
          q: { identityStatus: { $exists: false } },
          u: { $set: { identityStatus: 'unverified' } },
          multi: true
        }
      ]
    });
    console.log(`Command result:`, result);
  } catch (error) {
    console.error('Error updating users:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateUsers();
