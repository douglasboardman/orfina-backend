-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('USER', 'SYSTEM_ADMIN');

-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AccessSource" AS ENUM ('MANUAL', 'BOOTSTRAP');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "systemRole" "SystemRole" NOT NULL DEFAULT 'USER';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "csrfTokenHash" TEXT;

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "userId" TEXT,
    "status" "AccessStatus" NOT NULL DEFAULT 'ENABLED',
    "source" "AccessSource" NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_normalizedEmail_key" ON "AccessGrant"("normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_userId_key" ON "AccessGrant"("userId");

-- CreateIndex
CREATE INDEX "AccessGrant_status_createdAt_id_idx" ON "AccessGrant"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SystemAuditLog_createdAt_id_idx" ON "SystemAuditLog"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SystemAuditLog_targetId_createdAt_idx" ON "SystemAuditLog"("targetId", "createdAt");

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Cutover invalidates legacy sessions without a session-bound CSRF proof.
UPDATE "Session" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_email_normalized" CHECK ("normalizedEmail" = lower(btrim("email")));
ALTER TABLE "SystemAuditLog" ADD CONSTRAINT "SystemAuditLog_actor_type" CHECK ("actorType" IN ('USER', 'CLI'));
