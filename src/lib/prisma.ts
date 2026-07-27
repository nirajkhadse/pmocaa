import { PrismaClient } from '@/generated/prisma'
import { PrismaPg } from '@prisma/adapter-pg'

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set')
  }
  // Supabase's session pooler has a small per-project client limit. Keep the
  // development pool compact so a single Next.js process does not reserve most
  // of the available sessions.
  const adapter = new PrismaPg({
    connectionString,
    // The local app uses Supabase's transaction pooler (port 6543), so a
    // modest concurrent pool is safe and prevents read polling from blocking
    // task-assignment writes behind only one or two long-running queries.
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
