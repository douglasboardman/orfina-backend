BEGIN;

-- Refuse to discard a divergent classification: the subcategory must already
-- identify the same parent and household as the historical transaction.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Transaction" t
    JOIN "Subcategory" s ON s."id" = t."subcategoryId"
    JOIN "Category" c ON c."id" = s."categoryId"
    WHERE t."categoryId" <> s."categoryId" OR t."householdId" <> c."householdId"
  ) THEN
    RAISE EXCEPTION 'Transaction classification is inconsistent; reconcile before migrating';
  END IF;
END $$;

ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_categoryId_fkey";
ALTER TABLE "Transaction" DROP COLUMN "categoryId";
ALTER TABLE "Subcategory" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Reuse matching subcategories, including archived ones, preserving their IDs.
UPDATE "Subcategory" s SET "isDefault" = true, "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP
FROM "Category" c WHERE s."categoryId" = c."id" AND s."name" = c."name";
INSERT INTO "Subcategory" ("id", "categoryId", "name", "isDefault", "isActive", "updatedAt")
SELECT 'c' || substr(md5(random()::text || c."id"), 1, 24), c."id", c."name", true, true, CURRENT_TIMESTAMP
FROM "Category" c WHERE NOT EXISTS (
  SELECT 1 FROM "Subcategory" s WHERE s."categoryId" = c."id" AND s."isDefault"
);
CREATE UNIQUE INDEX "Subcategory_one_default_per_category" ON "Subcategory" ("categoryId") WHERE "isDefault";

-- This invariant lives in PostgreSQL so imports, seeds and concurrent writes
-- follow the same rule as the HTTP API.
CREATE FUNCTION sync_category_default_subcategory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE default_id TEXT; duplicate_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "Subcategory" ("id", "categoryId", "name", "isDefault", "updatedAt")
    VALUES ('c' || substr(md5(random()::text || NEW."id"), 1, 24), NEW."id", NEW."name", true, CURRENT_TIMESTAMP);
  ELSIF NEW."name" IS DISTINCT FROM OLD."name" THEN
    SELECT "id" INTO default_id FROM "Subcategory" WHERE "categoryId" = NEW."id" AND "isDefault" FOR UPDATE;
    SELECT "id" INTO duplicate_id FROM "Subcategory" WHERE "categoryId" = NEW."id" AND "name" = NEW."name" AND "id" <> default_id FOR UPDATE;
    IF duplicate_id IS NOT NULL THEN
      UPDATE "Transaction" SET "subcategoryId" = default_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "subcategoryId" = duplicate_id;
      UPDATE "InstallmentPurchase" SET "subcategoryId" = default_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "subcategoryId" = duplicate_id;
      UPDATE "RecurringRule" SET "subcategoryId" = default_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "subcategoryId" = duplicate_id;
      DELETE FROM "Subcategory" WHERE "id" = duplicate_id;
    END IF;
    UPDATE "Subcategory" SET "name" = NEW."name", "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = default_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Category_sync_default_subcategory" AFTER INSERT OR UPDATE OF "name" ON "Category"
FOR EACH ROW EXECUTE FUNCTION sync_category_default_subcategory();

CREATE FUNCTION protect_default_subcategory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isDefault" AND EXISTS (SELECT 1 FROM "Category" WHERE "id" = OLD."categoryId") THEN
      RAISE EXCEPTION 'The default subcategory cannot be deleted independently' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."isDefault" AND (NOT NEW."isDefault" OR NEW."categoryId" <> OLD."categoryId") THEN
    RAISE EXCEPTION 'The default subcategory cannot be detached' USING ERRCODE = '23514';
  END IF;
  IF NEW."isDefault" THEN
    SELECT "name" INTO category_name FROM "Category" WHERE "id" = NEW."categoryId";
    IF NEW."name" IS DISTINCT FROM category_name OR NOT NEW."isActive" THEN
      RAISE EXCEPTION 'The default subcategory must be active and match its category name' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Subcategory_protect_default" BEFORE INSERT OR UPDATE OR DELETE ON "Subcategory"
FOR EACH ROW EXECUTE FUNCTION protect_default_subcategory();
COMMIT;
