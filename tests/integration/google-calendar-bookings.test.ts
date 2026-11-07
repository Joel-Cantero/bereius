// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const mocks = vi.hoisted(() => ({ ensure: vi.fn(), remove: vi.fn() }));
vi.mock("@/modules/calendar/services/google-calendar", async (original) => ({
  ...await original<typeof import("@/modules/calendar/services/google-calendar")>(),
  ensureGoogleCalendarEvent: mocks.ensure,
  deleteGoogleCalendarEvent: mocks.remove,
}));

import { db } from "@/lib/db";
import { GoogleCalendarError, googleCalendarEventId } from "@/modules/calendar/services/google-calendar";
import {
  enqueueGoogleCalendarBookingSync,
  googleCalendarBookingJobKey,
  retryGoogleCalendarBookingSync,
  runGoogleCalendarBookingJob,
} from "@/modules/calendar/services/booking-sync";
import { saveIntegrationSettings } from "@/modules/booking/services/settings";
import { cancelBooking } from "@/modules/booking/services/decisions";
import { BOOKING_MAIL_JOB_KIND } from "@/modules/booking/services/mail";

describe.skipIf(!runIntegrationTests)("Google Calendar booking synchronization", () => {
  let originalIntegration: Awaited<ReturnType<typeof db.integrationSettings.findUnique>> = null;
  const bookingIds: string[] = [];
  const customerIds: string[] = [];
  const actorIds: string[] = [];

  async function fixture() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const actor = await db.user.create({
      data: { email: `google-sync-${suffix}@example.test`, normalizedEmail: `google-sync-${suffix}@example.test`, status: "ACTIVE" },
    });
    actorIds.push(actor.id);
    const customer = await db.customer.create({
      data: { taxId: `G${suffix}`.slice(0, 20), name: "Google Fixture Group", email: `group-${suffix}@example.test` },
    });
    customerIds.push(customer.id);
    const booking = await db.bookingRequest.create({
      data: {
        gravityEntryId: `google-sync-${suffix}`,
        customerId: customer.id,
        state: "AWAITING_PAYMENT",
        boardType: "SELF_CATERING",
        startDate: new Date("2026-12-06T00:00:00.000Z"),
        endDate: new Date("2026-12-08T00:00:00.000Z"),
        headcount: 30,
        advanceCents: 43_200,
        depositCents: 20_000,
        paymentDueAt: new Date(),
        submittedAt: new Date(),
        decidedAt: new Date(),
      },
    });
    bookingIds.push(booking.id);
    await db.payment.create({
      data: { bookingRequestId: booking.id, amountCents: 63_200, receivedAt: new Date(), recordedById: actor.id },
    });
    await db.$transaction((transaction) => enqueueGoogleCalendarBookingSync(booking.id, transaction));
    return { booking, actor, job: {
      id: `google-job-${booking.id}`,
      kind: "calendar.booking-event",
      idempotencyKey: googleCalendarBookingJobKey(booking.id),
      payload: { bookingRequestId: booking.id },
      attempts: 1,
    } };
  }

  beforeAll(async () => {
    originalIntegration = await db.integrationSettings.findUnique({ where: { provider: "GOOGLE_CALENDAR" } });
    await saveIntegrationSettings({
      provider: "GOOGLE_CALENDAR",
      config: { calendarId: "fixture-calendar@example.test" },
      secret: "synthetic-service-account-secret",
      updatedById: null,
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.integrationJob.deleteMany({ where: { idempotencyKey: { in: bookingIds.flatMap((id) => [
      googleCalendarBookingJobKey(id), `${BOOKING_MAIL_JOB_KIND}:confirmed:${id}`,
    ]) } } });
    await db.bookingRequest.deleteMany({ where: { id: { in: bookingIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    await db.user.deleteMany({ where: { id: { in: actorIds } } });
    bookingIds.length = 0;
    customerIds.length = 0;
    actorIds.length = 0;
  });

  afterAll(async () => {
    await db.integrationSettings.deleteMany({ where: { provider: "GOOGLE_CALENDAR" } });
    if (originalIntegration) {
      await db.integrationSettings.create({ data: { ...originalIntegration, config: originalIntegration.config ?? {} } });
    }
    await db.$disconnect();
  });

  it("confirms only after creating the event and atomically queues the confirmation mail", async () => {
    const { booking, actor, job } = await fixture();
    mocks.ensure.mockResolvedValue({ eventId: "stable-event-id", created: true });

    await runGoogleCalendarBookingJob(job);

    await expect(db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }))
      .resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(db.googleCalendarBookingEvent.findUniqueOrThrow({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject({ calendarId: "fixture-calendar@example.test", status: "CREATED", lastFailureCode: null });
    await expect(db.bookingAuditEvent.findMany({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject([{ actorUserId: actor.id, fromState: "AWAITING_PAYMENT", toState: "CONFIRMED" }]);
    await expect(db.integrationJob.count({ where: { idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${booking.id}` } }))
      .resolves.toBe(1);
    expect(mocks.ensure).toHaveBeenCalledOnce();
  });

  it("keeps the payment and booking state when Google fails", async () => {
    const { booking, job } = await fixture();
    mocks.ensure.mockRejectedValue(new GoogleCalendarError("unavailable"));

    await expect(runGoogleCalendarBookingJob(job)).rejects.toMatchObject({ code: "unavailable" });

    await expect(db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }))
      .resolves.toMatchObject({ state: "AWAITING_PAYMENT" });
    await expect(db.payment.count({ where: { bookingRequestId: booking.id } })).resolves.toBe(1);
    await expect(db.bookingAuditEvent.count({ where: { bookingRequestId: booking.id, toState: "CONFIRMED" } }))
      .resolves.toBe(0);
    await expect(db.googleCalendarBookingEvent.findUniqueOrThrow({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject({ status: "PENDING", lastFailureCode: "unavailable" });
    await expect(db.integrationJob.count({ where: { idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${booking.id}` } }))
      .resolves.toBe(0);
  });

  it("deletes the Google event before cancelling a confirmed booking", async () => {
    const { booking, actor } = await fixture();
    const eventId = googleCalendarEventId(booking.id);
    await db.bookingRequest.update({ where: { id: booking.id }, data: { state: "CONFIRMED" } });
    await db.googleCalendarBookingEvent.create({
      data: { bookingRequestId: booking.id, calendarId: "fixture-calendar@example.test", eventId, status: "CREATED" },
    });
    mocks.remove.mockResolvedValue(undefined);

    await cancelBooking({ bookingRequestId: booking.id, actorUserId: actor.id, reason: "Synthetic cancellation" });

    expect(mocks.remove).toHaveBeenCalledWith(
      { calendarId: "fixture-calendar@example.test" },
      "synthetic-service-account-secret",
      eventId,
    );
    await expect(db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }))
      .resolves.toMatchObject({ state: "CANCELLED" });
    await expect(db.googleCalendarBookingEvent.findUniqueOrThrow({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject({ status: "DELETED", lastFailureCode: null });
  });

  it("preserves a confirmed booking when Google refuses event deletion", async () => {
    const { booking, actor } = await fixture();
    const eventId = googleCalendarEventId(booking.id);
    await db.bookingRequest.update({ where: { id: booking.id }, data: { state: "CONFIRMED" } });
    await db.googleCalendarBookingEvent.create({
      data: { bookingRequestId: booking.id, calendarId: "fixture-calendar@example.test", eventId, status: "CREATED" },
    });
    mocks.remove.mockRejectedValue(new GoogleCalendarError("unavailable"));

    await expect(cancelBooking({
      bookingRequestId: booking.id,
      actorUserId: actor.id,
      reason: "Synthetic cancellation",
    })).rejects.toMatchObject({ code: "unavailable" });

    await expect(db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }))
      .resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(db.googleCalendarBookingEvent.findUniqueOrThrow({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject({ status: "CREATED", lastFailureCode: "unavailable" });
    await expect(db.bookingAuditEvent.count({ where: { bookingRequestId: booking.id, toState: "CANCELLED" } }))
      .resolves.toBe(0);
  });

  it("requeues an exhausted job without changing its event identity or payment", async () => {
    const { booking } = await fixture();
    const eventId = googleCalendarEventId(booking.id);
    await db.googleCalendarBookingEvent.create({
      data: {
        bookingRequestId: booking.id,
        calendarId: "fixture-calendar@example.test",
        eventId,
        status: "PENDING",
        lastFailureCode: "unavailable",
      },
    });
    await db.integrationJob.update({
      where: { idempotencyKey: googleCalendarBookingJobKey(booking.id) },
      data: { status: "DEAD", lastError: "unavailable" },
    });

    await retryGoogleCalendarBookingSync(booking.id);

    await expect(db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: googleCalendarBookingJobKey(booking.id) } }))
      .resolves.toMatchObject({ status: "PENDING", lastError: null });
    await expect(db.googleCalendarBookingEvent.findUniqueOrThrow({ where: { bookingRequestId: booking.id } }))
      .resolves.toMatchObject({ eventId, status: "PENDING", lastFailureCode: null });
    await expect(db.payment.count({ where: { bookingRequestId: booking.id } })).resolves.toBe(1);
    await expect(db.integrationJob.count({ where: { idempotencyKey: googleCalendarBookingJobKey(booking.id) } })).resolves.toBe(1);
  });
});