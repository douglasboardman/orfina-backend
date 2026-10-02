import { ForbiddenException } from '@nestjs/common';
import { PrismaClient, TransactionType } from '@prisma/client';
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
});
