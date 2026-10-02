-- CreateEnum
CREATE TYPE "CalendarBookingLinkAction" AS ENUM ('LINKED', 'UNLINKED');

-- CreateTable
CREATE TABLE "CalendarBookingLink" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "sourceKey" VARCHAR(64) NOT NULL,
    "eventKey" VARCHAR(64) NOT NULL,
    "eventUid" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "eventTitle" TEXT NOT NULL,
    "eventStart" TEXT NOT NULL,
    "eventEnd" TEXT NOT NULL,
    "allDay" BOOLEAN NOT NULL,
    "bookingStartDate" DATE NOT NULL,
    "bookingEndDate" DATE NOT NULL,
    "linkedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarBookingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarBookingAuditEvent" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "CalendarBookingLinkAction" NOT NULL,
    "eventTitle" TEXT NOT NULL,
    "sourceKey" VARCHAR(64) NOT NULL,
    "eventKey" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarBookingAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarBookingLink_bookingRequestId_key" ON "CalendarBookingLink"("bookingRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarBookingLink_sourceKey_eventKey_key" ON "CalendarBookingLink"("sourceKey", "eventKey");

-- CreateIndex
CREATE INDEX "CalendarBookingAuditEvent_bookingRequestId_createdAt_idx" ON "CalendarBookingAuditEvent"("bookingRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "CalendarBookingLink" ADD CONSTRAINT "CalendarBookingLink_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBookingLink" ADD CONSTRAINT "CalendarBookingLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBookingAuditEvent" ADD CONSTRAINT "CalendarBookingAuditEvent_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBookingAuditEvent" ADD CONSTRAINT "CalendarBookingAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
