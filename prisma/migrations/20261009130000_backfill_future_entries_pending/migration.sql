-- The first adoption of financial realization must not consider a future
-- economic occurrence completed. Preserve historical dates and discarded
-- entries; normalize only future items that were created before PENDING
-- became the default.
UPDATE "Transaction"
SET "status" = 'PENDING'
WHERE "status" = 'POSTED'
  AND "occurredOn" > CURRENT_DATE;

UPDATE "AccountTransfer"
SET "status" = 'PENDING'
WHERE "status" = 'POSTED'
  AND "occurredOn" > CURRENT_DATE;
