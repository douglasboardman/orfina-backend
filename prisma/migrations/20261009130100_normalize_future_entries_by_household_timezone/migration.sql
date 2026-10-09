-- Complete the adoption backfill using each household's civil day. This only
-- changes a boundary-day item when the database server and household timezone
-- differ; it is otherwise a no-op after the preceding backfill.
UPDATE "Transaction" AS transaction
SET "status" = 'PENDING'
FROM "Household" AS household
WHERE household."id" = transaction."householdId"
  AND transaction."status" = 'POSTED'
  AND transaction."occurredOn" > (CURRENT_TIMESTAMP AT TIME ZONE household."timezone")::date;

UPDATE "AccountTransfer" AS transfer
SET "status" = 'PENDING'
FROM "Household" AS household
WHERE household."id" = transfer."householdId"
  AND transfer."status" = 'POSTED'
  AND transfer."occurredOn" > (CURRENT_TIMESTAMP AT TIME ZONE household."timezone")::date;
