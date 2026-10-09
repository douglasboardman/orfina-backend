ALTER TABLE "HouseholdMember"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "archivedAt" TIMESTAMP(3);
