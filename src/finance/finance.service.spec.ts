import { BadRequestException } from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import { FinanceService } from './finance.service';

describe('FinanceService transaction rules', () => {
  const prisma = {
    account: { findFirst: jest.fn() },
    subcategory: { findFirst: jest.fn() },
    transaction: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    cardStatement: { findMany: jest.fn() },
    recurringRule: { findMany: jest.fn() },
    monthlyBudget: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const households = { assertCanWrite: jest.fn(), assertMember: jest.fn(), assertCanManage: jest.fn() };
  const service = new FinanceService(prisma as never, households as never, {} as never);
  const dto = { accountId: 'cl111111111111111111111111', subcategoryId: 'cl222222222222222222222222', type: TransactionType.EXPENSE, amount: 1250, description: 'Mercado', occurredOn: '2026-10-02' };

  beforeEach(() => jest.clearAllMocks());

  it('rejects a transaction when its subcategory belongs to the opposite type', async () => {
    households.assertCanWrite.mockResolvedValue({ role: 'MEMBER' });
    prisma.account.findFirst.mockResolvedValue({ id: dto.accountId });
    prisma.subcategory.findFirst.mockResolvedValue({ id: dto.subcategoryId, categoryId: 'cat_1', category: { type: TransactionType.INCOME } });

    await expect(service.createTransaction('user_1', 'household_1', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queries transactions with tenant scope, filters and pagination', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    prisma.transaction.findMany.mockReturnValue(Promise.resolve([]));
    prisma.transaction.count.mockReturnValue(Promise.resolve(0));
    prisma.$transaction.mockResolvedValue([[], 0]);

    const result = await service.listTransactions('user_1', 'household_1', {
      page: 2, pageSize: 20, type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333', from: '2026-10-01', to: '2026-10-31',
    });

    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 20 });
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 20,
      where: expect.objectContaining({ householdId: 'household_1', type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333' }),
    }));
  });

  it('divides installments in cents deterministically and keeps month-end civil dates', () => {
    expect((service as unknown as { splitAmount(total: number, count: number): number[] }).splitAmount(1000, 3)).toEqual([334, 333, 333]);
    expect((service as unknown as { addMonths(date: string, months: number): Date }).addMonths('2026-01-31', 1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
  });

  it('builds overview aggregates from the requested civil month only', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    (prisma as unknown as { account: { findFirst: jest.Mock; findMany: jest.Mock } }).account = { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([{ initialBalance: 1000, transactions: [], cardPayments: [], outgoingTransfers: [], incomingTransfers: [] }]) };
    prisma.transaction.findMany
      .mockResolvedValueOnce([{ id: 'recent', occurredOn: new Date('2026-04-04T12:00:00.000Z'), amount: 250, type: TransactionType.INCOME, status: 'POSTED', categoryId: 'income', category: { name: 'Salário', color: '#123456' } }])
      .mockResolvedValueOnce([
        { occurredOn: new Date('2026-04-04T12:00:00.000Z'), amount: 250, type: TransactionType.INCOME, status: 'POSTED', categoryId: 'income', category: { name: 'Salário', color: '#123456' } },
        { occurredOn: new Date('2026-04-09T12:00:00.000Z'), amount: 100, type: TransactionType.EXPENSE, status: 'PENDING', categoryId: 'food', category: { name: 'Mercado', color: '#654321' } },
      ])
      .mockResolvedValueOnce([{ amount: 75, type: TransactionType.EXPENSE, status: 'POSTED' }]);
    prisma.cardStatement.findMany.mockResolvedValue([]);
    prisma.recurringRule.findMany.mockResolvedValue([]);
    prisma.monthlyBudget.findMany.mockResolvedValue([{ categoryId: 'food', limitAmount: 500 }]);

    const overview = await service.overview('user_1', 'household_1', '2026-04');

    expect(overview.referenceMonth).toBe('2026-04');
    expect(overview.indicators).toMatchObject({ realizedIncome: 250, realizedExpenses: 0, pendingCommitments: 100, availableBalance: 1000 });
    expect(overview.comparison.expenses).toEqual({ current: 0, previous: 75 });
    expect(overview.charts.expenseByCategory).toEqual([]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ occurredOn: { gte: new Date('2026-04-01T12:00:00.000Z'), lt: new Date('2026-05-01T12:00:00.000Z') } }) }));
  });
});
