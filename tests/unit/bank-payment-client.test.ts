// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { createHoldedClient, HoldedMutationError } from "@/lib/holded/client";
import { receivedInvoiceAmounts } from "@/modules/banking/services/payment-operation";
import { isBookingPaymentCandidate } from "@/modules/banking/services/payment-matching";
import { createHttpMailProvider } from "../helpers/http-mail-provider";

const invoiceId = "a".repeat(24);
const estimateId = "b".repeat(24);
const accountId = "c".repeat(24);
const collectionId = "d".repeat(24);
const date = new Date("2026-10-25T00:00:00Z");

describe("received reserve invoice amounts", () => {
  it.each([76_736, 98_000, 102_000, 20_001])("invoices exactly the received %i cents", (amount) => {
    const result = receivedInvoiceAmounts(amount);
    expect(result.depositCents).toBe(20_000);
    expect(result.advanceCents + result.depositCents).toBe(amount);
  });
  it.each([0, -1, 19_999, 20_000, 20_000.1, NaN, 2_147_483_648])("refuses invalid invoice amount %s", (amount) => {
    expect(() => receivedInvoiceAmounts(amount)).toThrow("amount_mismatch");
  });
});

describe("inclusive 5% payment candidates", () => {
  const booking = {
    state: "AWAITING_PAYMENT", decidedAt: date, advanceCents: 80_000, depositCents: 20_000,
    documents: [{ issuedAt: date, documentNumber: "E-1" }],
  };
  it.each([[95_000, true], [105_000, true], [94_999, false], [105_001, false]])(
    "checks actual %i against the expected amount base", (amount, expected) => {
      expect(isBookingPaymentCandidate({
        direction: "INCOME", amountMinor: BigInt(amount), currency: "EUR", bookingDate: date, narrative: null,
      }, booking)).toBe(expected);
    },
  );
});

describe("public Holded payment mutations", () => {
  it("converts to a linked draft without approving the original stay lines", async () => {
    const http = createHttpMailProvider([{ status: 201, body: JSON.stringify({ id: invoiceId }) }]);
    const client = createHoldedClient("synthetic-key", http.client, "banking.payment");
    await expect(client.convertEstimateToInvoice({ estimateId, date, numberingSeriesId: accountId })).resolves.toEqual({ id: invoiceId });
    expect(JSON.parse(http.requests[0].body!)).toEqual({
      source_type: "estimate", source_id: estimateId, target_type: "invoice",
      date: "2026-10-25", due_date: "2026-10-25", number_line_id: accountId, draft: true,
    });
    expect(http.requests[0].logicalUrl.endsWith("/documents/convert")).toBe(true);
  });

  it("replaces draft lines with tax-inclusive received advance and non-subject deposit", async () => {
    const http = createHttpMailProvider([{ status: 200, body: "{}" }]);
    await createHoldedClient("synthetic", http.client).configureReserveInvoice(invoiceId, {
      contactId: estimateId, date, dueDate: date, description: "Synthetic stay", notes: "",
      language: "ca", items: [
        { name: "Bestreta", units: 1, price: 567.36, taxes: ["s_iva_10"] },
        { name: "Deposit", units: 1, price: 200, taxes: ["s_iva_nosujeto"] },
      ],
    });
    expect(http.requests[0].method).toBe("PUT");
    expect(JSON.parse(http.requests[0].body!)).toMatchObject({
      tax_included: true, discount: 0,
      items: [{ price: 567.36, taxes: ["s_iva_10"] }, { price: 200, taxes: ["s_iva_nosujeto"] }],
    });
  });

  it("accepts empty payment responses and reconciles the real movement to its collection", async () => {
    const http = createHttpMailProvider([{ status: 201 }, { status: 200, body: "{}" }]);
    const client = createHoldedClient("synthetic", http.client, "banking.payment");
    await client.registerInvoicePayment(invoiceId, { amountCents: 76_736, accountId, date });
    await client.reconcileBankPayment({ accountId, movementId: estimateId, collectionId });
    expect(JSON.parse(http.requests[0].body!)).toEqual({ amount: "767.36", treasury_id: accountId, date: "2026-10-25" });
    expect(JSON.parse(http.requests[1].body!)).toEqual({ documents: [{ document_id: collectionId, document_type: "collection" }] });
    expect(http.requests[1].logicalUrl.endsWith(`/treasury/accounts/${accountId}/bank-movements/${estimateId}/reconcile`)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422, 429])("classifies HTTP %i as definitive rejection", async (status) => {
    const http = createHttpMailProvider([{ status, body: "{}" }]);
    await expect(createHoldedClient("synthetic", http.client).registerInvoicePayment(invoiceId, {
      amountCents: 76_736, accountId, date,
    })).rejects.toMatchObject({ outcome: "definitive_failure" });
  });

  it.each([{ status: 500, body: "{}" }, { error: new Error("private-network-message") }, { status: 200, body: "bad-json" }])(
    "parks ambiguous payment responses", async (behavior) => {
      const http = createHttpMailProvider([behavior]);
      await expect(createHoldedClient("synthetic", http.client).registerInvoicePayment(invoiceId, {
        amountCents: 76_736, accountId, date,
      })).rejects.toBeInstanceOf(HoldedMutationError);
    },
  );

  it("validates source and exact payment evidence", async () => {
    const http = createHttpMailProvider([{ body: JSON.stringify({
      from: { id: estimateId, doc_type: "estimate" }, draft: false,
      payments_total: "767.36", payments_pending: "0", payments_detail: [
        { id: collectionId, amount: "767.36", date: "2026-10-25", bank_id: accountId },
      ],
    }) }]);
    await expect(createHoldedClient("synthetic", http.client).getInvoiceEvidence(invoiceId)).resolves.toEqual({
      source: { id: estimateId, doc_type: "estimate" }, draft: false, paidCents: 76_736, pendingCents: 0,
      payments: [{ id: collectionId, amountCents: 76_736, date: "2026-10-25", bankId: accountId }],
    });
  });
});
