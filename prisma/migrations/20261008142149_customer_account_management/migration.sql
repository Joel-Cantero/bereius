-- CreateEnum
CREATE TYPE "CustomerSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CustomerSyncMode" AS ENUM ('PREVIEW', 'APPLY');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'WORDPRESS';

-- CreateTable
CREATE TABLE "CustomerSyncRun" (
    "id" TEXT NOT NULL,
    "mode" "CustomerSyncMode" NOT NULL,
    "status" "CustomerSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "requestedById" TEXT,
    "settingsVersion" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "results" JSONB,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAdminEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "operation" TEXT NOT NULL,
    "principalId" INTEGER,
    "delegateId" INTEGER,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAdminEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSyncRun_leaseToken_key" ON "CustomerSyncRun"("leaseToken");

-- CreateIndex
CREATE INDEX "CustomerSyncRun_status_leaseExpiresAt_idx" ON "CustomerSyncRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CustomerSyncRun_startedAt_idx" ON "CustomerSyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "CustomerAdminEvent_createdAt_idx" ON "CustomerAdminEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "CustomerSyncRun" ADD CONSTRAINT "CustomerSyncRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdminEvent" ADD CONSTRAINT "CustomerAdminEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
