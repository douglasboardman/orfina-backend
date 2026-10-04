import { ForbiddenException } from '@nestjs/common';
import { EventsService } from './events.service';

describe('EventsService operational outbox controls', () => {
  const tx = { outboxEvent: { update: jest.fn() }, auditLog: { create: jest.fn() } };
  const prisma = {
    outboxEvent: { findMany: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
    householdMember: { findUnique: jest.fn() },
    $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const service = new EventsService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('returns failed-event metadata only for an administered household', async () => {
    prisma.householdMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.outboxEvent.findMany.mockResolvedValue([
      { id: 'event_1', aggregateType: 'transaction', aggregateId: 'transaction_1', eventType: 'orfina.transactions.transaction-posted.v1', attempts: 10, createdAt: new Date() },
    ]);

    await expect(service.listFailedForHousehold('user_1', 'household_1')).resolves.toEqual([
      expect.objectContaining({ id: 'event_1', eventType: 'orfina.transactions.transaction-posted.v1' }),
    ]);
    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ payload: { path: ['householdId'], equals: 'household_1' } }) }));
  });

  it('rejects requeue by a non-administrator', async () => {
    prisma.householdMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(service.requeueFailedForHousehold('user_1', 'household_1', 'event_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requeues only a failed event whose payload belongs to the household and audits it', async () => {
    prisma.householdMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.outboxEvent.findFirst.mockResolvedValue({ id: 'event_1' });

    await expect(service.requeueFailedForHousehold('user_1', 'household_1', 'event_1')).resolves.toEqual({ id: 'event_1', status: 'PENDING' });
    expect(tx.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', attempts: 0 }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ householdId: 'household_1', action: 'requeued' }) }));
  });
});
