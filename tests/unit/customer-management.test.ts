// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }, runs: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() }, events: { count: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() }, lock: vi.fn(), transaction: vi.fn(), resolve: vi.fn(), contacts: vi.fn(), principals: vi.fn(), save: vi.fn(), delegates: vi.fn(), mutate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { integrationSettings: mocks.settings, customerSyncRun: mocks.runs, customerAdminEvent: mocks.events, $transaction: mocks.transaction } }));
vi.mock("@/lib/holded/client", () => ({ createHoldedClient: () => ({ listFiscalContacts: mocks.contacts }) }));
vi.mock("@/modules/booking/services/settings", () => ({ resolveIntegration: mocks.resolve }));
vi.mock("@/modules/customers/wordpress", () => ({ createWordpressClient: () => ({ listPrincipals: mocks.principals, savePrincipal: mocks.save, getDelegates: mocks.delegates, mutateDelegate: mocks.mutate }), WordpressError: class extends Error { constructor(readonly code: string) { super(code); } } }));
import { runCustomerSync, runAutomaticCustomerSync, verifyWordpressConnection, mutateCustomerDelegate, reserveCustomerAdminAttempt, retainCustomerHistory, customerRunHistory } from "@/modules/customers/services/management";
import { WordpressError } from "@/modules/customers/wordpress";
import { fiscalPayload } from "@/modules/customers/reconciliation";

const contact = { id: "a".repeat(24), name: "Private customer", email: "private@example.test", phone: "600000000", is_person: false, type: "client" as const };
const config = { origin: "https://example.test", username: "service", writesEnabled: true, automaticSync: true };
let rows: { provider: string; updatedAt: Date; verifiedAt: Date | null; config: object }[];

beforeEach(() => {
  vi.resetAllMocks();
  rows = ["WORDPRESS", "HOLDED"].map((provider) => ({ provider, updatedAt: new Date("2026-10-08T00:00:00Z"), verifiedAt: new Date(), config: { ...config } }));
  mocks.settings.findMany.mockImplementation(async () => rows);
  mocks.settings.findUnique.mockResolvedValue({ config, updatedAt: rows[0].updatedAt });
  mocks.settings.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (callback) => typeof callback === "function" ? callback({ customerSyncRun: mocks.runs, customerAdminEvent: mocks.events, $executeRaw: mocks.lock }) : Promise.all(callback));
  mocks.runs.findFirst.mockImplementation(async (input) => input.where.mode === "PREVIEW" ? { id: "preview" } : null);
  mocks.runs.create.mockResolvedValue({ id: "run", leaseToken: "test-token" });
  mocks.runs.updateMany.mockResolvedValue({ count: 1 });
  mocks.resolve.mockResolvedValue({ config, secret: "test-only-secret" });
  mocks.contacts.mockResolvedValue([contact]); mocks.principals.mockResolvedValue([]);
  mocks.save.mockImplementation(async (payload) => ({ ...payload, id: 1, managed: true }));
  mocks.events.count.mockResolvedValue(0); mocks.events.create.mockResolvedValue({ id: "event" }); mocks.events.update.mockResolvedValue({});
  mocks.delegates.mockResolvedValue([]);
});

describe("customer management orchestration", () => {
  it("performs zero writes during preview and stores only technical results", async () => {
    expect(await runCustomerSync("PREVIEW", "admin")).toBe("run");
    expect(mocks.save).not.toHaveBeenCalled();
    const completion = mocks.runs.updateMany.mock.calls.find(([input]) => input.data.status === "SUCCEEDED")![0];
    expect(completion.data.results).toEqual([{ contactId: contact.id, kind: "create" }]);
    expect(JSON.stringify(completion)).not.toContain(contact.email);
    expect(JSON.stringify(completion)).not.toContain(contact.name);
  });
  it("writes sequentially and verifies canonical readback", async () => {
    expect(await runCustomerSync("APPLY", "admin")).toBe("run");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(fiscalPayload(contact));
    mocks.save.mockResolvedValue({ ...fiscalPayload(contact), id: 2, managed: false });
    await expect(runCustomerSync("APPLY", "admin")).rejects.toThrow("readback_mismatch");
  });
  it("requires a verified write-enabled connection and matching preview", async () => {
    rows[0].verifiedAt = null;
    await expect(runCustomerSync("APPLY", "admin")).rejects.toThrow("writes_disabled");
    rows[0].verifiedAt = new Date(); mocks.runs.findFirst.mockResolvedValue(null);
    await expect(runCustomerSync("APPLY", "admin")).rejects.toThrow("preview_required");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects configuration changes before any writes", async () => {
    mocks.principals.mockImplementation(async () => { rows[0].updatedAt = new Date(); return []; });
    await expect(runCustomerSync("APPLY", "admin")).rejects.toThrow("settings_changed");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete provider reads and lost leases", async () => {
    mocks.contacts.mockRejectedValueOnce(new Error("private provider payload"));
    await expect(runCustomerSync("PREVIEW", "admin")).rejects.toThrow("provider_unavailable");
    expect(mocks.principals).not.toHaveBeenCalled();
    mocks.runs.updateMany.mockResolvedValue({ count: 0 });
    await expect(runCustomerSync("PREVIEW", "admin")).rejects.toThrow("lease_lost");
  });
  it("enforces the per-run write limit", async () => {
    mocks.contacts.mockResolvedValue(Array.from({ length: 101 }, (_unused, index) => ({ ...contact, id: index.toString(16).padStart(24, "0"), email: `customer${index}@example.test` })));
    await expect(runCustomerSync("APPLY", "admin")).rejects.toThrow("batch_limit");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("keeps automatic synchronization opt-in and rate limited to once per day", async () => {
    mocks.settings.findUnique.mockResolvedValueOnce(null);
    expect(await runAutomaticCustomerSync()).toEqual({ processed: false });
    mocks.runs.findFirst.mockImplementation(async (input) => input.where.mode ? { id: "previous" } : null);
    expect(await runAutomaticCustomerSync()).toEqual({ processed: false, runId: null });
    expect(mocks.save).not.toHaveBeenCalled();
    rows[0].config = { ...config, automaticSync: false };
    expect(await runCustomerSync("APPLY", null, true)).toBeNull();
  });
  it("records delegate outcomes without profiles and never replays ambiguous email", async () => {
    const command = { principal_id: 1, holded_contact_id: contact.id, action: "invite", first_name: "Test", last_name: "Delegate", email: "delegate@example.test", phone: "600000000" };
    await mutateCustomerDelegate("admin", command);
    expect(mocks.events.create).toHaveBeenCalledWith({ data: { actorId: "admin", operation: "invite", principalId: 1, delegateId: undefined, outcome: "attempted" } });
    mocks.mutate.mockRejectedValue(new WordpressError("outcome_unknown"));
    await expect(mutateCustomerDelegate("admin", command)).rejects.toThrow("outcome_unknown");
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.events.update).toHaveBeenLastCalledWith({ where: { id: "event" }, data: { outcome: "outcome_unknown" } });
  });
  it("enforces administrator mutation rate limits", async () => {
    mocks.events.count.mockResolvedValue(20);
    await expect(reserveCustomerAdminAttempt("admin", "configure")).rejects.toThrow("rate_limited");
    expect(mocks.events.create).not.toHaveBeenCalled();
  });
  it("verifies the live connection and bounds history and retention", async () => {
    await verifyWordpressConnection();
    expect(mocks.settings.updateMany).toHaveBeenCalledWith({ where: { provider: "WORDPRESS", updatedAt: rows[0].updatedAt }, data: { verifiedAt: expect.any(Date) } });
    await customerRunHistory();
    expect(mocks.runs.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
    await retainCustomerHistory();
    expect(mocks.runs.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { not: "RUNNING" } }) }));
    expect(mocks.events.deleteMany).toHaveBeenCalledOnce();
  });
  it("does not verify settings changed during the remote request", async () => {
    mocks.settings.updateMany.mockResolvedValue({ count: 0 });
    await expect(verifyWordpressConnection()).rejects.toThrow("settings_changed");
    expect(mocks.settings.findUnique.mock.invocationCallOrder[0]).toBeLessThan(mocks.principals.mock.invocationCallOrder[0]);
  });
});