-- CreateEnum
CREATE TYPE "GoogleCalendarBookingEventStatus" AS ENUM ('PENDING', 'CREATED', 'DELETED');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'GOOGLE_CALENDAR';

-- CreateTable
CREATE TABLE "GoogleCalendarBookingEvent" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "eventId" VARCHAR(1024) NOT NULL,
    "status" "GoogleCalendarBookingEventStatus" NOT NULL DEFAULT 'PENDING',
    "lastFailureCode" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarBookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarBookingEvent_bookingRequestId_key" ON "GoogleCalendarBookingEvent"("bookingRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarBookingEvent_calendarId_eventId_key" ON "GoogleCalendarBookingEvent"("calendarId", "eventId");

-- AddForeignKey
ALTER TABLE "GoogleCalendarBookingEvent" ADD CONSTRAINT "GoogleCalendarBookingEvent_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
