// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireBookingActor: vi.fn(), approveBooking: vi.fn(), updateAdvance: vi.fn(), revalidatePath: vi.fn(), warn: vi.fn() }));
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
  updateAdvance: mocks.updateAdvance,
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
  updateAdvanceAction,
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

describe("advance update action", () => {
  function advanceForm(advance: string | null) {
    const data = new FormData();
    data.set("bookingRequestId", "booking-1");
    if (advance !== null) data.set("advance", advance);
    data.set("actorUserId", "forged-user");
    return data;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ userId: "operator-1", role: "OPERATOR" });
  });

  it("stores the euros entered as cents for the trusted actor", async () => {
    expect(await updateAdvanceAction({ status: "idle" }, advanceForm("250.10"))).toEqual({ status: "done" });
    expect(mocks.updateAdvance).toHaveBeenCalledWith({
      bookingRequestId: "booking-1",
      actorUserId: "operator-1",
      advanceCents: 25_010,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bookings/booking-1");
  });

  it.each([null, "", " ", "-1", "abc", "1000001"])("rejects the advance %j", async (advance) => {
    expect(await updateAdvanceAction({ status: "idle" }, advanceForm(advance))).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.updateAdvance).not.toHaveBeenCalled();
  });

  it("refuses unauthenticated callers", async () => {
    mocks.requireBookingActor.mockRejectedValue(new AuthorizationError("unauthenticated"));
    expect(await updateAdvanceAction({ status: "idle" }, advanceForm("100"))).toEqual({ status: "error", reason: "unauthenticated" });
    expect(mocks.updateAdvance).not.toHaveBeenCalled();
  });

  it("reports a booking that is no longer awaiting payment", async () => {
    mocks.updateAdvance.mockRejectedValue(new BookingTransitionError("state_changed", "paid"));
    expect(await updateAdvanceAction({ status: "idle" }, advanceForm("100"))).toEqual({ status: "error", reason: "state_changed" });
  });
});
