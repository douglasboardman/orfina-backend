CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'POSTED', 'DISCARDED');
CREATE TYPE "AccountTransferStatus" AS ENUM ('PENDING', 'POSTED', 'DISCARDED');
CREATE TYPE "ImportBatchStatus" AS ENUM ('DRAFT', 'VALIDATED', 'COMMITTED', 'CANCELED', 'FAILED');
CREATE TYPE "ImportItemStatus" AS ENUM ('VALID', 'INVALID', 'POSSIBLE_DUPLICATE', 'COMMITTED', 'CANCELED');

ALTER TABLE "Transaction" ADD COLUMN "status" "TransactionStatus" NOT NULL DEFAULT 'POSTED';
ALTER TABLE "Transaction" ADD COLUMN "importItemId" TEXT;

CREATE TABLE "AccountTransfer" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "sourceAccountId" TEXT NOT NULL,
  "destinationAccountId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "occurredOn" DATE NOT NULL,
  "status" "AccountTransferStatus" NOT NULL DEFAULT 'POSTED',
  "description" TEXT,
  "importItemId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountTransfer_distinct_accounts" CHECK ("sourceAccountId" <> "destinationAccountId"),
  CONSTRAINT "AccountTransfer_positive_amount" CHECK ("amount" > 0)
);

CREATE TABLE "ImportBatch" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "fileName" TEXT,
  "format" TEXT NOT NULL,
  "mapping" JSONB,
  "status" "ImportBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "diagnostics" JSONB,
  "committedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportItem" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" "ImportItemStatus" NOT NULL DEFAULT 'VALID',
  "data" JSONB NOT NULL,
  "diagnostics" JSONB,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Transaction_importItemId_key" ON "Transaction"("importItemId");
CREATE INDEX "Transaction_householdId_status_occurredOn_idx" ON "Transaction"("householdId", "status", "occurredOn");
CREATE UNIQUE INDEX "AccountTransfer_importItemId_key" ON "AccountTransfer"("importItemId");
CREATE INDEX "AccountTransfer_householdId_occurredOn_idx" ON "AccountTransfer"("householdId", "occurredOn");
CREATE INDEX "AccountTransfer_sourceAccountId_occurredOn_idx" ON "AccountTransfer"("sourceAccountId", "occurredOn");
CREATE INDEX "AccountTransfer_destinationAccountId_occurredOn_idx" ON "AccountTransfer"("destinationAccountId", "occurredOn");
CREATE UNIQUE INDEX "ImportBatch_householdId_sourceHash_key" ON "ImportBatch"("householdId", "sourceHash");
CREATE INDEX "ImportBatch_householdId_status_createdAt_idx" ON "ImportBatch"("householdId", "status", "createdAt");
CREATE UNIQUE INDEX "ImportItem_batchId_rowNumber_key" ON "ImportItem"("batchId", "rowNumber");
CREATE INDEX "ImportItem_householdId_fingerprint_idx" ON "ImportItem"("householdId", "fingerprint");
CREATE INDEX "ImportItem_batchId_status_idx" ON "ImportItem"("batchId", "status");

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importItemId_fkey" FOREIGN KEY ("importItemId") REFERENCES "ImportItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_importItemId_fkey" FOREIGN KEY ("importItemId") REFERENCES "ImportItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
