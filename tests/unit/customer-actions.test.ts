// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), save: vi.fn(), run: vi.fn(), verify: vi.fn(), mutate: vi.fn(), attempt: vi.fn(), finish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/modules/booking/authorization", () => ({ requireBookingActor: mocks.actor, AuthorizationError: class extends Error {} }));
vi.mock("@/modules/booking/services/settings", () => ({ saveIntegrationSettings: mocks.save }));
vi.mock("@/modules/customers/services/management", () => ({ CustomerManagementError: class extends Error {}, runCustomerSync: mocks.run, verifyWordpressConnection: mocks.verify, mutateCustomerDelegate: mocks.mutate, reserveCustomerAdminAttempt: mocks.attempt, finishCustomerAdminAttempt: mocks.finish }));
import { saveWordpressSettings, synchronizeCustomersAction, manageDelegateAction } from "@/modules/customers/actions/management";
const idle = { status: "idle" } as const;

describe("administrator customer actions", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue({ userId: "trusted-admin", role: "ADMINISTRATOR" }); mocks.attempt.mockResolvedValue({ id: "event" }); mocks.finish.mockResolvedValue(undefined); });
  it("checks administrator authorization before touching providers", async () => {
    mocks.actor.mockRejectedValue(new Error("private authentication failure"));
    expect((await synchronizeCustomersAction(idle, new FormData())).status).toBe("error");
    expect(mocks.actor).toHaveBeenCalledWith("ADMINISTRATOR");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("stores passwords only server-side and returns no credential", async () => {
    const form = new FormData(); form.set("origin", "https://example.test"); form.set("username", "service"); form.set("password", "test-only-password");
    expect(await saveWordpressSettings(idle, form)).toEqual({ status: "saved" });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ provider: "WORDPRESS", updatedById: "trusted-admin", secret: "test-only-password", config: expect.objectContaining({ writesEnabled: false, automaticSync: false }) }));
  });
  it("rejects malformed configuration and missing delegate versions", async () => {
    expect(await saveWordpressSettings(idle, new FormData())).toEqual({ status: "error", reason: "invalid" });
    const form = new FormData(); form.set("principal_id", "1"); form.set("holded_contact_id", "a".repeat(24)); form.set("action", "revoke");
    expect(await manageDelegateAction(idle, form)).toEqual({ status: "error", reason: "invalid" });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("derives the run initiator from the trusted actor and sanitizes failure", async () => {
    const form = new FormData(); form.set("mode", "PREVIEW"); form.set("actorId", "untrusted");
    expect(await synchronizeCustomersAction(idle, form)).toEqual({ status: "completed" });
    expect(mocks.run).toHaveBeenCalledWith("PREVIEW", "trusted-admin");
    mocks.run.mockRejectedValue(new Error("test-only-password customer@example.test"));
    expect(await synchronizeCustomersAction(idle, form)).toEqual({ status: "error", reason: "connection" });
  });
});