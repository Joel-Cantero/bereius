// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireBookingActor: vi.fn(), requestQuoteResend: vi.fn(), revalidatePath: vi.fn(), warn: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@/modules/booking/authorization", () => ({
  requireBookingActor: mocks.requireBookingActor,
  AuthorizationError: class extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") { super(code); }
  },
}));
vi.mock("@/modules/booking/services/quoting", () => ({
  requestQuoteResend: mocks.requestQuoteResend,
  QuoteResendError: class extends Error {
    constructor(readonly code: "busy" | "wrong_state" | "delivery_unknown") { super(code); }
  },
}));

import { AuthorizationError } from "@/modules/booking/authorization";
import { QuoteResendError } from "@/modules/booking/services/quoting";
import { resendQuoteAction } from "@/modules/booking/actions/quotes";

function form(bookingRequestId = "booking-1") {
  const data = new FormData();
  data.set("bookingRequestId", bookingRequestId);
  data.set("actorUserId", "forged-user");
  return data;
}

describe("quote resend action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ userId: "operator-1", role: "OPERATOR" });
  });

  it("uses the trusted actor, queues the job, and refreshes localized booking routes", async () => {
    expect(await resendQuoteAction({ status: "idle" }, form())).toEqual({ status: "done" });
    expect(mocks.requestQuoteResend).toHaveBeenCalledWith("booking-1", "operator-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/[locale]/(console)/bookings/[id]", "page");
  });

  it.each(["unauthenticated", "forbidden"] as const)("refuses %s callers", async (reason) => {
    mocks.requireBookingActor.mockRejectedValue(new AuthorizationError(reason));
    expect(await resendQuoteAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.requestQuoteResend).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(121)])("rejects an invalid booking identifier", async (id) => {
    expect(await resendQuoteAction({ status: "idle" }, form(id))).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.requestQuoteResend).not.toHaveBeenCalled();
  });

  it.each([
    ["busy", "quote_busy"], ["wrong_state", "state_changed"], ["delivery_unknown", "quote_delivery_unknown"],
  ] as const)("exposes a safe category for %s", async (code, reason) => {
    mocks.requestQuoteResend.mockRejectedValue(new QuoteResendError(code));
    expect(await resendQuoteAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not leak unexpected failures to the response or logger", async () => {
    mocks.requestQuoteResend.mockRejectedValue(new Error("private-provider-payload"));
    expect(await resendQuoteAction({ status: "idle" }, form())).toEqual({ status: "error", reason: "unknown" });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private-provider-payload");
  });
});