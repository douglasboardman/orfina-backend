CREATE TYPE "CardNetwork" AS ENUM ('VISA', 'MASTERCARD', 'ELO', 'AMERICAN_EXPRESS', 'HIPERCARD', 'DINERS_CLUB', 'DISCOVER', 'JCB', 'UNIONPAY', 'MAESTRO', 'OTHER');

CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuerName" TEXT,
    "issuerLogoUrl" TEXT,
    "network" "CardNetwork" NOT NULL,
    "lastFour" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Card_householdId_isActive_idx" ON "Card"("householdId", "isActive");

ALTER TABLE "Card" ADD CONSTRAINT "Card_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
