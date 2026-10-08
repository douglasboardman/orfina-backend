import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

    expect(transaction.subcategory.categoryId).toBe(category.id);
    expect(transaction.subcategoryId).toBe(subcategory.id);
    expect(transaction).not.toHaveProperty('categoryId');
    expect(transaction).not.toHaveProperty('category');
    await expect(finance.listTransactions(outsiderId, householdId, { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(prisma.transaction.create({ data: { householdId, accountId: account.id, type: TransactionType.EXPENSE, amount: 100, description: 'Sem subcategoria', occurredOn: new Date() } } as never)).rejects.toThrow();
  });

  it('creates exactly one automatic subcategory and protects its name and active status', async () => {
    const category = await finance.createCategory(ownerId, householdId, { name: 'Automática original', type: 'EXPENSE', color: '#123456' });
    const [automatic] = category.subcategories;
    expect(automatic).toMatchObject({ name: category.name, isDefault: true, isActive: true });
    await expect(finance.createSubcategory(ownerId, householdId, category.id, { name: category.name })).rejects.toBeInstanceOf(BadRequestException);
    await expect(prisma.subcategory.create({ data: { categoryId: category.id, name: category.name } })).rejects.toThrow();
    await expect(finance.updateSubcategory(ownerId, householdId, automatic.id, { name: 'Outro nome' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(finance.setSubcategoryStatus(ownerId, householdId, automatic.id, false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(prisma.subcategory.update({ where: { id: automatic.id }, data: { name: 'Outro nome' } })).rejects.toThrow();
    await expect(prisma.subcategory.delete({ where: { id: automatic.id } })).rejects.toThrow();
    const renamed = await finance.updateCategory(ownerId, householdId, category.id, { name: 'Automática renomeada' });
    expect(renamed.subcategories).toEqual([expect.objectContaining({ id: automatic.id, name: renamed.name, isDefault: true })]);
    await finance.setCategoryStatus(ownerId, householdId, category.id, false);
    await finance.setCategoryStatus(ownerId, householdId, category.id, true);
    expect(await prisma.subcategory.findUnique({ where: { id: automatic.id } })).toMatchObject({ isDefault: true, isActive: true });
    // Imports and seeds also use direct Prisma creation; the database enforces the invariant.
    const direct = await prisma.category.create({ data: { householdId, name: 'Categoria direta', type: 'INCOME' }, include: { subcategories: true } });
    expect(direct.subcategories).toEqual([expect.objectContaining({ name: direct.name, isDefault: true })]);
    await Promise.all(['Direta A', 'Direta B'].map((name) => prisma.category.update({ where: { id: direct.id }, data: { name } })));
    const final = await prisma.category.findUniqueOrThrow({ where: { id: direct.id }, include: { subcategories: true } });
    expect(final.subcategories).toEqual([expect.objectContaining({ name: final.name, isDefault: true })]);
  });

  it('merges a rename collision preserving transactions, installments, recurrence and category totals', async () => {
    const category = await finance.createCategory(ownerId, householdId, { name: 'Antes da união', type: 'EXPENSE', color: '#123456' });
    const automatic = category.subcategories[0];
    const duplicate = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Depois da união' });
    const specific = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Específica preservada' });
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta união', type: 'CHECKING', initialBalance: 0 });
    const card = await finance.createCard(ownerId, householdId, { name: 'Cartão união', network: CardNetwork.VISA });
    const movement = await finance.createTransaction(ownerId, householdId, { accountId: account.id, subcategoryId: duplicate.id, type: TransactionType.EXPENSE, amount: 750, description: 'Lançamento preservado', occurredOn: '2026-10-04' });
    await finance.createTransaction(ownerId, householdId, { accountId: account.id, subcategoryId: automatic.id, type: TransactionType.EXPENSE, amount: 250, description: 'Outro lançamento', occurredOn: '2026-10-04' });
    await finance.createTransaction(ownerId, householdId, { accountId: account.id, subcategoryId: specific.id, type: TransactionType.EXPENSE, amount: 125, description: 'Outra subcategoria', occurredOn: '2026-10-04' });
    await finance.createTransaction(ownerId, householdId, { accountId: account.id, subcategoryId: specific.id, type: TransactionType.EXPENSE, amount: 75, description: 'Pendente preservado', occurredOn: '2026-10-04', status: 'PENDING' });
    const purchase = await finance.createInstallmentPurchase(ownerId, householdId, { cardId: card.id, subcategoryId: duplicate.id, type: TransactionType.EXPENSE, totalAmount: 600, installmentCount: 2, description: 'Parcelada preservada', firstOccurredOn: '2026-12-04' });
    const rule = await finance.createRecurringRule(ownerId, householdId, { accountId: account.id, subcategoryId: duplicate.id, type: TransactionType.EXPENSE, amount: 100, description: 'Recorrência preservada', startOn: '2026-12-04' });
    await finance.updateCategory(ownerId, householdId, category.id, { name: duplicate.name });
    expect(await prisma.subcategory.findUnique({ where: { id: duplicate.id } })).toBeNull();
    expect(await prisma.subcategory.findUnique({ where: { id: automatic.id } })).toMatchObject({ name: duplicate.name, isDefault: true });
    expect(await prisma.transaction.findUnique({ where: { id: movement.id } })).toMatchObject({ subcategoryId: automatic.id, amount: 750 });
    expect(await prisma.installmentPurchase.findUnique({ where: { id: purchase.id } })).toMatchObject({ subcategoryId: automatic.id });
    expect(await prisma.recurringRule.findUnique({ where: { id: rule.id } })).toMatchObject({ subcategoryId: automatic.id });
    expect((await finance.listRecurringRules(ownerId, householdId)).find((item) => item.id === rule.id)?.category.id).toBe(category.id);
    expect(await prisma.transaction.count({ where: { installmentPurchaseId: purchase.id, subcategoryId: automatic.id } })).toBe(2);
    const filtered = await finance.listTransactions(ownerId, householdId, { page: 1, pageSize: 100, categoryId: category.id, from: '2026-10-01', to: '2026-10-31' });
    expect(filtered.total).toBe(4);
    expect(filtered.items.every((item) => item.subcategory.category.id === category.id)).toBe(true);
    await planning.upsertBudget(ownerId, householdId, '2026-10', { categoryId: category.id, limitAmount: 2_000 });
    expect((await planning.budgetSummary(ownerId, householdId, '2026-10')).rows.find((item) => item.categoryId === category.id)).toMatchObject({ spentAmount: 1_125, pendingAmount: 75 });
    expect((await finance.overview(ownerId, householdId, '2026-10')).charts.expenseByCategory.find((item) => item.categoryId === category.id)?.amount).toBe(1_125);
  });

  it('rejects foreign household accounts and subcategories on creation and editing', async () => {
    const foreign = await prisma.household.create({ data: { name: 'Grupo isolado', members: { create: { userId: ownerId, role: 'OWNER' } } } });
    try {
      const account = await finance.createAccount(ownerId, householdId, { name: 'Conta isolamento', type: 'CHECKING', initialBalance: 0 });
      const category = await finance.createCategory(ownerId, householdId, { name: 'Categoria isolamento', type: 'EXPENSE', color: '#123456' });
      const foreignCategory = await finance.createCategory(ownerId, foreign.id, { name: 'Categoria estrangeira', type: 'EXPENSE', color: '#123456' });
      const foreignAccount = await finance.createAccount(ownerId, foreign.id, { name: 'Conta estrangeira', type: 'CHECKING', initialBalance: 0 });
      const dto = { accountId: account.id, subcategoryId: category.subcategories[0].id, type: TransactionType.EXPENSE, amount: 100, description: 'Isolamento', occurredOn: '2026-10-04' };
      const movement = await finance.createTransaction(ownerId, householdId, dto);
      for (const invalid of [{ ...dto, accountId: foreignAccount.id }, { ...dto, subcategoryId: foreignCategory.subcategories[0].id }]) {
        await expect(finance.createTransaction(ownerId, householdId, invalid)).rejects.toBeInstanceOf(NotFoundException);
        await expect(finance.updateTransaction(ownerId, householdId, movement.id, invalid)).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(finance.updateCategory(outsiderId, householdId, category.id, { name: 'Inválido' })).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.outboxEvent.deleteMany({ where: { payload: { path: ['householdId'], equals: foreign.id } } });
      await prisma.household.delete({ where: { id: foreign.id } });
    }
  });

  it('creates the automatic subcategory when importing a new category and uses it without duplication', async () => {
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta nova importação', type: 'CHECKING', initialBalance: 0 });
    const csv = 'Data;Descrição;Valor;Tipo;Categoria;Subcategoria\n2026-10-03;Importação automática;-1,00;Despesa;Importada automática;Importada automática\n';
    const preview = await imports.preview(ownerId, householdId, { fileName: 'automatica.csv', contentBase64: Buffer.from(csv).toString('base64'), mapping: {}, accountId: account.id });
    await imports.commit(ownerId, householdId, preview.id, { createMissingCategories: true });
    const category = await prisma.category.findUniqueOrThrow({ where: { householdId_name_type: { householdId, name: 'Importada automática', type: 'EXPENSE' } }, include: { subcategories: true } });
    expect(category.subcategories).toEqual([expect.objectContaining({ name: category.name, isDefault: true })]);
    const [movement] = (await finance.listTransactions(ownerId, householdId, { page: 1, pageSize: 100, importBatchId: preview.id })).items;
    expect(movement.subcategoryId).toBe(category.subcategories[0].id);
  });

  it('accepts an income transaction funded by a card and rejects a transaction without a funding source', async () => {
    const category = await finance.createCategory(ownerId, householdId, { name: 'Cashback', type: 'INCOME', color: '#0099CC', icon: 'credit_card' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, category.id, { name: 'Estorno do cartão' });
    const card = await finance.createCard(ownerId, householdId, { name: 'Cartão teste', network: CardNetwork.VISA, lastFour: '1234' });
    const transaction = await finance.createTransaction(ownerId, householdId, { cardId: card.id, subcategoryId: subcategory.id, type: TransactionType.INCOME, amount: 500, description: 'Cashback', occurredOn: '2026-10-02' });
    expect(transaction.cardId).toBe(card.id);
    expect(transaction.accountId).toBeNull();
    await expect(prisma.transaction.create({ data: { householdId, subcategoryId: subcategory.id, type: TransactionType.INCOME, amount: 100, description: 'Sem origem', occurredOn: new Date() } } as never)).rejects.toThrow();
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

  it('persists every scheduled account installment and honors the continuous recurrence launch marker', async () => {
    const account = await finance.createAccount(ownerId, householdId, { name: 'Conta financiamento', type: 'CHECKING', initialBalance: 50_000 });
    const expense = await finance.createCategory(ownerId, householdId, { name: `Financiamento ${suffix}`, type: 'EXPENSE', color: '#5B5BD6', icon: 'handshake' });
    const subcategory = await finance.createSubcategory(ownerId, householdId, expense.id, { name: 'Parcela mensal' });

    const plan = await finance.createInstallmentPurchase(ownerId, householdId, { accountId: account.id, subcategoryId: subcategory.id, type: TransactionType.EXPENSE, totalAmount: 1_000, installmentCount: 3, description: 'Financiamento teste', firstOccurredOn: '2026-11-08' });
    const installments = await prisma.transaction.findMany({ where: { installmentPurchaseId: plan.id }, orderBy: { installmentNumber: 'asc' } });
    expect(installments).toEqual([
      expect.objectContaining({ accountId: account.id, cardId: null, installmentNumber: 1, amount: 334, description: 'Financiamento teste (1/3)' }),
      expect.objectContaining({ accountId: account.id, cardId: null, installmentNumber: 2, amount: 333, description: 'Financiamento teste (2/3)' }),
      expect.objectContaining({ accountId: account.id, cardId: null, installmentNumber: 3, amount: 333, description: 'Financiamento teste (3/3)' }),
    ]);

    await prisma.household.update({ where: { id: householdId }, data: { recurringMaterializationMode: 'DAYS_BEFORE_EXERCISE_MONTH', recurringMaterializationValue: 10 } });
    const rule = await finance.createRecurringRule(ownerId, householdId, { accountId: account.id, subcategoryId: subcategory.id, type: TransactionType.EXPENSE, amount: 400, description: 'Conta antecipada', startOn: '2026-11-08' });
    await finance.materializeRecurringRules(new Date('2026-10-22T12:00:00.000Z'));
    expect(await prisma.transaction.findUnique({ where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: new Date('2026-11-08T12:00:00.000Z') } } })).toMatchObject({ status: 'PENDING' });
    await finance.materializeRecurringRules(new Date('2026-11-08T12:00:00.000Z'));
    expect(await prisma.transaction.findUnique({ where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: new Date('2026-11-08T12:00:00.000Z') } } })).toMatchObject({ status: 'POSTED' });
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
