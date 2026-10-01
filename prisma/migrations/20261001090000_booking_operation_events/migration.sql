CREATE TYPE "BookingOperationEventType" AS ENUM ('QUOTE_REQUESTED', 'ESTIMATE_CREATED', 'ESTIMATE_REUSED', 'ESTIMATE_APPROVED', 'DELIVERY_STARTED', 'DELIVERY_ACCEPTED', 'DELIVERY_FAILED', 'DELIVERY_UNKNOWN', 'QUOTE_FAILED');

CREATE TABLE "BookingOperationEvent" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "BookingOperationEventType" NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingOperationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookingOperationEvent_bookingRequestId_createdAt_idx" ON "BookingOperationEvent"("bookingRequestId", "createdAt");
ALTER TABLE "BookingOperationEvent" ADD CONSTRAINT "BookingOperationEvent_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookingOperationEvent" ADD CONSTRAINT "BookingOperationEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;