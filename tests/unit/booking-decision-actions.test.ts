// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireBookingActor: vi.fn(), approveBooking: vi.fn(), revalidatePath: vi.fn(), warn: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@/modules/booking/authorization", () => ({
  requireBookingActor: mocks.requireBookingActor,
  AuthorizationError: class extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") { super(code); }
  },
}));
vi.mock("@/modules/booking/services/decisions", () => ({
  approveBooking: mocks.approveBooking,
  cancelBooking: vi.fn(),
  recordPayment: vi.fn(),
  rejectBooking: vi.fn(),
  PaymentError: class extends Error {},
}));
vi.mock("@/modules/booking/services/lifecycle", () => ({
  BookingTransitionError: class extends Error {
    constructor(readonly code: "state_changed" | "reason_required") { super(code); }
  },
}));

import { AuthorizationError } from "@/modules/booking/authorization";
import { BookingTransitionError } from "@/modules/booking/services/lifecycle";
import {
  approveBookingAction,
  approveBookingWithoutEmailAction,
} from "@/modules/booking/actions/decisions";

function form(bookingRequestId = "booking-1") {
  const data = new FormData();
  data.set("bookingRequestId", bookingRequestId);
  data.set("expectedFrom", "IN_REVIEW");
  data.set("actorUserId", "forged-user");
  data.set("sendQuote", "true");
  return data;
}

describe("booking approval actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ userId: "operator-1", role: "OPERATOR" });
  });

  it.each([
    { action: approveBookingAction, sendQuote: true },
    { action: approveBookingWithoutEmailAction, sendQuote: false },
  ])("approves as the trusted actor with sendQuote $sendQuote", async ({ action, sendQuote }) => {
    expect(await action({ status: "idle" }, form())).toEqual({ status: "done" });
    expect(mocks.approveBooking).toHaveBeenCalledWith({
      bookingRequestId: "booking-1",
      expectedFrom: "IN_REVIEW",
      actorUserId: "operator-1",
      sendQuote,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bookings/booking-1");
  });

  it.each(["unauthenticated", "forbidden"] as const)("refuses %s callers", async (reason) => {
    mocks.requireBookingActor.mockRejectedValue(new AuthorizationError(reason));
    expect(await approveBookingWithoutEmailAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.approveBooking).not.toHaveBeenCalled();
  });

  it("rejects a missing booking identifier", async () => {
    expect(await approveBookingWithoutEmailAction({ status: "idle" }, form(""))).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.approveBooking).not.toHaveBeenCalled();
  });

  it("reports a decision taken from a stale screen", async () => {
    mocks.approveBooking.mockRejectedValue(new BookingTransitionError("state_changed", "stale screen"));
    expect(await approveBookingWithoutEmailAction({ status: "idle" }, form())).toEqual({ status: "error", reason: "state_changed" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
