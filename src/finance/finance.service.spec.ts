import { BadRequestException } from '@nestjs/common';
import { RecurringMaterializationMode, TransactionType } from '@prisma/client';
import { FinanceService } from './finance.service';

describe('FinanceService transaction rules', () => {
  const prisma = {
    account: { findFirst: jest.fn(), findMany: jest.fn() },
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

  it('only converts a standalone transaction and preserves its financial type', async () => {
    households.assertCanWrite.mockResolvedValue({ role: 'MEMBER' });
    prisma.transaction.findFirst.mockResolvedValue({ id: 'transaction_1', type: TransactionType.EXPENSE, installmentPurchaseId: 'purchase_1', recurringRuleId: null });
    prisma.account.findFirst.mockResolvedValue({ id: dto.accountId });
    prisma.subcategory.findFirst.mockResolvedValue({ id: dto.subcategoryId, category: { type: TransactionType.EXPENSE } });

    await expect(service.convertTransaction('user_1', 'household_1', 'transaction_1', { mode: 'FIXED', ...dto, startOn: dto.occurredOn })).rejects.toBeInstanceOf(BadRequestException);

    prisma.transaction.findFirst.mockResolvedValue({ id: 'transaction_1', type: TransactionType.EXPENSE, installmentPurchaseId: null, recurringRuleId: null });
    await expect(service.convertTransaction('user_1', 'household_1', 'transaction_1', { mode: 'FIXED', ...dto, type: TransactionType.INCOME, startOn: dto.occurredOn })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queries the month ledger with tenant scope, filters and pagination', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    prisma.transaction.findMany.mockReturnValue(Promise.resolve([]));
    prisma.transaction.count.mockReturnValue(Promise.resolve(0));
    prisma.recurringRule.findMany.mockResolvedValue([]);
    prisma.$transaction.mockResolvedValue([[], 0]);

    const result = await service.listTransactions('user_1', 'household_1', {
      page: 2, pageSize: 20, type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333', from: '2026-10-01', to: '2026-10-31',
    });

    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 20 });
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ householdId: 'household_1', type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333' }),
    }));
  });

  it('divides installments in cents deterministically and keeps month-end civil dates', () => {
    expect((service as unknown as { splitAmount(total: number, count: number): number[] }).splitAmount(1000, 3)).toEqual([334, 333, 333]);
    expect((service as unknown as { addMonths(date: string, months: number): Date }).addMonths('2026-01-31', 1).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect((service as unknown as { addMonths(date: string, months: number): Date }).addMonths('2026-01-08', 9).toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('builds overview aggregates from the requested civil month only', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    prisma.account.findMany.mockResolvedValue([{
        initialBalance: 1000,
        transactions: [
          { occurredOn: new Date('2026-03-10T12:00:00.000Z'), amount: 50, type: TransactionType.EXPENSE, status: 'POSTED' },
          { occurredOn: new Date('2026-04-04T12:00:00.000Z'), amount: 250, type: TransactionType.INCOME, status: 'POSTED' },
        ],
        cardPayments: [{ paidOn: new Date('2026-04-20T12:00:00.000Z'), amount: 25 }],
        outgoingTransfers: [{ occurredOn: new Date('2026-04-10T12:00:00.000Z'), amount: 100, status: 'POSTED' }],
        incomingTransfers: [{ occurredOn: new Date('2026-03-20T12:00:00.000Z'), amount: 50, status: 'POSTED' }],
    }]);
    prisma.transaction.findMany
      .mockResolvedValueOnce([{ id: 'recent', occurredOn: new Date('2026-04-04T12:00:00.000Z'), amount: 250, type: TransactionType.INCOME, status: 'POSTED', subcategory: { categoryId: 'income', category: { name: 'Salário', color: '#123456' } } }])
      .mockResolvedValueOnce([
        { occurredOn: new Date('2026-04-04T12:00:00.000Z'), amount: 250, type: TransactionType.INCOME, status: 'POSTED', subcategory: { categoryId: 'income', category: { name: 'Salário', color: '#123456' } } },
        { occurredOn: new Date('2026-04-09T12:00:00.000Z'), amount: 100, type: TransactionType.EXPENSE, status: 'PENDING', subcategory: { categoryId: 'food', category: { name: 'Mercado', color: '#654321' } } },
      ])
      .mockResolvedValueOnce([{ amount: 75, type: TransactionType.EXPENSE, status: 'POSTED' }])
      .mockResolvedValueOnce([]);
    prisma.cardStatement.findMany.mockResolvedValue([]);
    prisma.recurringRule.findMany.mockResolvedValue([]);
    prisma.monthlyBudget.findMany.mockResolvedValue([{ categoryId: 'food', limitAmount: 500 }]);

    const overview = await service.overview('user_1', 'household_1', '2026-04');

    expect(overview.referenceMonth).toBe('2026-04');
    expect(overview.indicators).toMatchObject({ realizedIncome: 250, realizedExpenses: 0, pendingCommitments: 100, availableBalance: 1125 });
    expect(overview.accounts[0].balance).toBe(1125);
    expect(overview.comparison.expenses).toEqual({ current: 0, previous: 75 });
    expect(overview.charts.expenseByCategory).toEqual([]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ occurredOn: { gte: new Date('2026-04-01T12:00:00.000Z'), lt: new Date('2026-05-01T12:00:00.000Z') } }) }));
    expect(prisma.account.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        transactions: { where: { status: 'POSTED', occurredOn: { lt: new Date('2026-05-01T12:00:00.000Z') } } },
        cardPayments: { where: { paidOn: { lt: new Date('2026-05-01T12:00:00.000Z') } } },
        outgoingTransfers: { where: { status: 'POSTED', occurredOn: { lt: new Date('2026-05-01T12:00:00.000Z') } } },
        incomingTransfers: { where: { status: 'POSTED', occurredOn: { lt: new Date('2026-05-01T12:00:00.000Z') } } },
      }),
    }));
  });

  it('projects only missing recurring occurrences into a future reference month', () => {
    const project = (service as unknown as { projectRecurringOccurrences(rules: unknown[], end: Date, existing: Set<string>): Array<{ occurredOn: Date; isForecast: boolean }> }).projectRecurringOccurrences.bind(service);
    const category = { id: 'cat_1', name: 'Moradia', color: '#123456', icon: 'home' };
    const rules = [{ id: 'rule_1', householdId: 'household_1', accountId: 'account_1', cardId: null, subcategoryId: 'sub_1', type: TransactionType.EXPENSE, amount: 9900, description: 'Aluguel', notes: null, startOn: new Date('2026-10-08T12:00:00.000Z'), endOn: new Date('2027-10-08T12:00:00.000Z'), account: {}, card: null, category, subcategory: { id: 'sub_1', name: 'Aluguel', categoryId: 'cat_1', isDefault: true, isActive: true } }];
    const projected = project(rules, new Date('2026-12-01T12:00:00.000Z'), new Set(['rule_1:2026-10-08']));
    expect(projected.map((item) => item.occurredOn.toISOString().slice(0, 10))).toEqual(['2026-11-08']);
    expect(projected[0].isForecast).toBe(true);
  });

  it('calculates the household launch marker without changing the civil occurrence date', () => {
    const launchOn = (service as unknown as { recurringLaunchOn(occurredOn: Date, mode: RecurringMaterializationMode, value: number): Date }).recurringLaunchOn.bind(service);
    const occurrence = new Date('2026-11-08T12:00:00.000Z');

    expect(launchOn(occurrence, RecurringMaterializationMode.ON_OCCURRENCE_DATE, 0).toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(launchOn(occurrence, RecurringMaterializationMode.EXERCISE_MONTH_DAY, 5).toISOString()).toBe('2026-11-05T12:00:00.000Z');
    expect(launchOn(occurrence, RecurringMaterializationMode.DAYS_BEFORE_EXERCISE_MONTH, 10).toISOString()).toBe('2026-10-22T12:00:00.000Z');
  });
});
