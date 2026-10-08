-- A schedule may be registered after it has started. Historical installments
-- remain outside Orfina while persisted transactions retain their real number.
ALTER TABLE "InstallmentPurchase"
  ADD COLUMN "startInstallmentNumber" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "InstallmentPurchase"
  ADD CONSTRAINT "InstallmentPurchase_startInstallmentNumber_valid"
  CHECK ("startInstallmentNumber" >= 1 AND "startInstallmentNumber" <= "installmentCount");
