import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/modules/calendar/services/calendar", () => ({ readCalendar: mocks.read }));

import { db } from "@/lib/db";
import { saveIntegrationSettings } from "@/modules/booking/services/settings";
import { calendarEventKey, calendarSelection, calendarSourceKey } from "@/modules/calendar/services/identity";
import { getBookingCalendar, linkBookingCalendar, readCalendarWithBookings, unlinkBookingCalendar } from "@/modules/calendar/services/links";
import type { CalendarEntry } from "@/modules/calendar/ical";

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== "true")("calendar booking links", () => {
  const source = "https://calendar-link-fixture.example.test/feed.ics";
  const sourceKey = calendarSourceKey(source);
  const customers: string[] = [];
  const users: string[] = [];
  const entry: CalendarEntry = { id: "fixture:2026-10-02", uid: "calendar-link-fixture", occurrenceId: "", title: "Fixture group", start: "2026-10-02", end: "2026-10-05", allDay: true };
  let original: Awaited<ReturnType<typeof db.integrationSettings.findUnique>>;

  beforeAll(async () => { original = await db.integrationSettings.findUnique({ where: { provider: "CALENDAR_ICS" } }); });
  beforeEach(async () => {
    await saveIntegrationSettings({ provider: "CALENDAR_ICS", config: {}, secret: source, updatedById: null });
    mocks.read.mockResolvedValue({ status: "ok", sourceKey, entries: [{ ...entry }] });
  });
  afterEach(async () => {
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customers } } });
    await db.customer.deleteMany({ where: { id: { in: customers } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    customers.length = 0;
    users.length = 0;
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await db.integrationSettings.deleteMany({ where: { provider: "CALENDAR_ICS" } });
    if (original) await db.integrationSettings.create({ data: { ...original, config: original.config ?? {} } });
    await db.$disconnect();
  });

  async function fixture(state: "CONFIRMED" | "AWAITING_PAYMENT" = "CONFIRMED") {
    const suffix = randomUUID();
    const user = await db.user.create({ data: { email: `${suffix}@example.test`, normalizedEmail: `${suffix}@example.test`, name: "Fixture operator" } });
    users.push(user.id);
    const customer = await db.customer.create({ data: { taxId: suffix, name: "Fixture group", email: `${suffix}@example.test` } });
    customers.push(customer.id);
    const booking = await db.bookingRequest.create({ data: { customerId: customer.id, gravityEntryId: suffix, state, boardType: "SELF_CATERING", startDate: new Date(entry.start), endDate: new Date(entry.end), headcount: 40, submittedAt: new Date() } });
    return { booking, actorUserId: user.id, bookingRequestId: booking.id, selection: calendarSelection(sourceKey, entry)! };
  }

  it("links and unlinks atomically with actor audit, without changing booking/payment state", async () => {
    const input = await fixture();
    await linkBookingCalendar(input);
    const view = await getBookingCalendar(input.booking.id);
    expect(view?.link).toMatchObject({ title: entry.title, review: null });
    expect(view?.history[0]).toMatchObject({ action: "LINKED", actor: "Fixture operator" });
    await unlinkBookingCalendar({ ...input, linkId: view!.link!.id });
    expect((await getBookingCalendar(input.booking.id))?.link).toBeNull();
    expect(await db.calendarBookingAuditEvent.findMany({ where: { bookingRequestId: input.booking.id }, orderBy: { createdAt: "asc" } })).toMatchObject([{ action: "LINKED", actorUserId: input.actorUserId }, { action: "UNLINKED", actorUserId: input.actorUserId }]);
    expect(await db.bookingRequest.findUnique({ where: { id: input.booking.id } })).toMatchObject({ state: "CONFIRMED" });
    expect(await db.payment.count({ where: { bookingRequestId: input.booking.id } })).toBe(0);
  });
  it("allows only one concurrent owner of an original event", async () => {
    const first = await fixture();
    const second = await fixture();
    const results = await Promise.allSettled([linkBookingCalendar(first), linkBookingCalendar(second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(await db.calendarBookingLink.count({ where: { sourceKey, eventKey: calendarEventKey(entry)! } })).toBe(1);
    expect(await db.calendarBookingAuditEvent.count({ where: { bookingRequestId: { in: [first.booking.id, second.booking.id] } } })).toBe(1);
    const unlinked = await getBookingCalendar((await db.calendarBookingLink.findUniqueOrThrow({ where: { sourceKey_eventKey: { sourceKey, eventKey: calendarEventKey(entry)! } } })).bookingRequestId === first.booking.id ? second.booking.id : first.booking.id);
    expect(unlinked?.candidates).toEqual([]);
  });
  it("rejects unpaid requests before reading the feed", async () => {
    const input = await fixture("AWAITING_PAYMENT");
    await expect(linkBookingCalendar(input)).rejects.toMatchObject({ code: "state_changed" });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects a changed source or modified event after selection", async () => {
    const input = await fixture();
    mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey: calendarSourceKey(`${source}?new=1`), entries: [entry] });
    await expect(linkBookingCalendar(input)).rejects.toMatchObject({ code: "state_changed" });
    mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey, entries: [{ ...entry, end: "2026-10-06" }] });
    await expect(linkBookingCalendar(input)).rejects.toMatchObject({ code: "state_changed" });
  });
  it("rechecks booking state and source after fetching, before writing", async () => {
    const input = await fixture();
    mocks.read.mockImplementationOnce(async () => {
      await db.bookingRequest.update({ where: { id: input.booking.id }, data: { state: "CANCELLED" } });
      return { status: "ok", sourceKey, entries: [entry] };
    });
    await expect(linkBookingCalendar(input)).rejects.toMatchObject({ code: "state_changed" });
    await db.bookingRequest.update({ where: { id: input.booking.id }, data: { state: "CONFIRMED" } });
    mocks.read.mockImplementationOnce(async () => {
      await saveIntegrationSettings({ provider: "CALENDAR_ICS", config: {}, secret: `${source}?changed=1`, updatedById: null });
      return { status: "ok", sourceKey, entries: [entry] };
    });
    await expect(linkBookingCalendar(input)).rejects.toMatchObject({ code: "state_changed" });
    expect(await db.calendarBookingLink.count({ where: { bookingRequestId: input.booking.id } })).toBe(0);
  });
  it("flags moved, renamed, missing and replaced events; failures remain unverified", async () => {
    const input = await fixture();
    await linkBookingCalendar(input);
    for (const replacement of [{ ...entry, start: "2026-10-03" }, { ...entry, title: "New name" }]) {
      mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey, entries: [replacement] });
      expect((await getBookingCalendar(input.booking.id))?.link?.review).toBe("changed");
    }
    mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey, entries: [] });
    expect((await getBookingCalendar(input.booking.id))?.link?.review).toBe("missing");
    mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey: "b".repeat(64), entries: [entry] });
    expect((await getBookingCalendar(input.booking.id))?.link?.review).toBe("source_changed");
    mocks.read.mockResolvedValueOnce({ status: "unavailable", entries: [] });
    expect((await getBookingCalendar(input.booking.id))?.link?.review).toBe("unverified");
    expect(await db.calendarBookingLink.count({ where: { bookingRequestId: input.booking.id } })).toBe(1);
  });
  it("enriches live events and keeps missing links as review markers", async () => {
    const input = await fixture();
    await linkBookingCalendar(input);
    const calendar = await readCalendarWithBookings(new Date("2026-10-01"), new Date("2026-11-01"));
    expect(calendar.entries[0].bookings).toEqual([{ id: input.booking.id, label: "Fixture group", needsReview: false }]);
    mocks.read.mockResolvedValueOnce({ status: "ok", sourceKey, entries: [] });
    expect((await readCalendarWithBookings(new Date("2026-10-01"), new Date("2026-11-01"))).entries[0].bookings?.[0].needsReview).toBe(true);
  });
  it("rejects stale unlinking without deleting a replacement link", async () => {
    const input = await fixture();
    await linkBookingCalendar(input);
    await expect(unlinkBookingCalendar({ ...input, linkId: "stale" })).rejects.toMatchObject({ code: "state_changed" });
    expect(await db.calendarBookingLink.count({ where: { bookingRequestId: input.booking.id } })).toBe(1);
  });
});