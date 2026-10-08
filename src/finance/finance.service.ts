import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountTransferStatus, AccountType, CardNetwork, CardStatementStatus, CategoryType, Prisma, RecurringMaterializationMode, RecurringRuleStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';

type CreateAccount = { name: string; type: AccountType; bankName?: string; bankLogoUrl?: string; initialBalance: number };
type UpdateAccount = Partial<CreateAccount>;
type CreateCard = { name: string; issuerName?: string; issuerLogoUrl?: string; network: CardNetwork; lastFour?: string; creditLimit?: number; closingDay?: number; dueDay?: number };
type UpdateCard = Partial<CreateCard>;
type CreateCategory = { name: string; type: CategoryType; color: string; icon?: string };
type UpdateCategory = Partial<Pick<CreateCategory, 'name' | 'color' | 'icon'>>;
type CreateSubcategory = { name: string };
type CreateTransaction = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; occurredOn: string; notes?: string; status?: TransactionStatus };
type TransactionConversion =
  | { mode: 'FIXED'; accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; notes?: string; startOn: string; endOn?: string }
  | { mode: 'INSTALLMENT'; accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; totalAmount: number; installmentCount: number; startInstallmentNumber?: number; description: string; notes?: string; firstOccurredOn: string };
type TransactionListFilters = { page: number; pageSize: number; from?: string; to?: string; accountId?: string; cardId?: string; statementId?: string; recurringRuleId?: string; categoryId?: string; subcategoryId?: string; type?: TransactionType; status?: TransactionStatus; importBatchId?: string };
type CreateTransfer = { sourceAccountId: string; destinationAccountId: string; amount: number; occurredOn: string; description?: string; status?: AccountTransferStatus };
type StatementPayment = { accountId: string; amount: number; paidOn: string; idempotencyKey: string };
type InstallmentPurchaseInput = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; totalAmount: number; installmentCount: number; startInstallmentNumber?: number; description: string; firstOccurredOn: string; notes?: string };
type RecurringRuleInput = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; notes?: string; startOn: string; endOn?: string };
type RecurringProjectionSource = { id: string; householdId: string; accountId: string | null; cardId: string | null; subcategoryId: string; type: TransactionType; amount: number; description: string; notes: string | null; startOn: Date; endOn: Date | null; account: unknown; card: unknown; category: { id: string; name: string; color: string; icon: string }; subcategory: { id: string; name: string; categoryId: string; isDefault: boolean; isActive: boolean } };

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly households: HouseholdsService,
    private readonly events: EventsService,
  ) {}

  async overview(userId: string, householdId: string, requestedMonth?: string) {
    await this.households.assertMember(userId, householdId);
    const referenceMonth = this.monthStart(requestedMonth ?? new Date().toISOString().slice(0, 7));
    const previousMonth = this.addMonths(referenceMonth, -1);
    const { start, end } = this.monthRange(referenceMonth);
    const previousRange = this.monthRange(previousMonth);
    const [accounts, transactions, monthTransactions, previousTransactions, statements, recurringRules, budgets, recurringOccurrences] = await Promise.all([
      this.prisma.account.findMany({
        where: { householdId, isActive: true },
        include: {
          transactions: { where: { status: TransactionStatus.POSTED, occurredOn: { lt: end } } },
          cardPayments: { where: { paidOn: { lt: end } } },
          outgoingTransfers: { where: { status: AccountTransferStatus.POSTED, occurredOn: { lt: end } } },
          incomingTransfers: { where: { status: AccountTransferStatus.POSTED, occurredOn: { lt: end } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.transaction.findMany({ where: { householdId, occurredOn: { gte: start, lt: end } }, include: { subcategory: { include: { category: true } }, account: true, card: true }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: 8 }),
      this.prisma.transaction.findMany({ where: { householdId, occurredOn: { gte: start, lt: end } }, include: { account: true, card: true, subcategory: { include: { category: true } } }, orderBy: { occurredOn: 'asc' } }),
      this.prisma.transaction.findMany({ where: { householdId, occurredOn: { gte: previousRange.start, lt: previousRange.end } }, select: { amount: true, type: true, status: true } }),
      this.prisma.cardStatement.findMany({ where: { householdId, status: { not: CardStatementStatus.PAID } }, include: { card: true, payments: true }, orderBy: { dueOn: 'asc' }, take: 5 }),
      this.prisma.recurringRule.findMany({ where: { householdId, status: RecurringRuleStatus.ACTIVE }, include: { account: true, card: true, category: true, subcategory: true } }),
      this.prisma.monthlyBudget.findMany({ where: { householdId, referenceMonth }, select: { categoryId: true, limitAmount: true } }),
      this.prisma.transaction.findMany({ where: { householdId, recurringRuleId: { not: null }, occurredOn: { lt: end } }, select: { recurringRuleId: true, recurrenceOn: true } }),
    ]);
    const existingRecurring = new Set(recurringOccurrences.map((item) => `${item.recurringRuleId}:${item.recurrenceOn?.toISOString().slice(0, 10)}`));
    const projectedRecurring = this.projectRecurringOccurrences(recurringRules as RecurringProjectionSource[], end, existingRecurring);
    const projectedForMonth = projectedRecurring.filter((item) => item.occurredOn >= start && item.occurredOn < end);
    const accountSummaries = accounts.map((account) => {
      const movement = account.transactions.filter((item) => item.status === TransactionStatus.POSTED).reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      const payments = account.cardPayments.reduce((sum, payment) => sum + payment.amount, 0);
      const transfersOut = account.outgoingTransfers.filter((transfer) => transfer.status === AccountTransferStatus.POSTED).reduce((sum, transfer) => sum + transfer.amount, 0);
      const transfersIn = account.incomingTransfers.filter((transfer) => transfer.status === AccountTransferStatus.POSTED).reduce((sum, transfer) => sum + transfer.amount, 0);
      const projectedMovement = projectedRecurring.filter((item) => item.accountId === account.id).reduce((sum, item) => sum + (item.type === TransactionType.INCOME ? item.amount : -item.amount), 0);
      return { ...account, transactions: undefined, cardPayments: undefined, outgoingTransfers: undefined, incomingTransfers: undefined, balance: account.initialBalance + movement + projectedMovement - payments - transfersOut + transfersIn };
    });
    const monthItems = [...monthTransactions, ...projectedForMonth].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
    const posted = monthItems.filter((transaction) => transaction.status === TransactionStatus.POSTED);
    const realizedIncome = this.sumByType(posted, TransactionType.INCOME);
    const realizedExpenses = this.sumByType(posted, TransactionType.EXPENSE);
    const pendingCommitments = this.sumByType(monthItems.filter((transaction) => transaction.status === TransactionStatus.PENDING), TransactionType.EXPENSE);
    const previousPosted = previousTransactions.filter((transaction) => transaction.status === TransactionStatus.POSTED);
    const previousIncome = this.sumByType(previousPosted, TransactionType.INCOME);
    const previousExpenses = this.sumByType(previousPosted, TransactionType.EXPENSE);
    const weekly = Array.from({ length: 5 }, (_, index) => ({ week: index + 1, income: 0, expenses: 0 }));
    const categoryTotals = new Map<string, { categoryId: string; name: string; color: string; amount: number }>();
    for (const transaction of posted) {
      const week = Math.min(4, Math.floor((transaction.occurredOn.getUTCDate() - 1) / 7));
      if (transaction.type === TransactionType.INCOME) weekly[week].income += transaction.amount;
      else {
        weekly[week].expenses += transaction.amount;
        const category = categoryTotals.get(transaction.subcategory.categoryId) ?? { categoryId: transaction.subcategory.categoryId, name: transaction.subcategory.category.name, color: transaction.subcategory.category.color, amount: 0 };
        category.amount += transaction.amount;
        categoryTotals.set(transaction.subcategory.categoryId, category);
      }
    }
    const budgetLimit = budgets.reduce((sum, budget) => sum + budget.limitAmount, 0);
    const budgetSpent = posted.filter((transaction) => transaction.type === TransactionType.EXPENSE && budgets.some((budget) => budget.categoryId === transaction.subcategory.categoryId)).reduce((sum, transaction) => sum + transaction.amount, 0);
    const cardOpenTotal = statements.reduce((sum, statement) => sum + Math.max(0, statement.totalAmount - statement.payments.reduce((paid, payment) => paid + payment.amount, 0)), 0);
    const netFlow = realizedIncome - realizedExpenses;
    const previousNetFlow = previousIncome - previousExpenses;
    return {
      referenceMonth: referenceMonth.toISOString().slice(0, 7),
      isForecast: referenceMonth > this.monthStart(new Date().toISOString().slice(0, 7)),
      totalBalance: accountSummaries.reduce((sum, account) => sum + account.balance, 0),
      accounts: accountSummaries,
      recentTransactions: [...transactions, ...projectedForMonth].sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime()).slice(0, 8),
      cardOpenTotal,
      pendingCommitments,
      upcomingStatements: statements,
      recurringForecast: recurringRules.map((rule) => ({ id: rule.id, amount: rule.amount, description: rule.description, startOn: rule.startOn, endOn: rule.endOn })),
      indicators: { availableBalance: accountSummaries.reduce((sum, account) => sum + account.balance, 0), realizedIncome, realizedExpenses, pendingCommitments, cardOpenTotal, budgetCommitted: budgetSpent + pendingCommitments },
      comparison: { income: { current: realizedIncome, previous: previousIncome }, expenses: { current: realizedExpenses, previous: previousExpenses }, balance: { current: netFlow, previous: previousNetFlow } },
      charts: {
        weeklyFlow: weekly,
        expenseByCategory: [...categoryTotals.values()].sort((a, b) => b.amount - a.amount),
        budget: { limitAmount: budgetLimit, spentAmount: budgetSpent, pendingAmount: pendingCommitments },
      },
    };
  }

  async listAccounts(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const accounts = await this.prisma.account.findMany({ where: { householdId }, include: { transactions: true, cardPayments: true, outgoingTransfers: true, incomingTransfers: true }, orderBy: { name: 'asc' } });
    return accounts.map((account) => {
      const movement = account.transactions.filter((item) => item.status === TransactionStatus.POSTED).reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      const payments = account.cardPayments.reduce((sum, payment) => sum + payment.amount, 0);
      const transfersOut = account.outgoingTransfers.filter((transfer) => transfer.status === AccountTransferStatus.POSTED).reduce((sum, transfer) => sum + transfer.amount, 0);
      const transfersIn = account.incomingTransfers.filter((transfer) => transfer.status === AccountTransferStatus.POSTED).reduce((sum, transfer) => sum + transfer.amount, 0);
      return { ...account, transactions: undefined, cardPayments: undefined, outgoingTransfers: undefined, incomingTransfers: undefined, balance: account.initialBalance + movement - payments - transfersOut + transfersIn };
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
      await this.audit(tx, householdId, userId, 'account', account.id, 'created', ['name', 'type', 'initialBalance']);
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
      await this.audit(tx, householdId, userId, 'account', accountId, 'updated', Object.keys(dto));
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
      await this.audit(tx, householdId, userId, 'account', accountId, isActive ? 'activated' : 'archived', ['isActive']);
      return updated;
    });
  }

  async listCards(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.card.findMany({ where: { householdId }, orderBy: { name: 'asc' } });
  }

  async createCard(userId: string, householdId: string, dto: CreateCard) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.create({ data: { householdId, ...dto, closingDay: dto.closingDay ?? 1, dueDay: dto.dueDay ?? 10 } });
      await this.events.record(tx, { aggregateType: 'card', aggregateId: card.id, eventType: 'orfina.cards.card-created.v1', payload: { cardId: card.id, householdId, network: card.network } });
      await this.audit(tx, householdId, userId, 'card', card.id, 'created', ['name', 'network', 'creditLimit', 'closingDay', 'dueDay']);
      return card;
    });
  }

  async updateCard(userId: string, householdId: string, cardId: string, dto: UpdateCard) {
    await this.households.assertCanManage(userId, householdId);
    const card = await this.prisma.card.findFirst({ where: { id: cardId, householdId } });
    if (!card) throw new NotFoundException('Cartão não encontrado neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.card.update({ where: { id: cardId }, data: dto });
      await this.events.record(tx, { aggregateType: 'card', aggregateId: cardId, eventType: 'orfina.cards.card-updated.v1', payload: { cardId, householdId, changedFields: Object.keys(dto) } });
      await this.audit(tx, householdId, userId, 'card', cardId, 'updated', Object.keys(dto));
      return updated;
    });
  }

  async setCardStatus(userId: string, householdId: string, cardId: string, isActive: boolean) {
    await this.households.assertCanManage(userId, householdId);
    const card = await this.prisma.card.findFirst({ where: { id: cardId, householdId } });
    if (!card) throw new NotFoundException('Cartão não encontrado neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.card.update({ where: { id: cardId }, data: { isActive } });
      await this.events.record(tx, { aggregateType: 'card', aggregateId: cardId, eventType: `orfina.cards.card-${isActive ? 'activated' : 'archived'}.v1`, payload: { cardId, householdId, isActive } });
      await this.audit(tx, householdId, userId, 'card', cardId, isActive ? 'activated' : 'archived', ['isActive']);
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
      const category = await tx.category.create({ data: { householdId, ...dto }, include: { subcategories: true } });
      const subcategory = category.subcategories.find((item) => item.isDefault)!;
      await this.events.record(tx, { aggregateType: 'subcategory', aggregateId: subcategory.id, eventType: 'orfina.categories.subcategory-created.v1', payload: { householdId, categoryId: category.id, subcategoryId: subcategory.id, type: category.type } });
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
      const updated = await tx.category.update({ where: { id: categoryId }, data: dto, include: { subcategories: true } });
      if (dto.name && dto.name !== category.name) {
        const subcategory = updated.subcategories.find((item) => item.isDefault)!;
        await this.events.record(tx, { aggregateType: 'subcategory', aggregateId: subcategory.id, eventType: 'orfina.categories.subcategory-updated.v1', payload: { householdId, categoryId, subcategoryId: subcategory.id } });
      }
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
    if (dto.name === category.name) throw new BadRequestException('A subcategoria com o nome da categoria já existe automaticamente.');

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
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: subcategoryId, category: { householdId } }, include: { category: true } });
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.isDefault) throw new BadRequestException('A subcategoria automática é gerenciada pela categoria.');
    if (dto.name === subcategory.category.name) throw new BadRequestException('Este nome pertence à subcategoria automática.');
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
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: subcategoryId, category: { householdId } }, include: { category: true } });
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.isDefault) throw new BadRequestException('A subcategoria automática é gerenciada pela categoria.');
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
      cardId: filters.cardId,
      statementId: filters.statementId,
      recurringRuleId: filters.recurringRuleId,
      subcategory: filters.categoryId ? { categoryId: filters.categoryId } : undefined,
      subcategoryId: filters.subcategoryId,
      type: filters.type,
      status: filters.status,
      importItem: filters.importBatchId ? { batchId: filters.importBatchId } : undefined,
    };
    if (filters.from || filters.to) {
      where.occurredOn = {
        ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00.000Z`) } : {}),
        ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
      };
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where, include: { account: true, card: true, subcategory: { include: { category: true } } },
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
    const [account, card, subcategory] = await Promise.all([
      dto.accountId ? this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }) : null,
      dto.cardId ? this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }) : null,
      this.prisma.subcategory.findFirst({
        where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } },
        include: { category: true },
      }),
    ]);
    if (dto.accountId ? !account : !card) throw new NotFoundException(dto.accountId ? 'Conta não encontrada neste grupo familiar.' : 'Cartão não encontrado neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao do lançamento.');

    return this.prisma.$transaction(async (tx) => {
      const statement = card ? await this.statementForDate(tx, card, householdId, dto.occurredOn) : undefined;
      if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível alterar uma fatura fechada ou paga. Registre um ajuste rastreável.');
      const transaction = await tx.transaction.create({
        data: { householdId, ...dto, statementId: statement?.id, occurredOn: this.civilDate(dto.occurredOn) },
        include: { account: true, card: true, subcategory: { include: { category: true } } },
      });
      if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transaction.id,
        eventType: `orfina.transactions.transaction-${transaction.status === TransactionStatus.PENDING ? 'pending' : 'posted'}.v1`,
        payload: { transactionId: transaction.id, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.subcategory.categoryId, type: transaction.type, status: transaction.status },
      });
      await this.audit(tx, householdId, userId, 'transaction', transaction.id, 'created', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
      return transaction;
    });
  }

  async updateTransaction(userId: string, householdId: string, transactionId: string, dto: CreateTransaction) {
    await this.households.assertCanWrite(userId, householdId);
    const [existing, account, card, subcategory] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } }),
      dto.accountId ? this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }) : null,
      dto.cardId ? this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }) : null,
      this.prisma.subcategory.findFirst({
        where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } },
        include: { category: true },
      }),
    ]);
    if (!existing) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    if (dto.accountId ? !account : !card) throw new NotFoundException(dto.accountId ? 'Conta não encontrada neste grupo familiar.' : 'Cartão não encontrado neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao do lançamento.');

    return this.prisma.$transaction(async (tx) => {
      if (existing.statementId) {
        const oldStatement = await tx.cardStatement.findUnique({ where: { id: existing.statementId } });
        if (oldStatement?.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível alterar uma fatura fechada ou paga. Registre um ajuste rastreável.');
      }
      const statement = card ? await this.statementForDate(tx, card, householdId, dto.occurredOn) : undefined;
      if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível alterar uma fatura fechada ou paga. Registre um ajuste rastreável.');
      const transaction = await tx.transaction.update({
        where: { id: transactionId },
        data: {
          ...dto,
          statementId: statement?.id ?? null,
          occurredOn: this.civilDate(dto.occurredOn),
        },
        include: { account: true, card: true, subcategory: { include: { category: true } } },
      });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-updated.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.subcategory.categoryId, subcategoryId: transaction.subcategoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
      });
      if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.transactionImpact(existing.type, existing.amount));
      if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'updated', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
      return transaction;
    });
  }

  /** Converts a standalone transaction once; schedule occurrences cannot change kind. */
  async convertTransaction(userId: string, householdId: string, transactionId: string, dto: TransactionConversion) {
    await this.households.assertCanWrite(userId, householdId);
    const [existing, account, card, subcategory] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } }),
      dto.accountId ? this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }) : null,
      dto.cardId ? this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }) : null,
      this.prisma.subcategory.findFirst({ where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } }, include: { category: true } }),
    ]);
    if (!existing) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    if (existing.installmentPurchaseId || existing.recurringRuleId) throw new BadRequestException('Somente lançamentos avulsos podem ser convertidos.');
    if (existing.type !== dto.type) throw new BadRequestException('O tipo de um lançamento existente não pode ser alterado.');
    if (dto.accountId ? !account : !card) throw new NotFoundException(dto.accountId ? 'Conta não encontrada neste grupo familiar.' : 'Cartão não encontrado neste grupo familiar.');
    if (!subcategory || subcategory.category.type !== dto.type) throw new BadRequestException('A subcategoria deve pertencer a uma categoria ativa do mesmo tipo.');

    return this.prisma.$transaction(async (tx) => {
      if (existing.statementId) {
        const oldStatement = await tx.cardStatement.findUnique({ where: { id: existing.statementId } });
        if (oldStatement?.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível converter lançamento de uma fatura fechada ou paga.');
      }

      if (dto.mode === 'FIXED') {
        const occurredOn = this.civilDate(dto.startOn);
        const statement = card ? await this.statementForDate(tx, card, householdId, occurredOn) : undefined;
        if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível incluir a ocorrência em uma fatura fechada ou paga.');
        const rule = await tx.recurringRule.create({ data: { householdId, accountId: account?.id, cardId: card?.id, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, type: dto.type, amount: dto.amount, description: dto.description, notes: dto.notes, startOn: occurredOn, endOn: dto.endOn ? this.civilDate(dto.endOn) : undefined } });
        const transaction = await tx.transaction.update({ where: { id: transactionId }, data: { accountId: account?.id, cardId: card?.id, statementId: statement?.id ?? null, recurringRuleId: rule.id, recurrenceOn: occurredOn, subcategoryId: subcategory.id, type: dto.type, amount: dto.amount, description: dto.description, notes: dto.notes, occurredOn }, include: { subcategory: true } });
        if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.transactionImpact(existing.type, existing.amount));
        if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
        await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: rule.id, eventType: 'orfina.recurring.rule-created.v1', payload: { ruleId: rule.id, householdId, accountId: rule.accountId, cardId: rule.cardId, amount: rule.amount, convertedTransactionId: transactionId } });
        await this.events.record(tx, { aggregateType: 'transaction', aggregateId: transactionId, eventType: 'orfina.transactions.transaction-converted.v1', payload: { transactionId, householdId, mode: dto.mode, recurringRuleId: rule.id } });
        await this.audit(tx, householdId, userId, 'transaction', transactionId, 'converted-to-recurring', ['recurringRuleId', 'accountId', 'cardId', 'subcategoryId', 'amount', 'occurredOn']);
        return { mode: dto.mode, transaction, recurringRule: rule };
      }

      const startInstallmentNumber = dto.startInstallmentNumber ?? 1;
      const installments = this.splitAmount(dto.totalAmount, dto.installmentCount);
      const purchase = await tx.installmentPurchase.create({ data: { householdId, accountId: account?.id, cardId: card?.id, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, type: dto.type, totalAmount: dto.totalAmount, installmentCount: dto.installmentCount, startInstallmentNumber, description: dto.description, firstOccurredOn: this.civilDate(dto.firstOccurredOn) } });
      for (let index = startInstallmentNumber - 1; index < dto.installmentCount; index += 1) {
        const occurredOn = this.installmentOccurrenceOn(dto.firstOccurredOn, startInstallmentNumber, index);
        const statement = card ? await this.statementForDate(tx, card, householdId, occurredOn) : undefined;
        if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Uma parcela cairia em uma fatura já fechada; escolha uma data inicial posterior.');
        const amount = installments[index];
        if (index === startInstallmentNumber - 1) {
          const transaction = await tx.transaction.update({ where: { id: transactionId }, data: { accountId: account?.id, cardId: card?.id, statementId: statement?.id ?? null, installmentPurchaseId: purchase.id, installmentNumber: index + 1, subcategoryId: subcategory.id, type: dto.type, amount, description: `${dto.description} (${index + 1}/${dto.installmentCount})`, notes: dto.notes, occurredOn } });
          if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.transactionImpact(existing.type, existing.amount));
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
        } else {
          const transaction = await tx.transaction.create({ data: { householdId, accountId: account?.id, cardId: card?.id, statementId: statement?.id, installmentPurchaseId: purchase.id, installmentNumber: index + 1, subcategoryId: subcategory.id, type: dto.type, amount, description: `${dto.description} (${index + 1}/${dto.installmentCount})`, notes: dto.notes, occurredOn } });
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
        }
      }
      await this.events.record(tx, { aggregateType: 'installment-purchase', aggregateId: purchase.id, eventType: 'orfina.installments.purchase-created.v1', payload: { purchaseId: purchase.id, householdId, accountId: purchase.accountId, cardId: purchase.cardId, totalAmount: purchase.totalAmount, installmentCount: purchase.installmentCount, startInstallmentNumber, convertedTransactionId: transactionId } });
      await this.events.record(tx, { aggregateType: 'transaction', aggregateId: transactionId, eventType: 'orfina.transactions.transaction-converted.v1', payload: { transactionId, householdId, mode: dto.mode, installmentPurchaseId: purchase.id } });
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'converted-to-installment', ['installmentPurchaseId', 'accountId', 'cardId', 'subcategoryId', 'amount', 'occurredOn']);
      return { mode: dto.mode, installmentPurchase: purchase };
    });
  }

  /** Updates one occurrence, or splits its schedule so prior history stays immutable. */
  async updateOccurrence(userId: string, householdId: string, transactionId: string, dto: CreateTransaction, scope: 'ONE' | 'FOLLOWING') {
    if (scope === 'ONE') return this.updateTransaction(userId, householdId, transactionId, dto);
    await this.households.assertCanWrite(userId, householdId);
    const existing = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId }, include: { installmentPurchase: true, recurringRule: true } });
    if (!existing?.installmentPurchaseId && !existing?.recurringRuleId) throw new BadRequestException('Somente ocorrências de parcelamento ou recorrência podem ser alteradas a partir desta data.');
    // An installment schedule owns its source and calendar. Preserve those
    // values when changing this and following occurrences, even if a stale
    // client form posts a different selection or time representation.
    const effectiveDto = existing.installmentPurchaseId
      ? { ...dto, accountId: existing.accountId ?? undefined, cardId: existing.cardId ?? undefined, occurredOn: existing.occurredOn.toISOString().slice(0, 10) }
      : dto;
    const updated = await this.updateTransaction(userId, householdId, transactionId, effectiveDto);
    if (existing.installmentPurchaseId) return this.updateInstallmentOccurrences(userId, householdId, existing, updated);
    return this.splitRecurringRule(userId, householdId, existing, updated);
  }

  private async updateInstallmentOccurrences(userId: string, householdId: string, original: { installmentPurchaseId: string | null; installmentNumber: number | null; occurredOn: Date }, updated: { id: string; occurredOn: Date; subcategoryId: string; type: TransactionType; amount: number; description: string; notes: string | null }) {
    const purchaseId = original.installmentPurchaseId!;
    const [purchase, siblings, subcategory] = await Promise.all([
      this.prisma.installmentPurchase.findFirst({ where: { id: purchaseId, householdId } }),
      this.prisma.transaction.findMany({ where: { householdId, installmentPurchaseId: purchaseId, occurredOn: { gt: original.occurredOn } }, include: { statement: true } }),
      this.prisma.subcategory.findFirst({ where: { id: updated.subcategoryId }, include: { category: true } }),
    ]);
    if (!purchase || !subcategory || !original.installmentNumber) throw new NotFoundException('Parcelamento ou subcategoria não encontrados.');
    if (siblings.some((item) => item.statement && item.statement.status !== CardStatementStatus.OPEN)) throw new BadRequestException('Não é possível alterar parcelas futuras que pertencem a faturas fechadas ou pagas.');
    return this.prisma.$transaction(async (tx) => {
      const baseDescription = updated.description.replace(/ \(\d+\/\d+\)$/, '');
      const current = await tx.transaction.update({ where: { id: updated.id }, data: { description: `${baseDescription} (${original.installmentNumber}/${purchase.installmentCount})` } });
      for (const item of siblings) {
        const description = `${baseDescription} (${item.installmentNumber}/${purchase.installmentCount})`;
        const next = await tx.transaction.update({ where: { id: item.id }, data: { subcategoryId: updated.subcategoryId, type: updated.type, amount: updated.amount, description, notes: updated.notes } });
        if (item.statementId) await this.adjustStatementTotal(tx, item.statementId, this.transactionImpact(next.type, next.amount) - this.transactionImpact(item.type, item.amount));
      }
      const all = await tx.transaction.findMany({ where: { installmentPurchaseId: purchaseId }, select: { amount: true } });
      await tx.installmentPurchase.update({ where: { id: purchaseId }, data: { subcategoryId: updated.subcategoryId, categoryId: subcategory.categoryId, type: updated.type, description: baseDescription, totalAmount: all.reduce((sum, item) => sum + item.amount, 0) } });
      await this.events.record(tx, { aggregateType: 'installment-purchase', aggregateId: purchaseId, eventType: 'orfina.installments.occurrences-updated.v1', payload: { householdId, purchaseId, fromTransactionId: updated.id, updatedCount: siblings.length + 1 } });
      await this.audit(tx, householdId, userId, 'installment-purchase', purchaseId, 'occurrences-updated', ['subcategoryId', 'type', 'amount', 'description']);
      return { ...current, followingUpdated: siblings.length };
    });
  }

  private async splitRecurringRule(userId: string, householdId: string, original: { recurringRuleId: string | null; occurredOn: Date }, updated: { id: string; occurredOn: Date; accountId: string | null; cardId: string | null; subcategoryId: string; type: TransactionType; amount: number; description: string; notes: string | null }) {
    const rule = await this.prisma.recurringRule.findFirst({ where: { id: original.recurringRuleId!, householdId } });
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: updated.subcategoryId }, include: { category: true } });
    const targetCard = updated.cardId ? await this.prisma.card.findFirst({ where: { id: updated.cardId, householdId } }) : null;
    if (!rule || !subcategory) throw new NotFoundException('Recorrência ou subcategoria não encontrada.');
    const previous = this.addMonths(original.occurredOn, -1);
    return this.prisma.$transaction(async (tx) => {
      let successorId = rule.id;
      if (previous < rule.startOn) {
        await tx.recurringRule.update({ where: { id: rule.id }, data: { accountId: updated.accountId, cardId: updated.cardId, categoryId: subcategory.categoryId, subcategoryId: updated.subcategoryId, type: updated.type, amount: updated.amount, description: updated.description, notes: updated.notes, startOn: updated.occurredOn } });
      } else {
        await tx.recurringRule.update({ where: { id: rule.id }, data: { status: RecurringRuleStatus.ENDED, endOn: previous } });
        const successor = await tx.recurringRule.create({ data: { householdId, predecessorId: rule.id, accountId: updated.accountId, cardId: updated.cardId, categoryId: subcategory.categoryId, subcategoryId: updated.subcategoryId, type: updated.type, amount: updated.amount, description: updated.description, notes: updated.notes, startOn: updated.occurredOn, endOn: rule.endOn } });
        successorId = successor.id;
        await tx.transaction.update({ where: { id: updated.id }, data: { recurringRuleId: successor.id, recurrenceOn: updated.occurredOn } });
      }
      const futureOccurrences = await tx.transaction.findMany({ where: { householdId, recurringRuleId: rule.id, occurredOn: { gt: updated.occurredOn } }, include: { statement: true } });
      if (futureOccurrences.some((item) => item.statement && item.statement.status !== CardStatementStatus.OPEN)) throw new BadRequestException('Não é possível alterar competências futuras já pertencentes a faturas fechadas ou pagas.');
      for (const occurrence of futureOccurrences) {
        const statement = targetCard ? await this.statementForDate(tx, targetCard, householdId, occurrence.occurredOn) : undefined;
        if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Uma competência futura cairia em fatura fechada ou paga.');
        const next = await tx.transaction.update({ where: { id: occurrence.id }, data: { recurringRuleId: successorId, accountId: updated.accountId, cardId: updated.cardId, statementId: statement?.id ?? null, subcategoryId: updated.subcategoryId, type: updated.type, amount: updated.amount, description: updated.description, notes: updated.notes } });
        if (occurrence.statementId) await this.adjustStatementTotal(tx, occurrence.statementId, -this.transactionImpact(occurrence.type, occurrence.amount));
        if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(next.type, next.amount));
      }
      await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: successorId, eventType: 'orfina.recurring.occurrences-updated.v1', payload: { householdId, previousRuleId: rule.id, ruleId: successorId, fromTransactionId: updated.id } });
      await this.audit(tx, householdId, userId, 'recurring-rule', successorId, 'occurrences-updated', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'description']);
      return { ...updated, successorRuleId: successorId };
    });
  }

  async deleteTransaction(userId: string, householdId: string, transactionId: string) {
    await this.households.assertCanWrite(userId, householdId);
    const transaction = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId }, include: { subcategory: true } });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      if (transaction.statementId) {
        const statement = await tx.cardStatement.findUnique({ where: { id: transaction.statementId } });
        if (statement?.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível apagar lançamento de fatura fechada ou paga.');
        await this.adjustStatementTotal(tx, transaction.statementId, -this.transactionImpact(transaction.type, transaction.amount));
      }
      await tx.transaction.delete({ where: { id: transactionId } });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-deleted.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.subcategory.categoryId, subcategoryId: transaction.subcategoryId },
      });
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'deleted', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount']);
      return { id: transactionId, deleted: true };
    });
  }

  async setTransactionStatus(userId: string, householdId: string, transactionId: string, status: TransactionStatus) {
    await this.households.assertCanWrite(userId, householdId);
    const transaction = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } });
    if (!transaction) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
    if (transaction.statementId) throw new BadRequestException('A situação de lançamento de cartão é controlada pela fatura.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.transaction.update({ where: { id: transactionId }, data: { status }, include: { account: true, card: true, subcategory: { include: { category: true } } } });
      await this.events.record(tx, { aggregateType: 'transaction', aggregateId: transactionId, eventType: 'orfina.transactions.status-changed.v1', payload: { householdId, transactionId, status } });
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'status-changed', ['status']);
      return updated;
    });
  }

  async listTransfers(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.accountTransfer.findMany({ where: { householdId }, include: { sourceAccount: true, destinationAccount: true, importItem: { select: { batchId: true } } }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }] });
  }

  async createTransfer(userId: string, householdId: string, dto: CreateTransfer) {
    await this.households.assertCanManage(userId, householdId);
    if (dto.sourceAccountId === dto.destinationAccountId) throw new BadRequestException('Origem e destino da transferência devem ser contas diferentes.');
    const accounts = await this.prisma.account.count({ where: { householdId, isActive: true, id: { in: [dto.sourceAccountId, dto.destinationAccountId] } } });
    if (accounts !== 2) throw new NotFoundException('As contas da transferência devem ser ativas e pertencer ao grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.accountTransfer.create({ data: { householdId, ...dto, occurredOn: this.civilDate(dto.occurredOn), status: dto.status ?? AccountTransferStatus.POSTED }, include: { sourceAccount: true, destinationAccount: true } });
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-created.v1', payload: { householdId, transferId: transfer.id, status: transfer.status } });
      await this.audit(tx, householdId, userId, 'transfer', transfer.id, 'created', ['sourceAccountId', 'destinationAccountId', 'status']);
      return transfer;
    });
  }

  async setTransferStatus(userId: string, householdId: string, transferId: string, status: AccountTransferStatus) {
    await this.households.assertCanManage(userId, householdId);
    const transfer = await this.prisma.accountTransfer.findFirst({ where: { id: transferId, householdId } });
    if (!transfer) throw new NotFoundException('Transferência não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accountTransfer.update({ where: { id: transferId }, data: { status } });
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transferId, eventType: 'orfina.transfers.transfer-status-changed.v1', payload: { householdId, transferId, status } });
      await this.audit(tx, householdId, userId, 'transfer', transferId, 'status-changed', ['status']);
      return updated;
    });
  }

  async listCardStatements(userId: string, householdId: string, cardId: string) {
    await this.households.assertMember(userId, householdId);
    const card = await this.prisma.card.findFirst({ where: { id: cardId, householdId } });
    if (!card) throw new NotFoundException('Cartão não encontrado neste grupo familiar.');
    return this.prisma.cardStatement.findMany({
      where: { householdId, cardId },
      include: { payments: { orderBy: { paidOn: 'desc' } } },
      orderBy: { cycleEnd: 'desc' },
    });
  }

  async closeStatement(userId: string, householdId: string, statementId: string) {
    await this.households.assertCanManage(userId, householdId);
    const statement = await this.prisma.cardStatement.findFirst({ where: { id: statementId, householdId } });
    if (!statement) throw new NotFoundException('Fatura não encontrada neste grupo familiar.');
    if (statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Esta fatura já foi fechada ou paga.');
    return this.prisma.$transaction(async (tx) => {
      const closed = await tx.cardStatement.update({ where: { id: statementId }, data: { status: CardStatementStatus.CLOSED, closedAt: new Date() } });
      await this.events.record(tx, { aggregateType: 'card-statement', aggregateId: statementId, eventType: 'orfina.cards.statement-closed.v1', payload: { statementId, cardId: statement.cardId, householdId, totalAmount: closed.totalAmount } });
      await this.audit(tx, householdId, userId, 'card-statement', statementId, 'closed', ['status', 'closedAt']);
      return closed;
    });
  }

  async payStatement(userId: string, householdId: string, statementId: string, dto: StatementPayment) {
    await this.households.assertCanWrite(userId, householdId);
    const existing = await this.prisma.cardPayment.findUnique({ where: { householdId_idempotencyKey: { householdId, idempotencyKey: dto.idempotencyKey } } });
    if (existing) return existing;
    const [statement, account] = await Promise.all([
      this.prisma.cardStatement.findFirst({ where: { id: statementId, householdId }, include: { payments: true } }),
      this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }),
    ]);
    if (!statement) throw new NotFoundException('Fatura não encontrada neste grupo familiar.');
    if (!account) throw new NotFoundException('Conta não encontrada neste grupo familiar.');
    if (statement.status === CardStatementStatus.OPEN) throw new BadRequestException('Feche a fatura antes de registrar seu pagamento.');
    if (statement.status === CardStatementStatus.PAID) throw new BadRequestException('Esta fatura já está paga.');
    const alreadyPaid = statement.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const outstanding = statement.totalAmount - alreadyPaid;
    if (dto.amount > outstanding) throw new BadRequestException('O pagamento não pode superar o total em aberto da fatura.');
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.cardPayment.create({ data: { householdId, statementId, accountId: dto.accountId, amount: dto.amount, idempotencyKey: dto.idempotencyKey, paidOn: this.civilDate(dto.paidOn) } });
      const paidInFull = dto.amount === outstanding;
      if (paidInFull) await tx.cardStatement.update({ where: { id: statementId }, data: { status: CardStatementStatus.PAID, paidAt: new Date() } });
      await this.events.record(tx, { aggregateType: 'card-payment', aggregateId: payment.id, eventType: 'orfina.cards.statement-payment-posted.v1', payload: { paymentId: payment.id, statementId, cardId: statement.cardId, accountId: dto.accountId, householdId, amount: dto.amount } });
      await this.audit(tx, householdId, userId, 'card-payment', payment.id, 'created', ['statementId', 'accountId', 'amount', 'paidOn']);
      return payment;
    });
  }

  async createInstallmentPurchase(userId: string, householdId: string, dto: InstallmentPurchaseInput) {
    await this.households.assertCanWrite(userId, householdId);
    const startInstallmentNumber = dto.startInstallmentNumber ?? 1;
    if (startInstallmentNumber > dto.installmentCount) throw new BadRequestException('A parcela inicial não pode ser maior que o total de parcelas.');
    const [account, card, subcategory] = await Promise.all([
      dto.accountId ? this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }) : null,
      dto.cardId ? this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }) : null,
      this.prisma.subcategory.findFirst({ where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } }, include: { category: true } }),
    ]);
    if (dto.accountId ? !account : !card) throw new NotFoundException(dto.accountId ? 'Conta não encontrada neste grupo familiar.' : 'Cartão não encontrado neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao da compra.');
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.installmentPurchase.create({ data: { householdId, accountId: account?.id, cardId: card?.id, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, type: dto.type, totalAmount: dto.totalAmount, installmentCount: dto.installmentCount, startInstallmentNumber, description: dto.description, firstOccurredOn: this.civilDate(dto.firstOccurredOn) } });
      const installments = this.splitAmount(dto.totalAmount, dto.installmentCount);
      for (let index = startInstallmentNumber - 1; index < dto.installmentCount; index += 1) {
        const occurredOn = this.installmentOccurrenceOn(dto.firstOccurredOn, startInstallmentNumber, index);
        const statement = card ? await this.statementForDate(tx, card, householdId, occurredOn) : undefined;
        if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Uma parcela cairia em uma fatura já fechada; escolha uma data inicial posterior.');
        const amount = installments[index];
        const transaction = await tx.transaction.create({ data: { householdId, accountId: account?.id, cardId: card?.id, statementId: statement?.id, installmentPurchaseId: purchase.id, installmentNumber: index + 1, subcategoryId: subcategory.id, type: dto.type, amount, description: `${dto.description} (${index + 1}/${dto.installmentCount})`, notes: dto.notes, occurredOn: this.civilDate(occurredOn) } });
        if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      }
      await this.events.record(tx, { aggregateType: 'installment-purchase', aggregateId: purchase.id, eventType: 'orfina.installments.purchase-created.v1', payload: { purchaseId: purchase.id, householdId, accountId: account?.id, cardId: card?.id, totalAmount: dto.totalAmount, installmentCount: dto.installmentCount, startInstallmentNumber } });
      await this.audit(tx, householdId, userId, 'installment-purchase', purchase.id, 'created', ['accountId', 'cardId', 'totalAmount', 'installmentCount', 'startInstallmentNumber', 'subcategoryId']);
      return purchase;
    });
  }

  async cancelFutureInstallments(userId: string, householdId: string, purchaseId: string) {
    await this.households.assertCanWrite(userId, householdId);
    const purchase = await this.prisma.installmentPurchase.findFirst({ where: { id: purchaseId, householdId }, include: { transactions: { include: { statement: true } } } });
    if (!purchase) throw new NotFoundException('Compra parcelada não encontrada neste grupo familiar.');
    if (purchase.canceledAt) throw new BadRequestException('As parcelas futuras desta compra já foram canceladas.');
    const today = this.civilDate(new Date());
    const deletable = purchase.transactions.filter((transaction) => transaction.occurredOn > today && (!transaction.statement || transaction.statement.status === CardStatementStatus.OPEN));
    const blocked = purchase.transactions.filter((transaction) => transaction.occurredOn > today && transaction.statement && transaction.statement.status !== CardStatementStatus.OPEN);
    if (blocked.length) throw new BadRequestException('Não é possível cancelar parcelas que já pertencem a fatura fechada ou paga.');
    return this.prisma.$transaction(async (tx) => {
      for (const transaction of deletable) {
        if (transaction.statementId) await this.adjustStatementTotal(tx, transaction.statementId, -this.transactionImpact(transaction.type, transaction.amount));
        await tx.transaction.delete({ where: { id: transaction.id } });
      }
      const updated = await tx.installmentPurchase.update({ where: { id: purchaseId }, data: { canceledAt: new Date() } });
      await this.events.record(tx, { aggregateType: 'installment-purchase', aggregateId: purchaseId, eventType: 'orfina.installments.future-installments-canceled.v1', payload: { purchaseId, householdId, canceledCount: deletable.length } });
      await this.audit(tx, householdId, userId, 'installment-purchase', purchaseId, 'future-installments-canceled', ['canceledAt']);
      return { purchase: updated, canceledCount: deletable.length };
    });
  }

  async listRecurringRules(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.recurringRule.findMany({ where: { householdId }, include: { account: true, card: true, category: true, subcategory: true }, orderBy: { createdAt: 'desc' } });
  }

  async listInstallmentPurchases(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.installmentPurchase.findMany({
      where: { householdId },
      include: { account: true, card: true, transactions: { include: { statement: true }, orderBy: { installmentNumber: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createRecurringRule(userId: string, householdId: string, dto: RecurringRuleInput) {
    await this.households.assertCanWrite(userId, householdId);
    const [account, card, subcategory] = await Promise.all([
      dto.accountId ? this.prisma.account.findFirst({ where: { id: dto.accountId, householdId, isActive: true } }) : null,
      dto.cardId ? this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }) : null,
      this.prisma.subcategory.findFirst({ where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } }, include: { category: true } }),
    ]);
    if (dto.accountId ? !account : !card) throw new NotFoundException('A origem da recorrência não foi encontrada neste grupo familiar.');
    if (!subcategory || subcategory.category.type !== dto.type) throw new BadRequestException('A subcategoria deve pertencer a uma categoria ativa do mesmo tipo.');
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringRule.create({ data: { householdId, ...dto, categoryId: subcategory.categoryId, startOn: this.civilDate(dto.startOn), endOn: dto.endOn ? this.civilDate(dto.endOn) : undefined } });
      await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: rule.id, eventType: 'orfina.recurring.rule-created.v1', payload: { ruleId: rule.id, householdId, accountId: rule.accountId, cardId: rule.cardId, amount: rule.amount } });
      await this.audit(tx, householdId, userId, 'recurring-rule', rule.id, 'created', ['accountId', 'cardId', 'amount', 'startOn', 'endOn']);
      return rule;
    });
  }

  async setRecurringRuleStatus(userId: string, householdId: string, ruleId: string, status: 'ACTIVE' | 'PAUSED' | 'ENDED') {
    await this.households.assertCanWrite(userId, householdId);
    const rule = await this.prisma.recurringRule.findFirst({ where: { id: ruleId, householdId } });
    if (!rule) throw new NotFoundException('Regra recorrente não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recurringRule.update({ where: { id: ruleId }, data: { status: status as RecurringRuleStatus } });
      await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: ruleId, eventType: `orfina.recurring.rule-${status.toLowerCase()}.v1`, payload: { ruleId, householdId, status } });
      await this.audit(tx, householdId, userId, 'recurring-rule', ruleId, status.toLowerCase(), ['status']);
      return updated;
    });
  }

  /** Called by the worker; uniqueness on (recurringRuleId, recurrenceOn) makes retries safe. */
  async materializeRecurringRules(today = this.civilDate(new Date())) {
    const rules = await this.prisma.recurringRule.findMany({ where: { status: RecurringRuleStatus.ACTIVE }, include: { card: true, household: { select: { recurringMaterializationMode: true, recurringMaterializationValue: true } } } });
    let generated = 0;
    for (const rule of rules) {
      // The greatest advance is 28 days before a month; two civil months safely covers short months and month-end dates.
      const generationHorizon = this.addMonths(today, 2);
      for (let occurredOn = new Date(rule.startOn); occurredOn <= generationHorizon && (!rule.endOn || occurredOn <= rule.endOn); occurredOn = this.addMonths(occurredOn, 1)) {
        if (this.recurringLaunchOn(occurredOn, rule.household.recurringMaterializationMode, rule.household.recurringMaterializationValue) > today) continue;
        const made = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.transaction.findUnique({ where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: occurredOn } } });
          if (existing) return false;
          const statement = rule.card ? await this.statementForDate(tx, rule.card, rule.householdId, occurredOn) : undefined;
          if (statement && statement.status !== CardStatementStatus.OPEN) return false;
          const transaction = await tx.transaction.create({ data: { householdId: rule.householdId, accountId: rule.accountId, cardId: rule.cardId, statementId: statement?.id, recurringRuleId: rule.id, recurrenceOn: occurredOn, subcategoryId: rule.subcategoryId, type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes, occurredOn, status: occurredOn <= today ? TransactionStatus.POSTED : TransactionStatus.PENDING } });
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
          await this.events.record(tx, { aggregateType: 'recurring-occurrence', aggregateId: transaction.id, eventType: 'orfina.recurring.occurrence-created.v1', payload: { ruleId: rule.id, transactionId: transaction.id, householdId: rule.householdId, occurredOn: occurredOn.toISOString() } });
          await this.audit(tx, rule.householdId, null, 'recurring-occurrence', transaction.id, 'created', ['recurringRuleId', 'occurredOn']);
          return true;
        });
        if (made) generated += 1;
      }
      await this.prisma.transaction.updateMany({ where: { householdId: rule.householdId, recurringRuleId: rule.id, status: TransactionStatus.PENDING, occurredOn: { lte: today } }, data: { status: TransactionStatus.POSTED } });
    }
    return generated;
  }

  /** Builds read-only future occurrences; persistence remains the worker's responsibility. */
  private projectRecurringOccurrences(rules: RecurringProjectionSource[], end: Date, existing: Set<string>) {
    const projected: Array<{ id: string; accountId: string | null; cardId: string | null; account: unknown; card: unknown; subcategoryId: string; subcategory: { id: string; name: string; categoryId: string; isDefault: boolean; isActive: boolean; category: RecurringProjectionSource['category'] }; type: TransactionType; amount: number; description: string; notes: string | null; occurredOn: Date; status: TransactionStatus; isForecast: boolean }> = [];
    for (const rule of rules) {
      for (let occurredOn = new Date(rule.startOn); occurredOn < end && (!rule.endOn || occurredOn <= rule.endOn); occurredOn = this.addMonths(occurredOn, 1)) {
        const key = `${rule.id}:${occurredOn.toISOString().slice(0, 10)}`;
        if (existing.has(key)) continue;
        projected.push({ id: `forecast:${rule.id}:${occurredOn.toISOString().slice(0, 10)}`, accountId: rule.accountId, cardId: rule.cardId, account: rule.account, card: rule.card, subcategoryId: rule.subcategoryId, subcategory: { ...rule.subcategory, category: rule.category }, type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes, occurredOn, status: TransactionStatus.PENDING, isForecast: true });
      }
    }
    return projected;
  }

  private async statementForDate(tx: Prisma.TransactionClient, card: { id: string; closingDay: number; dueDay: number }, householdId: string, occurredOn: string | Date) {
    const date = this.civilDate(occurredOn);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const cycleEndMonth = date.getUTCDate() <= card.closingDay ? month : month + 1;
    const cycleEnd = this.utcDate(year, cycleEndMonth, card.closingDay);
    const cycleStart = this.utcDate(year, cycleEndMonth - 1, card.closingDay + 1);
    const dueOn = this.utcDate(year, cycleEndMonth + (card.dueDay <= card.closingDay ? 1 : 0), card.dueDay);
    return tx.cardStatement.upsert({ where: { cardId_cycleEnd: { cardId: card.id, cycleEnd } }, update: {}, create: { householdId, cardId: card.id, cycleStart, cycleEnd, dueOn } });
  }

  private async adjustStatementTotal(tx: Prisma.TransactionClient, statementId: string, amount: number) {
    await tx.cardStatement.update({ where: { id: statementId }, data: { totalAmount: { increment: amount } } });
  }

  private async audit(tx: Prisma.TransactionClient, householdId: string, actorId: string | null, aggregateType: string, aggregateId: string, action: string, changedFields: string[]) {
    await tx.auditLog.create({ data: { householdId, actorId, aggregateType, aggregateId, action, changedFields } });
  }

  private transactionImpact(type: TransactionType, amount: number) { return type === TransactionType.INCOME ? -amount : amount; }

  private sumByType(items: { amount: number; type: TransactionType }[], type: TransactionType) {
    return items.filter((item) => item.type === type).reduce((sum, item) => sum + item.amount, 0);
  }

  private monthStart(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new BadRequestException('Informe o mês no formato AAAA-MM.');
    const [year, month] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1, 12));
  }

  private monthRange(month: Date) {
    return { start: month, end: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1, 12)) };
  }

  private civilDate(value: string | Date) {
    const raw = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
    return new Date(`${raw}T12:00:00.000Z`);
  }

  private addMonths(value: string | Date, months: number) {
    const date = this.civilDate(value);
    const targetMonth = date.getUTCMonth() + months;
    const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    return this.utcDate(targetYear, normalizedMonth, Math.min(date.getUTCDate(), lastDay));
  }

  /**
   * The form's date is the occurrence being recorded, rather than a hidden
   * first installment. This lets someone register an ongoing plan at, for
   * example, installment 10 without shifting it another nine months ahead.
   */
  private installmentOccurrenceOn(occurrenceOn: string | Date, startInstallmentNumber: number, index: number) {
    return this.addMonths(occurrenceOn, index - (startInstallmentNumber - 1));
  }

  /** Returns the civil date on which one continuous occurrence becomes an actual transaction. */
  private recurringLaunchOn(occurredOn: Date, mode: RecurringMaterializationMode, value: number) {
    if (mode === RecurringMaterializationMode.ON_OCCURRENCE_DATE) return this.civilDate(occurredOn);
    const monthStart = this.utcDate(occurredOn.getUTCFullYear(), occurredOn.getUTCMonth(), 1);
    if (mode === RecurringMaterializationMode.EXERCISE_MONTH_DAY) return this.utcDate(occurredOn.getUTCFullYear(), occurredOn.getUTCMonth(), value);
    return this.addDays(monthStart, -value);
  }

  private addDays(value: Date, days: number) {
    const result = this.civilDate(value);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private splitAmount(totalAmount: number, installmentCount: number) {
    const quotient = Math.floor(totalAmount / installmentCount);
    const remainder = totalAmount % installmentCount;
    return Array.from({ length: installmentCount }, (_, index) => quotient + (index < remainder ? 1 : 0));
  }

  private utcDate(year: number, month: number, day: number) {
    const normalized = new Date(Date.UTC(year, month, 1, 12));
    const lastDay = new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0)).getUTCDate();
    normalized.setUTCDate(Math.min(day, lastDay));
    return normalized;
  }
}
