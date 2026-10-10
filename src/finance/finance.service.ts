import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountTransferStatus, AccountType, CardNetwork, CardStatementStatus, CategoryType, FinancialRealizationMode, Prisma, RecurringMaterializationMode, RecurringRuleStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';
import { cardCycle, financialDate, financialPeriodWhere, inFinancialPeriod, statementForOccurrence, statementOutstandingAt } from './financial-period';

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
type RecurringTransferInput = Omit<CreateTransfer, 'occurredOn' | 'status'> & { startOn: string; endOn?: string };
type DeleteScope = 'ONE' | 'FOLLOWING' | 'ALL';
type StatementPayment = { accountId: string; amount: number; paidOn: string; idempotencyKey: string };
type ArchivedItemType = 'ACCOUNT' | 'CARD' | 'CATEGORY' | 'SUBCATEGORY';
type InstallmentPurchaseInput = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; totalAmount: number; installmentCount: number; startInstallmentNumber?: number; description: string; firstOccurredOn: string; notes?: string };
type RecurringRuleInput = { accountId?: string; cardId?: string; subcategoryId: string; type: TransactionType; amount: number; description: string; notes?: string; startOn: string; endOn?: string };
type RecurringProjectionSource = { id: string; householdId: string; accountId: string | null; cardId: string | null; subcategoryId: string; type: TransactionType; amount: number; description: string; notes: string | null; startOn: Date; endOn: Date | null; excludedOccurrences?: Prisma.JsonValue; account: unknown; card: { closingDay: number; dueDay: number } | null; category: { id: string; name: string; color: string; icon: string }; subcategory: { id: string; name: string; categoryId: string; isDefault: boolean; isActive: boolean } };

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
    const currentMonth = this.monthStart(new Date().toISOString().slice(0, 7));
    const isForecast = referenceMonth > currentMonth;
    const today = this.civilDate(new Date());
    const previousMonth = this.addMonths(referenceMonth, -1);
    const { start, end } = this.monthRange(referenceMonth);
    const previousRange = this.monthRange(previousMonth);
    const [accounts, transactions, monthTransactions, previousTransactions, statements, recurringRules, budgets, recurringOccurrences] = await Promise.all([
      this.prisma.account.findMany({
        where: { householdId, isActive: true },
        include: {
          // The same account set serves the current balance and the selected
          // month's projection. Keep both calculations in the API so the UI
          // never has to infer a balance from partial ledger data.
          transactions: { where: { deletedAt: null } },
          cardPayments: true,
          outgoingTransfers: { where: { deletedAt: null } },
          incomingTransfers: { where: { deletedAt: null } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.transaction.findMany({ where: { householdId, deletedAt: null, ...financialPeriodWhere(start, end) }, include: { subcategory: { include: { category: true } }, account: true, card: true, statement: true }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.transaction.findMany({ where: { householdId, deletedAt: null, ...financialPeriodWhere(start, end) }, include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } }, orderBy: { occurredOn: 'asc' } }),
      this.prisma.transaction.findMany({ where: { householdId, deletedAt: null, ...financialPeriodWhere(previousRange.start, previousRange.end) }, include: { card: true, statement: true } }),
      this.prisma.cardStatement.findMany({
        where: { householdId },
        include: { card: true, payments: true }, orderBy: { dueOn: 'asc' },
      }),
      this.prisma.recurringRule.findMany({ where: { householdId, status: RecurringRuleStatus.ACTIVE }, include: { account: true, card: true, category: true, subcategory: true } }),
      this.prisma.monthlyBudget.findMany({ where: { householdId, referenceMonth }, select: { categoryId: true, limitAmount: true } }),
      this.prisma.transaction.findMany({ where: { householdId, recurringRuleId: { not: null }, recurrenceOn: { lt: end } }, select: { recurringRuleId: true, recurrenceOn: true } }),
    ]);
    const existingRecurring = new Set(recurringOccurrences.map((item) => `${item.recurringRuleId}:${item.recurrenceOn?.toISOString().slice(0, 10)}`));
    const projectedRecurring = this.projectRecurringOccurrences(recurringRules as RecurringProjectionSource[], end, existingRecurring).flatMap((item) => {
      const statement = statementForOccurrence(item, statements);
      return statement && statement.status !== CardStatementStatus.OPEN ? [] : [{ ...item, statement }];
    });
    const projectedForMonth = projectedRecurring.filter((item) => inFinancialPeriod(item, start, end));
    const accountSummaries = accounts.map((account) => {
      const balanceAt = (cutoff: Date, includePending: boolean) => {
        // PostgreSQL DATE values return at midnight; compare civil dates so
        // the first day of the next period never leaks into this balance.
        const movement = account.transactions
          .filter((item) => this.civilDate(item.occurredOn) < cutoff && (item.status === TransactionStatus.POSTED || (includePending && item.status === TransactionStatus.PENDING)))
          .reduce((sum, item) => sum + (item.type === 'INCOME' ? item.amount : -item.amount), 0);
        const payments = account.cardPayments.filter((payment) => this.civilDate(payment.paidOn) < cutoff).reduce((sum, payment) => sum + payment.amount, 0);
        const transfersOut = account.outgoingTransfers
          .filter((transfer) => this.civilDate(transfer.occurredOn) < cutoff && (transfer.status === AccountTransferStatus.POSTED || (includePending && transfer.status === AccountTransferStatus.PENDING)))
          .reduce((sum, transfer) => sum + transfer.amount, 0);
        const transfersIn = account.incomingTransfers
          .filter((transfer) => this.civilDate(transfer.occurredOn) < cutoff && (transfer.status === AccountTransferStatus.POSTED || (includePending && transfer.status === AccountTransferStatus.PENDING)))
          .reduce((sum, transfer) => sum + transfer.amount, 0);
        return account.initialBalance + movement - payments - transfersOut + transfersIn;
      };
      const currentBalance = balanceAt(this.addDays(today, 1), false);
      const previousMonthBalance = balanceAt(start, false);
      const realizedBalance = balanceAt(end, false);
      const projectedBalance = balanceAt(end, true) + projectedRecurring
        .filter((item) => item.accountId === account.id)
        .reduce((sum, item) => sum + (item.type === TransactionType.INCOME ? item.amount : -item.amount), 0);
      return {
        ...account,
        transactions: undefined, cardPayments: undefined, outgoingTransfers: undefined, incomingTransfers: undefined,
        balance: currentBalance, previousMonthBalance, realizedBalance, projectedBalance,
      };
    });
    const monthItems = [...monthTransactions.filter((item) => inFinancialPeriod(item, start, end)), ...projectedForMonth].sort((a, b) => financialDate(a).getTime() - financialDate(b).getTime());
    const posted = monthItems.filter((transaction) => transaction.status === TransactionStatus.POSTED);
    const realizedIncome = this.sumByType(posted, TransactionType.INCOME);
    const realizedExpenses = this.sumByType(posted, TransactionType.EXPENSE);
    const pendingCommitments = this.sumByType(monthItems.filter((transaction) => transaction.status === TransactionStatus.PENDING), TransactionType.EXPENSE);
    const pendingIncome = this.sumByType(monthItems.filter((transaction) => transaction.status === TransactionStatus.PENDING), TransactionType.INCOME);
    const availableBalance = accountSummaries.filter((account) => account.type !== AccountType.INVESTMENT).reduce((sum, account) => sum + account.realizedBalance, 0);
    const previousMonthAvailableBalance = accountSummaries.filter((account) => account.type !== AccountType.INVESTMENT).reduce((sum, account) => sum + account.previousMonthBalance, 0);
    const projectedDebtByCycle = new Map<string, number>();
    const cycleKey = (cardId: string, cycleEnd: Date) => `${cardId}:${cycleEnd.toISOString().slice(0, 10)}`;
    for (const statement of statements.filter((item) => this.civilDate(item.dueOn) < end)) {
      projectedDebtByCycle.set(cycleKey(statement.cardId, statement.cycleEnd), statementOutstandingAt(statement, end));
    }
    for (const item of projectedRecurring.filter((entry) => entry.cardId && financialDate(entry) < end)) {
      const cycleEnd = item.statement?.cycleEnd ?? cardCycle(item.card!, item.occurredOn).cycleEnd;
      const key = cycleKey(item.cardId!, cycleEnd);
      projectedDebtByCycle.set(key, (projectedDebtByCycle.get(key) ?? 0) + this.transactionImpact(item.type, item.amount));
    }
    const projectedCardDebt = [...projectedDebtByCycle.values()].reduce((sum, debt) => sum + Math.max(0, debt), 0);
    const projectedAvailableBalance = accountSummaries.filter((account) => account.type !== AccountType.INVESTMENT).reduce((sum, account) => sum + account.projectedBalance, 0) - projectedCardDebt;
    const investmentBalance = accountSummaries.filter((account) => account.type === AccountType.INVESTMENT).reduce((sum, account) => sum + account.realizedBalance, 0);
    const previousPosted = previousTransactions.filter((transaction) => transaction.status === TransactionStatus.POSTED && inFinancialPeriod(transaction, previousRange.start, previousRange.end));
    const previousIncome = this.sumByType(previousPosted, TransactionType.INCOME);
    const previousExpenses = this.sumByType(previousPosted, TransactionType.EXPENSE);
    const weekly = Array.from({ length: 5 }, (_, index) => ({ week: index + 1, income: 0, expenses: 0 }));
    const categoryTotals = new Map<string, { categoryId: string; name: string; color: string; amount: number }>();
    const projectedWeekly = Array.from({ length: 5 }, (_, index) => ({ week: index + 1, income: 0, expenses: 0 }));
    const projectedCategoryTotals = new Map<string, { categoryId: string; name: string; color: string; amount: number }>();
    for (const transaction of posted) {
      const week = Math.min(4, Math.floor((financialDate(transaction).getUTCDate() - 1) / 7));
      if (transaction.type === TransactionType.INCOME) weekly[week].income += transaction.amount;
      else {
        weekly[week].expenses += transaction.amount;
        const category = categoryTotals.get(transaction.subcategory.categoryId) ?? { categoryId: transaction.subcategory.categoryId, name: transaction.subcategory.category.name, color: transaction.subcategory.category.color, amount: 0 };
        category.amount += transaction.amount;
        categoryTotals.set(transaction.subcategory.categoryId, category);
      }
    }
    for (const transaction of monthItems.filter((item) => item.status !== TransactionStatus.DISCARDED)) {
      const week = Math.min(4, Math.floor((financialDate(transaction).getUTCDate() - 1) / 7));
      if (transaction.type === TransactionType.INCOME) projectedWeekly[week].income += transaction.amount;
      else {
        projectedWeekly[week].expenses += transaction.amount;
        const category = projectedCategoryTotals.get(transaction.subcategory.categoryId) ?? { categoryId: transaction.subcategory.categoryId, name: transaction.subcategory.category.name, color: transaction.subcategory.category.color, amount: 0 };
        category.amount += transaction.amount;
        projectedCategoryTotals.set(transaction.subcategory.categoryId, category);
      }
    }
    const budgetLimit = budgets.reduce((sum, budget) => sum + budget.limitAmount, 0);
    const budgetSpent = posted.filter((transaction) => transaction.type === TransactionType.EXPENSE && budgets.some((budget) => budget.categoryId === transaction.subcategory.categoryId)).reduce((sum, transaction) => sum + transaction.amount, 0);
    const upcomingStatements = statements.filter((statement) => this.civilDate(statement.dueOn) >= start && this.civilDate(statement.dueOn) < end && statementOutstandingAt(statement, end) > 0);
    const cardOpenTotal = upcomingStatements.reduce((sum, statement) => sum + Math.max(0, statementOutstandingAt(statement, end)), 0);
    const netFlow = realizedIncome - realizedExpenses;
    const previousNetFlow = previousIncome - previousExpenses;
    return {
      referenceMonth: referenceMonth.toISOString().slice(0, 7),
      isForecast,
      totalBalance: availableBalance,
      investmentBalance,
      accounts: accountSummaries,
      recentTransactions: [...transactions.filter((item) => inFinancialPeriod(item, start, end)), ...projectedForMonth].sort((a, b) => financialDate(b).getTime() - financialDate(a).getTime()).slice(0, 8).map((item) => this.transactionMetadata(item)),
      cardOpenTotal,
      pendingCommitments,
      upcomingStatements,
      recurringForecast: recurringRules.map((rule) => ({ id: rule.id, amount: rule.amount, description: rule.description, startOn: rule.startOn, endOn: rule.endOn })),
      indicators: { availableBalance, previousMonthAvailableBalance, projectedAvailableBalance, investmentBalance, realizedIncome, realizedExpenses, pendingIncome, pendingExpenses: pendingCommitments, totalIncome: realizedIncome + pendingIncome, totalExpenses: realizedExpenses + pendingCommitments, pendingCommitments, cardOpenTotal, budgetCommitted: budgetSpent + pendingCommitments },
      comparison: { income: { current: realizedIncome, previous: previousIncome }, expenses: { current: realizedExpenses, previous: previousExpenses }, balance: { current: netFlow, previous: previousNetFlow } },
      charts: {
        weeklyFlow: weekly,
        projectedWeeklyFlow: projectedWeekly,
        expenseByCategory: [...categoryTotals.values()].sort((a, b) => b.amount - a.amount),
        projectedExpenseByCategory: [...projectedCategoryTotals.values()].sort((a, b) => b.amount - a.amount),
        budget: { limitAmount: budgetLimit, spentAmount: budgetSpent, pendingAmount: pendingCommitments },
      },
    };
  }

  async listArchivedItems(userId: string, householdId: string) {
    await this.households.assertCanManage(userId, householdId);
    const [accounts, cards, categories, subcategories] = await Promise.all([
      this.prisma.account.findMany({ where: { householdId, isActive: false }, orderBy: { name: 'asc' } }),
      this.prisma.card.findMany({ where: { householdId, isActive: false }, orderBy: { name: 'asc' } }),
      this.prisma.category.findMany({ where: { householdId, isActive: false }, orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
      this.prisma.subcategory.findMany({ where: { isActive: false, isDefault: false, category: { householdId } }, include: { category: { select: { id: true, name: true, type: true } } }, orderBy: { name: 'asc' } }),
    ]);
    return { accounts, cards, categories, subcategories };
  }

  async deleteArchivedItem(userId: string, householdId: string, type: ArchivedItemType, itemId: string) {
    await this.households.assertCanManage(userId, householdId);
    if (type === 'ACCOUNT') return this.deleteArchivedAccount(userId, householdId, itemId);
    if (type === 'CARD') return this.deleteArchivedCard(userId, householdId, itemId);
    if (type === 'CATEGORY') return this.deleteArchivedCategory(userId, householdId, itemId);
    return this.deleteArchivedSubcategory(userId, householdId, itemId);
  }

  private async deleteArchivedAccount(userId: string, householdId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, householdId, isActive: false } });
    if (!account) throw new NotFoundException('Conta arquivada não encontrada neste grupo familiar.');
    const [transactions, transfers, payments, recurringRules, recurringTransfers, installments] = await Promise.all([
      this.prisma.transaction.count({ where: { accountId } }),
      this.prisma.accountTransfer.count({ where: { OR: [{ sourceAccountId: accountId }, { destinationAccountId: accountId }] } }),
      this.prisma.cardPayment.count({ where: { accountId } }),
      this.prisma.recurringRule.count({ where: { accountId } }),
      this.prisma.recurringTransferRule.count({ where: { OR: [{ sourceAccountId: accountId }, { destinationAccountId: accountId }] } }),
      this.prisma.installmentPurchase.count({ where: { accountId } }),
    ]);
    this.assertDeletionAllowed('a conta', { lançamentos: transactions, transferências: transfers, 'pagamentos de fatura': payments, recorrências: recurringRules, 'transferências recorrentes': recurringTransfers, parcelamentos: installments });
    return this.prisma.$transaction(async (tx) => {
      await tx.account.delete({ where: { id: accountId } });
      await this.events.record(tx, { aggregateType: 'account', aggregateId: accountId, eventType: 'orfina.accounts.account-deleted.v1', payload: { accountId, householdId } });
      await this.audit(tx, householdId, userId, 'account', accountId, 'deleted', []);
      return { id: accountId, deleted: true };
    });
  }

  private async deleteArchivedCard(userId: string, householdId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({ where: { id: cardId, householdId, isActive: false } });
    if (!card) throw new NotFoundException('Cartão arquivado não encontrado neste grupo familiar.');
    const [transactions, statements, installments, recurringRules] = await Promise.all([
      this.prisma.transaction.count({ where: { cardId } }),
      this.prisma.cardStatement.count({ where: { cardId } }),
      this.prisma.installmentPurchase.count({ where: { cardId } }),
      this.prisma.recurringRule.count({ where: { cardId } }),
    ]);
    this.assertDeletionAllowed('o cartão', { lançamentos: transactions, faturas: statements, parcelamentos: installments, recorrências: recurringRules });
    return this.prisma.$transaction(async (tx) => {
      await tx.card.delete({ where: { id: cardId } });
      await this.events.record(tx, { aggregateType: 'card', aggregateId: cardId, eventType: 'orfina.cards.card-deleted.v1', payload: { cardId, householdId } });
      await this.audit(tx, householdId, userId, 'card', cardId, 'deleted', []);
      return { id: cardId, deleted: true };
    });
  }

  private async deleteArchivedCategory(userId: string, householdId: string, categoryId: string) {
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, householdId, isActive: false } });
    if (!category) throw new NotFoundException('Categoria arquivada não encontrada neste grupo familiar.');
    const [transactions, installments, recurringRules, budgets] = await Promise.all([
      this.prisma.transaction.count({ where: { subcategory: { categoryId } } }),
      this.prisma.installmentPurchase.count({ where: { categoryId } }),
      this.prisma.recurringRule.count({ where: { categoryId } }),
      this.prisma.monthlyBudget.count({ where: { categoryId } }),
    ]);
    this.assertDeletionAllowed('a categoria', { lançamentos: transactions, parcelamentos: installments, recorrências: recurringRules, 'limites de orçamento': budgets });
    return this.prisma.$transaction(async (tx) => {
      await tx.category.delete({ where: { id: categoryId } });
      await this.events.record(tx, { aggregateType: 'category', aggregateId: categoryId, eventType: 'orfina.categories.category-deleted.v1', payload: { categoryId, householdId } });
      await this.audit(tx, householdId, userId, 'category', categoryId, 'deleted', []);
      return { id: categoryId, deleted: true };
    });
  }

  private async deleteArchivedSubcategory(userId: string, householdId: string, subcategoryId: string) {
    const subcategory = await this.prisma.subcategory.findFirst({ where: { id: subcategoryId, isActive: false, isDefault: false, category: { householdId } } });
    if (!subcategory) throw new NotFoundException('Subcategoria arquivada não encontrada neste grupo familiar.');
    const [transactions, installments, recurringRules] = await Promise.all([
      this.prisma.transaction.count({ where: { subcategoryId } }),
      this.prisma.installmentPurchase.count({ where: { subcategoryId } }),
      this.prisma.recurringRule.count({ where: { subcategoryId } }),
    ]);
    this.assertDeletionAllowed('a subcategoria', { lançamentos: transactions, parcelamentos: installments, recorrências: recurringRules });
    return this.prisma.$transaction(async (tx) => {
      await tx.subcategory.delete({ where: { id: subcategoryId } });
      await this.events.record(tx, { aggregateType: 'subcategory', aggregateId: subcategoryId, eventType: 'orfina.categories.subcategory-deleted.v1', payload: { subcategoryId, categoryId: subcategory.categoryId, householdId } });
      await this.audit(tx, householdId, userId, 'subcategory', subcategoryId, 'deleted', []);
      return { id: subcategoryId, deleted: true };
    });
  }

  private assertDeletionAllowed(label: string, relations: Record<string, number>) {
    const impacts = Object.entries(relations).filter(([, count]) => count > 0);
    if (!impacts.length) return;
    const details = impacts.map(([name, count]) => `${count} ${name}`).join(', ');
    throw new ConflictException(`Não é possível excluir ${label} porque existem registros relacionados: ${details}. Reative-o ou mantenha-o arquivado para preservar o histórico.`);
  }

  async listAccounts(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const accounts = await this.prisma.account.findMany({ where: { householdId, isActive: true }, include: { transactions: true, cardPayments: true, outgoingTransfers: true, incomingTransfers: true }, orderBy: { name: 'asc' } });
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
    return this.prisma.card.findMany({ where: { householdId, isActive: true }, orderBy: { name: 'asc' } });
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
      where: { householdId, isActive: true },
      include: { subcategories: { where: { isActive: true }, orderBy: { name: 'asc' } } },
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
    const statement = filters.statementId
      ? await this.prisma.cardStatement.findFirst({
        where: { id: filters.statementId, householdId },
        select: { id: true, cardId: true, cycleStart: true, cycleEnd: true, dueOn: true, status: true },
      })
      : undefined;
    if (filters.statementId && !statement) return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize };
    const rangeFrom = filters.from ? this.civilDate(filters.from) : statement?.cycleStart;
    const rangeTo = filters.to ? this.civilDate(filters.to) : statement?.cycleEnd;
    const where: Prisma.TransactionWhereInput = {
      householdId,
      deletedAt: null,
      accountId: filters.accountId,
      cardId: filters.cardId,
      statementId: statement ? undefined : filters.statementId,
      recurringRuleId: filters.recurringRuleId,
      subcategory: filters.categoryId ? { categoryId: filters.categoryId } : undefined,
      subcategoryId: filters.subcategoryId,
      type: filters.type,
      status: filters.status,
      importItem: filters.importBatchId ? { batchId: filters.importBatchId } : undefined,
    };
    // The statement link is authoritative for newly created entries. The
    // date-and-card fallback preserves the detail view for entries recorded
    // before statements were introduced.
    if (statement) {
      where.OR = [
        { statementId: statement.id },
        { statementId: null, cardId: statement.cardId, occurredOn: { gte: statement.cycleStart, lte: statement.cycleEnd } },
      ];
    }
    if (filters.from || filters.to) {
      if (statement) {
        where.occurredOn = { ...(rangeFrom ? { gte: rangeFrom } : {}), ...(rangeTo ? { lte: rangeTo } : {}) };
      } else {
        where.AND = [financialPeriodWhere(rangeFrom, rangeTo ? this.addDays(rangeTo, 1) : undefined)];
      }
    }
    // A bounded ledger includes virtual occurrences of active fixed rules.
    // They remain read-only projections until the worker or the user materializes
    // the occurrence, so a transaction is never duplicated merely for display.
    if (rangeFrom && rangeTo) {
      const from = rangeFrom;
      const to = rangeTo;
      const projectionEnd = new Date(to);
      projectionEnd.setUTCDate(projectionEnd.getUTCDate() + 1);
      const [persisted, recurringOccurrences, recurringRules, projectionStatements] = await Promise.all([
        this.prisma.transaction.findMany({
          where, include: { account: true, card: true, installmentPurchase: true, statement: true, subcategory: { include: { category: true } } },
          orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        }),
        this.prisma.transaction.findMany({
          where: { householdId, recurringRuleId: { not: null }, recurrenceOn: { lte: to } },
          select: { recurringRuleId: true, recurrenceOn: true },
        }),
        this.prisma.recurringRule.findMany({
          where: { householdId, status: RecurringRuleStatus.ACTIVE },
          include: { account: true, card: true, category: true, subcategory: true },
        }),
        this.prisma.cardStatement.findMany({ where: { householdId } }),
      ]);
      const existingRecurring = new Set(recurringOccurrences.map((item) => `${item.recurringRuleId}:${item.recurrenceOn?.toISOString().slice(0, 10)}`));
      const projectionFilters = statement ? { ...filters, statementId: undefined, cardId: statement.cardId } : filters;
      const projected = statement?.status && statement.status !== CardStatementStatus.OPEN
        ? []
        : this.projectRecurringOccurrences(recurringRules as RecurringProjectionSource[], projectionEnd, existingRecurring)
          .flatMap((item) => {
            const target = statement ?? statementForOccurrence(item, projectionStatements);
            return target && target.status !== CardStatementStatus.OPEN ? [] : [{ ...item, statement: target }];
          })
          .filter((item) => statement ? this.civilDate(item.occurredOn) >= from && this.civilDate(item.occurredOn) <= to : inFinancialPeriod(item, from, projectionEnd))
          .filter((item) => this.matchesProjectedTransaction(item, projectionFilters));
      const all = [...persisted.filter((item) => statement || inFinancialPeriod(item, from, projectionEnd)), ...projected].sort((a, b) => statement ? b.occurredOn.getTime() - a.occurredOn.getTime() : financialDate(b).getTime() - financialDate(a).getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { items: all.slice(start, start + filters.pageSize).map((item) => this.transactionMetadata(item)), total: all.length, page: filters.page, pageSize: filters.pageSize };
    }

    if (!statement && (rangeFrom || rangeTo)) {
      const persisted = await this.prisma.transaction.findMany({ where, include: { account: true, card: true, installmentPurchase: true, statement: true, subcategory: { include: { category: true } } } });
      const all = persisted.filter((item) => inFinancialPeriod(item, rangeFrom, rangeTo ? this.addDays(rangeTo, 1) : undefined)).sort((a, b) => financialDate(b).getTime() - financialDate(a).getTime());
      const offset = (filters.page - 1) * filters.pageSize;
      return { items: all.slice(offset, offset + filters.pageSize).map((item) => this.transactionMetadata(item)), total: all.length, page: filters.page, pageSize: filters.pageSize };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where, include: { account: true, card: true, installmentPurchase: true, statement: true, subcategory: { include: { category: true } } },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return { items: items.map((item) => this.transactionMetadata(item)), total, page: filters.page, pageSize: filters.pageSize };
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
        data: { householdId, ...dto, status: dto.status ?? TransactionStatus.PENDING, statementId: statement?.id, occurredOn: this.civilDate(dto.occurredOn) },
        include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } },
      });
      if (statement && transaction.status !== TransactionStatus.DISCARDED) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transaction.id,
        eventType: `orfina.transactions.transaction-${transaction.status.toLowerCase()}.v1`,
        payload: { transactionId: transaction.id, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.subcategory.categoryId, type: transaction.type, status: transaction.status },
      });
      await this.audit(tx, householdId, userId, 'transaction', transaction.id, 'created', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
      return this.transactionMetadata(transaction);
    });
  }

  async updateTransaction(userId: string, householdId: string, transactionId: string, dto: CreateTransaction) {
    await this.households.assertCanWrite(userId, householdId);
    const [existing, account, card, subcategory] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null } }),
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
      await tx.$queryRaw`SELECT "id" FROM "Transaction" WHERE "id" = ${transactionId} AND "householdId" = ${householdId} FOR UPDATE`;
      const current = await tx.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null } });
      if (!current) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
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
          accountId: dto.accountId ?? null,
          cardId: dto.cardId ?? null,
          statementId: statement?.id ?? null,
          occurredOn: this.civilDate(dto.occurredOn),
        },
        include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } },
      });
      await this.events.record(tx, {
        aggregateType: 'transaction', aggregateId: transactionId,
        eventType: 'orfina.transactions.transaction-updated.v1',
        payload: { transactionId, householdId, accountId: transaction.accountId, cardId: transaction.cardId, categoryId: transaction.subcategory.categoryId, subcategoryId: transaction.subcategoryId, type: transaction.type, amount: transaction.amount, occurredOn: transaction.occurredOn.toISOString() },
      });
      if (current.statementId) await this.adjustStatementTotal(tx, current.statementId, -this.billableImpact(current));
      if (statement && transaction.status !== TransactionStatus.DISCARDED) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'updated', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
      return this.transactionMetadata(transaction);
    });
  }

  /** Converts a standalone transaction once; schedule occurrences cannot change kind. */
  async convertTransaction(userId: string, householdId: string, transactionId: string, dto: TransactionConversion) {
    await this.households.assertCanWrite(userId, householdId);
    const [existing, account, card, subcategory] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null } }),
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
        if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.billableImpact(existing));
        if (statement) await this.adjustStatementTotal(tx, statement.id, this.billableImpact(transaction));
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
          if (existing.statementId) await this.adjustStatementTotal(tx, existing.statementId, -this.billableImpact(existing));
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.billableImpact(transaction));
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
    const existing = await this.prisma.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null }, include: { installmentPurchase: true, recurringRule: true } });
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
      this.prisma.transaction.findMany({ where: { householdId, deletedAt: null, installmentPurchaseId: purchaseId, occurredOn: { gt: original.occurredOn } }, include: { statement: true } }),
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
        if (item.statementId) await this.adjustStatementTotal(tx, item.statementId, this.billableImpact(next) - this.billableImpact(item));
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
      const futureOccurrences = await tx.transaction.findMany({ where: { householdId, deletedAt: null, recurringRuleId: rule.id, occurredOn: { gt: updated.occurredOn } }, include: { statement: true } });
      if (futureOccurrences.some((item) => item.statement && item.statement.status !== CardStatementStatus.OPEN)) throw new BadRequestException('Não é possível alterar competências futuras já pertencentes a faturas fechadas ou pagas.');
      for (const occurrence of futureOccurrences) {
        const statement = targetCard ? await this.statementForDate(tx, targetCard, householdId, occurrence.occurredOn) : undefined;
        if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Uma competência futura cairia em fatura fechada ou paga.');
        const next = await tx.transaction.update({ where: { id: occurrence.id }, data: { recurringRuleId: successorId, accountId: updated.accountId, cardId: updated.cardId, statementId: statement?.id ?? null, subcategoryId: updated.subcategoryId, type: updated.type, amount: updated.amount, description: updated.description, notes: updated.notes } });
        if (occurrence.statementId) await this.adjustStatementTotal(tx, occurrence.statementId, -this.billableImpact(occurrence));
        if (statement) await this.adjustStatementTotal(tx, statement.id, this.billableImpact(next));
      }
      await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: successorId, eventType: 'orfina.recurring.occurrences-updated.v1', payload: { householdId, previousRuleId: rule.id, ruleId: successorId, fromTransactionId: updated.id } });
      await this.audit(tx, householdId, userId, 'recurring-rule', successorId, 'occurrences-updated', ['accountId', 'cardId', 'subcategoryId', 'type', 'amount', 'description']);
      return { ...updated, successorRuleId: successorId };
    });
  }

  async deleteTransaction(userId: string, householdId: string, transactionId: string, scope: DeleteScope = 'ONE') {
    await this.households.assertCanWrite(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null }, include: { statement: true, recurringRule: true, subcategory: true } });
      if (!transaction) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
      if (transaction.statement && transaction.statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível apagar lançamento de fatura fechada ou paga.');
      const ruleIds = transaction.recurringRuleId && scope !== 'ONE' ? this.seriesRuleIds(await tx.recurringRule.findMany({ where: { householdId }, select: { id: true, predecessorId: true } }), transaction.recurringRuleId, scope === 'ALL') : transaction.recurringRuleId ? [transaction.recurringRuleId] : [];
      const series = transaction.recurringRuleId ? { recurringRuleId: { in: ruleIds } } : transaction.installmentPurchaseId ? { installmentPurchaseId: transaction.installmentPurchaseId } : undefined;
      if (scope !== 'ONE' && !series) throw new BadRequestException('Este lançamento não pertence a uma série.');
      const candidates = scope === 'ONE' ? [transaction] : await tx.transaction.findMany({ where: { householdId, deletedAt: null, ...series, ...(scope === 'FOLLOWING' ? { occurredOn: { gte: transaction.occurredOn } } : {}) }, include: { statement: true } });
      // Series removal preserves realized history; closed invoices always remain immutable.
      const deletable = candidates.filter((item) => (!item.statement || item.statement.status === CardStatementStatus.OPEN) && (scope === 'ONE' || item.status !== TransactionStatus.POSTED));
      for (const item of deletable) {
        if (item.statementId) await this.adjustStatementTotal(tx, item.statementId, -this.billableImpact(item));
        await tx.transaction.update({ where: { id: item.id }, data: { deletedAt: new Date(), status: TransactionStatus.DISCARDED } });
        await this.events.record(tx, { aggregateType: 'transaction', aggregateId: item.id, eventType: 'orfina.transactions.transaction-deleted.v1', payload: { transactionId: item.id, householdId, scope } });
        await this.audit(tx, householdId, userId, 'transaction', item.id, 'deleted', ['deletedAt', 'status']);
      }
      if (transaction.recurringRule) {
        const recurrenceOn = transaction.recurrenceOn ?? transaction.occurredOn;
        const exclusions = this.excludedDates(transaction.recurringRule.excludedOccurrences);
        const data = scope === 'ONE'
          ? { excludedOccurrences: [...new Set([...exclusions, recurrenceOn.toISOString().slice(0, 10)])] }
          : scope === 'ALL' ? { status: RecurringRuleStatus.ENDED }
          : { endOn: this.addDays(recurrenceOn, -1), ...(recurrenceOn <= transaction.recurringRule.startOn ? { status: RecurringRuleStatus.ENDED } : {}) };
        await tx.recurringRule.update({ where: { id: transaction.recurringRule.id }, data });
        await this.audit(tx, householdId, userId, 'recurring-rule', transaction.recurringRule.id, 'occurrences-deleted', Object.keys(data));
        await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: transaction.recurringRule.id, eventType: 'orfina.recurring.occurrences-deleted.v1', payload: { householdId, ruleId: transaction.recurringRule.id, scope, transactionId } });
        for (const ruleId of ruleIds.filter((id) => id !== transaction.recurringRuleId)) {
          await tx.recurringRule.update({ where: { id: ruleId }, data: { status: RecurringRuleStatus.ENDED } });
          await this.audit(tx, householdId, userId, 'recurring-rule', ruleId, 'occurrences-deleted', ['status']);
          await this.events.record(tx, { aggregateType: 'recurring-rule', aggregateId: ruleId, eventType: 'orfina.recurring.occurrences-deleted.v1', payload: { householdId, ruleId, scope, transactionId } });
        }
      }
      if (transaction.installmentPurchaseId && scope !== 'ONE') await tx.installmentPurchase.update({ where: { id: transaction.installmentPurchaseId }, data: { canceledAt: new Date() } });
      return { id: transactionId, deleted: deletable.some((item) => item.id === transactionId), deletedCount: deletable.length, preservedCount: candidates.length - deletable.length, scope };
    });
  }

  async setTransactionStatus(userId: string, householdId: string, transactionId: string, status: TransactionStatus) {
    await this.households.assertCanWrite(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Transaction" WHERE "id" = ${transactionId} AND "householdId" = ${householdId} FOR UPDATE`;
      const transaction = await tx.transaction.findFirst({ where: { id: transactionId, householdId, deletedAt: null }, include: { statement: true } });
      if (!transaction) throw new NotFoundException('Lançamento não encontrado neste grupo familiar.');
      if (transaction.statement) {
        await this.lockCard(tx, householdId, transaction.statement.cardId);
        const currentStatement = await tx.cardStatement.findUnique({ where: { id: transaction.statement.id } });
        if (currentStatement?.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível alterar lançamento de fatura fechada ou paga.');
      }
      if (transaction.statementId && transaction.status !== status) {
        const previousImpact = transaction.status === TransactionStatus.DISCARDED ? 0 : this.transactionImpact(transaction.type, transaction.amount);
        const nextImpact = status === TransactionStatus.DISCARDED ? 0 : this.transactionImpact(transaction.type, transaction.amount);
        if (previousImpact !== nextImpact) await this.adjustStatementTotal(tx, transaction.statementId, nextImpact - previousImpact);
      }
      const updated = await tx.transaction.update({ where: { id: transactionId }, data: { status }, include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } } });
      await this.events.record(tx, { aggregateType: 'transaction', aggregateId: transactionId, eventType: 'orfina.transactions.status-changed.v1', payload: { householdId, transactionId, status } });
      await this.audit(tx, householdId, userId, 'transaction', transactionId, 'status-changed', ['status']);
      return this.transactionMetadata(updated);
    });
  }

  async listTransfers(userId: string, householdId: string, filters: { from?: string; to?: string } = {}) {
    await this.households.assertMember(userId, householdId);
    const persisted = await this.prisma.accountTransfer.findMany({ where: { householdId, deletedAt: null, ...(filters.from || filters.to ? { occurredOn: { ...(filters.from ? { gte: this.civilDate(filters.from) } : {}), ...(filters.to ? { lte: this.civilDate(filters.to) } : {}) } } : {}) }, include: { sourceAccount: true, destinationAccount: true, importItem: { select: { batchId: true } } }, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }] });
    if (!filters.from || !filters.to) return persisted.map((item) => ({ ...item, mode: item.recurringTransferRuleId ? 'FIXED' : 'SINGLE', isForecast: false }));
    const [rules, occupied] = await Promise.all([
      this.prisma.recurringTransferRule.findMany({ where: { householdId, status: RecurringRuleStatus.ACTIVE }, include: { sourceAccount: true, destinationAccount: true } }),
      this.prisma.accountTransfer.findMany({ where: { householdId, recurringTransferRuleId: { not: null } }, select: { recurringTransferRuleId: true, recurrenceOn: true } }),
    ]);
    const existing = new Set(occupied.map((item) => `${item.recurringTransferRuleId}:${item.recurrenceOn?.toISOString().slice(0, 10)}`));
    const forecast = rules.flatMap((rule) => this.recurringDates(rule.startOn, rule.endOn, this.addDays(this.civilDate(filters.to!), 1))
      .filter((date) => date >= this.civilDate(filters.from!) && !this.excludedDates(rule.excludedOccurrences).includes(date.toISOString().slice(0, 10)) && !existing.has(`${rule.id}:${date.toISOString().slice(0, 10)}`))
      .map((occurredOn) => ({ id: `transfer-forecast:${rule.id}:${occurredOn.toISOString().slice(0, 10)}`, householdId, recurringTransferRuleId: rule.id, sourceAccountId: rule.sourceAccountId, destinationAccountId: rule.destinationAccountId, sourceAccount: rule.sourceAccount, destinationAccount: rule.destinationAccount, amount: rule.amount, description: rule.description, occurredOn, recurrenceOn: occurredOn, status: AccountTransferStatus.PENDING, mode: 'FIXED', isForecast: true })));
    return [...persisted.map((item) => ({ ...item, mode: item.recurringTransferRuleId ? 'FIXED' : 'SINGLE', isForecast: false })), ...forecast].sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime());
  }

  async createTransfer(userId: string, householdId: string, dto: CreateTransfer) {
    await this.households.assertCanManage(userId, householdId);
    if (dto.sourceAccountId === dto.destinationAccountId) throw new BadRequestException('Origem e destino da transferência devem ser contas diferentes.');
    const accounts = await this.prisma.account.count({ where: { householdId, isActive: true, id: { in: [dto.sourceAccountId, dto.destinationAccountId] } } });
    if (accounts !== 2) throw new NotFoundException('As contas da transferência devem ser ativas e pertencer ao grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.accountTransfer.create({ data: { householdId, ...dto, occurredOn: this.civilDate(dto.occurredOn), status: dto.status ?? AccountTransferStatus.PENDING }, include: { sourceAccount: true, destinationAccount: true } });
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-created.v1', payload: { householdId, transferId: transfer.id, status: transfer.status } });
      await this.audit(tx, householdId, userId, 'transfer', transfer.id, 'created', ['sourceAccountId', 'destinationAccountId', 'status']);
      return transfer;
    });
  }

  async setTransferStatus(userId: string, householdId: string, transferId: string, status: AccountTransferStatus) {
    await this.households.assertCanManage(userId, householdId);
    const transfer = await this.prisma.accountTransfer.findFirst({ where: { id: transferId, householdId, deletedAt: null } });
    if (!transfer) throw new NotFoundException('Transferência não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.accountTransfer.update({ where: { id: transferId }, data: { status } });
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transferId, eventType: 'orfina.transfers.transfer-status-changed.v1', payload: { householdId, transferId, status } });
      await this.audit(tx, householdId, userId, 'transfer', transferId, 'status-changed', ['status']);
      return updated;
    });
  }

  async listRecurringTransferRules(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    return this.prisma.recurringTransferRule.findMany({ where: { householdId }, include: { sourceAccount: true, destinationAccount: true }, orderBy: { createdAt: 'desc' } });
  }

  private async validateTransferAccounts(householdId: string, dto: { sourceAccountId: string; destinationAccountId: string }) {
    if (dto.sourceAccountId === dto.destinationAccountId) throw new BadRequestException('Origem e destino devem ser diferentes.');
    const count = await this.prisma.account.count({ where: { householdId, isActive: true, id: { in: [dto.sourceAccountId, dto.destinationAccountId] } } });
    if (count !== 2) throw new NotFoundException('As contas devem ser ativas e pertencer ao grupo familiar.');
  }

  async createRecurringTransferRule(userId: string, householdId: string, dto: RecurringTransferInput) {
    await this.households.assertCanManage(userId, householdId);
    await this.validateTransferAccounts(householdId, dto);
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringTransferRule.create({ data: { householdId, ...dto, startOn: this.civilDate(dto.startOn), endOn: dto.endOn ? this.civilDate(dto.endOn) : undefined }, include: { sourceAccount: true, destinationAccount: true } });
      await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: rule.id, eventType: 'orfina.transfers.recurring-rule-created.v1', payload: { householdId, ruleId: rule.id } });
      await this.audit(tx, householdId, userId, 'recurring-transfer-rule', rule.id, 'created', ['sourceAccountId', 'destinationAccountId', 'amount', 'startOn']);
      return rule;
    });
  }

  async setRecurringTransferRuleStatus(userId: string, householdId: string, ruleId: string, status: RecurringRuleStatus) {
    await this.households.assertCanManage(userId, householdId);
    const rule = await this.prisma.recurringTransferRule.findFirst({ where: { id: ruleId, householdId } });
    if (!rule) throw new NotFoundException('Recorrência de transferência não encontrada.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recurringTransferRule.update({ where: { id: ruleId }, data: { status } });
      await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: ruleId, eventType: 'orfina.transfers.recurring-rule-status-changed.v1', payload: { householdId, ruleId, status } });
      await this.audit(tx, householdId, userId, 'recurring-transfer-rule', ruleId, 'status-changed', ['status']);
      return updated;
    });
  }

  /** Editing the schedule creates a version; realized occurrences retain their original values and sources. */
  async updateRecurringTransferRule(userId: string, householdId: string, ruleId: string, dto: RecurringTransferInput) {
    await this.households.assertCanManage(userId, householdId);
    await this.validateTransferAccounts(householdId, dto);
    const startOn = this.civilDate(dto.startOn);
    const endOn = dto.endOn ? this.civilDate(dto.endOn) : null;
    if (endOn && endOn < startOn) throw new BadRequestException('A data final deve ser posterior à inicial.');
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringTransferRule.findFirst({ where: { id: ruleId, householdId } });
      if (!rule) throw new NotFoundException('Recorrência de transferência não encontrada.');
      if (rule.status === RecurringRuleStatus.ENDED) throw new BadRequestException('Uma versão encerrada não pode ser editada. Edite a versão vigente.');
      const ruleIds = this.seriesRuleIds(await tx.recurringTransferRule.findMany({ where: { householdId }, select: { id: true, predecessorId: true } }), ruleId, false);
      // A changed calendar day still represents the same monthly occurrence.
      const occurrences = await tx.accountTransfer.findMany({ where: { householdId, recurringTransferRuleId: { in: ruleIds }, deletedAt: null, occurredOn: { gte: this.monthStart(dto.startOn.slice(0, 7)) } } });
      const retained = occurrences.filter((item) => item.status === AccountTransferStatus.POSTED);
      const preservedDates = retained.map((item) => this.addMonths(startOn, (item.occurredOn.getUTCFullYear() - startOn.getUTCFullYear()) * 12 + item.occurredOn.getUTCMonth() - startOn.getUTCMonth()).toISOString().slice(0, 10));
      const excludedDates = this.excludedDates(rule.excludedOccurrences).filter((date) => date.slice(0, 7) >= dto.startOn.slice(0, 7)).map((date) => {
        const original = this.civilDate(date);
        return this.addMonths(startOn, (original.getUTCFullYear() - startOn.getUTCFullYear()) * 12 + original.getUTCMonth() - startOn.getUTCMonth()).toISOString().slice(0, 10);
      });
      const successor = await tx.recurringTransferRule.create({ data: { householdId, predecessorId: rule.id, sourceAccountId: dto.sourceAccountId, destinationAccountId: dto.destinationAccountId, amount: dto.amount, description: dto.description, startOn, endOn, status: rule.status, excludedOccurrences: [...new Set([...excludedDates, ...preservedDates])] }, include: { sourceAccount: true, destinationAccount: true } });
      for (const id of ruleIds) {
        await tx.recurringTransferRule.update({ where: { id }, data: { status: RecurringRuleStatus.ENDED } });
        await this.audit(tx, householdId, userId, 'recurring-transfer-rule', id, 'superseded', ['status']);
        await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: id, eventType: 'orfina.transfers.recurring-rule-superseded.v1', payload: { householdId, ruleId: id, successorRuleId: successor.id } });
      }
      const pending = occurrences.filter((item) => item.status !== AccountTransferStatus.POSTED);
      for (const item of pending) {
        await tx.accountTransfer.update({ where: { id: item.id }, data: { deletedAt: new Date(), status: AccountTransferStatus.DISCARDED } });
        await this.audit(tx, householdId, userId, 'transfer', item.id, 'superseded', ['deletedAt', 'status']);
        await this.events.record(tx, { aggregateType: 'transfer', aggregateId: item.id, eventType: 'orfina.transfers.transfer-superseded.v1', payload: { householdId, transferId: item.id, successorRuleId: successor.id } });
      }
      await this.audit(tx, householdId, userId, 'recurring-transfer-rule', successor.id, 'schedule-updated', Object.keys(dto));
      await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: successor.id, eventType: 'orfina.transfers.recurring-rule-split.v1', payload: { householdId, predecessorId: rule.id, ruleId: successor.id, startOn: dto.startOn, preservedCount: retained.length, supersededCount: pending.length } });
      return successor;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /** Rule-level deletion also covers virtual occurrences which have no transfer ID yet. */
  async deleteRecurringTransferRule(userId: string, householdId: string, ruleId: string, scope: DeleteScope = 'ALL', occurrenceInput?: string) {
    await this.households.assertCanManage(userId, householdId);
    if (scope !== 'ALL' && !occurrenceInput) throw new BadRequestException('Informe a ocorrência para este escopo.');
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.recurringTransferRule.findFirst({ where: { id: ruleId, householdId } });
      if (!rule) throw new NotFoundException('Recorrência de transferência não encontrada.');
      const occurredOn = occurrenceInput ? this.civilDate(occurrenceInput) : null;
      if (scope !== 'ALL' && (!occurredOn || !this.isRecurringOccurrence(rule.startOn, rule.endOn, occurredOn))) throw new BadRequestException('A data não corresponde a uma ocorrência desta regra.');
      const ruleIds = scope === 'ONE' ? [rule.id] : this.seriesRuleIds(await tx.recurringTransferRule.findMany({ where: { householdId }, select: { id: true, predecessorId: true } }), rule.id, scope === 'ALL');
      const candidates = await tx.accountTransfer.findMany({ where: { householdId, recurringTransferRuleId: { in: ruleIds }, deletedAt: null, ...(scope === 'ONE' ? { recurrenceOn: occurredOn } : scope === 'FOLLOWING' ? { occurredOn: { gte: occurredOn! } } : {}) } });
      if (scope === 'ONE' && candidates.some((item) => item.status === AccountTransferStatus.POSTED)) throw new BadRequestException('Para excluir uma transferência realizada, selecione o lançamento correspondente.');
      const pending = candidates.filter((item) => item.status !== AccountTransferStatus.POSTED);
      for (const item of pending) {
        await tx.accountTransfer.update({ where: { id: item.id }, data: { deletedAt: new Date(), status: AccountTransferStatus.DISCARDED } });
        await this.audit(tx, householdId, userId, 'transfer', item.id, 'deleted', ['deletedAt', 'status']);
        await this.events.record(tx, { aggregateType: 'transfer', aggregateId: item.id, eventType: 'orfina.transfers.transfer-deleted.v1', payload: { householdId, transferId: item.id, scope } });
      }
      for (const id of ruleIds) {
        const data = scope === 'ONE' ? { excludedOccurrences: [...new Set([...this.excludedDates(rule.excludedOccurrences), occurrenceInput!])] }
          : scope === 'FOLLOWING' && id === rule.id && occurredOn! > this.civilDate(rule.startOn) ? { endOn: this.addDays(occurredOn!, -1) }
          : { status: RecurringRuleStatus.ENDED };
        await tx.recurringTransferRule.update({ where: { id }, data });
        await this.audit(tx, householdId, userId, 'recurring-transfer-rule', id, 'occurrences-deleted', Object.keys(data));
        await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: id, eventType: 'orfina.transfers.recurring-occurrences-deleted.v1', payload: { householdId, ruleId: id, scope, occurredOn: occurrenceInput ?? null } });
      }
      return { id: ruleId, scope, deletedCount: pending.length, preservedCount: candidates.length - pending.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async materializeRecurringTransferOccurrence(userId: string, householdId: string, ruleId: string, date: string) {
    await this.households.assertCanManage(userId, householdId);
    const rule = await this.prisma.recurringTransferRule.findFirst({ where: { id: ruleId, householdId, status: RecurringRuleStatus.ACTIVE } });
    if (!rule) throw new NotFoundException('Recorrência de transferência ativa não encontrada.');
    const occurredOn = this.civilDate(date);
    if (!this.isRecurringOccurrence(rule.startOn, rule.endOn, occurredOn) || this.excludedDates(rule.excludedOccurrences).includes(date)) throw new BadRequestException('A data não corresponde a uma ocorrência disponível.');
    await this.validateTransferAccounts(householdId, rule);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.accountTransfer.findUnique({ where: { recurringTransferRuleId_recurrenceOn: { recurringTransferRuleId: rule.id, recurrenceOn: occurredOn } } });
      if (existing) return existing;
      const transfer = await tx.accountTransfer.create({ data: { householdId, recurringTransferRuleId: rule.id, recurrenceOn: occurredOn, sourceAccountId: rule.sourceAccountId, destinationAccountId: rule.destinationAccountId, amount: rule.amount, description: rule.description, occurredOn, status: AccountTransferStatus.PENDING }, include: { sourceAccount: true, destinationAccount: true } });
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-created.v1', payload: { householdId, transferId: transfer.id, ruleId: rule.id, status: transfer.status } });
      await this.audit(tx, householdId, userId, 'transfer', transfer.id, 'materialized', ['recurringTransferRuleId', 'recurrenceOn']);
      return transfer;
    });
  }

  private async materializeRecurringTransfers(today: Date) {
    const rules = await this.prisma.recurringTransferRule.findMany({ where: { status: RecurringRuleStatus.ACTIVE, sourceAccount: { isActive: true }, destinationAccount: { isActive: true } }, include: { household: true } });
    let generated = 0;
    for (const rule of rules) {
      for (const occurredOn of this.recurringDates(rule.startOn, rule.endOn, this.addMonths(today, 2))) {
        if (this.excludedDates(rule.excludedOccurrences).includes(occurredOn.toISOString().slice(0, 10)) || this.recurringLaunchOn(occurredOn, rule.household.recurringMaterializationMode, rule.household.recurringMaterializationValue) > today) continue;
        await this.prisma.$transaction(async (tx) => {
          const exists = await tx.accountTransfer.findUnique({ where: { recurringTransferRuleId_recurrenceOn: { recurringTransferRuleId: rule.id, recurrenceOn: occurredOn } } });
          if (exists) return;
          const transfer = await tx.accountTransfer.create({ data: { householdId: rule.householdId, sourceAccountId: rule.sourceAccountId, destinationAccountId: rule.destinationAccountId, recurringTransferRuleId: rule.id, recurrenceOn: occurredOn, amount: rule.amount, description: rule.description, occurredOn, status: AccountTransferStatus.PENDING } });
          await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-created.v1', payload: { householdId: rule.householdId, transferId: transfer.id, ruleId: rule.id, status: transfer.status } });
          await this.audit(tx, rule.householdId, null, 'transfer', transfer.id, 'materialized', ['recurringTransferRuleId', 'recurrenceOn']);
          generated += 1;
        });
      }
    }
    return generated;
  }

  async deleteTransfer(userId: string, householdId: string, transferId: string, scope: DeleteScope = 'ONE') {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.accountTransfer.findFirst({ where: { id: transferId, householdId, deletedAt: null }, include: { recurringTransferRule: true } });
      if (!transfer) throw new NotFoundException('Transferência não encontrada.');
      if (scope !== 'ONE' && !transfer.recurringTransferRule) throw new BadRequestException('Esta transferência não pertence a uma série.');
      const ruleIds = transfer.recurringTransferRuleId && scope !== 'ONE' ? this.seriesRuleIds(await tx.recurringTransferRule.findMany({ where: { householdId }, select: { id: true, predecessorId: true } }), transfer.recurringTransferRuleId, scope === 'ALL') : transfer.recurringTransferRuleId ? [transfer.recurringTransferRuleId] : [];
      const candidates = scope === 'ONE' ? [transfer] : await tx.accountTransfer.findMany({ where: { householdId, deletedAt: null, recurringTransferRuleId: { in: ruleIds }, ...(scope === 'FOLLOWING' ? { occurredOn: { gte: transfer.occurredOn } } : {}) } });
      const deletable = candidates.filter((item) => scope === 'ONE' || item.status !== AccountTransferStatus.POSTED);
      for (const item of deletable) {
        await tx.accountTransfer.update({ where: { id: item.id }, data: { deletedAt: new Date(), status: AccountTransferStatus.DISCARDED } });
        await this.events.record(tx, { aggregateType: 'transfer', aggregateId: item.id, eventType: 'orfina.transfers.transfer-deleted.v1', payload: { householdId, transferId: item.id, scope } });
        await this.audit(tx, householdId, userId, 'transfer', item.id, 'deleted', ['deletedAt', 'status']);
      }
      if (transfer.recurringTransferRule) {
        const rule = transfer.recurringTransferRule;
        const recurrenceOn = transfer.recurrenceOn ?? transfer.occurredOn;
        const data = scope === 'ONE' ? { excludedOccurrences: [...new Set([...this.excludedDates(rule.excludedOccurrences), recurrenceOn.toISOString().slice(0, 10)])] }
          : scope === 'ALL' || recurrenceOn <= rule.startOn ? { status: RecurringRuleStatus.ENDED }
          : { endOn: this.addDays(recurrenceOn, -1) };
        await tx.recurringTransferRule.update({ where: { id: rule.id }, data });
        await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: rule.id, eventType: 'orfina.transfers.recurring-occurrences-deleted.v1', payload: { householdId, ruleId: rule.id, scope } });
        await this.audit(tx, householdId, userId, 'recurring-transfer-rule', rule.id, 'occurrences-deleted', Object.keys(data));
        for (const ruleId of ruleIds.filter((id) => id !== rule.id)) {
          await tx.recurringTransferRule.update({ where: { id: ruleId }, data: { status: RecurringRuleStatus.ENDED } });
          await this.audit(tx, householdId, userId, 'recurring-transfer-rule', ruleId, 'occurrences-deleted', ['status']);
          await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: ruleId, eventType: 'orfina.transfers.recurring-occurrences-deleted.v1', payload: { householdId, ruleId, scope } });
        }
      }
      return { id: transferId, deleted: deletable.some((item) => item.id === transferId), deletedCount: deletable.length, preservedCount: candidates.length - deletable.length, scope };
    });
  }

  async updateTransfer(userId: string, householdId: string, transferId: string, dto: CreateTransfer, scope: DeleteScope = 'ONE') {
    await this.households.assertCanManage(userId, householdId);
    await this.validateTransferAccounts(householdId, dto);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.accountTransfer.findFirst({ where: { id: transferId, householdId, deletedAt: null }, include: { recurringTransferRule: true } });
      if (!current) throw new NotFoundException('Transferência não encontrada.');
      if (scope === 'ALL') throw new BadRequestException('Use uma ocorrência ou esta e as seguintes para preservar o histórico.');
      if (scope === 'FOLLOWING' && !current.recurringTransferRule) throw new BadRequestException('Esta transferência não pertence a uma série.');
      if (scope === 'FOLLOWING' && current.status === AccountTransferStatus.POSTED) throw new BadRequestException('Escolha uma ocorrência pendente para alterar a série.');
      let updated = await tx.accountTransfer.update({ where: { id: transferId }, data: { ...dto, occurredOn: this.civilDate(dto.occurredOn) }, include: { sourceAccount: true, destinationAccount: true } });
      if (scope === 'FOLLOWING' && current.recurringTransferRule) {
        const rule = current.recurringTransferRule;
        const boundary = current.recurrenceOn ?? current.occurredOn;
        const realizedFuture = await tx.accountTransfer.findMany({ where: { householdId, recurringTransferRuleId: rule.id, deletedAt: null, status: AccountTransferStatus.POSTED, occurredOn: { gt: current.occurredOn } }, select: { occurredOn: true } });
        const preservedDates = realizedFuture.map((item) => this.addMonths(dto.occurredOn, (item.occurredOn.getUTCFullYear() - boundary.getUTCFullYear()) * 12 + item.occurredOn.getUTCMonth() - boundary.getUTCMonth()).toISOString().slice(0, 10));
        await tx.recurringTransferRule.update({ where: { id: rule.id }, data: boundary <= rule.startOn ? { status: RecurringRuleStatus.ENDED } : { endOn: this.addDays(boundary, -1) } });
        const successor = await tx.recurringTransferRule.create({ data: { householdId, predecessorId: rule.id, sourceAccountId: dto.sourceAccountId, destinationAccountId: dto.destinationAccountId, amount: dto.amount, description: dto.description, startOn: this.civilDate(dto.occurredOn), endOn: rule.endOn, excludedOccurrences: [...new Set([...this.excludedDates(rule.excludedOccurrences).filter((date) => date >= boundary.toISOString().slice(0, 10)), ...preservedDates])] } });
        updated = await tx.accountTransfer.update({ where: { id: transferId }, data: { recurringTransferRuleId: successor.id, recurrenceOn: this.civilDate(dto.occurredOn) }, include: { sourceAccount: true, destinationAccount: true } });
        // Remove future pending materializations; successor generates the changed calendar.
        const future = await tx.accountTransfer.findMany({ where: { householdId, recurringTransferRuleId: rule.id, deletedAt: null, status: { not: AccountTransferStatus.POSTED }, occurredOn: { gt: current.occurredOn } } });
        for (const item of future) {
          await tx.accountTransfer.update({ where: { id: item.id }, data: { deletedAt: new Date(), status: AccountTransferStatus.DISCARDED } });
          await this.audit(tx, householdId, userId, 'transfer', item.id, 'superseded', ['deletedAt', 'status']);
          await this.events.record(tx, { aggregateType: 'transfer', aggregateId: item.id, eventType: 'orfina.transfers.transfer-superseded.v1', payload: { householdId, transferId: item.id, successorRuleId: successor.id } });
        }
        await this.events.record(tx, { aggregateType: 'recurring-transfer-rule', aggregateId: successor.id, eventType: 'orfina.transfers.recurring-rule-split.v1', payload: { householdId, predecessorId: rule.id, ruleId: successor.id, transferId } });
        await this.audit(tx, householdId, userId, 'recurring-transfer-rule', successor.id, 'split', ['predecessorId', 'startOn']);
      }
      await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transferId, eventType: 'orfina.transfers.transfer-updated.v1', payload: { householdId, transferId, scope } });
      await this.audit(tx, householdId, userId, 'transfer', transferId, 'updated', Object.keys(dto));
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
      orderBy: { dueOn: 'desc' },
    });
  }

  /**
   * Lists the invoices that are still visible to the household.  Limit usage is
   * calculated from every unpaid invoice of the same card, rather than just the
   * displayed cycle, so the value is useful when a prior statement is partially
   * paid.
   */
  async listStatements(userId: string, householdId: string, referenceMonth?: string) {
    await this.households.assertMember(userId, householdId);
    const dueOn = referenceMonth
      ? (() => {
        const { start, end } = this.monthRange(this.monthStart(referenceMonth));
        return { gte: start, lt: end };
      })()
      : undefined;
    const statements = await this.prisma.cardStatement.findMany({
      where: { householdId, card: { isActive: true }, dueOn },
      include: { card: true, payments: { orderBy: { paidOn: 'desc' } } },
      orderBy: [{ dueOn: 'desc' }, { cycleEnd: 'desc' }],
    });
    const outstanding = await this.prisma.cardStatement.findMany({
      where: { householdId, status: { not: CardStatementStatus.PAID }, card: { isActive: true } },
      include: { payments: true },
    });
    const usedByCard = new Map<string, number>();
    for (const statement of outstanding) {
      const paid = statement.payments.reduce((sum, payment) => sum + payment.amount, 0);
      usedByCard.set(statement.cardId, (usedByCard.get(statement.cardId) ?? 0) + Math.max(0, statement.totalAmount - paid));
    }
    return statements.map((statement) => {
      const limitUsedAmount = usedByCard.get(statement.cardId) ?? 0;
      const creditLimit = statement.card.creditLimit ?? null;
      return {
        ...statement,
        limitUsedAmount,
        limitUsagePercent: creditLimit && creditLimit > 0 ? Math.min(100, Math.round((limitUsedAmount / creditLimit) * 100)) : null,
      };
    });
  }

  async closeStatement(userId: string, householdId: string, statementId: string) {
    await this.households.assertCanManage(userId, householdId);
    const statement = await this.prisma.cardStatement.findFirst({ where: { id: statementId, householdId } });
    if (!statement) throw new NotFoundException('Fatura não encontrada neste grupo familiar.');
    if (statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Esta fatura já foi fechada ou paga.');
    return this.prisma.$transaction(async (tx) => {
      await this.lockCard(tx, householdId, statement.cardId);
      const current = await tx.cardStatement.findUnique({ where: { id: statementId } });
      if (current?.status !== CardStatementStatus.OPEN) throw new BadRequestException('Esta fatura já foi fechada ou paga.');
      const pending = await tx.transaction.count({ where: { householdId, statementId, deletedAt: null, status: TransactionStatus.PENDING } });
      if (pending) throw new BadRequestException('Realize ou descarte os lançamentos pendentes antes de fechar a fatura.');
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
    const deletable = purchase.transactions.filter((transaction) => !transaction.deletedAt && transaction.status !== TransactionStatus.POSTED && transaction.occurredOn > today && (!transaction.statement || transaction.statement.status === CardStatementStatus.OPEN));
    const blocked = purchase.transactions.filter((transaction) => transaction.occurredOn > today && transaction.statement && transaction.statement.status !== CardStatementStatus.OPEN);
    if (blocked.length) throw new BadRequestException('Não é possível cancelar parcelas que já pertencem a fatura fechada ou paga.');
    return this.prisma.$transaction(async (tx) => {
      for (const transaction of deletable) {
        if (transaction.statementId) await this.adjustStatementTotal(tx, transaction.statementId, -this.billableImpact(transaction));
        await tx.transaction.update({ where: { id: transaction.id }, data: { deletedAt: new Date(), status: TransactionStatus.DISCARDED } });
        await this.audit(tx, householdId, userId, 'transaction', transaction.id, 'deleted', ['deletedAt', 'status']);
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
      include: { account: true, card: true, transactions: { where: { deletedAt: null }, include: { statement: true }, orderBy: { installmentNumber: 'asc' } } },
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

  /** Materializes one projected fixed occurrence on explicit user confirmation. */
  async materializeRecurringOccurrence(userId: string, householdId: string, ruleId: string, occurredOnInput: string) {
    await this.households.assertCanWrite(userId, householdId);
    const rule = await this.prisma.recurringRule.findFirst({ where: { id: ruleId, householdId }, include: { card: true } });
    if (!rule || rule.status !== RecurringRuleStatus.ACTIVE) throw new NotFoundException('Recorrência ativa não encontrada neste grupo familiar.');
    const occurredOn = this.civilDate(occurredOnInput);
    if (!this.isRecurringOccurrence(rule.startOn, rule.endOn, occurredOn)) throw new BadRequestException('A data informada não corresponde a uma ocorrência desta recorrência.');
    if (this.excludedDates(rule.excludedOccurrences).includes(occurredOnInput)) throw new BadRequestException('Esta ocorrência foi excluída da recorrência.');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: occurredOn } },
        include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } },
      });
      if (existing) return this.transactionMetadata(existing);
      const statement = rule.card ? await this.statementForDate(tx, rule.card, householdId, occurredOn) : undefined;
      if (statement && statement.status !== CardStatementStatus.OPEN) throw new BadRequestException('Não é possível gerar uma ocorrência em fatura fechada ou paga.');
      const transaction = await tx.transaction.create({
        data: {
          householdId, accountId: rule.accountId, cardId: rule.cardId, statementId: statement?.id,
          recurringRuleId: rule.id, recurrenceOn: occurredOn, subcategoryId: rule.subcategoryId,
          type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes,
          occurredOn, status: TransactionStatus.PENDING,
        },
        include: { account: true, card: true, statement: true, subcategory: { include: { category: true } } },
      });
      if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
      await this.events.record(tx, { aggregateType: 'recurring-occurrence', aggregateId: transaction.id, eventType: 'orfina.recurring.occurrence-created.v1', payload: { ruleId: rule.id, transactionId: transaction.id, householdId, occurredOn: occurredOn.toISOString(), materializedEarly: true } });
      await this.audit(tx, householdId, userId, 'recurring-occurrence', transaction.id, 'materialized-early', ['recurringRuleId', 'occurredOn']);
      return this.transactionMetadata(transaction);
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
  async materializeRecurringRules(asOf?: Date) {
    const today = asOf ?? this.civilDate(new Date());
    const rules = await this.prisma.recurringRule.findMany({ where: { status: RecurringRuleStatus.ACTIVE }, include: { card: true, household: { select: { recurringMaterializationMode: true, recurringMaterializationValue: true } } } });
    let generated = 0;
    for (const rule of rules) {
      // The greatest advance is 28 days before a month; two civil months safely covers short months and month-end dates.
      const generationHorizon = this.addMonths(today, 2);
      for (const occurredOn of this.recurringDates(rule.startOn, rule.endOn, generationHorizon)) {
        if (this.excludedDates(rule.excludedOccurrences).includes(occurredOn.toISOString().slice(0, 10))) continue;
        if (this.recurringLaunchOn(occurredOn, rule.household.recurringMaterializationMode, rule.household.recurringMaterializationValue) > today) continue;
        const made = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.transaction.findUnique({ where: { recurringRuleId_recurrenceOn: { recurringRuleId: rule.id, recurrenceOn: occurredOn } } });
          if (existing) return false;
          const statement = rule.card ? await this.statementForDate(tx, rule.card, rule.householdId, occurredOn) : undefined;
          if (statement && statement.status !== CardStatementStatus.OPEN) return false;
          const transaction = await tx.transaction.create({ data: { householdId: rule.householdId, accountId: rule.accountId, cardId: rule.cardId, statementId: statement?.id, recurringRuleId: rule.id, recurrenceOn: occurredOn, subcategoryId: rule.subcategoryId, type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes, occurredOn, status: TransactionStatus.PENDING } });
          if (statement) await this.adjustStatementTotal(tx, statement.id, this.transactionImpact(transaction.type, transaction.amount));
          await this.events.record(tx, { aggregateType: 'recurring-occurrence', aggregateId: transaction.id, eventType: 'orfina.recurring.occurrence-created.v1', payload: { ruleId: rule.id, transactionId: transaction.id, householdId: rule.householdId, occurredOn: occurredOn.toISOString() } });
          await this.audit(tx, rule.householdId, null, 'recurring-occurrence', transaction.id, 'created', ['recurringRuleId', 'occurredOn']);
          return true;
        });
        if (made) generated += 1;
      }
    }
    generated += await this.materializeRecurringTransfers(today);
    await this.realizeDueFinancialEntries(asOf);
    return generated;
  }

  /** Realization policy applies to all entries, including standalone, installments and paused rules. */
  async realizeDueFinancialEntries(asOf?: Date) {
    const households = await this.prisma.household.findMany({ where: { financialRealizationMode: FinancialRealizationMode.ON_OCCURRENCE_DATE }, select: { id: true, timezone: true } });
    let realized = 0;
    for (const household of households) {
      const today = asOf ? this.civilDate(asOf) : this.todayInTimezone(household.timezone);
      const entries = await this.prisma.transaction.findMany({ where: { householdId: household.id, deletedAt: null, status: TransactionStatus.PENDING, occurredOn: { lte: today }, OR: [{ statementId: null }, { statement: { status: CardStatementStatus.OPEN } }] }, select: { id: true } });
      for (const entry of entries) {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.transaction.updateMany({ where: { id: entry.id, householdId: household.id, household: { financialRealizationMode: FinancialRealizationMode.ON_OCCURRENCE_DATE }, deletedAt: null, status: TransactionStatus.PENDING, OR: [{ statementId: null }, { statement: { status: CardStatementStatus.OPEN } }] }, data: { status: TransactionStatus.POSTED } });
          if (!updated.count) return;
          await this.events.record(tx, { aggregateType: 'transaction', aggregateId: entry.id, eventType: 'orfina.transactions.status-changed.v1', payload: { householdId: household.id, transactionId: entry.id, status: TransactionStatus.POSTED, automatic: true } });
          await this.audit(tx, household.id, null, 'transaction', entry.id, 'automatically-realized', ['status']);
          realized += 1;
        });
      }
      const transfers = await this.prisma.accountTransfer.findMany({ where: { householdId: household.id, deletedAt: null, status: AccountTransferStatus.PENDING, occurredOn: { lte: today } }, select: { id: true } });
      for (const transfer of transfers) {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.accountTransfer.updateMany({ where: { id: transfer.id, householdId: household.id, household: { financialRealizationMode: FinancialRealizationMode.ON_OCCURRENCE_DATE }, deletedAt: null, status: AccountTransferStatus.PENDING }, data: { status: AccountTransferStatus.POSTED } });
          if (!updated.count) return;
          await this.events.record(tx, { aggregateType: 'transfer', aggregateId: transfer.id, eventType: 'orfina.transfers.transfer-status-changed.v1', payload: { householdId: household.id, transferId: transfer.id, status: AccountTransferStatus.POSTED, automatic: true } });
          await this.audit(tx, household.id, null, 'transfer', transfer.id, 'automatically-realized', ['status']);
          realized += 1;
        });
      }
    }
    return realized;
  }

  /** Builds read-only future occurrences; persistence remains the worker's responsibility. */
  private projectRecurringOccurrences(rules: RecurringProjectionSource[], end: Date, existing: Set<string>) {
    const projected: Array<{ id: string; recurringRuleId: string; accountId: string | null; cardId: string | null; account: unknown; card: RecurringProjectionSource['card']; subcategoryId: string; subcategory: { id: string; name: string; categoryId: string; isDefault: boolean; isActive: boolean; category: RecurringProjectionSource['category'] }; type: TransactionType; amount: number; description: string; notes: string | null; occurredOn: Date; status: TransactionStatus; isForecast: boolean }> = [];
    for (const rule of rules) {
      for (const occurredOn of this.recurringDates(rule.startOn, rule.endOn, end)) {
        if (this.excludedDates(rule.excludedOccurrences).includes(occurredOn.toISOString().slice(0, 10))) continue;
        const key = `${rule.id}:${occurredOn.toISOString().slice(0, 10)}`;
        if (existing.has(key)) continue;
        projected.push({ id: `forecast:${rule.id}:${occurredOn.toISOString().slice(0, 10)}`, recurringRuleId: rule.id, accountId: rule.accountId, cardId: rule.cardId, account: rule.account, card: rule.card, subcategoryId: rule.subcategoryId, subcategory: { ...rule.subcategory, category: rule.category }, type: rule.type, amount: rule.amount, description: rule.description, notes: rule.notes, occurredOn, status: TransactionStatus.PENDING, isForecast: true });
      }
    }
    return projected;
  }

  private matchesProjectedTransaction(transaction: { accountId: string | null; cardId: string | null; recurringRuleId: string; subcategoryId: string; type: TransactionType; status: TransactionStatus; subcategory: { categoryId: string } }, filters: TransactionListFilters) {
    if (filters.accountId && transaction.accountId !== filters.accountId) return false;
    if (filters.cardId && transaction.cardId !== filters.cardId) return false;
    if (filters.statementId || filters.importBatchId) return false;
    if (filters.recurringRuleId && transaction.recurringRuleId !== filters.recurringRuleId) return false;
    if (filters.categoryId && transaction.subcategory.categoryId !== filters.categoryId) return false;
    if (filters.subcategoryId && transaction.subcategoryId !== filters.subcategoryId) return false;
    if (filters.type && transaction.type !== filters.type) return false;
    if (filters.status && transaction.status !== filters.status) return false;
    return true;
  }

  private isRecurringOccurrence(startOnInput: Date, endOnInput: Date | null, occurredOn: Date) {
    const startOn = this.civilDate(startOnInput);
    const endOn = endOnInput ? this.civilDate(endOnInput) : undefined;
    if (occurredOn < startOn || (endOn && occurredOn > endOn)) return false;
    const months = (occurredOn.getUTCFullYear() - startOn.getUTCFullYear()) * 12 + occurredOn.getUTCMonth() - startOn.getUTCMonth();
    return months >= 0 && this.addMonths(startOn, months).toISOString().slice(0, 10) === occurredOn.toISOString().slice(0, 10);
  }

  private excludedDates(value?: Prisma.JsonValue): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private seriesRuleIds(rules: { id: string; predecessorId: string | null }[], ruleId: string, includeAncestors: boolean) {
    const ids = new Set([ruleId]);
    let added = true;
    while (added) {
      added = false;
      for (const rule of rules) {
        if (rule.predecessorId && (ids.has(rule.predecessorId) || (includeAncestors && ids.has(rule.id)))) {
          for (const id of [rule.id, rule.predecessorId]) if (!ids.has(id)) { ids.add(id); added = true; }
        }
      }
    }
    return [...ids];
  }

  private recurringDates(startOn: Date, endOn: Date | null, horizon: Date) {
    const dates: Date[] = [];
    const start = this.civilDate(startOn);
    for (let month = 0; ; month += 1) {
      const date = this.addMonths(start, month);
      if (date >= horizon || (endOn && date > this.civilDate(endOn))) break;
      dates.push(date);
    }
    return dates;
  }

  private transactionMetadata<T extends { occurredOn: Date; cardId?: string | null; card?: RecurringProjectionSource['card']; recurringRuleId?: string | null; installmentPurchaseId?: string | null; installmentNumber?: number | null; installmentPurchase?: { installmentCount: number; startInstallmentNumber: number } | null; statement?: { status: CardStatementStatus; dueOn: Date } | null; isForecast?: boolean }>(item: T) {
    return { ...item, financialOn: financialDate(item), mode: item.installmentPurchaseId ? 'INSTALLMENT' : item.recurringRuleId ? 'FIXED' : 'SINGLE', installmentCount: item.installmentPurchase?.installmentCount ?? null, startInstallmentNumber: item.installmentPurchase?.startInstallmentNumber ?? null, statementStatus: item.statement?.status ?? null, isForecast: item.isForecast ?? false };
  }

  private async statementForDate(tx: Prisma.TransactionClient, card: { id: string; closingDay: number; dueDay: number }, householdId: string, occurredOn: string | Date) {
    await this.lockCard(tx, householdId, card.id);
    const { cycleStart, cycleEnd, dueOn } = cardCycle(card, this.civilDate(occurredOn));
    return tx.cardStatement.upsert({ where: { cardId_cycleEnd: { cardId: card.id, cycleEnd } }, update: {}, create: { householdId, cardId: card.id, cycleStart, cycleEnd, dueOn } });
  }

  private async adjustStatementTotal(tx: Prisma.TransactionClient, statementId: string, amount: number) {
    const changed = await tx.cardStatement.updateMany({ where: { id: statementId, status: CardStatementStatus.OPEN }, data: { totalAmount: { increment: amount } } });
    if (!changed.count) throw new BadRequestException('Não é possível alterar uma fatura fechada ou paga.');
  }

  private async lockCard(tx: Prisma.TransactionClient, householdId: string, cardId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Card" WHERE "id" = ${cardId} AND "householdId" = ${householdId} FOR UPDATE`;
  }

  private async audit(tx: Prisma.TransactionClient, householdId: string, actorId: string | null, aggregateType: string, aggregateId: string, action: string, changedFields: string[]) {
    await tx.auditLog.create({ data: { householdId, actorId, aggregateType, aggregateId, action, changedFields } });
  }

  private transactionImpact(type: TransactionType, amount: number) { return type === TransactionType.INCOME ? -amount : amount; }

  private billableImpact(item: { type: TransactionType; amount: number; status: TransactionStatus }) {
    return item.status === TransactionStatus.DISCARDED ? 0 : this.transactionImpact(item.type, item.amount);
  }

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

  private todayInTimezone(timezone: string) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    return this.civilDate(`${part('year')}-${part('month')}-${part('day')}`);
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
