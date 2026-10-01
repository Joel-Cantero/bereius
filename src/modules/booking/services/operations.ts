import "server-only";

import type { BookingOperationEventType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const FAILURE_CODES = new Set([
  "unauthorized", "not_found", "rate_limited", "invalid_request", "unavailable",
  "malformed_response", "incomplete_configuration", "no_service", "wrong_state",
  "not_configured", "invalid_config", "missing_fiscal_email", "invalid_delegate_email",
  "unlinked_customer", "invalid_delivery", "delivery_unknown",
]);

export function operationFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && FAILURE_CODES.has(code) ? code : "unexpected";
}

export async function recordBookingOperation(
  bookingRequestId: string,
  type: BookingOperationEventType,
  failureCode?: string,
): Promise<void> {
  await db.bookingOperationEvent.create({
    data: { bookingRequestId, type, failureCode },
  });
  logger.info(
    { event: "booking_operation", bookingRequestId, operation: type, failureCode },
    "booking document operation recorded",
  );
}