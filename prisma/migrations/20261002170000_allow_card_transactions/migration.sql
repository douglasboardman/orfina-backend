ALTER TABLE "Transaction" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "Transaction" ADD COLUMN "cardId" TEXT;
CREATE INDEX "Transaction_cardId_occurredOn_idx" ON "Transaction"("cardId", "occurredOn");
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_exactly_one_funding_source" CHECK (("accountId" IS NOT NULL AND "cardId" IS NULL) OR ("accountId" IS NULL AND "cardId" IS NOT NULL));
