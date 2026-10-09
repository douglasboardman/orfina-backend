-- Existing realized history is deliberately untouched. Only new entries default to pending.
CREATE TYPE "FinancialRealizationMode" AS ENUM ('MANUAL', 'ON_OCCURRENCE_DATE');
ALTER TABLE "Household" ADD COLUMN "financialRealizationMode" "FinancialRealizationMode" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Transaction" ALTER COLUMN "status" SET DEFAULT 'PENDING', ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "AccountTransfer" ALTER COLUMN "status" SET DEFAULT 'PENDING', ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "recurringTransferRuleId" TEXT, ADD COLUMN "recurrenceOn" DATE;
-- Civil-date exceptions survive occurrence removal and rule materialization retries.
ALTER TABLE "RecurringRule" ADD COLUMN "excludedOccurrences" JSONB NOT NULL DEFAULT '[]';
CREATE TABLE "RecurringTransferRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "householdId" TEXT NOT NULL REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "destinationAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amount" INTEGER NOT NULL,
  "description" TEXT,
  "startOn" DATE NOT NULL,
  "endOn" DATE,
  "status" "RecurringRuleStatus" NOT NULL DEFAULT 'ACTIVE',
  "excludedOccurrences" JSONB NOT NULL DEFAULT '[]',
  "predecessorId" TEXT REFERENCES "RecurringTransferRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringTransferRule_distinct_accounts" CHECK ("sourceAccountId" <> "destinationAccountId"),
  CONSTRAINT "RecurringTransferRule_positive_amount" CHECK ("amount" > 0),
  CONSTRAINT "RecurringTransferRule_date_range" CHECK ("endOn" IS NULL OR "endOn" >= "startOn")
);
CREATE INDEX "RecurringTransferRule_householdId_status_idx" ON "RecurringTransferRule"("householdId", "status");
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_recurringTransferRuleId_fkey" FOREIGN KEY ("recurringTransferRuleId") REFERENCES "RecurringTransferRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AccountTransfer_recurringTransferRuleId_recurrenceOn_key" ON "AccountTransfer"("recurringTransferRuleId", "recurrenceOn");
