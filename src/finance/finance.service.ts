import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, CardNetwork, CardStatementStatus, CategoryType, Prisma, RecurringRuleStatus, TransactionType } from '@prisma/client';
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
type CreateTransaction = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; occurredOn: string; notes?: string };
type TransactionListFilters = { page: number; pageSize: number; from?: string; to?: string; accountId?: string; cardId?: string; statementId?: string; recurringRuleId?: string; categoryId?: string; subcategoryId?: string; type?: TransactionType };
type StatementPayment = { accountId: string; amount: number; paidOn: string; idempotencyKey: string };
type InstallmentPurchaseInput = { cardId: string; subcategoryId: string; type: TransactionType; totalAmount: number; installmentCount: number; description: string; firstOccurredOn: string; notes?: string };
type RecurringRuleInput = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; notes?: string; startOn: string; endOn?: string };

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly households: HouseholdsService,
    private readonly events: EventsService,
  ) {}

  async overview(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const [accounts, transactions, statements, recurringRules] = await Promise.all([
      this.prisma.account.findMany({ where: { householdId, isActive: true }, include: { transactions: true, cardPayments: true }, orderBy: { name: 'asc' } }),
      this.prisma.transaction.findMany({ where: { householdId }, include: { category: true, subcategory: true, account: true, card: true }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: 8 }),
      this.prisma.cardStatement.findMany({ where: { householdId, status: { not: CardStatementStatus.PAID } }, include: { card: true, payments: true }, orderBy: { dueOn: 'asc' }, take: 5 }),
      this.prisma.recurringRule.findMany({ where: { householdId, status: RecurringRuleStatus.ACTIVE }, select: { id: true, amount: true, description: true, startOn: true, endOn: true } }),
    ]);
    const accountSummaries = accounts.map((account) => {
      const movement = account.transactions.reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      const payments = account.cardPayments.reduce((sum, payment) => sum + payment.amount, 0);
      return { ...account, transactions: undefined, cardPayments: undefined, balance: account.initialBalance + movement - payments };
    });
    return {
      totalBalance: accountSummaries.reduce((sum, account) => sum + account.balance, 0),
      accounts: accountSummaries,
      recentTransactions: transactions,
      cardOpenTotal: statements.reduce((sum, statement) => sum + Math.max(0, statement.totalAmount - statement.payments.reduce((paid, payment) => paid + payment.amount, 0)), 0),
      upcomingStatements: statements,
      recurringForecast: recurringRules,
    };
  }

  async listAccounts(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const accounts = await this.prisma.account.findMany({ where: { householdId }, include: { transactions: true, cardPayments: true }, orderBy: { name: 'asc' } });
    return accounts.map((account) => {
      const movement = account.transactions.reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
      const payments = account.cardPayments.reduce((sum, payment) => sum + payment.amount, 0);
      return { ...account, transactions: undefined, cardPayments: undefined, balance: account.initialBalance + movement - payments };
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
      cardId: filters.cardId,
      statementId: filters.statementId,
      recurringRuleId: filters.recurringRuleId,
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
        where, include: { account: true, card: true, category: true, subcategory: true },
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
        data: { householdId, ...dto, statementId: statement?.id, categoryId: subcategory.categoryId, occurredOn: this.civilDate(dto.occurredOn) },
        include: { account: true, card: true, category: true, subcategory: true },
      });
      if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transaction.id,
        eventType: 'orfina.transactions.transaction-posted.v1',
        payload: { transactionId: transaction.id, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.categoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
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
          categoryId: subcategory.categoryId,
          occurredOn: this.civilDate(dto.occurredOn),
        },
        include: { account: true, card: true, category: true, subcategory: true },
      });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-updated.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.categoryId, subcategoryId: transaction.subcategoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
      });
      if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.transactionImpact(existing.type, existing.amount));
      if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'updated', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
      return transaction;
    });
  }

  async deleteTransaction(userId: string, householdId: string, transactionId: string) {
    await this.households.assertCanWrite(userId, householdId);
    const transaction = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId } });
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
        payload: { transactionId, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.categoryId, subcategoryId: transaction.subcategoryId },
      });
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'deleted', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount']);
      return { id: transactionId, deleted: true };
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
    const [card, subcategory] = await Promise.all([
      this.prisma.card.findFirst({ where: { id: dto.cardId, householdId, isActive: true } }),
      this.prisma.subcategory.findFirst({ where: { id: dto.subcategoryId, isActive: true, category: { householdId, isActive: true } }, include: { category: true } }),
    ]);
    if (!card) throw new NotFoundException('Cartão não encontrado neste grupo familiar.');
    if (!subcategory) throw new NotFoundException('Subcategoria não encontrada neste grupo familiar.');
    if (subcategory.category.type !== dto.type) throw new BadRequestException('O tipo da categoria deve ser igual ao da compra.');
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.installmentPurchase.create({ data: { householdId, cardId: card.id, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, type: dto.type, totalAmount: dto.totalAmount, installmentCount: dto.installmentCount, description: dto.description, firstOccurredOn: this.civilDate(dto.firstOccurredOn) } });
      const installments = this.splitAmount(dto.totalAmount, dto.installmentCount);
      for (let index = 0; index < dto.installmentCount; index += 1) {
        const occurredOn = this.addMonths(dto.firstOccurredOn, index);
        const statement = await this.statementForDate(tx, card, householdId, occurredOn);
        if (statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Uma parcela cairia em uma fatura já fechada; escolha uma data inicial posterior.');
        const amount = installments[index];
        const transaction = await tx.transaction.create({ data: { householdId, cardId: card.id, statementId: statement.id, installmentPurchaseId: purchase.id, installmentNumber: index + 1, categoryId: subcategory.categoryId, subcategoryId: subcategory.id, type: dto.type, amount, description: `${dto.description} (${index + 1}/${dto.installmentCount})`, notes: dto.notes, occurredOn: this.civilDate(occurredOn) } });
        await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      }
      await this.events.record(tx, { aggregateType: 'installment-purchase', aggregateId: purchase.id, eventType: 'orfina.installments.purchase-created.v1', payload: { purchaseId: purchase.id, householdId, cardId: card.id, totalAmount: dto.totalAmount, installmentCount: dto.installmentCount } });
      await this.audit(tx, householdId, userId, 'installment-purchase', purchase.id, 'created', ['cardId', 'totalAmount', 'installmentCount', 'subcategoryId']);
      return purchase;
    });
  }

  async cancelFutureInstallments(userId: string, householdId: string, purchaseId: string) {
    await this.households.assertCanWrite(userId, householdId);
    const purchase = await this.prisma.installmentPurchase.findFirst({ where: { id: purchaseId, householdId }, include: { transactions: { include: { statement: true } } } });
    if (!purchase) throw new NotFoundException('Compra parcelada não encontrada neste grupo familiar.');
    if (purchase.canceledAt) throw new BadRequestException('As parcelas futuras desta compra já foram canceladas.');
    const today = this.civilDate(new Date());
    const deletable = purchase.transactions.filter((transaction) => transaction.occurredOn > today && transaction.statement?.status === CardStatementStatus.OPEN);
    const blocked = purchase.transactions.filter((transaction) => transaction.occurredOn > today && transaction.statement?.status !== CardStatementStatus.OPEN);
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
      include: { card: true, transactions: { include: { statement: true }, orderBy: { installmentNumber: 'asc' } } },
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
    const rules = await this.prisma.recurringRule.findMany({ where: { status: RecurringRuleStatus.ACTIVE }, include: { card: true } });
    let generated = 0;
    for (const rule of rules) {
      for (let occurredOn = new Date(rule.startOn); occurredOn <= today && (!rule.endOn || occurredOn <= rule.endOn); occurredOn = this.addMonths(occurredOn, 1)) {
        const made = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.transaction.findUnique({ where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: occurredOn } } });
          if (existing) return false;
          const statement = rule.card ? await this.statementForDate(tx, rule.card, rule.householdId, occurredOn) : undefined;
          if (statement && statement.status !== CardStatementStatus.OPEN) return false;
          const transaction = await tx.transaction.create({ data: { householdId: rule.householdId, accountId: rule.accountId, cardId: rule.cardId, statementId: statement?.id, recurringRuleId: rule.id, recurrenceOn: occurredOn, categoryId: rule.categoryId, subcategoryId: rule.subcategoryId, type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes, occurredOn } });
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
          await this.events.record(tx, { aggregateType: 'recurring-occurrence', aggregateId: transaction.id, eventType: 'orfina.recurring.occurrence-created.v1', payload: { ruleId: rule.id, transactionId: transaction.id, householdId: rule.householdId, occurredOn: occurredOn.toISOString() } });
          await this.audit(tx, rule.householdId, null, 'recurring-occurrence', transaction.id, 'created', ['recurringRuleId', 'occurredOn']);
          return true;
        });
        if (made) generated += 1;
      }
    }
    return generated;
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
