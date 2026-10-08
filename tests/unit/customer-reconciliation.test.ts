import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHoldedClient, type HoldedFiscalContact } from "@/lib/holded/client";
import { fiscalPayload, reconcileCustomers } from "@/modules/customers/reconciliation";
import type { Principal } from "@/modules/customers/schema";

const contact: HoldedFiscalContact = { id: "a".repeat(24), name: "Fiscal customer", email: "customer@example.test", is_person: false, type: "client" };
const principal: Principal = { ...fiscalPayload(contact), id: 1, managed: true };

describe("deterministic customer reconciliation", () => {
  it("proposes creations, compares canonical fields and leaves unchanged records alone", () => {
    expect(reconcileCustomers([contact], [])[0].kind).toBe("create");
    expect(reconcileCustomers([contact], [principal])[0].kind).toBe("unchanged");
    expect(reconcileCustomers([{ ...contact, phone: "600abc000" }], [principal])[0].kind).toBe("update");
    expect(fiscalPayload({ ...contact, phone: "600abc000", name: " Fiscal\ncustomer " }).meta.billing_phone).toBe("600000");
  });
  it("does not select an arbitrary duplicate ID or email winner", () => {
    expect(reconcileCustomers([contact, contact], [])[0].reason).toBe("duplicate_identity");
    const changes = reconcileCustomers([contact, { ...contact, id: "b".repeat(24) }], []);
    expect(changes.every((change) => change.kind === "conflict" && !change.payload)).toBe(true);
  });
  it("does not adopt unmanaged accounts or overwrite email owners", () => {
    expect(reconcileCustomers([contact], [{ ...principal, managed: false }])[0].reason).toBe("unmanaged_account");
    expect(reconcileCustomers([contact], [{ ...principal, holded_contact_id: "b".repeat(24) }])[0].reason).toBe("email_collision");
  });
  it("excludes people, missing flags and empty emails while reporting only genuinely absent IDs", () => {
    expect(reconcileCustomers([{ ...contact, is_person: true }], [principal])).toEqual([]);
    expect(reconcileCustomers([{ ...contact, is_person: undefined }], [principal])).toEqual([]);
    expect(reconcileCustomers([{ ...contact, email: "" }], [principal])).toEqual([]);
    expect(reconcileCustomers([], [principal])[0].kind).toBe("orphan_review");
  });
  it("reads a complete bounded Holded snapshot and rejects cursor cycles", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [contact], has_more: true, cursor: "next" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], has_more: false })));
    expect(await createHoldedClient("test-only-key", http).listFiscalContacts()).toEqual([contact]);
    http.mockImplementation(async () => new Response(JSON.stringify({ items: [contact], has_more: true, cursor: "cycle" })));
    await expect(createHoldedClient("test-only-key", http).listFiscalContacts()).rejects.toThrow("Invalid fiscal contact cursor");
  });
});