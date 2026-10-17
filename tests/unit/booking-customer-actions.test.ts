// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  requireBookingActor: vi.fn(),
  findBookingCustomerCandidate: vi.fn(),
  changeBookingCustomer: vi.fn(),
  revalidatePath: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => {
  const logger = { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
vi.mock("@/modules/booking/authorization", () => ({
  requireBookingActor: mocks.requireBookingActor,
  AuthorizationError: class extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") { super(code); }
  },
}));
vi.mock("@/modules/booking/services/contact-sync", () => ({
  findBookingCustomerCandidate: mocks.findBookingCustomerCandidate,
  changeBookingCustomer: mocks.changeBookingCustomer,
  createCustomerContact: vi.fn(),
  linkExistingEstimate: vi.fn(),
  updateCustomerContact: vi.fn(),
  ContactSyncError: class extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));

import { AuthorizationError } from "@/modules/booking/authorization";
import { ContactSyncError } from "@/modules/booking/services/contact-sync";
import { changeCustomerAction, findCustomerAction } from "@/modules/booking/actions/contact";

const CANDIDATE = {
  taxId: "B12345678",
  name: "Another organisation",
  email: "other@example.test",
  source: "booking" as const,
  current: false,
};

function form(taxId = "B12345678", bookingRequestId = "booking-1") {
  const data = new FormData();
  data.set("bookingRequestId", bookingRequestId);
  data.set("taxId", taxId);
  data.set("actorUserId", "forged-user");
  return data;
}

describe("booking customer actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ userId: "operator-1", role: "OPERATOR" });
    mocks.findBookingCustomerCandidate.mockResolvedValue(CANDIDATE);
  });

  it("previews the customer a tax identifier belongs to", async () => {
    expect(await findCustomerAction({ status: "idle" }, form(" B12345678 "))).toEqual({
      status: "found",
      ...CANDIDATE,
    });
    expect(mocks.findBookingCustomerCandidate).toHaveBeenCalledWith("booking-1", "B12345678");
    expect(mocks.changeBookingCustomer).not.toHaveBeenCalled();
  });

  it("reassigns as the trusted actor and refreshes localized booking routes", async () => {
    expect(await changeCustomerAction({ status: "idle" }, form())).toEqual({ status: "done" });
    expect(mocks.changeBookingCustomer).toHaveBeenCalledWith("booking-1", "B12345678", "operator-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/[locale]/(console)/bookings/[id]", "page");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/[locale]/(console)/bookings", "page");
  });

  it.each(["unauthenticated", "forbidden"] as const)("refuses %s callers", async (reason) => {
    mocks.requireBookingActor.mockRejectedValue(new AuthorizationError(reason));
    expect(await findCustomerAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(await changeCustomerAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.findBookingCustomerCandidate).not.toHaveBeenCalled();
    expect(mocks.changeBookingCustomer).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "X".repeat(33)])("rejects an unusable tax identifier", async (taxId) => {
    expect(await findCustomerAction({ status: "idle" }, form(taxId))).toEqual({ status: "error", reason: "invalid" });
    expect(await changeCustomerAction({ status: "idle" }, form(taxId))).toEqual({ status: "error", reason: "invalid" });
  });

  it.each([
    ["customer_not_found", "customer_not_found"],
    ["customer_without_email", "customer_without_email"],
    ["customer_locked", "state_changed"],
  ])("exposes a safe category for %s", async (code, reason) => {
    mocks.findBookingCustomerCandidate.mockRejectedValue(new ContactSyncError(code as never));
    mocks.changeBookingCustomer.mockRejectedValue(new ContactSyncError(code as never));
    expect(await findCustomerAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(await changeCustomerAction({ status: "idle" }, form())).toEqual({ status: "error", reason });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not leak unexpected failures to the response or logger", async () => {
    mocks.changeBookingCustomer.mockRejectedValue(new Error("private-provider-payload"));
    expect(await changeCustomerAction({ status: "idle" }, form())).toEqual({ status: "error", reason: "unknown" });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private-provider-payload");
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("B12345678");
  });
});
