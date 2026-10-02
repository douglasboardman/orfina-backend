import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, CategoryType, Prisma, TransactionType } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';

type CreateAccount = { name: string; type: AccountType; bankName?: string; bankLogoUrl?: string; initialBalance: number };
type UpdateAccount = Partial<CreateAccount>;
type CreateCategory = { name: string; type: CategoryType; color: string; icon?: string };
type UpdateCategory = Partial<Pick<CreateCategory, 'name' | 'color' | 'icon'>>;
type CreateSubcategory = { name: string };
type CreateTransaction = { accountId: string; subcategoryId: string; type: TransactionType; amount: number; description: string; occurredOn: string; notes?: string };
type TransactionListFilters = { page: number; pageSize: number; from?: string; to?: string; accountId?: string; categoryId?: string; subcategoryId?: string; type?: TransactionType };

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly households: HouseholdsService,
    private readonly events: EventsService,
  ) {}

  async overview(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const [accounts, transactions] = await Promise.all([
      this.prisma.account.findMany({ where: { householdId, isActive: true }, include: { transactions: true }, orderBy: { name: 'asc' } }),
      this.prisma.transaction.findMany({ where: { householdId }, include: { category: true, subcategory: true, account: true }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: 8 }),
    ]);
    const accountSummaries = accounts.map((account) => {
      const movement = account.transactions.reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      return { ...account, transactions: undefined, balance: account.initialBalance + movement };
    });
    return {
      totalBalance: accountSummaries.reduce((sum, account) => sum + account.balance, 0),
      accounts: accountSummaries,
      recentTransactions: transactions,
    };
  }

  async listAccounts(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const accounts = await this.prisma.account.findMany({ where: { householdId }, include: { transactions: true }, orderBy: { name: 'asc' } });
    return accounts.map((account) => {
      const movement = account.transactions.reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      return { ...account, transactions: undefined, balance: account.initialBalance + movement };
    });
  }

  async createAccount(userId: string, householdId: string, dto: CreateAccount) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { householdId, ...dto } });
      await this.events.record(tx, {
        aggregateType: 'account', aggregateId: account.id,
        eventType: 'orfina.accounts.account-created.v1',
        payload: { accountId: account.id, householdId, initialBalance: account.initialBalance },
      });
      return account;
    });
  }

  async updateAccount(userId: string, householdId: string, accountId: string, dto: UpdateAccount) {
    await this.households.assertCanManage(userId, householdId);
    const account = await this.prisma.account.findFirst({ where: { id: accountId, householdId } });
    if (!account) throw new NotFoundException('Conta não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({ where: { id: accountId }, data: dto });
      await this.events.record(tx, {
        aggregateType: 'account', aggregateId: accountId,
        eventType: 'orfina.accounts.account-updated.v1',
        payload: { accountId, householdId, changedFields: Object.keys(dto) },
      });
      return updated;
    });
  }

  async setAccountStatus(userId: string, householdId: string, accountId: string, isActive: boolean) {
    await this.households.assertCanManage(userId, householdId);
    const account = await this.prisma.account.findFirst({ where: { id: accountId, householdId } });
    if (!account) throw new NotFoundException('Conta não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({ where: { id: accountId }, data: { isActive } });
      await this.events.record(tx, {
        aggregateType: 'account', aggregateId: accountId,
        eventType: `orfina.accounts.account-${isActive ? 'activated' : 'archived'}.v1`,
        payload: { accountId, householdId, isActive },
      });
      return updated;
    });
  }

  async listCategories(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.category.findMany({
      where: { householdId },
      include: { subcategories: { orderBy: { name: 'asc' } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(userId: string, householdId: string, dto: CreateCategory) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.create({ data: { householdId, ...dto } });
      await this.events.record(tx, {
        aggregateType: 'category', aggregateId: category.id,
        eventType: 'orfina.categories.category-created.v1',
        payload: { categoryId: category.id, householdId, type: category.type },
      });
      return category;
    });
  }

  async updateCategory(userId: string, householdId: string, categoryId: string, dto: UpdateCategory) {
    await this.households.assertCanManage(userId, householdId);
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, householdId } });
    if (!category) throw new NotFoundException('Categoria não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.category.update({ where: { id: categoryId }, data: dto });
      await this.events.record(tx, {
        aggregateType: 'category', aggregateId: categoryId,
        eventType: 'orfina.categories.category-updated.v1',
        payload: { categoryId, householdId, changedFields: Object.keys(dto) },
      });
      return updated;
    });
  }

  async setCategoryStatus(userId: string, householdId: string, categoryId: string, isActive: boolean) {
    await this.households.assertCanManage(userId, householdId);
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, householdId } });
    if (!category) throw new NotFoundException('Categoria não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.category.update({ where: { id: categoryId }, data: { isActive } });
      await this.events.record(tx, {
        aggregateType: 'category', aggregateId: categoryId,
        eventType: `orfina.categories.category-${isActive ? 'activated' : 'archived'}.v1`,
        payload: { categoryId, householdId, isActive },
      });
      return updated;
    });
  }

  async createSubcategory(userId: string, householdId: string, categoryId: string, dto: CreateSubcategory) {
    await this.households.assertCanManage(userId, householdId);
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, householdId, isActive: true } });
    if (!category) throw new NotFoundException('Categoria não encontrada neste grupo familiar.');

    return this.prisma.$transaction(async (tx) => {
      const subcategory = await tx.subcategory.create({ data: { categoryId, ...dto } });
      await this.events.record(tx, {
        aggregateType: 'subcategory', aggregateId: subcategory.id,
        eventType: 'orfina.categories.subcategory-created.v1',
        payload: { subcategoryId: subcategory.id, categoryId, householdId, type: category.type },
      });
      return subcategory;
    });
  }

  async updateSubcategory(userId: string, householdId: string, subcategoryId: string, dto: CreateSubcategory) {
    await this.households.assertCanManage(userId, householdId);
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: subcategoryId, category: { householdId } } });
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subcategory.update({ where: { id: subcategoryId }, data: dto });
      await this.events.record(tx, {
        aggregateType: 'subcategory', aggregateId: subcategoryId,
        eventType: 'orfina.categories.subcategory-updated.v1',
        payload: { subcategoryId, categoryId: subcategory.categoryId, householdId },
      });
      return updated;
    });
  }

  async setSubcategoryStatus(userId: string, householdId: string, subcategoryId: string, isActive: boolean) {
    await this.households.assertCanManage(userId, householdId);
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: subcategoryId, category: { householdId } } });
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subcategory.update({ where: { id: subcategoryId }, data: { isActive } });
      await this.events.record(tx, {
        aggregateType: 'subcategory', aggregateId: subcategoryId,
        eventType: `orfina.categories.subcategory-${isActive ? 'activated' : 'archived'}.v1`,
        payload: { subcategoryId, categoryId: subcategory.categoryId, householdId, isActive },
      });
      return updated;
    });
  }

  async listTransactions(userId: string, householdId: string, filters: TransactionListFilters) {
    await this.households.assertMember(userId, householdId);
    const where: Prisma.TransactionWhereInput = {
      householdId,
      accountId: filters.accountId,
      categoryId: filters.categoryId,
      subcategoryId: filters.subcategoryId,
      type: filters.type,
    };
    if (filters.from || filters.to) {
      where.occurredOn = {
        ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00.000Z`) } : {}),
        ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
      };
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where, include: { account: true, category: true, subcategory: true },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return { items, total, page: filters.page, pageSize: filters.pageSize };
  }

  async createTransaction(userId: string, householdId: string, dto: CreateTransaction) {
    await this.households.assertCanWrite(userId, householdId);
    const [account, subcategory] = await Promise.all([
      this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }),
      this.prisma.subcategory.findFirst({
        where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } },
        include: { category: true },
      }),
    ]);
    if (!account) throw new NotFoundException('Conta não encontrada neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao do lançamento.');

    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: { householdId, ...dto, categoryId: subcategory.categoryId, occurredOn: new Date(`${dto.occurredOn}T12:00:00.000Z`) },
        include: { account: true, category: true, subcategory: true },
      });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transaction.id,
        eventType: 'orfina.transactions.transaction-posted.v1',
        payload: { transactionId: transaction.id, householdId, accountId: transaction.accountId, categoryId: transaction.categoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
      });
      return transaction;
    });
  }

  async updateTransaction(userId: string, householdId: string, transactionId: string, dto: CreateTransaction) {
    await this.households.assertCanWrite(userId, householdId);
    const [existing, account, subcategory] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } }),
      this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }),
      this.prisma.subcategory.findFirst({
        where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } },
        include: { category: true },
      }),
    ]);
    if (!existing) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    if (!account) throw new NotFoundException('Conta não encontrada neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao do lançamento.');

    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.update({
        where: { id: transactionId },
        data: {
          ...dto,
          categoryId: subcategory.categoryId,
          occurredOn: new Date(`${dto.occurredOn}T12:00:00.000Z`),
        },
        include: { account: true, category: true, subcategory: true },
      });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-updated.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, categoryId: transaction.categoryId, subcategoryId: transaction.subcategoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
      });
      return transaction;
    });
  }

  async deleteTransaction(userId: string, householdId: string, transactionId: string) {
    await this.households.assertCanWrite(userId, householdId);
    const transaction = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      await tx.transaction.delete({ where: { id: transactionId } });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-deleted.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, categoryId: transaction.categoryId, subcategoryId: transaction.subcategoryId },
      });
      return { id: transactionId, deleted: true };
    });
  }
}
