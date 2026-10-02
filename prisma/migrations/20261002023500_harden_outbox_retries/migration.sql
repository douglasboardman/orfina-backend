ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "lastError" TEXT;

DROP INDEX "OutboxEvent_status_createdAt_idx";
CREATE INDEX "OutboxEvent_status_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("status", "nextAttemptAt", "createdAt");
