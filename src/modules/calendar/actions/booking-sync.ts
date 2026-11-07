"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { BookingTransitionError } from "@/modules/booking/services/lifecycle";
import { retryGoogleCalendarBookingSync } from "@/modules/calendar/services/booking-sync";

export type GoogleCalendarBookingActionState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; reason: "unauthenticated" | "forbidden" | "invalid" | "state_changed" | "unknown" };

const schema = z.object({ bookingRequestId: z.string().min(1).max(191) }).strict();

export async function retryGoogleCalendarBookingAction(
  _previous: GoogleCalendarBookingActionState,
  formData: FormData,
): Promise<GoogleCalendarBookingActionState> {
  try {
    await requireBookingActor();
    const parsed = schema.safeParse({ bookingRequestId: formData.get("bookingRequestId") });
    if (!parsed.success) return { status: "error", reason: "invalid" };
    await retryGoogleCalendarBookingSync(parsed.data.bookingRequestId);
    revalidatePath("/[locale]/(console)/bookings/[id]", "page");
    return { status: "done" };
  } catch (error) {
    if (error instanceof AuthorizationError) return { status: "error", reason: error.code };
    if (error instanceof BookingTransitionError) return { status: "error", reason: "state_changed" };
    if (error instanceof z.ZodError) return { status: "error", reason: "invalid" };
    return { status: "error", reason: "unknown" };
  }
}