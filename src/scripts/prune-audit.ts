import { PrismaClient } from '@prisma/client';
import { lockIdentity, recordIdentity } from '../identity/identity-policy';
async function main() {
  const execute = process.argv.slice(2).includes('--execute');
  const prisma = new PrismaClient();
  try {
    const cutoff = new Date(Date.now() - 180 * 86400000);
    const count = await prisma.systemAuditLog.count({ where: { createdAt: { lt: cutoff } } });
    if (execute && count) await prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      const deleted = await tx.systemAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      await recordIdentity(tx, { actorType: 'CLI', action: 'AUDIT_RETENTION_APPLIED', targetType: 'system', targetId: 'audit', changes: { deletedCount: deleted.count, retentionDays: 180 }, reason: 'Retention policy', event: 'audit-retention-applied' });
    });
    console.log({ dryRun: !execute, retentionDays: 180, eligibleCount: count });
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { console.error('Não foi possível aplicar a retenção. Nenhum detalhe sensível foi exibido.'); process.exitCode = 1; });
