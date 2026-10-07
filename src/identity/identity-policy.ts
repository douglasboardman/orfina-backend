import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const emailSchema = z.string().trim().email().max(254);
export const normalizeEmail = (email: string) => emailSchema.parse(email).toLowerCase();
export const reasonSchema = z.string().trim().min(1).max(500);
export function identityError(status: number, code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new HttpException({ statusCode: status, code, message, ...details }, status);
}

// A single transaction-scoped lock serializes access, role and session writes.
// This deliberately favors correctness over throughput in the initial beta.
export async function lockIdentity(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(71411)`;
}

export async function recordIdentity(tx: Prisma.TransactionClient, input: {
  actorUserId?: string; actorType?: 'USER' | 'CLI'; action: string;
  targetId: string; targetType?: string; changes: Prisma.InputJsonValue;
  reason?: string; requestId?: string; event: string; userId?: string;
}) {
  await tx.systemAuditLog.create({ data: {
    actorUserId: input.actorUserId, actorType: input.actorType ?? 'USER',
    action: input.action, targetType: input.targetType ?? 'access-grant',
    targetId: input.targetId, changes: input.changes, reason: input.reason, requestId: input.requestId,
  } });
  await tx.outboxEvent.create({ data: {
    aggregateType: input.targetType ?? 'access-grant', aggregateId: input.targetId,
    eventType: `orfina.identity.${input.event}.v1`, version: 1,
    payload: { targetId: input.targetId, userId: input.userId ?? null,
      actorUserId: input.actorUserId ?? null, actorType: input.actorType ?? 'USER' },
  } });
}
