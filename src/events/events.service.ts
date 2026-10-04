import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HouseholdRole, OutboxStatus, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DomainEvent = {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
  version?: number;
};

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: Prisma.TransactionClient | PrismaClient, event: DomainEvent) {
    return tx.outboxEvent.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        version: event.version ?? 1,
        payload: event.payload,
      },
    });
  }

  async outboxMetrics() {
    const [groups, nextRetry] = await Promise.all([
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.findFirst({ where: { status: 'PENDING', nextAttemptAt: { not: null } }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
    ]);
    const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
    return {
      generatedAt: new Date().toISOString(),
      pending: counts.PENDING ?? 0,
      published: counts.PUBLISHED ?? 0,
      failed: counts.FAILED ?? 0,
      nextRetryAt: nextRetry?.nextAttemptAt?.toISOString() ?? null,
    };
  }

  async listFailedForHousehold(userId: string, householdId: string) {
    await this.assertCanManage(userId, householdId);
    const failed = await this.prisma.outboxEvent.findMany({
      where: { status: OutboxStatus.FAILED, payload: { path: ['householdId'], equals: householdId } },
      select: { id: true, aggregateType: true, aggregateId: true, eventType: true, attempts: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return failed;
  }

  async requeueFailedForHousehold(userId: string, householdId: string, eventId: string) {
    await this.assertCanManage(userId, householdId);
    const event = await this.prisma.outboxEvent.findFirst({ where: { id: eventId, status: OutboxStatus.FAILED, payload: { path: ['householdId'], equals: householdId } } });
    if (!event) throw new NotFoundException('Evento falho não encontrado neste grupo.');
    await this.prisma.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { status: OutboxStatus.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null, claimToken: null, claimedAt: null },
      });
      await tx.auditLog.create({
        data: { householdId, actorId: userId, aggregateType: 'outbox-event', aggregateId: event.id, action: 'requeued', changedFields: ['status', 'attempts', 'nextAttemptAt', 'lastError'] },
      });
    });
    return { id: event.id, status: OutboxStatus.PENDING };
  }

  private async assertCanManage(userId: string, householdId: string) {
    const membership = await this.prisma.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } }, select: { role: true } });
    if (!membership || (membership.role !== HouseholdRole.OWNER && membership.role !== HouseholdRole.ADMIN)) {
      throw new ForbiddenException('Seu perfil não pode administrar a outbox deste grupo.');
    }
  }
}
