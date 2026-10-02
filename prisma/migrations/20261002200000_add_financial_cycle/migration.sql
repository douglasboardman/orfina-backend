-- Financial-cycle aggregates are additive and preserve every applied schema.
CREATE TYPE "CardStatementStatus" AS ENUM ('OPEN', 'CLOSED', 'PAID');
CREATE TYPE "RecurringRuleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

ALTER TABLE "Card"
  ADD COLUMN "creditLimit" INTEGER,
  ADD COLUMN "closingDay" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "dueDay" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "OutboxEvent"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3);
CREATE INDEX "OutboxEvent_status_nextAttemptAt_claimedAt_createdAt_idx" ON "OutboxEvent"("status", "nextAttemptAt", "claimedAt", "createdAt");

CREATE TABLE "CardStatement" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "cycleStart" DATE NOT NULL,
  "cycleEnd" DATE NOT NULL,
  "dueOn" DATE NOT NULL,
  "totalAmount" INTEGER NOT NULL DEFAULT 0,
  "status" "CardStatementStatus" NOT NULL DEFAULT 'OPEN',
  "closedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CardStatement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CardPayment" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "statementId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "paidOn" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstallmentPurchase" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "subcategoryId" TEXT NOT NULL,
  "type" "TransactionType" NOT NULL,
  "totalAmount" INTEGER NOT NULL,
  "installmentCount" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "firstOccurredOn" DATE NOT NULL,
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstallmentPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecurringRule" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT,
  "cardId" TEXT,
  "categoryId" TEXT NOT NULL,
  "subcategoryId" TEXT NOT NULL,
  "type" "TransactionType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "notes" TEXT,
  "startOn" DATE NOT NULL,
  "endOn" DATE,
  "status" "RecurringRuleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecurringRule_exactly_one_source" CHECK (("accountId" IS NOT NULL AND "cardId" IS NULL) OR ("accountId" IS NULL AND "cardId" IS NOT NULL))
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "actorId" TEXT,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "changedFields" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Transaction"
  ADD COLUMN "statementId" TEXT,
  ADD COLUMN "installmentPurchaseId" TEXT,
  ADD COLUMN "installmentNumber" INTEGER,
  ADD COLUMN "recurringRuleId" TEXT,
  ADD COLUMN "recurrenceOn" DATE;

CREATE UNIQUE INDEX "CardStatement_cardId_cycleEnd_key" ON "CardStatement"("cardId", "cycleEnd");
CREATE INDEX "CardStatement_householdId_status_dueOn_idx" ON "CardStatement"("householdId", "status", "dueOn");
CREATE UNIQUE INDEX "CardPayment_householdId_idempotencyKey_key" ON "CardPayment"("householdId", "idempotencyKey");
CREATE INDEX "CardPayment_statementId_idx" ON "CardPayment"("statementId");
CREATE INDEX "CardPayment_accountId_paidOn_idx" ON "CardPayment"("accountId", "paidOn");
CREATE INDEX "InstallmentPurchase_householdId_cardId_idx" ON "InstallmentPurchase"("householdId", "cardId");
CREATE INDEX "RecurringRule_householdId_status_idx" ON "RecurringRule"("householdId", "status");
CREATE INDEX "AuditLog_householdId_aggregateType_aggregateId_createdAt_idx" ON "AuditLog"("householdId", "aggregateType", "aggregateId", "createdAt");
CREATE INDEX "Transaction_statementId_idx" ON "Transaction"("statementId");
CREATE INDEX "Transaction_installmentPurchaseId_idx" ON "Transaction"("installmentPurchaseId");
CREATE UNIQUE INDEX "Transaction_recurringRuleId_recurrenceOn_key" ON "Transaction"("recurringRuleId", "recurrenceOn");

ALTER TABLE "CardStatement" ADD CONSTRAINT "CardStatement_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardStatement" ADD CONSTRAINT "CardStatement_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CardStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InstallmentPurchase" ADD CONSTRAINT "InstallmentPurchase_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstallmentPurchase" ADD CONSTRAINT "InstallmentPurchase_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InstallmentPurchase" ADD CONSTRAINT "InstallmentPurchase_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InstallmentPurchase" ADD CONSTRAINT "InstallmentPurchase_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CardStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_installmentPurchaseId_fkey" FOREIGN KEY ("installmentPurchaseId") REFERENCES "InstallmentPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_recurringRuleId_fkey" FOREIGN KEY ("recurringRuleId") REFERENCES "RecurringRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
