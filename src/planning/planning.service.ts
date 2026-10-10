import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SavingsGoalStatus } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';
import { financialDate, financialPeriodWhere, inFinancialPeriod, recurringFinancialOccurrences, statementOutstandingAt } from '../finance/financial-period';

type BudgetInput = { categoryId: string; limitAmount: number; notes?: string };
type GoalInput = { name: string; targetAmount: number; targetDate?: string; color: string; icon?: string };
type ContributionInput = { amount: number; occurredOn: string; notes?: string; idempotencyKey: string };

@Injectable()
export class PlanningService {
  constructor(private readonly prisma: PrismaService, private readonly households: HouseholdsService, private readonly events: EventsService) {}

  async budgetSummary(userId: string, householdId: string, month: string) {
    await this.households.assertMember(userId, householdId);
    const referenceMonth = this.monthStart(month);
    const { start, end } = this.monthRange(referenceMonth);
    const [budgets, transactions, categories, budgetMonth, recurringRules, installments, cards, recurringOccurrences] = await Promise.all([
      this.prisma.monthlyBudget.findMany({ where: { householdId, referenceMonth, category: { isActive: true } }, include: { category: true }, orderBy: { category: { name: 'asc' } } }),
      this.prisma.transaction.findMany({ where: { householdId, deletedAt: null, type: 'EXPENSE', status: { in: ['POSTED', 'PENDING'] }, ...financialPeriodWhere(start, end) }, include: { card: true, statement: true } }),
      this.prisma.category.findMany({ where: { householdId, type: 'EXPENSE', isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.budgetMonth.findUnique({ where: { householdId_referenceMonth: { householdId, referenceMonth } } }),
      this.prisma.recurringRule.findMany({ where: { householdId, status: 'ACTIVE', type: 'EXPENSE', startOn: { lt: end } }, include: { card: true } }),
      this.prisma.installmentPurchase.findMany({ where: { householdId, canceledAt: null, type: 'EXPENSE' }, include: { transactions: { where: { deletedAt: null, status: 'PENDING', ...financialPeriodWhere(start, end) }, include: { card: true, statement: true } } } }),
      this.prisma.cardStatement.findMany({ where: { householdId }, include: { payments: true } }),
      this.prisma.transaction.findMany({ where: { householdId, recurringRuleId: { not: null }, recurrenceOn: { lt: end } }, select: { recurringRuleId: true, recurrenceOn: true } }),
    ]);
    const subcategories = await this.prisma.subcategory.findMany({ where: { isActive: true, category: { householdId, isActive: true } }, select: { id: true, categoryId: true } });
    const parentBySubcategory = new Map(subcategories.map((item) => [item.id, item.categoryId]));
    const existing = new Set(recurringOccurrences.map((item) => `${item.recurringRuleId}:${item.recurrenceOn?.toISOString().slice(0, 10)}`));
    const recurringInMonth = recurringRules.flatMap((rule) => recurringFinancialOccurrences(rule, start, end, cards).map((occurredOn) => ({ rule, occurredOn })));
    const forecasts = recurringInMonth.filter(({ rule, occurredOn }) => !existing.has(`${rule.id}:${occurredOn.toISOString().slice(0, 10)}`)).map(({ rule }) => ({ subcategoryId: rule.subcategoryId, amount: rule.amount }));
    const monthTransactions = transactions.filter((item) => inFinancialPeriod(item, start, end));
    const aggregateByCategory = (items: { subcategoryId: string; amount: number }[]) => {
      const totals = new Map<string, number>();
      for (const item of items) {
        const categoryId = parentBySubcategory.get(item.subcategoryId);
        if (categoryId) totals.set(categoryId, (totals.get(categoryId) ?? 0) + item.amount);
      }
      return totals;
    };
    const spendByCategory = aggregateByCategory(monthTransactions.filter((item) => item.status === 'POSTED'));
    const pendingByCategory = aggregateByCategory([...monthTransactions.filter((item) => item.status === 'PENDING'), ...forecasts]);
    const rows = budgets.map((budget) => ({
      ...budget,
      spentAmount: spendByCategory.get(budget.categoryId) ?? 0,
      pendingAmount: pendingByCategory.get(budget.categoryId) ?? 0,
      availableAmount: budget.limitAmount - (spendByCategory.get(budget.categoryId) ?? 0),
      percentUsed: budget.limitAmount ? Math.round(((spendByCategory.get(budget.categoryId) ?? 0) / budget.limitAmount) * 100) : 0,
    })).sort((a, b) => b.percentUsed - a.percentUsed || a.category.name.localeCompare(b.category.name));
    const budgeted = new Set(budgets.map((budget) => budget.categoryId));
    const unbudgeted = categories.filter((category) => !budgeted.has(category.id)).map((category) => ({ category, spentAmount: spendByCategory.get(category.id) ?? 0, pendingAmount: pendingByCategory.get(category.id) ?? 0 })).filter((item) => item.spentAmount > 0 || item.pendingAmount > 0);
    const projectedRecurring = recurringInMonth.reduce((sum, { rule }) => sum + rule.amount, 0);
    const projectedInstallments = installments.reduce((sum, purchase) => sum + purchase.transactions.filter((transaction) => inFinancialPeriod(transaction, start, end) && financialDate(transaction) >= this.today()).reduce((subtotal, transaction) => subtotal + transaction.amount, 0), 0);
    const cardOpenTotal = cards.filter((statement) => statement.dueOn.toISOString().slice(0, 7) === month).reduce((sum, statement) => sum + Math.max(0, statementOutstandingAt(statement, end)), 0);
    return {
      referenceMonth: referenceMonth.toISOString(),
      isClosed: Boolean(budgetMonth?.closedAt),
      closedAt: budgetMonth?.closedAt?.toISOString() ?? null,
      rows,
      unbudgeted,
      totals: {
        plannedAmount: rows.reduce((sum, row) => sum + row.limitAmount, 0),
        spentAmount: rows.reduce((sum, row) => sum + row.spentAmount, 0),
        pendingAmount: rows.reduce((sum, row) => sum + row.pendingAmount, 0),
        availableAmount: rows.reduce((sum, row) => sum + row.availableAmount, 0),
        unbudgetedAmount: unbudgeted.reduce((sum, row) => sum + row.spentAmount, 0),
        projectedRecurring,
        projectedInstallments,
        cardOpenTotal,
      },
    };
  }

  async upsertBudget(userId: string, householdId: string, month: string, input: BudgetInput) {
    await this.households.assertCanManage(userId, householdId);
    const referenceMonth = this.monthStart(month);
    await this.assertBudgetOpen(householdId, referenceMonth);
    const category = await this.prisma.category.findFirst({ where: { id: input.categoryId, householdId, type: 'EXPENSE', isActive: true } });
    if (!category) throw new NotFoundException('Categoria de despesa não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const budget = await tx.monthlyBudget.upsert({ where: { householdId_referenceMonth_categoryId: { householdId, referenceMonth, categoryId: category.id } }, update: { limitAmount: input.limitAmount, notes: input.notes }, create: { householdId, referenceMonth, categoryId: category.id, limitAmount: input.limitAmount, notes: input.notes } });
      await this.events.record(tx, { aggregateType: 'monthly-budget', aggregateId: budget.id, eventType: 'orfina.budgets.monthly-budget-upserted.v1', payload: { householdId, budgetId: budget.id, categoryId: category.id, referenceMonth: referenceMonth.toISOString(), limitAmount: input.limitAmount } });
      await this.audit(tx, householdId, userId, 'monthly-budget', budget.id, 'upserted', ['limitAmount', 'notes']);
      return budget;
    });
  }

  async deleteBudget(userId: string, householdId: string, month: string, categoryId: string) {
    await this.households.assertCanManage(userId, householdId);
    const referenceMonth = this.monthStart(month);
    await this.assertBudgetOpen(householdId, referenceMonth);
    const budget = await this.prisma.monthlyBudget.findFirst({ where: { householdId, referenceMonth, categoryId } });
    if (!budget) throw new NotFoundException('Limite não encontrado neste mês.');
    return this.prisma.$transaction(async (tx) => {
      await tx.monthlyBudget.delete({ where: { id: budget.id } });
      await this.events.record(tx, { aggregateType: 'monthly-budget', aggregateId: budget.id, eventType: 'orfina.budgets.monthly-budget-deleted.v1', payload: { householdId, budgetId: budget.id, categoryId, referenceMonth: referenceMonth.toISOString() } });
      await this.audit(tx, householdId, userId, 'monthly-budget', budget.id, 'deleted', ['limitAmount', 'notes']);
      return { id: budget.id, deleted: true };
    });
  }

  async copyBudgets(userId: string, householdId: string, sourceMonth: string, targetMonth: string) {
    await this.households.assertCanManage(userId, householdId);
    const source = this.monthStart(sourceMonth); const target = this.monthStart(targetMonth);
    if (source.getTime() === target.getTime()) throw new BadRequestException('Escolha meses diferentes para copiar o orçamento.');
    await this.assertBudgetOpen(householdId, target);
    const sourceBudgets = await this.prisma.monthlyBudget.findMany({ where: { householdId, referenceMonth: source } });
    return this.prisma.$transaction(async (tx) => {
      for (const budget of sourceBudgets) await tx.monthlyBudget.upsert({ where: { householdId_referenceMonth_categoryId: { householdId, referenceMonth: target, categoryId: budget.categoryId } }, update: { limitAmount: budget.limitAmount, notes: budget.notes }, create: { householdId, referenceMonth: target, categoryId: budget.categoryId, limitAmount: budget.limitAmount, notes: budget.notes } });
      await this.events.record(tx, { aggregateType: 'budget-month', aggregateId: `${householdId}:${target.toISOString().slice(0, 10)}`, eventType: 'orfina.budgets.month-copied.v1', payload: { householdId, sourceMonth: source.toISOString(), targetMonth: target.toISOString(), copiedCount: sourceBudgets.length } });
      await this.audit(tx, householdId, userId, 'budget-month', target.toISOString().slice(0, 10), 'copied', ['sourceMonth']);
      return { copiedCount: sourceBudgets.length };
    });
  }

  async setMonthClosed(userId: string, householdId: string, month: string, closed: boolean) {
    await this.households.assertCanManage(userId, householdId);
    const referenceMonth = this.monthStart(month);
    const snapshot = closed ? await this.budgetSummary(userId, householdId, month) : undefined;
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.budgetMonth.upsert({ where: { householdId_referenceMonth: { householdId, referenceMonth } }, update: { closedAt: closed ? new Date() : null, closedById: closed ? userId : null, snapshot: closed ? snapshot as Prisma.InputJsonValue : Prisma.JsonNull }, create: { householdId, referenceMonth, closedAt: closed ? new Date() : null, closedById: closed ? userId : null, snapshot: closed ? snapshot as Prisma.InputJsonValue : undefined } });
      await this.events.record(tx, { aggregateType: 'budget-month', aggregateId: result.id, eventType: `orfina.budgets.month-${closed ? 'closed' : 'reopened'}.v1`, payload: { householdId, referenceMonth: referenceMonth.toISOString() } });
      await this.audit(tx, householdId, userId, 'budget-month', result.id, closed ? 'closed' : 'reopened', ['closedAt']);
      return result;
    });
  }

  async listGoals(userId: string, householdId: string) {
    await this.households.assertMember(userId, householdId);
    const goals = await this.prisma.savingsGoal.findMany({ where: { householdId, status: { not: SavingsGoalStatus.ARCHIVED } }, include: { contributions: { orderBy: { occurredOn: 'desc' } } }, orderBy: { createdAt: 'desc' } });
    return goals.map((goal) => this.goalProjection(goal));
  }

  async listArchivedGoals(userId: string, householdId: string) {
    await this.households.assertCanManage(userId, householdId);
    const goals = await this.prisma.savingsGoal.findMany({ where: { householdId, status: SavingsGoalStatus.ARCHIVED }, include: { contributions: { orderBy: { occurredOn: 'desc' } } }, orderBy: { createdAt: 'desc' } });
    return goals.map((goal) => this.goalProjection(goal));
  }

  async deleteArchivedGoal(userId: string, householdId: string, goalId: string) {
    await this.households.assertCanManage(userId, householdId);
    const goal = await this.prisma.savingsGoal.findFirst({ where: { id: goalId, householdId, status: SavingsGoalStatus.ARCHIVED } });
    if (!goal) throw new NotFoundException('Meta arquivada não encontrada neste grupo familiar.');
    const contributions = await this.prisma.goalContribution.count({ where: { goalId } });
    if (contributions) throw new ConflictException(`Não é possível excluir a meta porque existem ${contributions} contribuições relacionadas. Reative-a ou mantenha-a arquivada para preservar o histórico.`);
    return this.prisma.$transaction(async (tx) => {
      await tx.savingsGoal.delete({ where: { id: goalId } });
      await this.events.record(tx, { aggregateType: 'savings-goal', aggregateId: goalId, eventType: 'orfina.goals.goal-deleted.v1', payload: { householdId, goalId } });
      await this.audit(tx, householdId, userId, 'savings-goal', goalId, 'deleted', []);
      return { id: goalId, deleted: true };
    });
  }

  async createGoal(userId: string, householdId: string, input: GoalInput) {
    await this.households.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const goal = await tx.savingsGoal.create({ data: { householdId, name: input.name, targetAmount: input.targetAmount, targetDate: input.targetDate ? this.civilDate(input.targetDate) : undefined, color: input.color, icon: input.icon } });
      await this.events.record(tx, { aggregateType: 'savings-goal', aggregateId: goal.id, eventType: 'orfina.goals.goal-created.v1', payload: { householdId, goalId: goal.id, targetAmount: goal.targetAmount, targetDate: goal.targetDate?.toISOString() } });
      await this.audit(tx, householdId, userId, 'savings-goal', goal.id, 'created', ['name', 'targetAmount', 'targetDate']);
      return goal;
    });
  }

  async setGoalStatus(userId: string, householdId: string, goalId: string, status: SavingsGoalStatus) {
    await this.households.assertCanManage(userId, householdId);
    const goal = await this.prisma.savingsGoal.findFirst({ where: { id: goalId, householdId } });
    if (!goal) throw new NotFoundException('Meta não encontrada neste grupo familiar.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.savingsGoal.update({ where: { id: goalId }, data: { status } });
      await this.events.record(tx, { aggregateType: 'savings-goal', aggregateId: goalId, eventType: `orfina.goals.goal-${status.toLowerCase()}.v1`, payload: { householdId, goalId, status } });
      await this.audit(tx, householdId, userId, 'savings-goal', goalId, status.toLowerCase(), ['status']);
      return updated;
    });
  }

  async contributeToGoal(userId: string, householdId: string, goalId: string, input: ContributionInput) {
    await this.households.assertCanWrite(userId, householdId);
    const existing = await this.prisma.goalContribution.findUnique({ where: { householdId_idempotencyKey: { householdId, idempotencyKey: input.idempotencyKey } } });
    if (existing) return existing;
    const goal = await this.prisma.savingsGoal.findFirst({ where: { id: goalId, householdId }, include: { contributions: true } });
    if (!goal) throw new NotFoundException('Meta não encontrada neste grupo familiar.');
    if (goal.status !== SavingsGoalStatus.ACTIVE) throw new BadRequestException('Somente metas ativas recebem contribuições.');
    return this.prisma.$transaction(async (tx) => {
      const contribution = await tx.goalContribution.create({ data: { householdId, goalId, actorId: userId, amount: input.amount, occurredOn: this.civilDate(input.occurredOn), notes: input.notes, idempotencyKey: input.idempotencyKey } });
      const total = goal.contributions.reduce((sum, item) => sum + item.amount, 0) + input.amount;
      if (total >= goal.targetAmount) await tx.savingsGoal.update({ where: { id: goalId }, data: { status: SavingsGoalStatus.COMPLETED } });
      await this.events.record(tx, { aggregateType: 'goal-contribution', aggregateId: contribution.id, eventType: 'orfina.goals.contribution-created.v1', payload: { householdId, goalId, contributionId: contribution.id, amount: input.amount, occurredOn: contribution.occurredOn.toISOString() } });
      await this.audit(tx, householdId, userId, 'goal-contribution', contribution.id, 'created', ['goalId', 'amount', 'occurredOn']);
      return contribution;
    });
  }

  private goalProjection<T extends { targetAmount: number; targetDate: Date | null; contributions: { amount: number }[] }>(goal: T) {
    const savedAmount = goal.contributions.reduce((sum, item) => sum + item.amount, 0);
    const remainingAmount = Math.max(0, goal.targetAmount - savedAmount);
    const days = goal.targetDate ? Math.max(0, Math.ceil((goal.targetDate.getTime() - this.today().getTime()) / 86_400_000)) : null;
    return { ...goal, savedAmount, remainingAmount, percentComplete: Math.min(100, Math.round((savedAmount / goal.targetAmount) * 100)), monthlyRequiredAmount: days === null ? null : days === 0 ? remainingAmount : Math.ceil(remainingAmount / Math.max(1, Math.ceil(days / 30))) };
  }

  private async assertBudgetOpen(householdId: string, referenceMonth: Date) {
    const month = await this.prisma.budgetMonth.findUnique({ where: { householdId_referenceMonth: { householdId, referenceMonth } } });
    if (month?.closedAt) throw new BadRequestException('O orçamento deste mês está encerrado. Reabra-o antes de alterar limites.');
  }
  private async audit(tx: Prisma.TransactionClient, householdId: string, actorId: string, aggregateType: string, aggregateId: string, action: string, changedFields: string[]) { await tx.auditLog.create({ data: { householdId, actorId, aggregateType, aggregateId, action, changedFields } }); }
  private monthStart(value: string) { if (!/^\d{4}-\d{2}(-\d{2})?$/.test(value)) throw new BadRequestException('Informe o mês no formato AAAA-MM.'); const [year, month] = value.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(year, month - 1, 1, 12)); }
  private monthRange(month: Date) { return { start: month, end: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1, 12)) }; }
  private civilDate(value: string) { return new Date(`${value.slice(0, 10)}T12:00:00.000Z`); }
  private today() { return this.civilDate(new Date().toISOString()); }
}
