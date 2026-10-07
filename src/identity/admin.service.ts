import { Injectable } from '@nestjs/common';
import { AccessStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { identityError, lockIdentity, normalizeEmail, recordIdentity } from './identity-policy';

export const userSummary = { id: true, name: true, email: true, systemRole: true, lastLoginAt: true, createdAt: true } as const;
export type AdminActor = { id: string; sessionId: string; requestId?: string };

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertActor(tx: Prisma.TransactionClient, actor: AdminActor) {
    const session = await tx.session.findFirst({ where: {
      id: actor.sessionId, userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() },
      user: { systemRole: 'SYSTEM_ADMIN', accessGrant: { is: { status: 'ENABLED' } } },
    }, select: { id: true } });
    if (!session) identityError(403, 'SYSTEM_ADMIN_REQUIRED', 'Administração do sistema exige permissão ativa.');
  }

  async list(query: { page: number; pageSize: number; search?: string; status?: AccessStatus; linked?: 'yes' | 'no' }) {
    const where: Prisma.AccessGrantWhereInput = {
      status: query.status,
      ...(query.linked ? { userId: query.linked === 'yes' ? { not: null } : null } : {}),
      ...(query.search ? { OR: [
        { normalizedEmail: { contains: query.search.toLowerCase(), mode: 'insensitive' } },
        { user: { is: { name: { contains: query.search, mode: 'insensitive' } } } },
      ] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.accessGrant.findMany({ where, include: { user: { select: userSummary } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.accessGrant.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async detail(id: string) {
    const grant = await this.prisma.accessGrant.findUnique({ where: { id }, include: { user: { select: userSummary } } });
    if (!grant) identityError(404, 'ACCESS_GRANT_NOT_FOUND', 'Autorização não encontrada.');
    const history = await this.prisma.systemAuditLog.findMany({ where: { targetId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
    return { ...grant, history };
  }

  async create(actor: AdminActor, input: { email: string; reason?: string }) {
    return this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      await this.assertActor(tx, actor);
      const normalizedEmail = normalizeEmail(input.email);
      const existing = await tx.accessGrant.findUnique({ where: { normalizedEmail } });
      if (existing) identityError(409, 'EMAIL_ALREADY_AUTHORIZED', 'E-mail já cadastrado. Consulte seu acesso.', { grantId: existing.id });
      // Legacy identities require an operator to bind the grant explicitly.
      const grant = await tx.accessGrant.create({ data: { email: input.email.trim(), normalizedEmail, reason: input.reason,
        createdById: actor.id, updatedById: actor.id } });
      await recordIdentity(tx, { actorUserId: actor.id, action: 'ACCESS_GRANTED', targetId: grant.id,
        changes: { status: { before: null, after: 'ENABLED' } }, reason: input.reason, requestId: actor.requestId, event: 'access-granted' });
      return grant;
    });
  }

  async setStatus(actor: AdminActor, id: string, input: { status: AccessStatus; reason?: string; expectedVersion: number }) {
    return this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      await this.assertActor(tx, actor);
      const grant = await tx.accessGrant.findUnique({ where: { id }, include: { user: true } });
      if (!grant) identityError(404, 'ACCESS_GRANT_NOT_FOUND', 'Autorização não encontrada.');
      if (grant.version !== input.expectedVersion) identityError(409, 'VERSION_CONFLICT', 'O acesso foi alterado. Recarregue e tente novamente.');
      if (grant.status === input.status) return grant;
      if (input.status === 'DISABLED' && grant.user?.systemRole === 'SYSTEM_ADMIN') {
        if (grant.userId === actor.id) identityError(409, 'SELF_DISABLE_FORBIDDEN', 'Você não pode desabilitar seu próprio acesso.');
        const remaining = await tx.user.count({ where: { systemRole: 'SYSTEM_ADMIN', accessGrant: { is: { status: 'ENABLED' } } } });
        if (remaining <= 1) identityError(409, 'LAST_ADMIN_PROTECTED', 'O último administrador ativo está protegido.');
      }
      const updated = await tx.accessGrant.update({ where: { id }, data: { status: input.status, reason: input.reason,
        updatedById: actor.id, version: { increment: 1 } } });
      if (input.status === 'DISABLED' && grant.userId) await tx.session.updateMany({ where: { userId: grant.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await recordIdentity(tx, { actorUserId: actor.id, action: input.status === 'DISABLED' ? 'ACCESS_DISABLED' : 'ACCESS_ENABLED',
        targetId: id, userId: grant.userId ?? undefined, changes: { status: { before: grant.status, after: input.status } },
        reason: input.reason, requestId: actor.requestId, event: input.status === 'DISABLED' ? 'access-disabled' : 'access-enabled' });
      return updated;
    });
  }

  async revoke(actor: AdminActor, userId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockIdentity(tx);
      await this.assertActor(tx, actor);
      const grant = await tx.accessGrant.findUnique({ where: { userId } });
      if (!grant) identityError(404, 'ACCESS_GRANT_NOT_FOUND', 'Autorização não encontrada.');
      const result = await tx.session.updateMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
      if (result.count) await recordIdentity(tx, { actorUserId: actor.id, action: 'SESSIONS_REVOKED', targetId: grant.id,
        userId, changes: { revokedCount: result.count }, reason, requestId: actor.requestId, event: 'sessions-revoked' });
      return { revokedCount: result.count };
    });
  }

  async audit(query: { page: number; pageSize: number; action?: string; actorUserId?: string; targetId?: string; from?: Date; to?: Date }) {
    const where: Prisma.SystemAuditLogWhereInput = { action: query.action, actorUserId: query.actorUserId, targetId: query.targetId,
      createdAt: { gte: query.from, lte: query.to } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.systemAuditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.systemAuditLog.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
