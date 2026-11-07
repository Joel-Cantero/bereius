// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), retry: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/modules/booking/authorization", () => ({
  AuthorizationError: class extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") { super(code); }
  },
  requireBookingActor: mocks.actor,
}));
vi.mock("@/modules/calendar/services/booking-sync", () => ({
  retryGoogleCalendarBookingSync: mocks.retry,
}));

import { AuthorizationError } from "@/modules/booking/authorization";
import { retryGoogleCalendarBookingAction } from "@/modules/calendar/actions/booking-sync";

function form(bookingRequestId = "booking-1") {
  const data = new FormData();
  data.set("bookingRequestId", bookingRequestId);
  return data;
}

describe("Google Calendar booking retry action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.actor.mockResolvedValue({ userId: "trusted-operator", role: "OPERATOR" });
  });

  it("retries for the trusted operator and refreshes the booking detail", async () => {
    expect(await retryGoogleCalendarBookingAction({ status: "idle" }, form())).toEqual({ status: "done" });
    expect(mocks.retry).toHaveBeenCalledWith("booking-1");
    expect(mocks.revalidate).toHaveBeenCalledWith("/[locale]/(console)/bookings/[id]", "page");
  });

  it.each(["unauthenticated", "forbidden"] as const)("refuses %s callers", async (reason) => {
    mocks.actor.mockRejectedValue(new AuthorizationError(reason));
    expect(await retryGoogleCalendarBookingAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("rejects an invalid booking identifier before retrying", async () => {
    expect(await retryGoogleCalendarBookingAction({ status: "idle" }, form(""))).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});