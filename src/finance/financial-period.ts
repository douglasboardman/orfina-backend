import { CardStatementStatus, Prisma } from '@prisma/client';

type CardCycle = { closingDay: number; dueDay: number };
export type FinancialEntry = { occurredOn: Date; cardId?: string | null; card?: CardCycle | null; statement?: { dueOn: Date } | null };
export type FinancialStatement = { cardId: string; cycleStart: Date; cycleEnd: Date; dueOn: Date; status: CardStatementStatus };

function civilDate(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
}

/** Purchase dates determine the cycle; its stored due date determines financial impact. */
export function cardCycle(card: CardCycle, occurredOn: Date) {
  const year = occurredOn.getUTCFullYear();
  const month = occurredOn.getUTCMonth() + (occurredOn.getUTCDate() > card.closingDay ? 1 : 0);
  return {
    cycleStart: new Date(Date.UTC(year, month - 1, card.closingDay + 1, 12)),
    cycleEnd: new Date(Date.UTC(year, month, card.closingDay, 12)),
    dueOn: new Date(Date.UTC(year, month + (card.dueDay <= card.closingDay ? 1 : 0), card.dueDay, 12)),
  };
}

export function financialDate(entry: FinancialEntry): Date {
  if (entry.statement) return civilDate(entry.statement.dueOn);
  if (entry.cardId && entry.card) return cardCycle(entry.card, entry.occurredOn).dueOn;
  return civilDate(entry.occurredOn);
}

export function inFinancialPeriod(entry: FinancialEntry, start?: Date, end?: Date) {
  const date = financialDate(entry);
  return (!start || date >= start) && (!end || date < end);
}

export function statementForOccurrence<T extends FinancialStatement>(entry: FinancialEntry, statements: T[]) {
  const occurredOn = civilDate(entry.occurredOn);
  return entry.cardId ? statements.find((statement) => statement.cardId === entry.cardId && occurredOn >= civilDate(statement.cycleStart) && occurredOn <= civilDate(statement.cycleEnd)) : undefined;
}

export function statementOutstandingAt(statement: { totalAmount: number; payments: { amount: number; paidOn: Date }[] }, cutoff: Date) {
  return statement.totalAmount - statement.payments.filter((payment) => civilDate(payment.paidOn) < cutoff).reduce((sum, payment) => sum + payment.amount, 0);
}

/** Bounded candidates include legacy card entries without a statement; filter those after reading. */
export function financialPeriodWhere(start?: Date, end?: Date): Prisma.TransactionWhereInput {
  const range = { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
  const legacyStart = start ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 2, 1, 12)) : undefined;
  return { OR: [
    { cardId: null, occurredOn: range },
    { cardId: { not: null }, statement: { dueOn: range } },
    { cardId: { not: null }, statementId: null, occurredOn: { ...(legacyStart ? { gte: legacyStart } : {}), ...(end ? { lt: end } : {}) } },
  ] };
}

/** Monthly recurrences are generated on their purchase calendar, then assigned by due date. */
export function recurringFinancialOccurrences(rule: { startOn: Date; endOn: Date | null; excludedOccurrences?: Prisma.JsonValue; cardId?: string | null; card?: CardCycle | null }, start: Date, end: Date, statements: FinancialStatement[] = []) {
  const dates: Date[] = [];
  const excluded = Array.isArray(rule.excludedOccurrences) ? rule.excludedOccurrences : [];
  const firstMonth = Math.max(0, (start.getUTCFullYear() - rule.startOn.getUTCFullYear()) * 12 + start.getUTCMonth() - rule.startOn.getUTCMonth() - 2);
  for (let offset = firstMonth; ; offset += 1) {
    const year = rule.startOn.getUTCFullYear();
    const month = rule.startOn.getUTCMonth() + offset;
    const day = Math.min(rule.startOn.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    const occurredOn = new Date(Date.UTC(year, month, day, 12));
    if (occurredOn >= end || (rule.endOn && occurredOn > civilDate(rule.endOn))) break;
    const entry = { ...rule, occurredOn };
    const statement = statementForOccurrence(entry, statements);
    if (statement && statement.status !== 'OPEN') continue;
    if (!excluded.includes(occurredOn.toISOString().slice(0, 10)) && inFinancialPeriod({ ...entry, statement }, start, end)) dates.push(occurredOn);
  }
  return dates;
}
