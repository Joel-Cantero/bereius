CREATE TYPE "BankPaymentStage" AS ENUM ('PREPARED', 'CONVERTED', 'CONFIGURED', 'APPROVED', 'PAID', 'RECONCILED', 'SENT', 'COMPLETED');
CREATE TYPE "BankPaymentStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'FAILED', 'UNKNOWN', 'BLOCKED', 'COMPLETED');

CREATE TABLE "BankPaymentOperation" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "stage" "BankPaymentStage" NOT NULL DEFAULT 'PREPARED',
    "status" "BankPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "receivedAt" DATE NOT NULL,
    "reference" TEXT,
    "contactId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "collectionId" TEXT,
    "lastFailureCode" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankPaymentOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankPaymentOperation_amount_check" CHECK ("amountCents" > 20000)
);

CREATE UNIQUE INDEX "BankPaymentOperation_bookingRequestId_key" ON "BankPaymentOperation"("bookingRequestId");
CREATE UNIQUE INDEX "BankPaymentOperation_movementId_key" ON "BankPaymentOperation"("movementId");
CREATE UNIQUE INDEX "BankPaymentOperation_invoiceId_key" ON "BankPaymentOperation"("invoiceId");
CREATE INDEX "BankPaymentOperation_status_updatedAt_idx" ON "BankPaymentOperation"("status", "updatedAt");

ALTER TABLE "BankPaymentOperation" ADD CONSTRAINT "BankPaymentOperation_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankPaymentOperation" ADD CONSTRAINT "BankPaymentOperation_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "BankMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
