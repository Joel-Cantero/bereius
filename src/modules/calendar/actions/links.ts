"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { routing } from "@/i18n/routing";
import { logger } from "@/lib/logger";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { CalendarLinkError, linkBookingCalendar, unlinkBookingCalendar } from "@/modules/calendar/services/links";

export type CalendarLinkActionState = { status: "idle" | "done" } | { status: "error"; reason: "unauthenticated" | "forbidden" | "invalid" | "state_changed" | "conflict" | "unavailable" | "not_configured" | "unknown" };

const idSchema = z.string().min(1).max(191).regex(/^[a-zA-Z0-9_-]+$/);
const linkSchema = z.object({ bookingRequestId: idSchema, selection: z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/), confirmed: z.literal("yes") });
const unlinkSchema = z.object({ bookingRequestId: idSchema, linkId: idSchema });

function failure(error: unknown): CalendarLinkActionState {
  if (error instanceof AuthorizationError || error instanceof CalendarLinkError) return { status: "error", reason: error.code };
  if (error instanceof z.ZodError) return { status: "error", reason: "invalid" };
  logger.warn({ event: "calendar_link_failed" }, "calendar linking failed");
  return { status: "error", reason: "unknown" };
}

function refresh(id: string) {
  for (const locale of routing.locales) {
    revalidatePath(`/${locale}/bookings/${id}`);
    revalidatePath(`/${locale}/calendar`);
  }
}

export async function linkBookingCalendarAction(_previous: CalendarLinkActionState, data: FormData): Promise<CalendarLinkActionState> {
  try {
    const actor = await requireBookingActor();
    const input = linkSchema.parse({ bookingRequestId: data.get("bookingRequestId"), selection: data.get("selection"), confirmed: data.get("confirmed") });
    await linkBookingCalendar({ ...input, actorUserId: actor.userId });
    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) { return failure(error); }
}

export async function unlinkBookingCalendarAction(_previous: CalendarLinkActionState, data: FormData): Promise<CalendarLinkActionState> {
  try {
    const actor = await requireBookingActor();
    const input = unlinkSchema.parse({ bookingRequestId: data.get("bookingRequestId"), linkId: data.get("linkId") });
    await unlinkBookingCalendar({ ...input, actorUserId: actor.userId });
    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) { return failure(error); }
}