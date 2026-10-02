-- Categories are the visual and reporting parent. Subcategories inherit their color and icon from it.
CREATE TABLE "Subcategory" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subcategory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Transaction" ADD COLUMN "subcategoryId" TEXT;
CREATE UNIQUE INDEX "Subcategory_categoryId_name_key" ON "Subcategory"("categoryId", "name");

-- Preserve any pre-existing transactions: each affected category gets a neutral
-- legacy subcategory before the new mandatory relation is enforced.
INSERT INTO "Subcategory" ("id", "categoryId", "name", "isActive", "createdAt", "updatedAt")
SELECT 'legacy_' || c."id", c."id", 'Não categorizado', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Category" c
WHERE EXISTS (SELECT 1 FROM "Transaction" t WHERE t."categoryId" = c."id")
ON CONFLICT ("categoryId", "name") DO NOTHING;

UPDATE "Transaction" t
SET "subcategoryId" = s."id"
FROM "Subcategory" s
WHERE s."categoryId" = t."categoryId"
  AND s."name" = 'Não categorizado'
  AND t."subcategoryId" IS NULL;

ALTER TABLE "Transaction" ALTER COLUMN "subcategoryId" SET NOT NULL;

CREATE INDEX "Subcategory_categoryId_idx" ON "Subcategory"("categoryId");
CREATE INDEX "Transaction_subcategoryId_idx" ON "Transaction"("subcategoryId");

ALTER TABLE "Subcategory" ADD CONSTRAINT "Subcategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "Subcategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
