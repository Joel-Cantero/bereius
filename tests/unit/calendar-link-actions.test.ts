import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), link: vi.fn(), unlink: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/modules/booking/authorization", () => {
  class AuthorizationError extends Error { constructor(readonly code: "unauthenticated" | "forbidden") { super(code); } }
  return { AuthorizationError, requireBookingActor: mocks.actor };
});
vi.mock("@/modules/calendar/services/links", () => {
  class CalendarLinkError extends Error { constructor(readonly code: string) { super(code); } }
  return { CalendarLinkError, linkBookingCalendar: mocks.link, unlinkBookingCalendar: mocks.unlink };
});

import { AuthorizationError } from "@/modules/booking/authorization";
import { CalendarLinkError } from "@/modules/calendar/services/links";
import { linkBookingCalendarAction, unlinkBookingCalendarAction } from "@/modules/calendar/actions/links";

function data() {
  const form = new FormData();
  form.set("bookingRequestId", "booking-fixture");
  form.set("selection", `${"a".repeat(64)}:${"b".repeat(64)}`);
  form.set("confirmed", "yes");
  form.set("linkId", "link-fixture");
  form.set("actorUserId", "untrusted");
  return form;
}

describe("calendar link actions", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue({ userId: "trusted-operator", role: "OPERATOR" }); mocks.link.mockResolvedValue(undefined); mocks.unlink.mockResolvedValue(undefined); });
  it.each(["unauthenticated", "forbidden"] as const)("rejects %s before calling the domain", async (reason) => {
    mocks.actor.mockRejectedValue(new AuthorizationError(reason));
    expect(await linkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "error", reason });
    expect(await unlinkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "error", reason });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it("uses the trusted actor and refreshes all localized views", async () => {
    expect(await linkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "done" });
    expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "trusted-operator", bookingRequestId: "booking-fixture" }));
    expect(mocks.revalidate).toHaveBeenCalledWith("/ca/bookings/booking-fixture");
    expect(mocks.revalidate).toHaveBeenCalledWith("/es/calendar");
    expect(await unlinkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "done" });
    expect(mocks.unlink).toHaveBeenCalledWith({ actorUserId: "trusted-operator", bookingRequestId: "booking-fixture", linkId: "link-fixture" });
  });
  it.each(["confirmed", "selection", "bookingRequestId"])("requires validated %s", async (field) => {
    const form = data();
    form.delete(field);
    expect(await linkBookingCalendarAction({ status: "idle" }, form)).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it.each(["state_changed", "conflict", "unavailable", "not_configured"] as const)("returns a safe %s category", async (reason) => {
    mocks.link.mockRejectedValue(new CalendarLinkError(reason));
    expect(await linkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "error", reason });
  });
  it("does not expose database or provider errors", async () => {
    mocks.link.mockRejectedValue(new Error("credential and database details"));
    expect(await linkBookingCalendarAction({ status: "idle" }, data())).toEqual({ status: "error", reason: "unknown" });
  });
});