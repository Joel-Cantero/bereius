-- WordPress reuses Gravity Forms entry ids after a database restore, so the
-- submission time completes an entry's identity. Existing ids are unique, so
-- the composite index cannot meet a duplicate.

-- DropIndex
DROP INDEX "BookingRequest_gravityEntryId_key";

-- AlterTable
ALTER TABLE "IntakeCursor" ADD COLUMN     "lastEntryCreatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_gravityEntryId_submittedAt_key" ON "BookingRequest"("gravityEntryId", "submittedAt");
