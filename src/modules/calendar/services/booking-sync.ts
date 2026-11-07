import "server-only";

import { z } from "zod";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BookingTransitionError, transitionBooking, type BookingTransactionClient } from "@/modules/booking/services/lifecycle";
import { BOOKING_MAIL_JOB_KIND } from "@/modules/booking/services/mail";
import { enqueueJob, type OutboxJob } from "@/modules/booking/services/outbox";
import { resolveIntegration } from "@/modules/booking/services/settings";
import { GOOGLE_CALENDAR_BOOKING_JOB_KIND } from "@/modules/calendar/constants";
import type { GoogleCalendarBookingSyncView } from "@/modules/calendar/types";
import {
  deleteGoogleCalendarEvent,
  ensureGoogleCalendarEvent,
  GoogleCalendarError,
  googleCalendarEventId,
} from "@/modules/calendar/services/google-calendar";

const payloadSchema = z.object({ bookingRequestId: z.string().min(1).max(191) }).strict();

export function googleCalendarBookingJobKey(bookingRequestId: string): string {
  return `${GOOGLE_CALENDAR_BOOKING_JOB_KIND}:${bookingRequestId}`;
}

export async function enqueueGoogleCalendarBookingSync(
  bookingRequestId: string,
  transaction: BookingTransactionClient,
): Promise<void> {
  await enqueueJob({
    kind: GOOGLE_CALENDAR_BOOKING_JOB_KIND,
    idempotencyKey: googleCalendarBookingJobKey(bookingRequestId),
    payload: { bookingRequestId },
  }, transaction);
}

export async function getGoogleCalendarBookingSyncView(
  bookingRequestId: string,
): Promise<GoogleCalendarBookingSyncView> {
  const [event, job] = await Promise.all([
    db.googleCalendarBookingEvent.findUnique({
      where: { bookingRequestId },
      select: { eventId: true, status: true, lastFailureCode: true },
    }),
    db.integrationJob.findUnique({
      where: { idempotencyKey: googleCalendarBookingJobKey(bookingRequestId) },
      select: { status: true, lastError: true },
    }),
  ]);

  if (event?.status === "CREATED") {
    return { status: "created", lastFailureCode: null, eventId: event.eventId };
  }
  if (job?.status === "DEAD") {
    return { status: "failed", lastFailureCode: job.lastError ?? event?.lastFailureCode ?? "unknown", eventId: event?.eventId ?? null };
  }
  if (job && ["PENDING", "CLAIMED"].includes(job.status)) {
    return { status: "pending", lastFailureCode: event?.lastFailureCode ?? null, eventId: event?.eventId ?? null };
  }
  if (event?.status === "PENDING") {
    return { status: "pending", lastFailureCode: event.lastFailureCode, eventId: event.eventId };
  }
  return { status: "none", lastFailureCode: null, eventId: event?.eventId ?? null };
}

async function finalizeConfirmation(bookingRequestId: string, eventId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${bookingRequestId} FOR UPDATE`;
    const booking = await tx.bookingRequest.findUnique({
      where: { id: bookingRequestId },
      include: {
        payments: { orderBy: { createdAt: "asc" }, take: 1, select: { recordedById: true } },
        customer: { select: { email: true } },
      },
    });
    if (!booking || booking.state !== "AWAITING_PAYMENT" || booking.payments.length === 0) {
      return false;
    }

    const event = await tx.googleCalendarBookingEvent.findUnique({
      where: { bookingRequestId },
      select: { eventId: true, status: true },
    });
    if (!event || event.eventId !== eventId || event.status === "DELETED") return false;

    const confirmedAt = new Date();
    await tx.googleCalendarBookingEvent.update({
      where: { bookingRequestId },
      data: { status: "CREATED", syncedAt: confirmedAt, lastFailureCode: null },
    });
    await transitionBooking({
      bookingRequestId,
      to: "CONFIRMED",
      actorUserId: booking.payments[0].recordedById,
      expectedFrom: "AWAITING_PAYMENT",
    }, tx);

    await tx.bankReconciliationProposal.updateMany({
      where: { status: "PENDING", bookingRequestId },
      data: { status: "INVALIDATED", invalidatedAt: confirmedAt, invalidationCode: "SIBLING_CONFIRMED" },
    });
    await enqueueJob({
      kind: BOOKING_MAIL_JOB_KIND,
      idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${bookingRequestId}`,
      payload: {
        to: booking.customer.email,
        subject: "Your booking is confirmed",
        text: "We have received your payment and your booking is confirmed.",
      },
    }, tx);
    return true;
  });
}

export async function cancelGoogleCalendarBooking(
  bookingRequestId: string,
  actorUserId: string,
  reason?: string,
): Promise<boolean> {
  const prepared = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${bookingRequestId} FOR UPDATE`;
    const booking = await tx.bookingRequest.findUnique({
      where: { id: bookingRequestId },
      select: {
        state: true,
        bankPaymentOperation: { select: { status: true } },
        googleCalendarEvent: { select: { calendarId: true, eventId: true, status: true } },
      },
    });
    if (!booking) throw new BookingTransitionError("unknown_booking", "Booking request not found");
    if (booking.state !== "AWAITING_PAYMENT" && booking.state !== "CONFIRMED") return null;
    if (booking.bankPaymentOperation && booking.bankPaymentOperation.status !== "COMPLETED") {
      throw new BookingTransitionError("state_changed", "A bank payment is being processed");
    }

    const job = await tx.integrationJob.findUnique({
      where: { idempotencyKey: googleCalendarBookingJobKey(bookingRequestId) },
      select: { id: true, status: true },
    });
    if (job?.status === "CLAIMED") {
      throw new BookingTransitionError("state_changed", "Google Calendar synchronization is in progress");
    }
    if (job && (job.status === "PENDING" || job.status === "DEAD")) {
      const stopped = await tx.integrationJob.updateMany({
        where: { id: job.id, status: job.status },
        data: { status: "SUCCEEDED", lastError: null },
      });
      if (stopped.count !== 1) {
        throw new BookingTransitionError("state_changed", "Google Calendar synchronization changed");
      }
    }
    if (!booking.googleCalendarEvent && !job) return null;
    return { state: booking.state, event: booking.googleCalendarEvent };
  });

  if (!prepared) return false;

  if (prepared.event && prepared.event.status !== "DELETED") {
    try {
      const integration = await resolveIntegration("GOOGLE_CALENDAR");
      await deleteGoogleCalendarEvent(
        { calendarId: prepared.event.calendarId },
        integration.secret,
        prepared.event.eventId,
      );
    } catch (error) {
      const failureCode = error instanceof GoogleCalendarError
        ? error.code
        : "calendar_delete_failed";
      await db.googleCalendarBookingEvent.updateMany({
        where: { bookingRequestId, eventId: prepared.event.eventId },
        data: { lastFailureCode: failureCode },
      });
      throw error instanceof GoogleCalendarError ? error : new GoogleCalendarError("unavailable");
    }
  }

  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${bookingRequestId} FOR UPDATE`;
    const current = await tx.bookingRequest.findUnique({
      where: { id: bookingRequestId },
      select: { state: true, googleCalendarEvent: { select: { eventId: true } } },
    });
    if (!current || current.state !== prepared.state) {
      throw new BookingTransitionError("state_changed", "Booking changed while Google Calendar was processing");
    }
    if (prepared.event) {
      if (current.googleCalendarEvent?.eventId !== prepared.event.eventId) {
        throw new BookingTransitionError("state_changed", "Google Calendar event changed");
      }
      await tx.googleCalendarBookingEvent.update({
        where: { bookingRequestId },
        data: { status: "DELETED", syncedAt: new Date(), lastFailureCode: null },
      });
    }
    await transitionBooking({
      bookingRequestId,
      to: "CANCELLED",
      actorUserId,
      reason,
      expectedFrom: prepared.state,
    }, tx);
  });
  return true;
}

async function loadOrCreateEventLink(
  bookingRequestId: string,
  calendarId: string,
  transaction: BookingTransactionClient,
) {
  await transaction.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${bookingRequestId} FOR UPDATE`;
  const booking = await transaction.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: {
      state: true,
      payments: { select: { id: true }, take: 1 },
      googleCalendarEvent: true,
    },
  });
  if (!booking || booking.state !== "AWAITING_PAYMENT" || booking.payments.length === 0) return null;
  if (booking.googleCalendarEvent) return booking.googleCalendarEvent;
  return transaction.googleCalendarBookingEvent.create({
    data: {
      bookingRequestId,
      calendarId,
      eventId: googleCalendarEventId(bookingRequestId),
    },
  });
}

export async function runGoogleCalendarBookingJob(job: OutboxJob): Promise<void> {
  const { bookingRequestId } = payloadSchema.parse(job.payload);
  const initial = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: {
      state: true,
      startDate: true,
      endDate: true,
      headcount: true,
      boardType: true,
      payments: { select: { id: true }, take: 1 },
      customer: { select: { name: true } },
      googleCalendarEvent: true,
    },
  });
  if (!initial || initial.state !== "AWAITING_PAYMENT" || initial.payments.length === 0) return;

  const integration = await resolveIntegration("GOOGLE_CALENDAR");
  const link = await db.$transaction((tx) =>
    loadOrCreateEventLink(bookingRequestId, integration.config.calendarId, tx),
  );
  if (!link || link.status === "DELETED") return;

  try {
    await ensureGoogleCalendarEvent(
      { calendarId: link.calendarId },
      integration.secret,
      {
        id: bookingRequestId,
        customerName: initial.customer.name,
        headcount: initial.headcount,
        boardType: initial.boardType,
        startDate: initial.startDate,
        endDate: initial.endDate,
      },
    );
  } catch (error) {
    const failureCode = error instanceof GoogleCalendarError ? error.code : "calendar_sync_failed";
    await db.googleCalendarBookingEvent.updateMany({
      where: { bookingRequestId, status: "PENDING" },
      data: { lastFailureCode: failureCode },
    });
    throw error instanceof GoogleCalendarError ? error : new GoogleCalendarError("unavailable");
  }

  const confirmed = await finalizeConfirmation(bookingRequestId, link.eventId);
  if (confirmed) {
    logger.info({ event: "google_calendar_booking_confirmed", bookingRequestId }, "booking event synchronized");
    return;
  }

  // The booking changed while Google was processing the insert. Remove the
  // orphaned event before allowing this job to complete.
  await deleteGoogleCalendarEvent(
    { calendarId: link.calendarId },
    integration.secret,
    link.eventId,
  );
  await db.googleCalendarBookingEvent.updateMany({
    where: { bookingRequestId, eventId: link.eventId, status: "PENDING" },
    data: { status: "DELETED", syncedAt: new Date(), lastFailureCode: null },
  });
}

export async function retryGoogleCalendarBookingSync(bookingRequestId: string): Promise<void> {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: { state: true, payments: { select: { id: true }, take: 1 } },
  });
  if (!booking || booking.state !== "AWAITING_PAYMENT" || booking.payments.length === 0) {
    throw new BookingTransitionError("state_changed", "This booking cannot be retried");
  }

  const retried = await db.integrationJob.updateMany({
    where: {
      kind: GOOGLE_CALENDAR_BOOKING_JOB_KIND,
      idempotencyKey: googleCalendarBookingJobKey(bookingRequestId),
      status: "DEAD",
    },
    data: { status: "PENDING", runAfter: new Date(), lastError: null },
  });
  if (retried.count !== 1) {
    throw new BookingTransitionError("state_changed", "This calendar job is not ready to retry");
  }
  await db.googleCalendarBookingEvent.updateMany({
    where: { bookingRequestId, status: "PENDING" },
    data: { lastFailureCode: null },
  });
}