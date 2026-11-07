// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  GoogleAuth: vi.fn(),
  calendar: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@googleapis/calendar", () => ({
  auth: { GoogleAuth: mocks.GoogleAuth },
  calendar: mocks.calendar,
}));

import {
  deleteGoogleCalendarEvent,
  ensureGoogleCalendarEvent,
  googleCalendarEventId,
  toGoogleCalendarEvent,
} from "@/modules/calendar/services/google-calendar";

const credential = JSON.stringify({
  type: "service_account",
  client_email: "calendar@example.test",
  private_key: "synthetic-test-key",
});

const reservation = {
  id: "booking-123",
  customerName: "Test Group",
  headcount: 30,
  boardType: "SELF_CATERING" as const,
  startDate: new Date("2026-12-06T00:00:00.000Z"),
  endDate: new Date("2026-12-08T00:00:00.000Z"),
};

function missingEvent() {
  return Object.assign(new Error("not found"), { response: { status: 404 } });
}

describe("Google Calendar booking events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.GoogleAuth.mockImplementation(function GoogleAuth() { return {}; });
    mocks.calendar.mockReturnValue({ events: {
      list: mocks.list,
      get: mocks.get,
      insert: mocks.insert,
      delete: mocks.delete,
    } });
    mocks.list.mockResolvedValue({ data: { accessRole: "writer" } });
  });

  it("generates a deterministic Google-valid event id", () => {
    const first = googleCalendarEventId(reservation.id);
    expect(googleCalendarEventId(reservation.id)).toBe(first);
    expect(googleCalendarEventId("booking-456")).not.toBe(first);
    expect(first).toMatch(/^[0-9a-v]{5,1024}$/u);
  });

  it("maps the booking to an all-day event with an exclusive checkout date", () => {
    expect(toGoogleCalendarEvent(reservation)).toEqual({
      id: googleCalendarEventId(reservation.id),
      summary: "Test Group",
      description: "30 personas\nRégimen: Derecho a cocina",
      start: { date: "2026-12-06" },
      end: { date: "2026-12-08" },
    });
  });

  it("inserts once after confirming writer access and an absent stable id", async () => {
    mocks.get.mockRejectedValue(missingEvent());
    mocks.insert.mockResolvedValue({ data: { id: googleCalendarEventId(reservation.id) } });

    await expect(ensureGoogleCalendarEvent(
      { calendarId: "calendar@example.test" }, credential, reservation,
    )).resolves.toMatchObject({ eventId: googleCalendarEventId(reservation.id) });

    expect(mocks.list).toHaveBeenCalledWith(
      { calendarId: "calendar@example.test", maxResults: 1 },
      { timeout: 10_000 },
    );
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: "calendar@example.test",
      requestBody: toGoogleCalendarEvent(reservation),
    }), expect.anything());
  });

  it("reconciles an event already created after an uncertain insert response", async () => {
    const event = toGoogleCalendarEvent(reservation);
    mocks.get.mockResolvedValue({ data: event });

    await expect(ensureGoogleCalendarEvent(
      { calendarId: "calendar@example.test" }, credential, reservation,
    )).resolves.toMatchObject({ eventId: event.id });

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses an existing event whose contents do not match this reservation", async () => {
    mocks.get.mockResolvedValue({ data: { ...toGoogleCalendarEvent(reservation), summary: "Other booking" } });

    await expect(ensureGoogleCalendarEvent(
      { calendarId: "calendar@example.test" }, credential, reservation,
    )).rejects.toMatchObject({ code: "event_conflict" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("deletes only after verifying write access to the snapshotted calendar", async () => {
    await expect(deleteGoogleCalendarEvent(
      { calendarId: "old-calendar@example.test" }, credential, googleCalendarEventId(reservation.id),
    )).resolves.toBeUndefined();

    expect(mocks.list).toHaveBeenCalledWith(
      { calendarId: "old-calendar@example.test", maxResults: 1 },
      { timeout: 10_000 },
    );
    expect(mocks.delete).toHaveBeenCalledWith({
      calendarId: "old-calendar@example.test",
      eventId: googleCalendarEventId(reservation.id),
    }, expect.anything());
  });

  it("treats a missing event as deleted only after destination access is verified", async () => {
    mocks.delete.mockRejectedValue(missingEvent());
    await expect(deleteGoogleCalendarEvent(
      { calendarId: "calendar@example.test" }, credential, googleCalendarEventId(reservation.id),
    )).resolves.toBeUndefined();
    expect(mocks.list).toHaveBeenCalledOnce();
  });
});