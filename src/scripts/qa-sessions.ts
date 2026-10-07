import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { writeFile } from 'node:fs/promises';
import { AuthService } from '../auth/auth.service';
async function main() {
  const db = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(db.hostname) || !/_(delivery11|test)$/.test(db.pathname)) throw new Error('Isolated QA database required');
  const destination = process.env.ORFINA_QA_SESSION_FILE;
  if (!destination?.startsWith('/tmp/orfina-qa-')) throw new Error('Private temporary file required');
  const prisma = new PrismaClient();
  try {
    const auth = new AuthService(prisma as never, new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '15m' } }));
    const result: Record<string, unknown> = {};
    for (const [kind, role] of [['admin', 'SYSTEM_ADMIN'], ['member', 'USER']] as const) {
      const email = `qa-${kind}@example.test`;
      const user = await prisma.user.upsert({ where: { email }, create: { email, name: `QA ${kind}`, systemRole: role }, update: { systemRole: role } });
      await prisma.accessGrant.upsert({ where: { normalizedEmail: email }, create: { email, normalizedEmail: email, userId: user.id }, update: { userId: user.id, status: 'ENABLED' } });
      const issued = await auth.createSession(user);
      result[kind] = { userId: user.id, token: issued.token, csrf: issued.csrf };
    }
    await writeFile(destination, JSON.stringify(result), { mode: 0o600 });
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error('QA fixture refused; check isolated configuration.'); process.exitCode = 1; });
