import { cardCycle, financialDate, financialPeriodWhere, inFinancialPeriod, recurringFinancialOccurrences } from './financial-period';

const date = (value: string) => new Date(`${value}T12:00:00.000Z`);
const card = { closingDay: 25, dueDay: 5 };

describe('Card financial period', () => {
  it.each([
    ['2026-09-26', '2026-10-25', '2026-11-05'],
    ['2026-10-10', '2026-10-25', '2026-11-05'],
    ['2026-10-25', '2026-10-25', '2026-11-05'],
    ['2026-10-26', '2026-11-25', '2026-12-05'],
    ['2026-12-26', '2027-01-25', '2027-02-05'],
  ])('assigns purchase %s to its closing date %s and financial date %s', (purchase, close, due) => {
    expect(cardCycle(card, date(purchase)).cycleEnd).toEqual(date(close));
    expect(financialDate({ cardId: 'card', card, occurredOn: date(purchase) })).toEqual(date(due));
  });

  it('keeps closing and due dates in the same month when due day follows closing day', () => {
    expect(cardCycle({ closingDay: 5, dueDay: 12 }, date('2026-10-06')).dueOn).toEqual(date('2026-11-12'));
    expect(cardCycle({ closingDay: 5, dueDay: 12 }, date('2026-10-05')).dueOn).toEqual(date('2026-10-12'));
    expect(cardCycle({ closingDay: 5, dueDay: 5 }, date('2026-10-05')).dueOn).toEqual(date('2026-11-05'));
  });

  it('preserves stored statement dates even after a card calendar changes', () => {
    const entry = { cardId: 'card', card: { closingDay: 1, dueDay: 10 }, occurredOn: date('2026-10-10'), statement: { dueOn: new Date('2026-11-05T00:00:00.000Z') } };
    expect(financialDate(entry)).toEqual(date('2026-11-05'));
    expect(inFinancialPeriod(entry, date('2026-10-01'), date('2026-11-01'))).toBe(false);
    expect(inFinancialPeriod(entry, date('2026-11-01'), date('2026-12-01'))).toBe(true);
  });

  it('normalizes civil account dates and includes the first day of the month', () => {
    const entry = { occurredOn: new Date('2026-11-01T00:00:00.000Z') };
    expect(inFinancialPeriod(entry, date('2026-11-01'), date('2026-12-01'))).toBe(true);
    expect(inFinancialPeriod({ occurredOn: date('2026-12-01') }, date('2026-11-01'), date('2026-12-01'))).toBe(false);
  });

  it('includes a card recurrence that ended in October in the November budget', () => {
    const rule = { cardId: 'card', card, startOn: date('2026-10-10'), endOn: date('2026-10-10') };
    expect(recurringFinancialOccurrences(rule, date('2026-10-01'), date('2026-11-01'))).toEqual([]);
    expect(recurringFinancialOccurrences(rule, date('2026-11-01'), date('2026-12-01'))).toEqual([date('2026-10-10')]);
    expect(recurringFinancialOccurrences({ ...rule, excludedOccurrences: ['2026-10-10'] }, date('2026-11-01'), date('2026-12-01'))).toEqual([]);
  });

  it('projects a month-end account recurrence in a short month', () => {
    expect(recurringFinancialOccurrences({ startOn: date('2026-01-31'), endOn: null }, date('2026-02-01'), date('2026-03-01'))).toEqual([date('2026-02-28')]);
  });

  it('queries both stored invoice due dates and bounded legacy entries', () => {
    expect(financialPeriodWhere(date('2026-11-01'), date('2026-12-01')).OR).toContainEqual({ cardId: { not: null }, statement: { dueOn: { gte: date('2026-11-01'), lt: date('2026-12-01') } } });
    expect(financialPeriodWhere(date('2026-11-01'), date('2026-12-01')).OR).toContainEqual({ cardId: { not: null }, statementId: null, occurredOn: { gte: date('2026-09-01'), lt: date('2026-12-01') } });
  });
});
