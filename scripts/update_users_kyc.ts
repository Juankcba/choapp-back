import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateUsers() {
  console.log('Starting user update...');
  try {
    const result = await prisma.user.updateMany({
      where: {
        identityStatus: {
          notIn: ['verified', 'pending', 'rejected']
        } // This catches null, undefined, unverified, or missing.
      },
      data: {
        identityStatus: 'unverified'
      }
    });
    console.log(`Successfully updated ${result.count} users to "unverified" status.`);
  } catch (error) {
    console.error('Error updating users:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateUsers();
