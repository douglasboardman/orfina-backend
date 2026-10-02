import { ForbiddenException } from '@nestjs/common';
import { CardNetwork, PrismaClient, TransactionType } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { FinanceService } from './finance.service';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('Finance integration (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const events = new EventsService(prisma as never);
  const households = new HouseholdsService(prisma as never, events);
  const finance = new FinanceService(prisma as never, households, events);
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
});
