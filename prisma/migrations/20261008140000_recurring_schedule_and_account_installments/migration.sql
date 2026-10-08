-- Recurring rules retain their historical chain and households own the generation policy.
CREATE TYPE "RecurringMaterializationMode" AS ENUM ('ON_OCCURRENCE_DATE', 'EXERCISE_MONTH_DAY', 'DAYS_BEFORE_EXERCISE_MONTH');

ALTER TABLE "Household"
  ADD COLUMN "recurringMaterializationMode" "RecurringMaterializationMode" NOT NULL DEFAULT 'ON_OCCURRENCE_DATE',
  ADD COLUMN "recurringMaterializationValue" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "InstallmentPurchase"
  ADD COLUMN "accountId" TEXT,
  ALTER COLUMN "cardId" DROP NOT NULL;

ALTER TABLE "InstallmentPurchase"
  ADD CONSTRAINT "InstallmentPurchase_exactly_one_source"
  CHECK (("accountId" IS NOT NULL AND "cardId" IS NULL) OR ("accountId" IS NULL AND "cardId" IS NOT NULL));

ALTER TABLE "InstallmentPurchase"
  ADD CONSTRAINT "InstallmentPurchase_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "InstallmentPurchase_householdId_accountId_idx" ON "InstallmentPurchase"("householdId", "accountId");

ALTER TABLE "RecurringRule" ADD COLUMN "predecessorId" TEXT;
ALTER TABLE "RecurringRule"
  ADD CONSTRAINT "RecurringRule_predecessorId_fkey"
  FOREIGN KEY ("predecessorId") REFERENCES "RecurringRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "RecurringRule_predecessorId_idx" ON "RecurringRule"("predecessorId");
