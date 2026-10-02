import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), save: vi.fn(), resolve: vi.fn(), verified: vi.fn(), fetch: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/modules/booking/authorization", () => {
  class AuthorizationError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") { super(code); }
  }
  return { AuthorizationError, requireBookingActor: mocks.actor };
});
vi.mock("@/modules/booking/services/settings", () => {
  class IntegrationSettingsError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return { IntegrationSettingsError, saveIntegrationSettings: mocks.save, resolveIntegration: mocks.resolve, markIntegrationVerified: mocks.verified, listIntegrationStatus: vi.fn(), normalizeTaxId: vi.fn(), readIntegrationConfig: vi.fn() };
});
vi.mock("@/modules/calendar/source", async (original) => ({ ...await original<typeof import("@/modules/calendar/source")>(), fetchCalendarSource: mocks.fetch }));

import { AuthorizationError } from "@/modules/booking/authorization";
import { saveCalendarSettings, testIntegration } from "@/modules/booking/actions/settings";
import { readCalendar } from "@/modules/calendar/services/calendar";
import { IntegrationSettingsError } from "@/modules/booking/services/settings";

const source = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";

describe("calendar integration actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.mockResolvedValue({ userId: "trusted-admin", role: "ADMINISTRATOR" });
    mocks.resolve.mockResolvedValue({ config: {}, secret: "https://example.test/feed.ics" });
    mocks.fetch.mockResolvedValue(source);
  });
  it.each(["unauthenticated", "forbidden"] as const)("rejects %s changes and connection tests", async (reason) => {
    mocks.actor.mockRejectedValue(new AuthorizationError(reason));
    expect(await saveCalendarSettings({ status: "idle" }, new FormData())).toEqual({ status: "error", reason });
    expect(await testIntegration("CALENDAR_ICS")).toEqual({ status: "error", reason });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("stores the URL only as an encrypted secret with server-derived identity", async () => {
    const data = new FormData();
    data.set("calendarUrl", "https://example.test/feed.ics?token=fixture");
    data.set("userId", "untrusted");
    expect(await saveCalendarSettings({ status: "idle" }, data)).toEqual({ status: "saved" });
    expect(mocks.actor).toHaveBeenCalledWith("ADMINISTRATOR");
    expect(mocks.save).toHaveBeenCalledWith({ provider: "CALENDAR_ICS", config: {}, secret: "https://example.test/feed.ics?token=fixture", updatedById: "trusted-admin" });
    expect(mocks.revalidate).toHaveBeenCalled();
  });
  it("rejects invalid source before persistence", async () => {
    const data = new FormData();
    data.set("calendarUrl", "https://127.0.0.1/feed");
    expect(await saveCalendarSettings({ status: "idle" }, data)).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("verifies only a successfully parsed source", async () => {
    expect(await testIntegration("CALENDAR_ICS")).toEqual({ status: "verified" });
    expect(mocks.verified).toHaveBeenCalledWith("CALENDAR_ICS");
    mocks.fetch.mockResolvedValue("not ICS");
    mocks.verified.mockClear();
    expect(await testIntegration("CALENDAR_ICS")).toEqual({ status: "error", reason: "connection" });
    expect(mocks.verified).not.toHaveBeenCalled();
  });
  it("returns a safe failure without exposing source errors", async () => {
    mocks.fetch.mockRejectedValue(new Error("private source details"));
    expect(await readCalendar(new Date("2026-10-01"), new Date("2026-11-01"))).toEqual({ status: "unavailable", entries: [] });
  });
  it("distinguishes an unconfigured source", async () => {
    mocks.resolve.mockRejectedValue(new IntegrationSettingsError("not_configured", "Not configured"));
    expect(await readCalendar(new Date("2026-10-01"), new Date("2026-11-01"))).toEqual({ status: "not_configured", entries: [] });
  });
});