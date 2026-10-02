CREATE TYPE "SavingsGoalStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

CREATE TABLE "MonthlyBudget" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "referenceMonth" DATE NOT NULL,
  "categoryId" TEXT NOT NULL,
  "limitAmount" INTEGER NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetMonth" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "referenceMonth" DATE NOT NULL,
  "closedAt" TIMESTAMP(3),
  "closedById" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BudgetMonth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavingsGoal" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "targetAmount" INTEGER NOT NULL,
  "targetDate" DATE,
  "color" TEXT NOT NULL DEFAULT '#5B5BD6',
  "icon" TEXT,
  "status" "SavingsGoalStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoalContribution" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "occurredOn" DATE NOT NULL,
  "notes" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoalContribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonthlyBudget_householdId_referenceMonth_categoryId_key" ON "MonthlyBudget"("householdId", "referenceMonth", "categoryId");
CREATE INDEX "MonthlyBudget_householdId_referenceMonth_idx" ON "MonthlyBudget"("householdId", "referenceMonth");
CREATE UNIQUE INDEX "BudgetMonth_householdId_referenceMonth_key" ON "BudgetMonth"("householdId", "referenceMonth");
CREATE INDEX "BudgetMonth_householdId_closedAt_idx" ON "BudgetMonth"("householdId", "closedAt");
CREATE INDEX "SavingsGoal_householdId_status_idx" ON "SavingsGoal"("householdId", "status");
CREATE UNIQUE INDEX "GoalContribution_householdId_idempotencyKey_key" ON "GoalContribution"("householdId", "idempotencyKey");
CREATE INDEX "GoalContribution_goalId_occurredOn_idx" ON "GoalContribution"("goalId", "occurredOn");

ALTER TABLE "MonthlyBudget" ADD CONSTRAINT "MonthlyBudget_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyBudget" ADD CONSTRAINT "MonthlyBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetMonth" ADD CONSTRAINT "BudgetMonth_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
