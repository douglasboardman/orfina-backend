import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { identityError, lockIdentity, normalizeEmail, recordIdentity, reasonSchema } from './identity-policy';

export const operatorSchema = z.object({ action: z.enum(['bootstrap', 'promote', 'demote', 'recover', 'bind', 'revoke-all']),
  email: z.string().email().max(254).optional(), googleSub: z.string().regex(/^[0-9]{1,255}$/).optional(), reason: reasonSchema.optional(), dryRun: z.boolean().default(false) }).strict();
export async function operateAdmin(prisma: PrismaClient, raw: z.input<typeof operatorSchema>) {
  const input = operatorSchema.parse(raw);
  if (input.action !== 'revoke-all' && (!input.email || !input.googleSub)) identityError(422, 'VALIDATION_ERROR', 'Informe e-mail e identificador Google validado.');
  if (input.action !== 'bootstrap' && !input.reason) identityError(422, 'VALIDATION_ERROR', 'Informe um motivo operacional.');
  return prisma.$transaction(async (tx) => {
    await lockIdentity(tx);
    if (input.action === 'revoke-all') {
      const count = await tx.session.count({ where: { revokedAt: null } });
      if (!input.dryRun) {
        await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
        await recordIdentity(tx, { actorType: 'CLI', action: 'ALL_SESSIONS_REVOKED', targetType: 'system', targetId: 'sessions',
          changes: { revokedCount: count }, reason: input.reason, event: 'sessions-revoked' });
      }
      return { action: input.action, dryRun: input.dryRun, count };
    }
    const normalizedEmail = normalizeEmail(input.email!);
    let user = await tx.user.findUnique({ where: { googleId: input.googleSub! } });
    const collision = await tx.user.findFirst({ where: { email: { equals: input.email!, mode: 'insensitive' }, ...(user ? { id: { not: user.id } } : {}) } });
    if (collision) identityError(409, 'IDENTITY_CONFLICT', 'E-mail associado a outra identidade; reconcilie antes de continuar.');
    let grant = await tx.accessGrant.findUnique({ where: { normalizedEmail } });
    const linked = user ? await tx.accessGrant.findUnique({ where: { userId: user.id } }) : null;
    if (linked && linked.id !== grant?.id) identityError(409, 'IDENTITY_CONFLICT', 'Identidade já vinculada a outra autorização.');
    if (grant?.userId && grant.userId !== user?.id) identityError(409, 'IDENTITY_CONFLICT', 'Autorização vinculada a outra identidade.');
    const activeAdmins = await tx.user.count({ where: { systemRole: 'SYSTEM_ADMIN', accessGrant: { is: { status: 'ENABLED' } } } });
    if (input.action === 'bootstrap') {
      if (user?.systemRole === 'SYSTEM_ADMIN' && grant?.status === 'ENABLED' && grant.userId === user.id) return { unchanged: true, userId: user.id };
      if (activeAdmins || grant?.status === 'DISABLED') identityError(409, 'BOOTSTRAP_CONFLICT', 'Bootstrap não pode substituir administradores ou reativar autorizações.');
    }
    if (input.action === 'demote') {
      if (!user || !grant) identityError(404, 'ACCESS_GRANT_NOT_FOUND', 'Usuário autorizado não encontrado.');
      if (user.systemRole === 'SYSTEM_ADMIN' && grant.status === 'ENABLED' && activeAdmins <= 1) identityError(409, 'LAST_ADMIN_PROTECTED', 'O último administrador ativo está protegido.');
    }
    if (input.action === 'promote' && (!user || grant?.status !== 'ENABLED')) identityError(409, 'ACCESS_DENIED', 'Promova somente uma identidade já autorizada e vinculada.');
    if (input.action === 'bind' && grant?.status === 'DISABLED') identityError(409, 'ACCESS_DENIED', 'Vínculo não pode reabilitar autorização desabilitada.');
    if (input.dryRun) return { action: input.action, dryRun: true, email: input.email, existingUser: Boolean(user) };
    const before = { role: user?.systemRole ?? null, status: grant?.status ?? null, linked: Boolean(grant?.userId) };
    if (!user) user = await tx.user.create({ data: { email: input.email!, name: input.email!, googleId: input.googleSub! } });
    if (!grant) grant = await tx.accessGrant.create({ data: { email: input.email!, normalizedEmail, userId: user.id,
      source: input.action === 'bootstrap' ? 'BOOTSTRAP' : 'MANUAL', reason: input.reason } });
    else grant = await tx.accessGrant.update({ where: { id: grant.id }, data: { userId: user.id,
      ...(input.action === 'recover' ? { status: 'ENABLED' } : {}), reason: input.reason, version: { increment: 1 } } });
    const role = input.action === 'demote' ? 'USER' : input.action === 'bind' ? user.systemRole : 'SYSTEM_ADMIN';
    await tx.user.update({ where: { id: user.id }, data: { systemRole: role } });
    await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordIdentity(tx, { actorType: 'CLI', action: ({ bootstrap: 'ADMIN_BOOTSTRAPPED', recover: 'ADMIN_RECOVERED', bind: 'ACCESS_LINKED', promote: 'ADMIN_PROMOTED', demote: 'ADMIN_DEMOTED' } as const)[input.action], targetId: grant.id, userId: user.id,
      changes: { before, after: { role, status: grant.status, linked: true } }, reason: input.reason,
      event: input.action === 'bootstrap' ? 'admin-bootstrapped' : input.action === 'recover' ? 'admin-recovered' : input.action === 'bind' ? 'access-linked' : 'admin-role-changed' });
    return { action: input.action, userId: user.id, grantId: grant.id };
  });
}
