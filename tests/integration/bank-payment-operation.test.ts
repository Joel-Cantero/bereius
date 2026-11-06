// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import { HoldedDeliveryError, HoldedMutationError, type HoldedInvoiceSummary } from "@/lib/holded/client";
import { beginBankPayment, runBankPaymentJob, BANK_PAYMENT_JOB_KIND, recoverInterruptedBankPayments, type BankPaymentClient } from "@/modules/banking/services/payment-operation";
import { listMovementBookingCandidates } from "@/modules/banking/services/queries";
import { reconcileBankMovements } from "@/modules/banking/services/reconciliation";
import { recordPayment, cancelBooking, updateAdvance } from "@/modules/booking/services/decisions";
import type { HoldedConfig } from "@/modules/booking/services/settings";
import { createBankingFixtureScope } from "../helpers/banking";

const scopes = new Set<ReturnType<typeof createBankingFixtureScope>>();
const operationIds = new Set<string>();
const config: HoldedConfig = {
  advanceServiceId: "advance-service", depositServiceId: "deposit-service",
  language: "ca", serviceIdsBySku: {}, negotiatedTaxIds: [],
};
const invoiceId = "a".repeat(24);
const estimateId = "b".repeat(24);
const contactId = "c".repeat(24);
const collectionId = "d".repeat(24);

async function fixture(amountCents = 30_100) {
  const scope = createBankingFixtureScope("payment-operation");
  scopes.add(scope);
  const actor = await db.user.create({ data: scope.user() });
  const customer = await db.customer.create({ data: { ...scope.customer(), holdedContactId: contactId } });
  const booking = await db.bookingRequest.create({ data: scope.booking(customer) });
  await db.holdedDocument.create({
    data: { bookingRequestId: booking.id, type: "ESTIMATE", holdedId: estimateId,
      documentNumber: "E-1", issuedAt: booking.decidedAt! },
  });
  const account = await db.holdedTreasuryAccount.create({ data: scope.treasuryAccount() });
  const movement = await db.bankMovement.create({
    data: scope.movement(account, { amountMinor: BigInt(amountCents), narrative: "E-1 received" }),
  });
  return { scope, actor, customer, booking, account, movement, amountCents };
}

async function started(context: Awaited<ReturnType<typeof fixture>>) {
  await beginBankPayment({
    bookingRequestId: context.booking.id, movementId: context.movement.id, actorUserId: context.actor.id,
  });
  const op = await db.bankPaymentOperation.findUniqueOrThrow({ where: { bookingRequestId: context.booking.id } });
  operationIds.add(op.id);
  const stored = await db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: `${BANK_PAYMENT_JOB_KIND}:${op.id}` } });
  return { op, job: { ...stored, attempts: 1 } };
}

function provider(context: Awaited<ReturnType<typeof fixture>>) {
  let draft = true;
  let configured = false;
  let paid = false;
  let reconciled = false;
  const day = new Date().toISOString().slice(0, 10);
  const client: BankPaymentClient = {
    getEstimate: vi.fn(async () => ({
      id: estimateId, number: "E-1", description: null, date: null, totalCents: 100_000,
      status: "pending", draft: false, contactId, contactName: null,
    })),
    listNumberingSeries: vi.fn(async () => [{ id: "series-f", name: "F" }]),
    readService: vi.fn(async (id) => ({ priceCents: id === "deposit-service" ? 20_000 : 0, accountId: id })),
    convertEstimateToInvoice: vi.fn(async () => ({ id: invoiceId })),
    configureReserveInvoice: vi.fn(async () => { configured = true; }),
    approveInvoice: vi.fn(async () => { draft = false; }),
    getInvoice: vi.fn(async (): Promise<HoldedInvoiceSummary> => ({
      id: invoiceId, number: "F-1", date: day, dueDate: day,
      totalCents: configured ? context.amountCents : 100_000, status: draft ? "draft" : "approved",
      contactId, taxIncluded: true, items: [
        { name: "Bestreta", description: null, serviceId: "advance-service", accountId: "advance-service",
          units: 1, priceCents: context.amountCents - 20_000, taxes: ["s_iva_10"] },
        { name: "Deposit", description: null, serviceId: "deposit-service", accountId: "deposit-service",
          units: 1, priceCents: 20_000, taxes: ["s_iva_nosujeto"] },
      ],
    })),
    getInvoiceEvidence: vi.fn(async () => ({
      source: { id: estimateId, doc_type: "estimate" }, draft,
      paidCents: paid ? context.amountCents : 0, pendingCents: paid ? 0 : context.amountCents,
      payments: paid ? [{ id: collectionId, amountCents: context.amountCents,
        date: context.movement.bookingDate.toISOString().slice(0, 10), bankId: context.account.holdedAccountId }] : [],
    })),
    registerInvoicePayment: vi.fn(async () => { paid = true; }),
    reconcileBankPayment: vi.fn(async () => { reconciled = true; }),
    listBankMovements: vi.fn(async () => ({
      items: [{
        id: context.movement.holdedMovementId, banking_account_id: context.account.holdedAccountId,
        booking_date: context.movement.bookingDate.toISOString(), value_date: null,
        amount: (context.amountCents / 100).toFixed(2), currency: "EUR",
        status: reconciled ? "reconciled" : "pending",
      }], hasMore: false, cursor: null,
    })),
    listDelegateEmails: vi.fn(async () => ["delegate@example.test", "DELEGATE@example.test"]),
    sendEstimate: vi.fn(async () => {}),
    sendInvoice: vi.fn(async () => {
      expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: context.booking.id } })).state).toBe("AWAITING_PAYMENT");
    }),
  };
  return client;
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== "true")("durable bank payment operations", () => {
  afterEach(async () => {
    await db.integrationJob.deleteMany({ where: { idempotencyKey: { in: [...operationIds].map((id) => `${BANK_PAYMENT_JOB_KIND}:${id}`) } } });
    for (const scope of scopes) {
      const ids = await db.bookingRequest.findMany({ where: { id: { startsWith: scope.scopeId } }, select: { id: true } });
      await db.integrationJob.deleteMany({ where: { idempotencyKey: { in: ids.map(({ id }) => `booking.mail:confirmed:${id}`) } } });
      await scope.cleanup();
    }
    scopes.clear(); operationIds.clear();
  });
  afterAll(() => db.$disconnect());

  it.each([28_500, 31_500])("uses received %i cents and confirms only after Holded and delivery", async (amount) => {
    const context = await fixture(amount);
    const { job } = await started(context);
    const client = provider(context);
    expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: context.booking.id } })).state).toBe("AWAITING_PAYMENT");
    await runBankPaymentJob(job, { client, config });
    expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: context.booking.id } })).state).toBe("CONFIRMED");
    expect(await db.payment.findFirst({ where: { bookingRequestId: context.booking.id } })).toMatchObject({ amountCents: amount, bankMovementId: context.movement.id });
    expect(client.configureReserveInvoice).toHaveBeenCalledWith(invoiceId, expect.objectContaining({
      items: [expect.objectContaining({ price: (amount - 20_000) / 100, taxes: ["s_iva_10"] }),
        expect.objectContaining({ price: 200, taxes: ["s_iva_nosujeto"] })],
    }));
    expect(client.sendInvoice).toHaveBeenCalledWith(invoiceId,
      { emails: [context.customer.email.toLowerCase()], cc: ["delegate@example.test"] }, undefined, expect.any(String));
    await runBankPaymentJob(job, { client, config });
    expect(client.registerInvoicePayment).toHaveBeenCalledOnce();
    expect(client.sendInvoice).toHaveBeenCalledOnce();
    expect(await db.bookingAuditEvent.count({ where: { bookingRequestId: context.booking.id, toState: "CONFIRMED" } })).toBe(1);
    const run = await db.bankSyncRun.create({ data: {
      accountId: context.account.id, trigger: "MANUAL", windowStartDate: context.account.importStartDate,
    } });
    await expect(reconcileBankMovements([context.movement.id], undefined, { runId: run.id, pageNumber: 1 }))
      .resolves.toMatchObject({ incidentCount: 0 });
    await db.bankMovement.update({ where: { id: context.movement.id }, data: { amountMinor: BigInt(amount - 1) } });
    await expect(reconcileBankMovements([context.movement.id], undefined, { runId: run.id, pageNumber: 1 }))
      .resolves.toMatchObject({ incidentCount: 1 });
  });

  it("returns inverse candidates without requiring a concept reference", async () => {
    const context = await fixture();
    await db.bankMovement.update({ where: { id: context.movement.id }, data: { narrative: "No reference" } });
    const result = await listMovementBookingCandidates(context.movement.id);
    expect(result.candidates).toContainEqual(expect.objectContaining({ bookingRequestId: context.booking.id, expectedAmountMinor: "30000" }));
    await started(context);
    await expect(listMovementBookingCandidates(context.movement.id)).rejects.toMatchObject({ code: "movement_ineligible" });
  });

  it("claims a movement only once under concurrent selections", async () => {
    const context = await fixture();
    const command = { bookingRequestId: context.booking.id, movementId: context.movement.id, actorUserId: context.actor.id };
    const results = await Promise.allSettled([beginBankPayment(command), beginBankPayment(command)]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const operation = await db.bankPaymentOperation.findUniqueOrThrow({ where: { movementId: context.movement.id } });
    operationIds.add(operation.id);
    expect(await db.payment.count({ where: { bookingRequestId: context.booking.id } })).toBe(0);
  });

  it("protects processing bookings from cancellation, manual payment and advance edits", async () => {
    const context = await fixture();
    await started(context);
    await expect(cancelBooking({ bookingRequestId: context.booking.id, actorUserId: context.actor.id, reason: "Synthetic" })).rejects.toMatchObject({ code: "state_changed" });
    await expect(recordPayment({ bookingRequestId: context.booking.id, actorUserId: context.actor.id, amountCents: 30_000, receivedAt: new Date() })).rejects.toMatchObject({ code: "state_changed" });
    await expect(updateAdvance({ bookingRequestId: context.booking.id, actorUserId: context.actor.id, advanceCents: 11_000 })).rejects.toMatchObject({ code: "state_changed" });
    expect(await db.payment.count({ where: { bookingRequestId: context.booking.id } })).toBe(0);
  });

  it.each(["convertEstimateToInvoice", "configureReserveInvoice", "approveInvoice", "registerInvoicePayment", "reconcileBankPayment"] as const)(
    "does not repeat ambiguous %s", async (method) => {
      const context = await fixture();
      const { job, op } = await started(context);
      const client = provider(context);
      vi.mocked(client[method]).mockRejectedValueOnce(new HoldedMutationError("unavailable", "unknown"));
      await runBankPaymentJob(job, { client, config });
      expect(await db.bankPaymentOperation.findUnique({ where: { id: op.id } })).toMatchObject({ status: "UNKNOWN" });
      await runBankPaymentJob(job, { client, config });
      expect(client[method]).toHaveBeenCalledOnce();
      expect((await db.bookingRequest.findUniqueOrThrow({ where: { id: context.booking.id } })).state).toBe("AWAITING_PAYMENT");
    },
  );

  it("retries a definitive payment rejection without recreating the invoice", async () => {
    const context = await fixture();
    const { job } = await started(context);
    const client = provider(context);
    vi.mocked(client.registerInvoicePayment).mockRejectedValueOnce(new HoldedMutationError("rate_limited", "definitive_failure"));
    await expect(runBankPaymentJob(job, { client, config })).rejects.toBeInstanceOf(HoldedMutationError);
    await runBankPaymentJob(job, { client, config });
    expect(client.convertEstimateToInvoice).toHaveBeenCalledOnce();
    expect(client.approveInvoice).toHaveBeenCalledOnce();
    expect(client.registerInvoicePayment).toHaveBeenCalledTimes(2);
  });

  it("does not confirm or resend on an unknown email outcome", async () => {
    const context = await fixture();
    const { job, op } = await started(context);
    const client = provider(context);
    vi.mocked(client.sendInvoice).mockRejectedValueOnce(new HoldedDeliveryError("unavailable", "unknown", "Synthetic"));
    await runBankPaymentJob(job, { client, config });
    expect(await db.bankPaymentOperation.findUnique({ where: { id: op.id } })).toMatchObject({ status: "UNKNOWN", stage: "RECONCILED" });
    await runBankPaymentJob(job, { client, config });
    expect(client.sendInvoice).toHaveBeenCalledOnce();
    expect(await db.payment.count({ where: { bookingRequestId: context.booking.id } })).toBe(0);
  });

  it("parks a stale claimed worker instead of replaying an unknown write", async () => {
    const context = await fixture();
    const { job, op } = await started(context);
    await db.integrationJob.update({ where: { id: job.id }, data: { status: "CLAIMED", claimedAt: new Date(0) } });
    await db.bankPaymentOperation.update({ where: { id: op.id }, data: { status: "IN_FLIGHT" } });
    await recoverInterruptedBankPayments();
    expect(await db.bankPaymentOperation.findUnique({ where: { id: op.id } })).toMatchObject({ status: "UNKNOWN" });
  });

  it("retries final local commit without any provider reads or sending twice", async () => {
    const context = await fixture();
    const { job, op } = await started(context);
    const client = provider(context);
    vi.mocked(client.sendInvoice).mockImplementationOnce(async () => {
      await db.bookingRequest.update({ where: { id: context.booking.id }, data: { state: "CONFIRMED" } });
    });
    await expect(runBankPaymentJob(job, { client, config })).rejects.toMatchObject({ code: "state_changed" });
    expect(await db.bankPaymentOperation.findUnique({ where: { id: op.id } })).toMatchObject({ stage: "SENT", status: "FAILED" });
    expect(await db.payment.count({ where: { bookingRequestId: context.booking.id } })).toBe(0);
    await db.bookingRequest.update({ where: { id: context.booking.id }, data: { state: "AWAITING_PAYMENT" } });
    await runBankPaymentJob(job);
    expect(await db.bankPaymentOperation.findUnique({ where: { id: op.id } })).toMatchObject({ status: "COMPLETED" });
    expect(client.sendInvoice).toHaveBeenCalledOnce();
  });

  it("fails closed when delegate discovery is incomplete", async () => {
    const context = await fixture();
    const { job } = await started(context);
    const client = provider(context);
    vi.mocked(client.listDelegateEmails).mockRejectedValueOnce(new Error("synthetic discovery error"));
    await expect(runBankPaymentJob(job, { client, config })).rejects.toThrow("synthetic discovery error");
    expect(client.sendInvoice).not.toHaveBeenCalled();
    expect(await db.payment.count({ where: { bookingRequestId: context.booking.id } })).toBe(0);
    await runBankPaymentJob(job, { client, config });
    expect(client.convertEstimateToInvoice).toHaveBeenCalledOnce();
  });
});
