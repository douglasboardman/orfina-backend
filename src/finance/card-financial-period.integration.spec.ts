import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PlanningService } from '../planning/planning.service';
import { FinanceService } from './finance.service';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('Card due-date financial period (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const events = new EventsService(prisma as never);
  const households = new HouseholdsService(prisma as never, events);
  const finance = new FinanceService(prisma as never, households, events);
  const planning = new PlanningService(prisma as never, households, events);
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let userId: string;
  let householdId: string;
  let accountId: string;
  let cardId: string;
  let categoryId: string;
  let expenseId: string;
  let incomeId: string;
  let purchaseId: string;
  let ruleId: string;
  let novemberStatementId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `due-date-${suffix}@example.test`, name: 'Due date integration' } });
    userId = user.id;
    const household = await prisma.household.create({ data: { name: `Due date ${suffix}`, members: { create: { userId, role: 'OWNER' } } } });
    householdId = household.id;
    accountId = (await finance.createAccount(userId, householdId, { name: 'Conta', type: 'CHECKING', initialBalance: 100_000 })).id;
    cardId = (await finance.createCard(userId, householdId, { name: 'Fecha 25 vence 05', network: 'VISA', closingDay: 25, dueDay: 5 })).id;
    const expense = await finance.createCategory(userId, householdId, { name: 'Compras', type: 'EXPENSE', color: '#123456' });
    categoryId = expense.id;
    expenseId = expense.subcategories[0].id;
    incomeId = (await finance.createCategory(userId, householdId, { name: 'Estornos', type: 'INCOME', color: '#123456' })).subcategories[0].id;
    for (const month of ['2026-10', '2026-11', '2026-12', '2027-01']) await planning.upsertBudget(userId, householdId, month, { categoryId, limitAmount: 50_000 });
  });

  afterAll(async () => {
    if (householdId) {
      await prisma.outboxEvent.deleteMany({ where: { payload: { path: ['householdId'], equals: householdId } } });
      await prisma.household.delete({ where: { id: householdId } });
    }
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const buy = (occurredOn: string, amount: number, status: 'POSTED' | 'PENDING' | 'DISCARDED' = 'POSTED') => finance.createTransaction(userId, householdId, { cardId, subcategoryId: expenseId, type: 'EXPENSE', amount, description: `Compra ${occurredOn}`, occurredOn, status });
  const ledger = (month: string) => finance.listTransactions(userId, householdId, { page: 1, pageSize: 100, from: `${month}-01`, to: `${month}-${month === '2026-11' ? '30' : '31'}` });

  it('assigns the entire Sep 26–Oct 25 cycle to November while preserving purchase dates', async () => {
    await buy('2026-09-26', 700);
    const purchase = await buy('2026-10-10', 2_500);
    purchaseId = purchase.id;
    expect(purchase.financialOn.toISOString().slice(0, 10)).toBe('2026-11-05');
    await buy('2026-10-25', 600, 'PENDING');
    await buy('2026-10-26', 900);
    await buy('2026-10-12', 50, 'DISCARDED');
    const deleted = await buy('2026-10-13', 60);
    await finance.deleteTransaction(userId, householdId, deleted.id);
    await finance.createTransaction(userId, householdId, { cardId, subcategoryId: incomeId, type: 'INCOME', amount: 200, description: 'Cashback', occurredOn: '2026-10-20', status: 'POSTED' });
    await finance.createTransaction(userId, householdId, { accountId, subcategoryId: expenseId, type: 'EXPENSE', amount: 100, description: 'Débito outubro', occurredOn: '2026-10-10', status: 'POSTED' });

    const october = await finance.overview(userId, householdId, '2026-10');
    const november = await finance.overview(userId, householdId, '2026-11');
    expect(october.indicators).toMatchObject({ realizedExpenses: 100, pendingExpenses: 0, projectedAvailableBalance: 99_900, cardOpenTotal: 0 });
    expect(november.indicators).toMatchObject({ realizedExpenses: 3_200, pendingExpenses: 600, realizedIncome: 200, projectedAvailableBalance: 96_300, availableBalance: 99_900, cardOpenTotal: 3_600 });
    expect(november.charts.projectedWeeklyFlow[0]).toEqual({ week: 1, income: 200, expenses: 3_800 });
    expect(november.comparison.expenses).toEqual({ current: 3_200, previous: 100 });
    expect((await ledger('2026-10')).items.map((item) => item.description)).toEqual(['Débito outubro']);
    expect((await ledger('2026-11')).items.find((item) => item.id === purchaseId)).toMatchObject({ occurredOn: new Date('2026-10-10T00:00:00.000Z'), financialOn: new Date('2026-11-05T12:00:00.000Z') });
    expect((await planning.budgetSummary(userId, householdId, '2026-10')).totals.spentAmount).toBe(100);
    expect((await planning.budgetSummary(userId, householdId, '2026-11')).rows[0]).toMatchObject({ spentAmount: 3_200, pendingAmount: 600 });
    const [statement] = await finance.listStatements(userId, householdId, '2026-11');
    novemberStatementId = statement.id;
    expect(statement.cycleStart.toISOString().slice(0, 10)).toBe('2026-09-26');
    expect(statement.cycleEnd.toISOString().slice(0, 10)).toBe('2026-10-25');
    expect(statement.dueOn.toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(await finance.listStatements(userId, householdId, '2026-10')).toEqual([]);
    await expect(finance.overview('outside-user', householdId, '2026-11')).rejects.toBeInstanceOf(ForbiddenException);
    expect((await finance.listTransactions(userId, householdId, { page: 1, pageSize: 100, statementId: novemberStatementId })).items.some((item) => item.id === purchaseId)).toBe(true);
    const firstPage = await finance.listTransactions(userId, householdId, { page: 1, pageSize: 2, from: '2026-11-01', to: '2026-11-30', cardId });
    const secondPage = await finance.listTransactions(userId, householdId, { page: 2, pageSize: 2, from: '2026-11-01', to: '2026-11-30', cardId });
    expect(firstPage.total).toBe(5);
    expect(secondPage.items.some((item) => firstPage.items.some((first) => first.id === item.id))).toBe(false);
  });

  it('moves installments and unmaterialized October recurrence into their due months once', async () => {
    await finance.createInstallmentPurchase(userId, householdId, { cardId, subcategoryId: expenseId, type: 'EXPENSE', totalAmount: 900, installmentCount: 3, firstOccurredOn: '2026-10-10', description: 'Parcelas' });
    ruleId = (await finance.createRecurringRule(userId, householdId, { cardId, subcategoryId: expenseId, type: 'EXPENSE', amount: 450, description: 'Assinatura outubro', startOn: '2026-10-10', endOn: '2026-10-10' })).id;
    const summary = await planning.budgetSummary(userId, householdId, '2026-11');
    expect(summary.rows[0]).toMatchObject({ spentAmount: 3_200, pendingAmount: 1_350 });
    expect(summary.totals).toMatchObject({ projectedRecurring: 450, projectedInstallments: 300, cardOpenTotal: 3_900 });
    expect((await finance.overview(userId, householdId, '2026-11')).indicators).toMatchObject({ pendingExpenses: 1_350, totalExpenses: 4_550, projectedAvailableBalance: 95_550 });
    expect((await ledger('2026-10')).items.some((item) => item.recurringRuleId === ruleId)).toBe(false);
    expect((await ledger('2026-11')).items.filter((item) => item.recurringRuleId === ruleId)).toHaveLength(1);
    const forecast = (await ledger('2026-11')).items.find((item) => item.recurringRuleId === ruleId)!;
    expect(forecast).toMatchObject({ isForecast: true, financialOn: new Date('2026-11-05T12:00:00.000Z') });
    expect((await finance.overview(userId, householdId, '2026-12')).indicators.totalExpenses).toBe(1_200);
    expect((await planning.budgetSummary(userId, householdId, '2027-01')).totals.pendingAmount).toBe(300);
    await finance.materializeRecurringOccurrence(userId, householdId, ruleId, '2026-10-10');
    expect((await ledger('2026-11')).items.filter((item) => item.recurringRuleId === ruleId)).toHaveLength(1);
    expect((await planning.budgetSummary(userId, householdId, '2026-11')).rows[0].pendingAmount).toBe(1_350);
  });

  it('deducts only unpaid debt from projected cash and never counts a payment as another expense', async () => {
    const entries = await prisma.transaction.findMany({ where: { householdId, statementId: novemberStatementId, status: 'PENDING' } });
    for (const entry of entries) await finance.setTransactionStatus(userId, householdId, entry.id, 'POSTED');
    await finance.closeStatement(userId, householdId, novemberStatementId);
    const before = await finance.overview(userId, householdId, '2026-11');
    expect(before.indicators.projectedAvailableBalance).toBe(95_550);
    await finance.payStatement(userId, householdId, novemberStatementId, { accountId, amount: 1_000, paidOn: '2026-11-05', idempotencyKey: `partial-${suffix}` });
    const partial = await finance.overview(userId, householdId, '2026-11');
    expect(partial.indicators).toMatchObject({ availableBalance: 98_900, projectedAvailableBalance: 95_550, cardOpenTotal: 3_350, realizedExpenses: 4_550 });
    await finance.payStatement(userId, householdId, novemberStatementId, { accountId, amount: 3_350, paidOn: '2026-11-05', idempotencyKey: `remaining-${suffix}` });
    const paid = await finance.overview(userId, householdId, '2026-11');
    expect(paid.indicators).toMatchObject({ availableBalance: 95_550, projectedAvailableBalance: 95_550, cardOpenTotal: 0, realizedExpenses: 4_550 });
    expect((await planning.budgetSummary(userId, householdId, '2026-11')).rows[0]).toMatchObject({ spentAmount: 4_550, pendingAmount: 0 });
    expect((await finance.overview(userId, householdId, '2026-10')).indicators.projectedAvailableBalance).toBe(99_900);
    await expect(finance.setTransactionStatus(userId, householdId, purchaseId, 'PENDING')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps stored due dates and closed statements immutable after calendar changes and read projections', async () => {
    const before = await prisma.cardStatement.findMany({ where: { householdId }, orderBy: { id: 'asc' } });
    await finance.updateCard(userId, householdId, cardId, { closingDay: 1, dueDay: 20 });
    await finance.createRecurringRule(userId, householdId, { cardId, subcategoryId: expenseId, type: 'EXPENSE', amount: 100, description: 'Não alterar fatura paga', startOn: '2026-10-11', endOn: '2026-10-11' });
    expect((await ledger('2026-11')).items.find((item) => item.id === purchaseId)?.financialOn.toISOString().slice(0, 10)).toBe('2026-11-05');
    expect((await finance.overview(userId, householdId, '2026-11')).indicators.totalExpenses).toBe(4_550);
    expect((await planning.budgetSummary(userId, householdId, '2026-11')).rows[0].pendingAmount).toBe(0);
    expect(await prisma.cardStatement.findMany({ where: { householdId }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('keeps November debt in its cash projection when payment is recorded for December', async () => {
    const card = await finance.createCard(userId, householdId, { name: 'Pagamento atrasado', network: 'VISA', closingDay: 25, dueDay: 5 });
    const baseNovember = await finance.overview(userId, householdId, '2026-11');
    const baseDecember = await finance.overview(userId, householdId, '2026-12');
    await finance.createTransaction(userId, householdId, { cardId: card.id, subcategoryId: expenseId, type: 'EXPENSE', amount: 500, description: 'Vence novembro paga dezembro', occurredOn: '2026-10-10', status: 'POSTED' });
    const [statement] = await finance.listCardStatements(userId, householdId, card.id);
    await finance.closeStatement(userId, householdId, statement.id);
    await finance.payStatement(userId, householdId, statement.id, { accountId, amount: 500, paidOn: '2026-12-05', idempotencyKey: `late-${suffix}` });
    const november = await finance.overview(userId, householdId, '2026-11');
    const december = await finance.overview(userId, householdId, '2026-12');
    expect(november.indicators.availableBalance).toBe(baseNovember.indicators.availableBalance);
    expect(november.indicators.projectedAvailableBalance).toBe(baseNovember.indicators.projectedAvailableBalance - 500);
    expect(november.indicators.totalExpenses).toBe(baseNovember.indicators.totalExpenses + 500);
    expect(december.indicators.projectedAvailableBalance).toBe(baseDecember.indicators.projectedAvailableBalance - 500);
    expect(december.indicators.totalExpenses).toBe(baseDecember.indicators.totalExpenses);
  });
});
