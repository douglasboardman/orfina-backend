import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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
    const [groups, nextRetry, latestFailure] = await Promise.all([
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.findFirst({ where: { status: 'PENDING', nextAttemptAt: { not: null } }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
      this.prisma.outboxEvent.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { id: true, eventType: true, attempts: true, lastError: true, createdAt: true } }),
    ]);
    const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
    return {
      generatedAt: new Date().toISOString(),
      pending: counts.PENDING ?? 0,
      published: counts.PUBLISHED ?? 0,
      failed: counts.FAILED ?? 0,
      nextRetryAt: nextRetry?.nextAttemptAt?.toISOString() ?? null,
      latestFailure,
    };
  }
}
