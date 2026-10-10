import { BadRequestException, ConflictException } from '@nestjs/common';
import { RecurringMaterializationMode, TransactionType } from '@prisma/client';
import { FinanceService } from './finance.service';

describe('FinanceService transaction rules', () => {
  const prisma = {
    account: { findFirst: jest.fn(), findMany: jest.fn() },
    card: { findFirst: jest.fn(), findMany: jest.fn() },
    subcategory: { findFirst: jest.fn() },
    transaction: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    cardStatement: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    recurringRule: { findMany: jest.fn(), count: jest.fn() },
    installmentPurchase: { count: jest.fn() },
    monthlyBudget: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const households = { assertCanWrite: jest.fn(), assertMember: jest.fn(), assertCanManage: jest.fn() };
  const service = new FinanceService(prisma as never, households as never, {} as never);
  const dto = { accountId: 'cl111111111111111111111111', subcategoryId: 'cl222222222222222222222222', type: TransactionType.EXPENSE, amount: 1250, description: 'Mercado', occurredOn: '2026-10-02' };

  beforeEach(() => { jest.clearAllMocks(); prisma.cardStatement.findMany.mockResolvedValue([]); });

  it('rejects a transaction when its subcategory belongs to the opposite type', async () => {
    households.assertCanWrite.mockResolvedValue({ role: 'MEMBER' });
    prisma.account.findFirst.mockResolvedValue({ id: dto.accountId });
    prisma.subcategory.findFirst.mockResolvedValue({ id: dto.subcategoryId, categoryId: 'cat_1', category: { type: TransactionType.INCOME } });

    await expect(service.createTransaction('user_1', 'household_1', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps an archived card when it has a financial record linked to it', async () => {
    households.assertCanManage.mockResolvedValue({ role: 'MANAGER' });
    prisma.card.findFirst.mockResolvedValue({ id: 'card_1', householdId: 'household_1', isActive: false });
    prisma.transaction.count.mockResolvedValue(1);
    prisma.cardStatement.count.mockResolvedValue(0);
    prisma.installmentPurchase.count.mockResolvedValue(0);
    prisma.recurringRule.count.mockResolvedValue(0);

    await expect(service.deleteArchivedItem('user_1', 'household_1', 'CARD', 'card_1')).rejects.toBeInstanceOf(ConflictException);
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
          { occurredOn: new Date('2026-04-09T12:00:00.000Z'), amount: 100, type: TransactionType.EXPENSE, status: 'PENDING' },
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
      .mockResolvedValueOnce([{ occurredOn: new Date('2026-03-10T12:00:00.000Z'), amount: 75, type: TransactionType.EXPENSE, status: 'POSTED' }])
      .mockResolvedValueOnce([]);
    prisma.cardStatement.findMany.mockResolvedValue([]);
    prisma.recurringRule.findMany.mockResolvedValue([]);
    prisma.monthlyBudget.findMany.mockResolvedValue([{ categoryId: 'food', limitAmount: 500 }]);

    const overview = await service.overview('user_1', 'household_1', '2026-04');

    expect(overview.referenceMonth).toBe('2026-04');
    expect(overview.indicators).toMatchObject({ realizedIncome: 250, realizedExpenses: 0, pendingCommitments: 100, availableBalance: 1125, previousMonthAvailableBalance: 1000, projectedAvailableBalance: 1025 });
    expect(overview.accounts[0].balance).toBe(1125);
    expect(overview.accounts[0].projectedBalance).toBe(1025);
    expect(overview.comparison.expenses).toEqual({ current: 0, previous: 75 });
    expect(overview.charts.expenseByCategory).toEqual([]);
    expect(overview.charts.projectedWeeklyFlow[1]).toEqual({ week: 2, income: 0, expenses: 100 });
    expect(overview.charts.projectedExpenseByCategory).toEqual([{ categoryId: 'food', name: 'Mercado', color: '#654321', amount: 100 }]);
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ householdId: 'household_1', OR: expect.arrayContaining([{ cardId: { not: null }, statement: { dueOn: { gte: new Date('2026-04-01T12:00:00.000Z'), lt: new Date('2026-05-01T12:00:00.000Z') } } }]) }) }));
    expect(prisma.account.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        transactions: { where: { deletedAt: null } },
        cardPayments: true,
        outgoingTransfers: { where: { deletedAt: null } },
        incomingTransfers: { where: { deletedAt: null } },
      }),
    }));
  });

  it.each(['00', '12'])('keeps civil balance boundaries when persisted dates return at %s:00 UTC', async (hour) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    try {
      const date = (day: string) => new Date(`${day}T${hour}:00:00.000Z`);
      const ledger = [
        { occurredOn: date('2026-10-31'), amount: 100, type: TransactionType.INCOME, status: 'POSTED' },
        { occurredOn: date('2026-11-01'), amount: 200, type: TransactionType.INCOME, status: 'POSTED' },
        { occurredOn: date('2026-11-16'), amount: 500, type: TransactionType.INCOME, status: 'POSTED' },
        { occurredOn: date('2026-11-30'), amount: 300, type: TransactionType.EXPENSE, status: 'PENDING' },
        { occurredOn: date('2026-12-01'), amount: 9000, type: TransactionType.INCOME, status: 'POSTED' },
        { occurredOn: date('2026-12-01'), amount: 8000, type: TransactionType.EXPENSE, status: 'PENDING' },
      ];
      prisma.account.findMany.mockResolvedValue([{
        id: 'account_1', type: 'CHECKING', initialBalance: 1000, transactions: ledger,
        cardPayments: [{ paidOn: date('2026-11-01'), amount: 50 }, { paidOn: date('2026-12-01'), amount: 6000 }],
        outgoingTransfers: [{ occurredOn: date('2026-11-01'), amount: 40, status: 'POSTED' }, { occurredOn: date('2026-12-01'), amount: 5000, status: 'PENDING' }],
        incomingTransfers: [{ occurredOn: date('2026-11-01'), amount: 60, status: 'POSTED' }, { occurredOn: date('2026-12-01'), amount: 4000, status: 'POSTED' }],
      }]);
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.recurringRule.findMany.mockResolvedValue([]);
      prisma.monthlyBudget.findMany.mockResolvedValue([]);

      const overview = await service.overview('user_1', 'household_1', '2026-11');

      expect(overview.accounts[0]).toMatchObject({ balance: 1270, previousMonthBalance: 1100, realizedBalance: 1770, projectedBalance: 1470 });
      expect(overview.indicators).toMatchObject({ previousMonthAvailableBalance: 1100, availableBalance: 1770, projectedAvailableBalance: 1470 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reserves card expenses once and excludes investment transfers from monthly income and expenses', async () => {
    const occurredOn = new Date('2026-11-01T00:00:00.000Z');
    const subcategory = { categoryId: 'category_1', category: { name: 'Categoria', color: '#123456' } };
    const ledger = [
      { occurredOn, amount: 1000, type: TransactionType.INCOME, status: 'PENDING', subcategory },
      { occurredOn, amount: 200, type: TransactionType.EXPENSE, status: 'PENDING', subcategory },
    ];
    const transfer = { occurredOn, amount: 300, status: 'PENDING' };
    prisma.account.findMany.mockResolvedValue([
      { id: 'checking_1', type: 'CHECKING', initialBalance: 0, transactions: ledger, cardPayments: [], outgoingTransfers: [transfer], incomingTransfers: [] },
      { id: 'investment_1', type: 'INVESTMENT', initialBalance: 500, transactions: [], cardPayments: [], outgoingTransfers: [], incomingTransfers: [transfer] },
    ]);
    const cardExpense = { occurredOn, cardId: 'card_1', statement: { dueOn: new Date('2026-11-05T00:00:00.000Z') }, amount: 100, type: TransactionType.EXPENSE, status: 'PENDING', subcategory };
    prisma.transaction.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([...ledger, cardExpense]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.cardStatement.findMany.mockResolvedValue([{ cardId: 'card_1', cycleEnd: new Date('2026-11-02T00:00:00.000Z'), dueOn: new Date('2026-11-05T00:00:00.000Z'), totalAmount: 100, payments: [] }]);
    prisma.recurringRule.findMany.mockResolvedValue([]);
    prisma.monthlyBudget.findMany.mockResolvedValue([]);

    const overview = await service.overview('user_1', 'household_1', '2026-11');

    expect(overview.indicators).toMatchObject({ totalIncome: 1000, totalExpenses: 300, projectedAvailableBalance: 400, cardOpenTotal: 100 });
    expect(overview.accounts.map((account) => account.projectedBalance)).toEqual([500, 800]);
    expect(overview.indicators.projectedAvailableBalance).toBe(overview.indicators.totalIncome - overview.indicators.totalExpenses - transfer.amount);
  });

  it('includes projected fixed card occurrences in an open future statement', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    prisma.cardStatement.findFirst.mockResolvedValue({
      id: 'statement_1', cardId: 'card_1', cycleStart: new Date('2026-10-11T12:00:00.000Z'), cycleEnd: new Date('2026-11-10T12:00:00.000Z'), dueOn: new Date('2026-12-05T12:00:00.000Z'), status: 'OPEN',
    });
    prisma.transaction.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.recurringRule.findMany.mockResolvedValue([{
      id: 'rule_1', householdId: 'household_1', accountId: null, cardId: 'card_1', subcategoryId: 'sub_1', type: TransactionType.EXPENSE, amount: 9900, description: 'Streaming', notes: null,
      startOn: new Date('2026-11-01T12:00:00.000Z'), endOn: null, excludedOccurrences: [], account: null, card: { id: 'card_1', closingDay: 10, dueDay: 5 },
      category: { id: 'category_1', name: 'Assinaturas', color: '#123456', icon: 'subscriptions' }, subcategory: { id: 'sub_1', name: 'Streaming', categoryId: 'category_1', isDefault: false, isActive: true },
    }]);

    const result = await service.listTransactions('user_1', 'household_1', { statementId: 'statement_1', page: 1, pageSize: 100 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ description: 'Streaming', mode: 'FIXED', isForecast: true, cardId: 'card_1' });
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([expect.objectContaining({ statementId: 'statement_1' })]),
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

  it('uses only unpaid statements due in a future reference month', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    try {
      households.assertMember.mockResolvedValue({ role: 'MEMBER' });
      prisma.account.findMany.mockResolvedValue([]);
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.cardStatement.findMany.mockResolvedValue([{ id: 'statement_1', cardId: 'card_1', cycleStart: new Date('2026-09-26T12:00:00.000Z'), cycleEnd: new Date('2026-10-25T12:00:00.000Z'), dueOn: new Date('2026-11-05T12:00:00.000Z'), status: 'CLOSED', totalAmount: 900, payments: [{ amount: 250, paidOn: new Date('2026-11-05T12:00:00.000Z') }], card: {} }]);
      prisma.recurringRule.findMany.mockResolvedValue([]);
      prisma.monthlyBudget.findMany.mockResolvedValue([]);

      const overview = await service.overview('user_1', 'household_1', '2026-11');

      expect(overview.isForecast).toBe(true);
      expect(overview.indicators.cardOpenTotal).toBe(650);
      expect(prisma.cardStatement.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { householdId: 'household_1' },
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('lists active-card invoices with the unpaid balance used against each limit', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    const card = { id: 'card_1', isActive: true, creditLimit: 10_000 };
    prisma.cardStatement.findMany
      .mockResolvedValueOnce([{ id: 'statement_current', cardId: card.id, totalAmount: 2_500, status: 'OPEN', card, payments: [] }])
      .mockResolvedValueOnce([
        { id: 'statement_current', cardId: card.id, totalAmount: 2_500, status: 'OPEN', payments: [] },
        { id: 'statement_previous', cardId: card.id, totalAmount: 3_000, status: 'CLOSED', payments: [{ amount: 1_000 }] },
      ]);

    const statements = await service.listStatements('user_1', 'household_1');

    expect(statements[0]).toMatchObject({ id: 'statement_current', limitUsedAmount: 4_500, limitUsagePercent: 45 });
    expect(prisma.cardStatement.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ householdId: 'household_1', card: { isActive: true } }),
    }));
    expect(prisma.cardStatement.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { householdId: 'household_1', status: { not: 'PAID' }, card: { isActive: true } },
    }));
  });

  it('calculates the household launch marker without changing the civil occurrence date', () => {
    const launchOn = (service as unknown as { recurringLaunchOn(occurredOn: Date, mode: RecurringMaterializationMode, value: number): Date }).recurringLaunchOn.bind(service);
    const occurrence = new Date('2026-11-08T12:00:00.000Z');

    expect(launchOn(occurrence, RecurringMaterializationMode.ON_OCCURRENCE_DATE, 0).toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(launchOn(occurrence, RecurringMaterializationMode.EXERCISE_MONTH_DAY, 5).toISOString()).toBe('2026-11-05T12:00:00.000Z');
    expect(launchOn(occurrence, RecurringMaterializationMode.DAYS_BEFORE_EXERCISE_MONTH, 10).toISOString()).toBe('2026-10-22T12:00:00.000Z');
  });
});
