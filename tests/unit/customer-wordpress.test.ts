// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { createWordpressClient, nativeWordpressTransport } from "@/modules/customers/wordpress";
import { delegateCommandSchema, wordpressConfigSchema } from "@/modules/customers/schema";

const config = wordpressConfigSchema.parse({ origin: "https://example.test", username: "service" });

describe("customer WordPress boundary", () => {
  let response: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
  let outgoing: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  let content: Buffer;
  beforeEach(() => {
    vi.clearAllMocks();
    content = Buffer.from("{}");
    response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: vi.fn() });
    outgoing = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    mocks.request.mockImplementation((_url, options, callback) => {
      outgoing.end.mockImplementation(() => options.lookup("example.test", {}, (error: Error | null) => {
        if (error) outgoing.emit("error", error);
        else { callback(response); response.emit("data", content); response.emit("end"); }
      }));
      return outgoing;
    });
  });
  it("defaults to preview without daily writes", () => {
    expect(config.writesEnabled).toBe(false);
    expect(config.automaticSync).toBe(false);
    expect(wordpressConfigSchema.safeParse({ ...config, origin: "https://example.test/private" }).success).toBe(false);
  });
  it("bounds requests and does not leak provider errors", async () => {
    expect(await nativeWordpressTransport(config, "test-only-password")("customers", "GET")).toEqual({});
    expect(mocks.request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    content = Buffer.from('{"message":"personal data"}'); response.statusCode = 403;
    await expect(nativeWordpressTransport(config, "test-only-password")("customers", "GET")).rejects.toThrow("wordpress_rejected");
  });
  it("rejects private DNS and ambiguous mutations without retries", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(nativeWordpressTransport(config, "test-only-password")("delegations", "POST", {})).rejects.toThrow("outcome_unknown");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("rejects redirects and oversized responses", async () => {
    response.statusCode = 302;
    await expect(nativeWordpressTransport(config, "test-only-password")("customers", "GET")).rejects.toThrow();
    response.statusCode = 200; content = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(nativeWordpressTransport(config, "test-only-password")("customers", "GET")).rejects.toThrow();
  });
  it("fails closed on repeated principals or incomplete pages", async () => {
    const item = { id: 1, holded_contact_id: "test", email: "", name: "", managed: true, meta: {} };
    const transport = vi.fn().mockResolvedValueOnce({ items: [item], page: 1, has_more: true }).mockResolvedValueOnce({ items: [item], page: 2, has_more: false });
    await expect(createWordpressClient(config, "", transport).listPrincipals()).rejects.toThrow("incomplete_snapshot");
  });
  it("requires profiles for invites and versions for lifecycle commands", () => {
    const base = { principal_id: 1, holded_contact_id: "a".repeat(24) };
    expect(delegateCommandSchema.safeParse({ ...base, action: "invite" }).success).toBe(false);
    expect(delegateCommandSchema.safeParse({ ...base, action: "revoke", delegate_id: 2 }).success).toBe(false);
    expect(delegateCommandSchema.safeParse({ ...base, action: "revoke", delegate_id: 2, generation: 1, expected_status: "active" }).success).toBe(true);
  });
  it("accepts the native invitation response with delegate_id without replay", async () => {
    const transport = vi.fn().mockResolvedValue({ delegate_id: 2, principal_id: 1, status: "pending", created: true });
    await expect(createWordpressClient(config, "", transport).mutateDelegate({ action: "invite" })).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledExactlyOnceWith("delegations", "POST", {});
  });
});