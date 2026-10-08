// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import { HoldedDeliveryError, type HoldedClient } from "@/lib/holded/client";
import type { HoldedConfig } from "@/modules/booking/services/settings";
import type { OutboxJob } from "@/modules/booking/services/outbox";
import { quoteJobKey, requestQuoteResend, runQuoteJob } from "@/modules/booking/services/quoting";

const config: HoldedConfig = {
  advanceServiceId: "svc-advance",
  depositServiceId: "svc-deposit",
  mailTemplateId: "tpl-1",
  paymentMethodId: "pay-1",
  language: "ca",
  serviceIdsBySku: { dc40: "svc-dc40", pc40: "svc-pc40" },
  negotiatedTaxIds: [],
};

interface StubOptions {
  failOn?: keyof HoldedClient;
  depositPriceCents?: number;
}

function stubClient(options: StubOptions = {}) {
  const calls: string[] = [];

  const track = <T>(name: keyof HoldedClient, value: () => T) => {
    calls.push(name);
    if (options.failOn === name) {
      throw new Error(`Holded failed at ${name}`);
    }
    return value();
  };

  const client: HoldedClient = {
    listFiscalContacts: vi.fn(async () => []),
    ping: vi.fn(async () => {
      track("ping", () => undefined);
    }),
    listCatalogue: vi.fn(async () => track("listCatalogue", () => [])),
    listTreasuryAccounts: vi.fn(async () =>
      track("listTreasuryAccounts", () => []),
    ),
    listBankMovements: vi.fn(async () =>
      track("listBankMovements", () => ({
        items: [],
        hasMore: false,
        cursor: null,
      })),
    ),
    findContactByTaxId: vi.fn(async () => track("findContactByTaxId", () => null)),
    getContact: vi.fn(async () => track("getContact", () => null)),
    createContact: vi.fn(async () => track("createContact", () => ({ id: "contact-1" }))),
    updateContact: vi.fn(async () => {
      track("updateContact", () => undefined);
    }),
    listDelegateEmails: vi.fn(async () =>
      track("listDelegateEmails", () => []),
    ),
    listEstimatesByContact: vi.fn(async () => track("listEstimatesByContact", () => [])),
    listEstimates: vi.fn(async () => track("listEstimates", () => [])),
    getEstimate: vi.fn(async () => track("getEstimate", () => null)),
    getInvoice: vi.fn(async () => track("getInvoice", () => null)),
    listNumberingSeries: vi.fn(async (type) =>
      track("listNumberingSeries", () =>
        type === "estimate"
          ? [{ id: "series-e", name: "E" }]
          : [{ id: "series-f", name: "F" }],
      ),
    ),
    approveEstimate: vi.fn(async () => {
      track("approveEstimate", () => undefined);
    }),
    approveInvoice: vi.fn(async () => {
      track("approveInvoice", () => undefined);
    }),
    readService: vi.fn(async (serviceId: string) =>
      track("readService", () => ({
        priceCents:
          serviceId === "svc-deposit"
            ? (options.depositPriceCents ?? 20_000)
            : 1_800,
        accountId: `account-for-${serviceId}`,
      })),
    ),
    createEstimate: vi.fn(async () =>
      track("createEstimate", () => ({ id: `est-${calls.length}`, number: "PRE-1" })),
    ),
    sendEstimate: vi.fn(async () => {
      track("sendEstimate", () => undefined);
    }),
    sendInvoice: vi.fn(async () => {
      track("sendInvoice", () => undefined);
    }),
    createInvoice: vi.fn(async () =>
      track("createInvoice", () => ({ id: `inv-${calls.length}`, number: "FAC-1" })),
    ),
    removeEstimateDeductions: vi.fn(async () => track("removeEstimateDeductions", () => false)),
    replaceEstimateLines: vi.fn(async () => {
      track("replaceEstimateLines", () => undefined);
    }),
  };

  return { client, calls };
}

describe.skipIf(!runIntegrationTests)("booking quoting integration", () => {
  const customerIds: string[] = [];
  const actorIds: string[] = [];

  async function actor() {
    const email = `quote-operator-${crypto.randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, normalizedEmail: email, name: "Operator" } });
    actorIds.push(user.id);
    return user.id;
  }

  async function issuedBooking() {
    const booking = await approvedBooking();
    const { client } = stubClient();
    await runQuoteJob(job(booking.id), { client, config });
    const document = await db.holdedDocument.findFirstOrThrow({ where: { bookingRequestId: booking.id } });
    vi.mocked(client.getEstimate).mockResolvedValue({
      id: document.holdedId, number: document.documentNumber, description: null, date: null,
      totalCents: document.totalCents, status: "approved", contactId: "contact-1", contactName: null,
    });
    vi.clearAllMocks();
    return { booking, document, client };
  }

  async function queuedJob(bookingRequestId: string) {
    return db.integrationJob.findUniqueOrThrow({ where: { idempotencyKey: quoteJobKey(bookingRequestId) } });
  }

  async function approvedBooking() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: {
        taxId: `Q${suffix}`.slice(0, 20),
        name: "Fixture group",
        email: "group@example.test",
      },
    });
    customerIds.push(customer.id);

    return db.bookingRequest.create({
      data: {
        gravityEntryId: `quote-${suffix}`,
        customerId: customer.id,
        state: "AWAITING_PAYMENT",
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
  }

  function job(bookingRequestId: string): OutboxJob {
    return {
      id: "job-1",
      kind: "booking.quote",
      idempotencyKey: `booking.quote:${bookingRequestId}`,
      payload: { bookingRequestId },
      attempts: 1,
    };
  }

  afterEach(async () => {
    const bookings = await db.bookingRequest.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
    await db.integrationJob.deleteMany({ where: { idempotencyKey: { in: bookings.map(({ id }) => quoteJobKey(id)) } } });
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    await db.user.deleteMany({ where: { id: { in: actorIds } } });
    customerIds.length = 0;
    actorIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("recovers a dead creation job and records every successful document step", async () => {
    const booking = await approvedBooking();
    const actorUserId = await actor();
    const old = await db.integrationJob.create({ data: {
      kind: "booking.quote", idempotencyKey: quoteJobKey(booking.id), payload: { bookingRequestId: booking.id },
      status: "DEAD", attempts: 6, lastError: "old failure",
    } });
    await requestQuoteResend(booking.id, actorUserId);
    const queued = await queuedJob(booking.id);
    expect(queued).toMatchObject({ id: old.id, status: "PENDING", attempts: 0, lastError: null });
    const { client } = stubClient();
    await runQuoteJob(queued, { client, config });
    expect(client.createEstimate).toHaveBeenCalledOnce();
    expect(client.sendEstimate).toHaveBeenCalledOnce();
    const events = await db.bookingOperationEvent.findMany({ where: { bookingRequestId: booking.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((event) => event.type)).toEqual([
      "QUOTE_REQUESTED", "ESTIMATE_CREATED", "ESTIMATE_APPROVED", "DELIVERY_STARTED", "DELIVERY_ACCEPTED",
    ]);
    expect(events[0]?.actorUserId).toBe(actorUserId);
  });

  it.each(["AWAITING_PAYMENT", "CONFIRMED", "COMPLETED"] as const)(
    "resends a linked estimate in %s without repricing, changing dates, or issuing another document",
    async (state) => {
      const { booking, document, client } = await issuedBooking();
      await db.bookingRequest.update({ where: { id: booking.id }, data: { state } });
      const before = await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } });
      const deliveryBefore = await db.documentDelivery.findUniqueOrThrow({ where: { holdedDocumentId: document.id } });
      await requestQuoteResend(booking.id, await actor());
      const queued = await queuedJob(booking.id);
      await runQuoteJob(queued, { client, config });
      await runQuoteJob(queued, { client, config });
      expect(client.sendEstimate).toHaveBeenCalledOnce();
      expect(client.createEstimate).not.toHaveBeenCalled();
      expect(client.createInvoice).not.toHaveBeenCalled();
      expect(client.readService).not.toHaveBeenCalled();
      expect(client.removeEstimateDeductions).toHaveBeenCalledOnce();
      expect(client.replaceEstimateLines).not.toHaveBeenCalled();
      expect(client.approveEstimate).toHaveBeenCalledOnce();
      expect(client.listDelegateEmails).not.toHaveBeenCalled();
      expect(await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(before);
      const delivery = await db.documentDelivery.findUniqueOrThrow({ where: { holdedDocumentId: document.id } });
      expect(delivery).toMatchObject({ status: "ACCEPTED", toEmail: deliveryBefore.toEmail, ccEmails: deliveryBefore.ccEmails });
      expect(await db.holdedDocument.count({ where: { bookingRequestId: booking.id } })).toBe(1);
    },
  );

  it("corrects legacy deductions and approves the corrected contract before resend", async () => {
    const { booking, document, client } = await issuedBooking();
    vi.mocked(client.removeEstimateDeductions).mockResolvedValue(true);
    const before = await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } });
    await requestQuoteResend(booking.id, await actor());
    const queued = await queuedJob(booking.id);
    await runQuoteJob(queued, { client, config });
    await runQuoteJob(queued, { client, config });
    expect(client.removeEstimateDeductions).toHaveBeenCalledWith(document.holdedId, {
      contactId: "contact-1", names: ["Dipòsit", "Reserva", "Bestreta"], serviceIds: ["svc-deposit", "svc-advance"],
    });
    expect(client.removeEstimateDeductions).toHaveBeenCalledOnce();
    expect(client.approveEstimate).toHaveBeenCalledOnce();
    expect(client.sendEstimate).toHaveBeenCalledOnce();
    expect(vi.mocked(client.removeEstimateDeductions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.approveEstimate).mock.invocationCallOrder[0]);
    expect(vi.mocked(client.approveEstimate).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.sendEstimate).mock.invocationCallOrder[0]);
    expect(client.readService).not.toHaveBeenCalled();
    expect(client.createEstimate).not.toHaveBeenCalled();
    expect(await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(before);
  });

  it("retries approval after correction without sending an unapproved contract", async () => {
    const { booking, client } = await issuedBooking();
    vi.mocked(client.removeEstimateDeductions).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(client.approveEstimate).mockRejectedValueOnce(new Error("approval failed"));
    await requestQuoteResend(booking.id, await actor());
    const queued = await queuedJob(booking.id);
    await expect(runQuoteJob(queued, { client, config })).rejects.toThrow("approval failed");
    expect(client.sendEstimate).not.toHaveBeenCalled();
    await runQuoteJob(queued, { client, config });
    expect(client.approveEstimate).toHaveBeenCalledTimes(2);
    expect(client.sendEstimate).toHaveBeenCalledOnce();
  });

  it("never sends a linked contract if deduction correction fails", async () => {
    const { booking, client } = await issuedBooking();
    vi.mocked(client.removeEstimateDeductions).mockRejectedValue(new Error("unreadable contract"));
    await requestQuoteResend(booking.id, await actor());
    await expect(runQuoteJob(await queuedJob(booking.id), { client, config })).rejects.toThrow("unreadable contract");
    expect(client.sendEstimate).not.toHaveBeenCalled();
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("finishes a partially generated linked estimate before sending it", async () => {
    const booking = await approvedBooking();
    const failed = stubClient({ failOn: "approveEstimate" });
    await expect(runQuoteJob(job(booking.id), { client: failed.client, config })).rejects.toThrow();
    await requestQuoteResend(booking.id, await actor());
    const { client, calls } = stubClient();
    await runQuoteJob(await queuedJob(booking.id), { client, config });
    expect(client.createEstimate).not.toHaveBeenCalled();
    expect(client.approveEstimate).toHaveBeenCalledOnce();
    expect(client.sendEstimate).toHaveBeenCalledOnce();
    expect(calls.indexOf("approveEstimate")).toBeLessThan(calls.indexOf("sendEstimate"));
  });

  it("does not reprice an already delivered estimate even if local amounts are missing", async () => {
    const { booking, client } = await issuedBooking();
    await db.bookingRequest.update({ where: { id: booking.id }, data: { advanceCents: null, depositCents: null } });
    await requestQuoteResend(booking.id, await actor());
    await runQuoteJob(await queuedJob(booking.id), { client, config });
    expect(client.sendEstimate).toHaveBeenCalledOnce();
    expect(client.readService).not.toHaveBeenCalled();
    expect(client.replaceEstimateLines).not.toHaveBeenCalled();
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("resumes a newly created draft after a manual recovery fails before approval", async () => {
    const booking = await approvedBooking();
    await requestQuoteResend(booking.id, await actor());
    const queued = await queuedJob(booking.id);
    const failing = stubClient({ failOn: "replaceEstimateLines" });
    await expect(runQuoteJob(queued, { client: failing.client, config })).rejects.toThrow();
    expect(failing.client.sendEstimate).not.toHaveBeenCalled();
    const { client, calls } = stubClient();
    await runQuoteJob(queued, { client, config });
    expect(client.createEstimate).not.toHaveBeenCalled();
    expect(client.approveEstimate).toHaveBeenCalledOnce();
    expect(client.sendEstimate).toHaveBeenCalledOnce();
    expect(calls.indexOf("approveEstimate")).toBeLessThan(calls.indexOf("sendEstimate"));
  });

  it("serializes concurrent requests even when no quoting job exists yet", async () => {
    const booking = await approvedBooking();
    const actorUserId = await actor();
    const results = await Promise.allSettled([
      requestQuoteResend(booking.id, actorUserId), requestQuoteResend(booking.id, actorUserId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "busy" } });
    expect(await db.integrationJob.count({ where: { idempotencyKey: quoteJobKey(booking.id) } })).toBe(1);
    expect(await db.bookingOperationEvent.count({ where: { bookingRequestId: booking.id, type: "QUOTE_REQUESTED" } })).toBe(1);
  });

  it.each(["PENDING", "CLAIMED"] as const)("does not reset a %s job", async (status) => {
    const booking = await approvedBooking();
    const old = await db.integrationJob.create({ data: {
      kind: "booking.quote", idempotencyKey: quoteJobKey(booking.id), payload: { bookingRequestId: booking.id },
      status, attempts: 3, lastError: "previous failure",
    } });
    await expect(requestQuoteResend(booking.id, await actor())).rejects.toMatchObject({ code: "busy" });
    expect(await queuedJob(booking.id)).toEqual(old);
  });

  it.each(["UNKNOWN", "IN_FLIGHT"] as const)("does not reset a %s delivery", async (status) => {
    const { booking, document } = await issuedBooking();
    await db.holdedDocument.update({ where: { id: document.id }, data: { sentAt: null } });
    const before = await db.documentDelivery.update({ where: { holdedDocumentId: document.id }, data: { status } });
    await expect(requestQuoteResend(booking.id, await actor())).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(await db.documentDelivery.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await db.integrationJob.count({ where: { idempotencyKey: quoteJobKey(booking.id) } })).toBe(0);
  });

  it("blocks another request inside the cooldown even after a fast successful delivery", async () => {
    const { booking, client } = await issuedBooking();
    const actorUserId = await actor();
    await requestQuoteResend(booking.id, actorUserId);
    const queued = await queuedJob(booking.id);
    await runQuoteJob(queued, { client, config });
    await db.integrationJob.update({ where: { id: queued.id }, data: { status: "SUCCEEDED" } });
    await expect(requestQuoteResend(booking.id, actorUserId)).rejects.toMatchObject({ code: "busy" });
    expect(client.sendEstimate).toHaveBeenCalledOnce();
  });

  it.each(["missing", "different_contact"])("does not recreate or send a %s remote estimate", async (mode) => {
    const { booking, client } = await issuedBooking();
    const estimate = await client.getEstimate("fixture");
    vi.mocked(client.getEstimate).mockResolvedValue(mode === "missing" ? null : { ...estimate!, contactId: "other-contact" });
    await requestQuoteResend(booking.id, await actor());
    await expect(runQuoteJob(await queuedJob(booking.id), { client, config })).rejects.toMatchObject({ code: "incomplete_configuration" });
    expect(client.createEstimate).not.toHaveBeenCalled();
    expect(client.sendEstimate).not.toHaveBeenCalled();
    expect(await db.bookingOperationEvent.findFirst({ where: { bookingRequestId: booking.id, type: "QUOTE_FAILED" } })).toMatchObject({ failureCode: "incomplete_configuration" });
  });

  it.each(["definitive_failure", "unknown"] as const)("logs a %s resend failure without provider text", async (outcome) => {
    const { booking, document, client } = await issuedBooking();
    vi.mocked(client.sendEstimate).mockRejectedValue(new HoldedDeliveryError("invalid_request", outcome, "private-provider-response@example.test"));
    await requestQuoteResend(booking.id, await actor());
    await expect(runQuoteJob(await queuedJob(booking.id), { client, config })).rejects.toThrow();
    const events = await db.bookingOperationEvent.findMany({ where: { bookingRequestId: booking.id } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: outcome === "unknown" ? "DELIVERY_UNKNOWN" : "DELIVERY_FAILED", failureCode: "invalid_request" }),
      expect.objectContaining({ type: "QUOTE_FAILED", failureCode: "invalid_request" }),
    ]));
    expect(JSON.stringify(events)).not.toContain("private-provider-response");
    expect(await db.documentDelivery.findUnique({ where: { holdedDocumentId: document.id } })).toMatchObject({ status: outcome === "unknown" ? "UNKNOWN" : "FAILED" });
  });

  it("issues and sends the estimate without creating a reserve invoice", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    const documents = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
      orderBy: { type: "asc" },
    });

    expect(documents.map((doc) => doc.type)).toEqual(["ESTIMATE"]);
    expect(client.sendEstimate).toHaveBeenCalledTimes(1);
    expect(client.createInvoice).not.toHaveBeenCalled();
    expect(client.approveInvoice).not.toHaveBeenCalled();
    expect(client.replaceEstimateLines).toHaveBeenCalledTimes(1);

    const updated = await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } });
    // 2 nights x 40 people at 18 EUR, 30% advance plus the configured deposit.
    expect(updated.billableUnits).toBe(80);
    expect(updated.advanceCents).toBe(43_200);
    expect(updated.depositCents).toBe(20_000);
    expect(updated.paymentDueAt).not.toBeNull();
    expect(client.replaceEstimateLines).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ serviceId: "svc-dc40", price: 18, units: 80 })],
    );
  });

  it("uses the configured deposit service price in the expected payment", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient({ depositPriceCents: 22_500 });

    await runQuoteJob(job(booking.id), { client, config });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({
      advanceCents: 43_200,
      depositCents: 22_500,
    });
    expect(client.replaceEstimateLines).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ serviceId: "svc-dc40", price: 18, units: 80 })],
    );
  });

  it("does not duplicate the estimate when a later estimate step fails and retries", async () => {
    const booking = await approvedBooking();

    const failing = stubClient({ failOn: "replaceEstimateLines" });
    await expect(runQuoteJob(job(booking.id), { client: failing.client, config })).rejects.toThrow();

    const afterFailure = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
    });
    expect(afterFailure.map((doc) => doc.type)).toEqual(["ESTIMATE"]);

    const retry = stubClient();
    await runQuoteJob(job(booking.id), { client: retry.client, config });

    const documents = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
    });
    expect(documents.filter((doc) => doc.type === "ESTIMATE")).toHaveLength(1);
    expect(documents.filter((doc) => doc.type === "RESERVE_INVOICE")).toHaveLength(0);
    // The retry resumed rather than re-issuing the estimate, and finally mailed
    // it: the first attempt never got that far.
    expect(retry.client.createEstimate).not.toHaveBeenCalled();
    expect(failing.client.sendEstimate).not.toHaveBeenCalled();
    expect(retry.client.sendEstimate).toHaveBeenCalledTimes(1);
  });

  it("reuses a stored Holded contact instead of looking it up again", async () => {
    const booking = await approvedBooking();
    await db.customer.update({
      where: { id: booking.customerId },
      data: { holdedContactId: "contact-existing" },
    });

    const { client } = stubClient();
    await runQuoteJob(job(booking.id), { client, config });

    expect(client.findContactByTaxId).not.toHaveBeenCalled();
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it("records no document when the estimate call itself fails", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient({ failOn: "createEstimate" });

    await expect(runQuoteJob(job(booking.id), { client, config })).rejects.toThrow();

    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("refuses to quote a booking that is not approved", async () => {
    const booking = await approvedBooking();
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { state: "IN_REVIEW" },
    });
    const { client } = stubClient();

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toMatchObject({ code: "wrong_state" });
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("fails loudly when no service is configured for the band", async () => {
    const booking = await approvedBooking();
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { headcount: 90 },
    });
    const { client } = stubClient();

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toMatchObject({ code: "no_service" });
  });

  it("prefers a negotiated service over the band rate", async () => {
    const booking = await approvedBooking();
    await db.customer.update({
      where: { id: booking.customerId },
      data: { negotiatedServiceId: "svc-negotiated" },
    });
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.readService).toHaveBeenCalledWith("svc-negotiated", {
      fresh: true,
    });
  });

  it("bills the negotiated service to a tax identifier on the settings list", async () => {
    const booking = await approvedBooking();
    const customer = await db.customer.findUniqueOrThrow({
      where: { id: booking.customerId },
    });
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), {
      client,
      // Spaced and lower-cased on purpose: the identity is what matters.
      config: {
        ...config,
        negotiatedServiceId: "svc-special",
        negotiatedTaxIds: [` ${customer.taxId.toLowerCase()} `],
      },
    });

    expect(client.readService).toHaveBeenCalledWith("svc-special", { fresh: true });
  });

  it("leaves a customer off the list on the band rate", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), {
      client,
      config: { ...config, negotiatedServiceId: "svc-special", negotiatedTaxIds: ["X0000000X"] },
    });

    expect(client.readService).toHaveBeenCalledWith("svc-dc40", { fresh: true });
  });

  it("numbers the estimate from its series and takes it out of draft", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.createEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ numberingSeriesId: "series-e" }),
    );
    expect(client.approveEstimate).toHaveBeenCalledTimes(1);
    expect(client.createInvoice).not.toHaveBeenCalled();
    expect(client.approveInvoice).not.toHaveBeenCalled();
  });

  it("approves the estimate before mailing it, so the customer gets the final document", async () => {
    const booking = await approvedBooking();
    const { client, calls } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(calls.indexOf("replaceEstimateLines")).toBeLessThan(
      calls.indexOf("approveEstimate"),
    );
    expect(calls.indexOf("approveEstimate")).toBeLessThan(calls.indexOf("sendEstimate"));
  });

  it("does not mail the estimate twice when a later step fails and the job retries", async () => {
    const booking = await approvedBooking();

    const failing = stubClient({ failOn: "readService" });
    const first = stubClient();
    await runQuoteJob(job(booking.id), { client: first.client, config });
    expect(first.client.sendEstimate).toHaveBeenCalledTimes(1);
    expect(failing.client.sendEstimate).not.toHaveBeenCalled();

    const retry = stubClient();
    await runQuoteJob(job(booking.id), { client: retry.client, config });
    expect(retry.client.sendEstimate).not.toHaveBeenCalled();
  });

  it("defers the reserve invoice until a bank movement is linked", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.createInvoice).not.toHaveBeenCalled();
    await expect(
      db.holdedDocument.count({
        where: { bookingRequestId: booking.id, type: "RESERVE_INVOICE" },
      }),
    ).resolves.toBe(0);
  });

  it("keeps the full stay in the contract and payment conditions in the notes", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.createEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "01/06/27 - 03/06/27 - 40 persones DC", notes: expect.stringContaining("Reserva bestreta: 432") }),
    );
    expect(client.replaceEstimateLines).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ serviceId: "svc-dc40", price: 18, units: 80 })],
    );
  });

  it("refuses to quote while the deposit service is still unconfigured", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await expect(
      runQuoteJob(job(booking.id), {
        client,
        config: { ...config, depositServiceId: undefined },
      }),
    ).rejects.toMatchObject({ code: "incomplete_configuration" });
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("refuses to quote a service that carries no accounting account", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();
    client.readService = vi.fn(async () => ({ priceCents: 1_800, accountId: null }));

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toMatchObject({ code: "incomplete_configuration" });
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("does not subtract the deposit or advance from the stay taxable base", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.replaceEstimateLines).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ serviceId: "svc-dc40", price: 18, taxes: ["s_iva_10"] })],
    );
  });

  it("posts the full stay to its original accounting account", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.replaceEstimateLines).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ serviceId: "svc-dc40", accountId: "account-for-svc-dc40" })],
    );
  });

  it("reads Holded and sends the estimate to fiscal To plus every delegate CC", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();
    vi.mocked(client.listDelegateEmails).mockResolvedValueOnce([
      "zulu@example.test",
      "alpha@example.test",
    ]);

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.listDelegateEmails).toHaveBeenCalledWith("contact-1");
    expect(client.sendEstimate).toHaveBeenCalledWith(
      expect.any(String),
      {
        emails: ["group@example.test"],
        cc: ["alpha@example.test", "zulu@example.test"],
      },
      config.mailTemplateId,
      "Gestió de reserves Berea",
    );
    await expect(
      db.documentDelivery.findFirstOrThrow({
        where: { holdedDocument: { bookingRequestId: booking.id } },
      }),
    ).resolves.toMatchObject({
      status: "ACCEPTED",
      toEmail: "group@example.test",
      ccEmails: ["alpha@example.test", "zulu@example.test"],
    });
  });

  it("defers delivery and persists no recipients when Holded lookup fails", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();
    vi.mocked(client.listDelegateEmails).mockRejectedValueOnce(new Error("Holded unavailable"));

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toThrow("Holded unavailable");

    expect(client.sendEstimate).not.toHaveBeenCalled();
    await expect(
      db.documentDelivery.count({
        where: { holdedDocument: { bookingRequestId: booking.id } },
      }),
    ).resolves.toBe(0);
  });

  it("parks an ambiguous send outcome and does not resend on quote retry", async () => {
    const booking = await approvedBooking();
    const first = stubClient();
    first.client.sendEstimate = vi.fn(async () => {
      const { HoldedDeliveryError } = await import("@/lib/holded/client");
      throw new HoldedDeliveryError("unavailable", "unknown", "timeout");
    });

    await expect(
      runQuoteJob(job(booking.id), { client: first.client, config }),
    ).rejects.toThrow("timeout");

    const retry = stubClient();
    await runQuoteJob(job(booking.id), { client: retry.client, config });

    expect(retry.client.sendEstimate).not.toHaveBeenCalled();
    await expect(
      db.documentDelivery.findFirstOrThrow({
        where: { holdedDocument: { bookingRequestId: booking.id } },
      }),
    ).resolves.toMatchObject({ status: "UNKNOWN" });
  });
});
