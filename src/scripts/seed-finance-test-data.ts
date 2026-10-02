import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CardNetwork, CardStatementStatus, CategoryType, Prisma, PrismaClient, SavingsGoalStatus, TransactionType } from '@prisma/client';

type SheetRow = Record<string, string>;
type ImportedRow = { source: 'despesas' | 'receitas'; row: number; data: SheetRow };
type Tx = Prisma.TransactionClient;

const markerPrefix = 'seed:xlsx-3d66208d';
const today = civilDate('2026-10-02');
const colors: Record<string, string> = {
  'Reajuste de fatura': '#D65B5B',
  'Transferências': '#5B5BD6',
};

function civilDate(value: string | Date) {
  const raw = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return new Date(`${raw}T12:00:00.000Z`);
}

function usage() {
  throw new Error('Uso: npm run seed:test-data -- <arquivo.xlsx> --household-id <id> --actor-id <id>');
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) usage();
  return process.argv[index + 1];
}

function decodeXml(value: string) {
  return value
    .replace(/&#(x[\da-fA-F]+|\d+);/g, (_, entity: string) => String.fromCodePoint(entity.startsWith('x') ? Number.parseInt(entity.slice(1), 16) : Number.parseInt(entity, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function columnIndex(reference: string) {
  return [...reference.replace(/\d/g, '')].reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function unzipEntry(file: string, entry: string) {
  return execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8' });
}

function sharedStrings(file: string) {
  const xml = unzipEntry(file, 'xl/sharedStrings.xml');
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => decodeXml([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join('')));
}

function readSheet(file: string, entry: string, strings: string[]) {
  const xml = unzipEntry(file, entry);
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = /\br="([A-Z]+\d+)"/.exec(cellMatch[1])?.[1];
      if (!reference) continue;
      const value = /<v>([\s\S]*?)<\/v>/.exec(cellMatch[2])?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(cellMatch[1])?.[1];
      cells[columnIndex(reference)] = type === 's' && value ? strings[Number(value)] : decodeXml(value);
    }
    rows.push(cells);
  }
  const headers = rows[0] ?? [];
  return rows.slice(1).map((cells, index) => ({ row: index + 2, data: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])) }));
}

function isDate(value: string) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value) || /^\d+(\.\d+)?$/.test(value);
}

function dateFromExport(value: string) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    const [day, month, year] = value.split('/');
    return `${year}-${month}-${day}`;
  }
  const epoch = Date.UTC(1899, 11, 30, 12);
  return new Date(epoch + Number(value) * 86_400_000).toISOString().slice(0, 10);
}

function cents(value: string) {
  const raw = value.trim().replace(/[R$\s]/g, '');
  const negative = raw.startsWith('-');
  const unsigned = negative || raw.startsWith('+') ? raw.slice(1) : raw;
  const normalized = unsigned.includes(',') ? unsigned.replace(/\./g, '').replace(',', '.') : unsigned;
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`Valor monetário inválido: ${value}`);
  const [whole, decimal = ''] = normalized.split('.');
  const valueInCents = Number(whole) * 100 + Number((decimal + '00').slice(0, 2));
  return negative ? -valueInCents : valueInCents;
}

function truncate(value: string, length: number) {
  return value.trim().slice(0, length);
}

function event(tx: Tx, aggregateType: string, aggregateId: string, eventType: string, payload: Prisma.InputJsonValue) {
  return tx.outboxEvent.create({ data: { aggregateType, aggregateId, eventType, payload } });
}

function audit(tx: Tx, householdId: string, actorId: string, aggregateType: string, aggregateId: string, action: string, changedFields: string[]) {
  return tx.auditLog.create({ data: { householdId, actorId, aggregateType, aggregateId, action, changedFields } });
}

async function categoryAndSubcategory(tx: Tx, householdId: string, actorId: string, name: string, type: CategoryType, subcategoryName: string) {
  let category = await tx.category.findUnique({ where: { householdId_name_type: { householdId, name, type } } });
  if (!category) {
    category = await tx.category.create({ data: { householdId, name, type, color: colors[name] ?? (type === 'INCOME' ? '#2E8B57' : '#D65B5B'), icon: type === 'INCOME' ? 'payments' : 'receipt_long' } });
    await event(tx, 'category', category.id, 'orfina.categories.category-created.v1', { householdId, categoryId: category.id, type });
    await audit(tx, householdId, actorId, 'category', category.id, 'created-by-test-seed', ['name', 'type']);
  }
  let subcategory = await tx.subcategory.findUnique({ where: { categoryId_name: { categoryId: category.id, name: subcategoryName } } });
  if (!subcategory) {
    subcategory = await tx.subcategory.create({ data: { categoryId: category.id, name: subcategoryName } });
    await event(tx, 'subcategory', subcategory.id, 'orfina.categories.subcategory-created.v1', { householdId, categoryId: category.id, subcategoryId: subcategory.id, type });
    await audit(tx, householdId, actorId, 'subcategory', subcategory.id, 'created-by-test-seed', ['name']);
  }
  return { category, subcategory };
}

async function accountByName(tx: Tx, householdId: string, actorId: string, name: string) {
  let account = await tx.account.findFirst({ where: { householdId, name } });
  if (account) return account;
  const bank = name.startsWith('Banrisul') ? { bankName: 'Banrisul', bankLogoUrl: '/assets/banks/bank-037.svg' } : name.startsWith('Caixa') ? { bankName: 'Caixa', bankLogoUrl: '/assets/banks/bank-040.svg' } : {};
  account = await tx.account.create({ data: { householdId, name, type: 'CHECKING', initialBalance: 0, ...bank } });
  await event(tx, 'account', account.id, 'orfina.accounts.account-created.v1', { householdId, accountId: account.id, initialBalance: 0 });
  await audit(tx, householdId, actorId, 'account', account.id, 'created-by-test-seed', ['name', 'type']);
  return account;
}

async function createAccountTransaction(tx: Tx, args: { householdId: string; actorId: string; accountId: string; categoryId: string; subcategoryId: string; type: TransactionType; amount: number; description: string; occurredOn: string; notes: string }) {
  const existing = await tx.transaction.findFirst({ where: { householdId: args.householdId, notes: args.notes }, select: { id: true } });
  if (existing) return false;
  const { actorId: _actorId, occurredOn, ...data } = args;
  const transaction = await tx.transaction.create({ data: { ...data, occurredOn: civilDate(occurredOn) } });
  await event(tx, 'transaction', transaction.id, 'orfina.transactions.transaction-posted.v1', { householdId: args.householdId, transactionId: transaction.id, accountId: args.accountId, categoryId: args.categoryId, type: args.type, amount: args.amount, occurredOn: transaction.occurredOn.toISOString() });
  await audit(tx, args.householdId, args.actorId, 'transaction', transaction.id, 'imported-for-test', ['accountId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
  return true;
}

function monthDate(year: number, month: number, day: number) {
  const normalized = new Date(Date.UTC(year, month, 1, 12));
  normalized.setUTCDate(Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
  return normalized;
}

async function statementForDate(tx: Tx, householdId: string, card: { id: string; closingDay: number; dueDay: number }, occurredOn: string) {
  const date = civilDate(occurredOn);
  const cycleEndMonth = date.getUTCDate() <= card.closingDay ? date.getUTCMonth() : date.getUTCMonth() + 1;
  const cycleEnd = monthDate(date.getUTCFullYear(), cycleEndMonth, card.closingDay);
  const cycleStart = monthDate(date.getUTCFullYear(), cycleEndMonth - 1, card.closingDay + 1);
  const dueOn = monthDate(date.getUTCFullYear(), cycleEndMonth + (card.dueDay <= card.closingDay ? 1 : 0), card.dueDay);
  return tx.cardStatement.upsert({ where: { cardId_cycleEnd: { cardId: card.id, cycleEnd } }, update: {}, create: { householdId, cardId: card.id, cycleStart, cycleEnd, dueOn } });
}

async function createCardTransaction(tx: Tx, args: { householdId: string; actorId: string; card: { id: string; closingDay: number; dueDay: number }; categoryId: string; subcategoryId: string; type: TransactionType; amount: number; description: string; occurredOn: string; notes: string; installmentPurchaseId?: string; installmentNumber?: number; recurringRuleId?: string; recurrenceOn?: Date }) {
  const existing = await tx.transaction.findFirst({ where: { householdId: args.householdId, notes: args.notes }, select: { id: true } });
  if (existing) return false;
  const statement = await statementForDate(tx, args.householdId, args.card, args.occurredOn);
  if (statement.status !== CardStatementStatus.OPEN) throw new Error(`A fatura ${statement.id} não está aberta para ${args.description}.`);
  const transaction = await tx.transaction.create({ data: { householdId: args.householdId, cardId: args.card.id, statementId: statement.id, categoryId: args.categoryId, subcategoryId: args.subcategoryId, type: args.type, amount: args.amount, description: args.description, notes: args.notes, occurredOn: civilDate(args.occurredOn), installmentPurchaseId: args.installmentPurchaseId, installmentNumber: args.installmentNumber, recurringRuleId: args.recurringRuleId, recurrenceOn: args.recurrenceOn } });
  await tx.cardStatement.update({ where: { id: statement.id }, data: { totalAmount: { increment: args.type === TransactionType.EXPENSE ? args.amount : -args.amount } } });
  await event(tx, 'transaction', transaction.id, 'orfina.transactions.transaction-posted.v1', { householdId: args.householdId, transactionId: transaction.id, cardId: args.card.id, categoryId: args.categoryId, type: args.type, amount: args.amount, occurredOn: transaction.occurredOn.toISOString() });
  await audit(tx, args.householdId, args.actorId, 'transaction', transaction.id, 'created-by-test-seed', ['cardId', 'subcategoryId', 'type', 'amount', 'occurredOn']);
  return true;
}

async function cardByName(tx: Tx, householdId: string, actorId: string, input: { name: string; issuerName: string; issuerLogoUrl: string; network: CardNetwork; lastFour: string; creditLimit: number; closingDay: number; dueDay: number }) {
  let card = await tx.card.findFirst({ where: { householdId, name: input.name } });
  if (card) return card;
  card = await tx.card.create({ data: { householdId, ...input } });
  await event(tx, 'card', card.id, 'orfina.cards.card-created.v1', { householdId, cardId: card.id, network: card.network });
  await audit(tx, householdId, actorId, 'card', card.id, 'created-by-test-seed', ['name', 'network', 'creditLimit', 'closingDay', 'dueDay']);
  return card;
}

function addMonths(date: string, months: number) {
  const source = civilDate(date);
  return monthDate(source.getUTCFullYear(), source.getUTCMonth() + months, source.getUTCDate()).toISOString().slice(0, 10);
}

async function addSupplementalData(tx: Tx, householdId: string, actorId: string) {
  const accounts = {
    inter: await accountByName(tx, householdId, actorId, 'Banco Inter Douglas'),
    banrisul: await accountByName(tx, householdId, actorId, 'Banrisul Evelise'),
  };
  const restaurant = await categoryAndSubcategory(tx, householdId, actorId, 'Alimentação Extra', CategoryType.EXPENSE, 'Restaurante');
  const supermarket = await categoryAndSubcategory(tx, householdId, actorId, 'Despesas Mensais Básicas', CategoryType.EXPENSE, 'Supermercado');
  const electronics = await categoryAndSubcategory(tx, householdId, actorId, 'Aquisições', CategoryType.EXPENSE, 'Eletrônicos');
  const internet = await categoryAndSubcategory(tx, householdId, actorId, 'Moradia e Serviços Básicos', CategoryType.EXPENSE, 'Internet');
  const streaming = await categoryAndSubcategory(tx, householdId, actorId, 'Assinaturas', CategoryType.EXPENSE, 'Streaming');
  const nubank = await cardByName(tx, householdId, actorId, { name: 'Nubank Ultravioleta (teste)', issuerName: 'Nubank', issuerLogoUrl: '/assets/banks/bank-064.svg', network: CardNetwork.VISA, lastFour: '1234', creditLimit: 800_000, closingDay: 5, dueDay: 12 });
  const banrisulCard = await cardByName(tx, householdId, actorId, { name: 'Banrisul Mastercard (teste)', issuerName: 'Banrisul', issuerLogoUrl: '/assets/banks/bank-037.svg', network: CardNetwork.MASTERCARD, lastFour: '5678', creditLimit: 500_000, closingDay: 30, dueDay: 8 });

  const cardTransactions = [
    { card: nubank, source: restaurant, amount: 12_500, description: 'Jantar em família (teste)', occurredOn: '2026-08-20', notes: `${markerPrefix}:card:nubank:restaurant` },
    { card: nubank, source: supermarket, amount: 37_890, description: 'Mercado no cartão (teste)', occurredOn: '2026-09-17', notes: `${markerPrefix}:card:nubank:supermarket` },
    { card: nubank, source: restaurant, amount: 8_900, description: 'Almoço no cartão (teste)', occurredOn: '2026-09-28', notes: `${markerPrefix}:card:nubank:lunch` },
    { card: banrisulCard, source: restaurant, amount: 15_700, description: 'Restaurante no Banrisul (teste)', occurredOn: '2026-09-12', notes: `${markerPrefix}:card:banrisul:restaurant` },
  ];
  for (const item of cardTransactions) await createCardTransaction(tx, { householdId, actorId, card: item.card, categoryId: item.source.category.id, subcategoryId: item.source.subcategory.id, type: TransactionType.EXPENSE, amount: item.amount, description: item.description, occurredOn: item.occurredOn, notes: item.notes });

  let installment = await tx.installmentPurchase.findFirst({ where: { householdId, cardId: nubank.id, description: 'Notebook para testes' } });
  if (!installment) {
    installment = await tx.installmentPurchase.create({ data: { householdId, cardId: nubank.id, categoryId: electronics.category.id, subcategoryId: electronics.subcategory.id, type: TransactionType.EXPENSE, totalAmount: 360_000, installmentCount: 6, description: 'Notebook para testes', firstOccurredOn: civilDate('2026-08-18') } });
    await event(tx, 'installment-purchase', installment.id, 'orfina.installments.purchase-created.v1', { householdId, purchaseId: installment.id, cardId: nubank.id, totalAmount: installment.totalAmount, installmentCount: installment.installmentCount });
    await audit(tx, householdId, actorId, 'installment-purchase', installment.id, 'created-by-test-seed', ['cardId', 'totalAmount', 'installmentCount']);
  }
  for (let index = 0; index < installment.installmentCount; index += 1) {
    const occurredOn = addMonths('2026-08-18', index);
    await createCardTransaction(tx, { householdId, actorId, card: nubank, categoryId: electronics.category.id, subcategoryId: electronics.subcategory.id, type: TransactionType.EXPENSE, amount: 60_000, description: `Notebook para testes (${index + 1}/6)`, occurredOn, notes: `${markerPrefix}:installment:notebook:${index + 1}`, installmentPurchaseId: installment.id, installmentNumber: index + 1 });
  }

  let accountRule = await tx.recurringRule.findFirst({ where: { householdId, description: 'Internet residencial (teste)' } });
  if (!accountRule) {
    accountRule = await tx.recurringRule.create({ data: { householdId, accountId: accounts.banrisul.id, categoryId: internet.category.id, subcategoryId: internet.subcategory.id, type: TransactionType.EXPENSE, amount: 12_999, description: 'Internet residencial (teste)', notes: `${markerPrefix}:recurring:internet`, startOn: civilDate('2026-08-01') } });
    await event(tx, 'recurring-rule', accountRule.id, 'orfina.recurring.rule-created.v1', { householdId, ruleId: accountRule.id, accountId: accounts.banrisul.id, amount: accountRule.amount });
    await audit(tx, householdId, actorId, 'recurring-rule', accountRule.id, 'created-by-test-seed', ['accountId', 'amount', 'startOn']);
  }
  for (const occurredOn of ['2026-08-01', '2026-09-01', '2026-10-01']) {
    await createAccountTransaction(tx, { householdId, actorId, accountId: accounts.banrisul.id, categoryId: internet.category.id, subcategoryId: internet.subcategory.id, type: TransactionType.EXPENSE, amount: accountRule.amount, description: accountRule.description, occurredOn, notes: `${markerPrefix}:recurring:internet:${occurredOn}` });
    await tx.transaction.updateMany({ where: { householdId, notes: `${markerPrefix}:recurring:internet:${occurredOn}` }, data: { recurringRuleId: accountRule.id, recurrenceOn: civilDate(occurredOn) } });
  }

  let cardRule = await tx.recurringRule.findFirst({ where: { householdId, description: 'Streaming no cartão (teste)' } });
  if (!cardRule) {
    cardRule = await tx.recurringRule.create({ data: { householdId, cardId: nubank.id, categoryId: streaming.category.id, subcategoryId: streaming.subcategory.id, type: TransactionType.EXPENSE, amount: 3_290, description: 'Streaming no cartão (teste)', notes: `${markerPrefix}:recurring:streaming`, startOn: civilDate('2026-10-01') } });
    await event(tx, 'recurring-rule', cardRule.id, 'orfina.recurring.rule-created.v1', { householdId, ruleId: cardRule.id, cardId: nubank.id, amount: cardRule.amount });
    await audit(tx, householdId, actorId, 'recurring-rule', cardRule.id, 'created-by-test-seed', ['cardId', 'amount', 'startOn']);
  }
  await createCardTransaction(tx, { householdId, actorId, card: nubank, categoryId: streaming.category.id, subcategoryId: streaming.subcategory.id, type: TransactionType.EXPENSE, amount: cardRule.amount, description: cardRule.description, occurredOn: '2026-10-01', notes: `${markerPrefix}:recurring:streaming:2026-10-01`, recurringRuleId: cardRule.id, recurrenceOn: civilDate('2026-10-01') });

  const nubankStatements = await tx.cardStatement.findMany({ where: { householdId, cardId: nubank.id }, include: { payments: true } });
  for (const statement of nubankStatements.filter((item) => item.cycleEnd < today && item.status === CardStatementStatus.OPEN)) {
    await tx.cardStatement.update({ where: { id: statement.id }, data: { status: CardStatementStatus.CLOSED, closedAt: today } });
    const paid = statement.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const outstanding = statement.totalAmount - paid;
    if (outstanding > 0) {
      const paymentKey = `${markerPrefix}:payment:${statement.id}`;
      const payment = await tx.cardPayment.findUnique({ where: { householdId_idempotencyKey: { householdId, idempotencyKey: paymentKey } } });
      if (!payment) {
        const created = await tx.cardPayment.create({ data: { householdId, statementId: statement.id, accountId: accounts.inter.id, amount: outstanding, paidOn: statement.dueOn, idempotencyKey: paymentKey } });
        await event(tx, 'card-payment', created.id, 'orfina.cards.statement-payment-posted.v1', { householdId, paymentId: created.id, statementId: statement.id, cardId: nubank.id, accountId: accounts.inter.id, amount: outstanding });
        await audit(tx, householdId, actorId, 'card-payment', created.id, 'created-by-test-seed', ['statementId', 'accountId', 'amount', 'paidOn']);
      }
    }
    await tx.cardStatement.update({ where: { id: statement.id }, data: { status: CardStatementStatus.PAID, paidAt: today } });
  }
  await tx.cardStatement.updateMany({ where: { householdId, cardId: banrisulCard.id, cycleEnd: { lt: today }, status: CardStatementStatus.OPEN }, data: { status: CardStatementStatus.CLOSED, closedAt: today } });
  const finalizedStatements = await tx.cardStatement.findMany({ where: { householdId, cardId: { in: [nubank.id, banrisulCard.id] }, status: { in: [CardStatementStatus.CLOSED, CardStatementStatus.PAID] } } });
  for (const statement of finalizedStatements) {
    const closeRecorded = await tx.auditLog.findFirst({ where: { householdId, aggregateType: 'card-statement', aggregateId: statement.id, action: 'closed' }, select: { id: true } });
    if (!closeRecorded) {
      await event(tx, 'card-statement', statement.id, 'orfina.cards.statement-closed.v1', { householdId, statementId: statement.id, cardId: statement.cardId, totalAmount: statement.totalAmount });
      await audit(tx, householdId, actorId, 'card-statement', statement.id, 'closed', ['status', 'closedAt']);
    }
  }

  const budgets = [
    [electronics.category.id, 200_000], [supermarket.category.id, 300_000], [restaurant.category.id, 130_000], [internet.category.id, 300_000], [streaming.category.id, 35_000],
  ] as const;
  for (const [categoryId, limitAmount] of budgets) {
    const existing = await tx.monthlyBudget.findUnique({ where: { householdId_referenceMonth_categoryId: { householdId, referenceMonth: civilDate('2026-10-01'), categoryId } } });
    if (!existing) {
      const budget = await tx.monthlyBudget.create({ data: { householdId, referenceMonth: civilDate('2026-10-01'), categoryId, limitAmount, notes: 'Criado pela massa de testes' } });
      await event(tx, 'monthly-budget', budget.id, 'orfina.budgets.monthly-budget-upserted.v1', { householdId, budgetId: budget.id, categoryId, referenceMonth: budget.referenceMonth.toISOString(), limitAmount });
      await audit(tx, householdId, actorId, 'monthly-budget', budget.id, 'created-by-test-seed', ['limitAmount']);
    }
  }
  const september = civilDate('2026-09-01');
  let budgetMonth = await tx.budgetMonth.findUnique({ where: { householdId_referenceMonth: { householdId, referenceMonth: september } } });
  if (!budgetMonth) budgetMonth = await tx.budgetMonth.create({ data: { householdId, referenceMonth: september, closedAt: today, closedById: actorId, snapshot: Prisma.JsonNull } });
  const closeRecorded = await tx.auditLog.findFirst({ where: { householdId, aggregateType: 'budget-month', aggregateId: budgetMonth.id, action: 'closed' }, select: { id: true } });
  if (!closeRecorded) {
    await event(tx, 'budget-month', budgetMonth.id, 'orfina.budgets.month-closed.v1', { householdId, referenceMonth: budgetMonth.referenceMonth.toISOString() });
    await audit(tx, householdId, actorId, 'budget-month', budgetMonth.id, 'closed', ['closedAt']);
  }

  const goals = [
    { name: 'Reserva de emergência (teste)', targetAmount: 1_500_000, targetDate: '2027-03-31', color: '#5B5BD6', contributions: [['2026-08-10', 250_000], ['2026-09-10', 150_000]] },
    { name: 'Viagem em família (teste)', targetAmount: 600_000, targetDate: '2027-01-15', color: '#D65B5B', contributions: [['2026-09-15', 125_000]] },
  ] as const;
  for (const goalInput of goals) {
    let goal = await tx.savingsGoal.findFirst({ where: { householdId, name: goalInput.name } });
    if (!goal) {
      goal = await tx.savingsGoal.create({ data: { householdId, name: goalInput.name, targetAmount: goalInput.targetAmount, targetDate: civilDate(goalInput.targetDate), color: goalInput.color, icon: 'savings', status: SavingsGoalStatus.ACTIVE } });
      await event(tx, 'savings-goal', goal.id, 'orfina.goals.goal-created.v1', { householdId, goalId: goal.id, targetAmount: goal.targetAmount, targetDate: goal.targetDate?.toISOString() });
      await audit(tx, householdId, actorId, 'savings-goal', goal.id, 'created-by-test-seed', ['name', 'targetAmount', 'targetDate']);
    }
    for (const [occurredOn, amount] of goalInput.contributions) {
      const idempotencyKey = `${markerPrefix}:goal:${goal.name}:${occurredOn}`;
      const existing = await tx.goalContribution.findUnique({ where: { householdId_idempotencyKey: { householdId, idempotencyKey } } });
      if (!existing) {
        const contribution = await tx.goalContribution.create({ data: { householdId, goalId: goal.id, actorId, amount, occurredOn: civilDate(occurredOn), notes: 'Aporte criado pela massa de testes', idempotencyKey } });
        await event(tx, 'goal-contribution', contribution.id, 'orfina.goals.contribution-created.v1', { householdId, goalId: goal.id, contributionId: contribution.id, amount, occurredOn: contribution.occurredOn.toISOString() });
        await audit(tx, householdId, actorId, 'goal-contribution', contribution.id, 'created-by-test-seed', ['goalId', 'amount', 'occurredOn']);
      }
    }
  }
}

async function run() {
  const file = resolve(process.argv[2] ?? '');
  const householdId = argument('--household-id');
  const actorId = argument('--actor-id');
  if (!file.endsWith('.xlsx')) usage();
  readFileSync(file);
  const strings = sharedStrings(file);
  const expenses = readSheet(file, 'xl/worksheets/sheet2.xml', strings).filter((item) => isDate(item.data.Data)).map((item) => ({ ...item, source: 'despesas' as const }));
  const incomes = readSheet(file, 'xl/worksheets/sheet3.xml', strings).filter((item) => isDate(item.data.Data)).map((item) => ({ ...item, source: 'receitas' as const }));
  const transfers = readSheet(file, 'xl/worksheets/sheet4.xml', strings).filter((item) => isDate(item.data.Data));
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.householdMember.findUnique({ where: { householdId_userId: { householdId, userId: actorId } } });
      if (!member) throw new Error('O ator informado não pertence ao grupo familiar informado.');
      const imported = [...expenses, ...incomes] as ImportedRow[];
      let importedTransactions = 0;
      for (const item of imported) {
        const type = item.source === 'despesas' ? TransactionType.EXPENSE : TransactionType.INCOME;
        const { category, subcategory } = await categoryAndSubcategory(tx, householdId, actorId, item.data.Categoria, type === TransactionType.EXPENSE ? CategoryType.EXPENSE : CategoryType.INCOME, item.data.Subcategoria || 'Sem subcategoria');
        const account = await accountByName(tx, householdId, actorId, item.data.Conta);
        const sourceKey = `${markerPrefix}:${item.source}:${item.row}`;
        const created = await createAccountTransaction(tx, { householdId, actorId, accountId: account.id, categoryId: category.id, subcategoryId: subcategory.id, type, amount: Math.abs(cents(item.data.Valor)), description: truncate(item.data.Descrição || `${item.data.Categoria} - importado`, 160), occurredOn: dateFromExport(item.data.Data), notes: `${sourceKey}; situação original: ${item.data.Situação || 'não informada'}` });
        if (created) importedTransactions += 1;
      }
      const transferExpense = await categoryAndSubcategory(tx, householdId, actorId, 'Outros', CategoryType.EXPENSE, 'Transferência entre Contas');
      const transferIncome = await categoryAndSubcategory(tx, householdId, actorId, 'Outras Receitas', CategoryType.INCOME, 'Transferência entre Contas');
      let importedTransfers = 0;
      for (const item of transfers) {
        const origin = await accountByName(tx, householdId, actorId, item.data['Conta origem']);
        const destination = await accountByName(tx, householdId, actorId, item.data['Conta destino']);
        const sourceKey = `${markerPrefix}:transferencias:${item.row}`;
        const date = dateFromExport(item.data.Data);
        const amount = Math.abs(cents(item.data.Valor));
        const out = await createAccountTransaction(tx, { householdId, actorId, accountId: origin.id, categoryId: transferExpense.category.id, subcategoryId: transferExpense.subcategory.id, type: TransactionType.EXPENSE, amount, description: `Transferência para ${destination.name}`, occurredOn: date, notes: `${sourceKey}:saida` });
        const incoming = await createAccountTransaction(tx, { householdId, actorId, accountId: destination.id, categoryId: transferIncome.category.id, subcategoryId: transferIncome.subcategory.id, type: TransactionType.INCOME, amount, description: `Transferência de ${origin.name}`, occurredOn: date, notes: `${sourceKey}:entrada` });
        if (out || incoming) importedTransfers += 1;
      }
      await addSupplementalData(tx, householdId, actorId);
      return { importedTransactions, importedTransfers, sourceTransactions: imported.length, sourceTransfers: transfers.length };
    }, { maxWait: 5_000, timeout: 60_000 });
    const totals = await Promise.all(['transaction', 'card', 'cardStatement', 'cardPayment', 'installmentPurchase', 'recurringRule', 'monthlyBudget', 'savingsGoal', 'goalContribution'].map(async (model) => [model, await (prisma[model as keyof PrismaClient] as { count: (args: object) => Promise<number> }).count({ where: { householdId } })]));
    console.log(JSON.stringify({ file: basename(file), householdId, ...result, totals: Object.fromEntries(totals) }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
