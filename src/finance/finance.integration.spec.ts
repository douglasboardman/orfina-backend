import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CardNetwork, PrismaClient, TransactionType } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { FinanceService } from './finance.service';
import { PlanningService } from '../planning/planning.service';
import { ImportsService } from '../imports/imports.service';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('Finance integration (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const events = new EventsService(prisma as never);
  const households = new HouseholdsService(prisma as never, events);
  const finance = new FinanceService(prisma as never, households, events);
  const planning = new PlanningService(prisma as never, households, events);
  const imports = new ImportsService(prisma as never, households, events);
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let householdId = '';
  let ownerId = '';
  let outsiderId = '';

  beforeAll(async () => {
    await prisma.$connect();
    const [owner, outsider] = await Promise.all([
      prisma.user.create({ data: { email: `integration-owner-${suffix}@example.test`, name: 'Integration owner' } }),
      prisma.user.create({ data: { email: `integration-outsider-${suffix}@example.test`, name: 'Integration outsider' } }),
    ]);
    ownerId = owner.id;
    outsiderId = outsider.id;
    const household = await prisma.household.create({ data: { name: `Integration ${suffix}`, members: { create: { userId: owner.id, role: 'OWNER' } } } });
    householdId = household.id;
  });

  afterAll(async () => {
    if (ownerId) {
      if (householdId) {
        await prisma.outboxEvent.deleteMany({ where: { payload: { path: ['householdId'], equals: householdId } } });
        await prisma.household.delete({ where: { id: householdId } }).catch(() => undefined);
      }
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId].filter(Boolean) } } });
    }
    await prisma.$disconnect();
  });

  it('isolates households and derives the parent category from the mandatory subcategory', async () => {
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta de teste', type: 'CHECKING', initialBalance: 0 });
    const category = await finance.createCategory(ownerId, householdId, { name: 'Alimentação', type: 'EXPENSE', color: '#5B5BD6', icon: '🛒' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Mercado' });

    const transaction = await finance.createTransaction(ownerId, householdId, {
      accountId: account.id,
      subcategoryId: subcategory.id,
      type: TransactionType.EXPENSE,
      amount: 1599,
      description: 'Compra de teste',
      occurredOn: '2026-10-02',
    });

    expect(transaction.categoryId).toBe(category.id);
    expect(transaction.subcategoryId).toBe(subcategory.id);
    await expect(finance.listTransactions(outsiderId, householdId, { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(prisma.transaction.create({ data: { householdId, accountId: account.id, categoryId: category.id, type: TransactionType.EXPENSE, amount: 100, description: 'Sem subcategoria', occurredOn: new Date() } } as never)).rejects.toThrow();
  });

  it('accepts an income transaction funded by a card and rejects a transaction without a funding source', async () => {
    const category = await finance.createCategory(ownerId, householdId, { name: 'Cashback', type: 'INCOME', color: '#0099CC', icon: 'credit_card' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Estorno do cartão' });
    const card = await finance.createCard(ownerId, householdId, { name: 'Cartão teste', network: CardNetwork.VISA, lastFour: '1234' });
    const transaction = await finance.createTransaction(ownerId, householdId, { cardId: card.id, subcategoryId: subcategory.id, type: TransactionType.INCOME, amount: 500, description: 'Cashback', occurredOn: '2026-10-02' });
    expect(transaction.cardId).toBe(card.id);
    expect(transaction.accountId).toBeNull();
    await expect(prisma.transaction.create({ data: { householdId, categoryId: category.id, subcategoryId: subcategory.id, type: TransactionType.INCOME, amount: 100, description: 'Sem origem', occurredOn: new Date() } } as never)).rejects.toThrow();
  });

  it('keeps a card statement isolated, settles it idempotently from a household account and materializes recurrence once', async () => {
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta para fatura', type: 'CHECKING', initialBalance: 20_000 });
    const expense = await finance.createCategory(ownerId, householdId, { name: 'Assinaturas', type: 'EXPENSE', color: '#5B5BD6', icon: 'receipt_long' });
    const expenseSubcategory = await finance.createSubcategory(ownerId, householdId, expense.id, { name: 'Streaming' });
    const card = await finance.createCard(ownerId, householdId, { name: 'Cartão ciclo', network: CardNetwork.VISA, closingDay: 10, dueDay: 5 });
    await finance.createTransaction(ownerId, householdId, { cardId: card.id, subcategoryId: expenseSubcategory.id, type: TransactionType.EXPENSE, amount: 1_250, description: 'Compra no cartão', occurredOn: '2026-10-11' });

    const [statement] = await finance.listCardStatements(ownerId, householdId, card.id);
    expect(statement.totalAmount).toBe(1_250);
    expect(statement.status).toBe('OPEN');
    await finance.closeStatement(ownerId, householdId, statement.id);
    const firstPayment = await finance.payStatement(ownerId, householdId, statement.id, { accountId: account.id, amount: 1_250, paidOn: '2026-11-05', idempotencyKey: `payment-${suffix}` });
    const retriedPayment = await finance.payStatement(ownerId, householdId, statement.id, { accountId: account.id, amount: 1_250, paidOn: '2026-11-05', idempotencyKey: `payment-${suffix}` });
    expect(retriedPayment.id).toBe(firstPayment.id);
    expect((await finance.listCardStatements(ownerId, householdId, card.id))[0].status).toBe('PAID');
    expect((await finance.listAccounts(ownerId, householdId)).find((item) => item.id === account.id)?.balance).toBe(18_750);
    await expect(finance.payStatement(outsiderId, householdId, statement.id, { accountId: account.id, amount: 1, paidOn: '2026-11-05', idempotencyKey: `outside-${suffix}` })).rejects.toBeInstanceOf(ForbiddenException);

    await finance.createRecurringRule(ownerId, householdId, { accountId: account.id, subcategoryId: expenseSubcategory.id, type: TransactionType.EXPENSE, amount: 499, description: 'Recorrência', startOn: '2026-10-01' });
    await finance.materializeRecurringRules(new Date('2026-10-02T12:00:00.000Z'));
    await finance.materializeRecurringRules(new Date('2026-10-02T12:00:00.000Z'));
    const recurring = await prisma.transaction.findMany({ where: { householdId, recurringRuleId: { not: null } } });
    expect(recurring).toHaveLength(1);
  });

  it('keeps budgets and goals tenant-scoped, auditable and idempotent', async () => {
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta orçamento', type: 'CHECKING', initialBalance: 0 });
    const category = await finance.createCategory(ownerId, householdId, { name: `Orçamento ${suffix}`, type: 'EXPENSE', color: '#5B5BD6', icon: 'sell' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Despesa planejada' });
    await finance.createTransaction(ownerId, householdId, { accountId: account.id, subcategoryId: subcategory.id, type: TransactionType.EXPENSE, amount: 750, description: 'Consumo do orçamento', occurredOn: '2026-10-04' });
    await planning.upsertBudget(ownerId, householdId, '2026-10', { categoryId: category.id, limitAmount: 1_000 });
    const summary = await planning.budgetSummary(ownerId, householdId, '2026-10');
    expect(summary.rows.find((row) => row.categoryId === category.id)).toEqual(expect.objectContaining({ spentAmount: 750, availableAmount: 250 }));
    await planning.setMonthClosed(ownerId, householdId, '2026-10', true);
    await expect(planning.upsertBudget(ownerId, householdId, '2026-10', { categoryId: category.id, limitAmount: 1_500 })).rejects.toBeInstanceOf(BadRequestException);
    await planning.setMonthClosed(ownerId, householdId, '2026-10', false);

    const goal = await planning.createGoal(ownerId, householdId, { name: 'Reserva familiar', targetAmount: 2_000, color: '#5B5BD6' });
    const first = await planning.contributeToGoal(ownerId, householdId, goal.id, { amount: 500, occurredOn: '2026-10-04', idempotencyKey: `goal-${suffix}` });
    const retried = await planning.contributeToGoal(ownerId, householdId, goal.id, { amount: 500, occurredOn: '2026-10-04', idempotencyKey: `goal-${suffix}` });
    expect(retried.id).toBe(first.id);
    expect((await planning.listGoals(ownerId, householdId)).find((item) => item.id === goal.id)).toEqual(expect.objectContaining({ savedAmount: 500, remainingAmount: 1_500 }));
    await expect(planning.contributeToGoal(outsiderId, householdId, goal.id, { amount: 1, occurredOn: '2026-10-04', idempotencyKey: `outside-goal-${suffix}` })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps pending movements out of available balance and commits a reviewed CSV only once', async () => {
    const source = await finance.createAccount(ownerId, householdId, { name: `Origem ${suffix}`, type: 'CHECKING', initialBalance: 10_000 });
    const destination = await finance.createAccount(ownerId, householdId, { name: `Destino ${suffix}`, type: 'SAVINGS', initialBalance: 0 });
    const category = await finance.createCategory(ownerId, householdId, { name: `Importação ${suffix}`, type: 'EXPENSE', color: '#5B5BD6', icon: 'receipt_long' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Revisada' });

    await finance.createTransaction(ownerId, householdId, { accountId: source.id, subcategoryId: subcategory.id, type: TransactionType.EXPENSE, amount: 1_500, description: 'Pendente', occurredOn: '2026-10-02', status: 'PENDING' as never });
    await finance.createTransfer(ownerId, householdId, { sourceAccountId: source.id, destinationAccountId: destination.id, amount: 2_000, occurredOn: '2026-10-02' });
    const balances = await finance.listAccounts(ownerId, householdId);
    expect(balances.find((account) => account.id === source.id)?.balance).toBe(8_000);
    expect(balances.find((account) => account.id === destination.id)?.balance).toBe(2_000);

    const csv = `Data;Descrição;Valor;Tipo;Categoria;Subcategoria;Situação\n2026-10-03;Importação revisada;-12,34;Despesa;${category.name};${subcategory.name};Pendente\n`;
    const preview = await imports.preview(ownerId, householdId, { fileName: 'movimentos.csv', contentBase64: Buffer.from(csv).toString('base64'), mapping: {}, accountId: source.id });
    expect(preview.status).toBe('VALIDATED');
    expect((await imports.get(ownerId, householdId, preview.id)).items[0].status).toBe('VALID');
    await imports.commit(ownerId, householdId, preview.id, { createMissingCategories: false });
    const retriedPreview = await imports.preview(ownerId, householdId, { fileName: 'movimentos.csv', contentBase64: Buffer.from(csv).toString('base64'), mapping: {}, accountId: source.id });
    expect(retriedPreview.id).toBe(preview.id);
    expect((await finance.listTransactions(ownerId, householdId, { page: 1, pageSize: 100, importBatchId: preview.id })).items).toHaveLength(1);
    expect((await finance.overview(ownerId, householdId)).pendingCommitments).toBeGreaterThanOrEqual(2_734);
  });
});
