"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logger } from "@/lib/logger";
import type { DecisionActionState } from "@/modules/booking/actions/decisions";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { QuoteResendError, requestQuoteResend } from "@/modules/booking/services/quoting";

const schema = z.object({ bookingRequestId: z.string().trim().min(1).max(120) });

export async function resendQuoteAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  try {
    const actor = await requireBookingActor();
    const input = schema.parse({ bookingRequestId: formData.get("bookingRequestId") });
    await requestQuoteResend(input.bookingRequestId, actor.userId);
    revalidatePath("/[locale]/(console)/bookings/[id]", "page");
    revalidatePath("/[locale]/(console)/bookings", "page");
    return { status: "done" };
  } catch (error) {
    const reason = error instanceof AuthorizationError ? error.code
      : error instanceof z.ZodError ? "invalid"
      : error instanceof QuoteResendError ? error.code === "wrong_state" ? "state_changed"
        : error.code === "busy" ? "quote_busy" : "quote_delivery_unknown"
      : "unknown";
    logger.warn({ event: "booking_quote_resend_failed", reason }, "quote resend refused");
    return { status: "error", reason };
  }
}