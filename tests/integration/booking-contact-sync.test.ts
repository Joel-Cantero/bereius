// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

const mocks = vi.hoisted(() => ({
  contact: null as Record<string, unknown> | null,
  findContactByTaxId: vi.fn(async () => mocks.contact),
  estimates: [] as Record<string, unknown>[],
  updateContact: vi.fn(async () => undefined),
  createContact: vi.fn(async () => ({ id: "new-contact" })),
  readService: vi.fn(async () => ({ priceCents: 22_500, accountId: null })),
  listEstimatesByContact: vi.fn(async () => mocks.estimates),
}));

vi.mock("@/modules/booking/services/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntegration: vi.fn(async () => ({
    config: { depositServiceId: "service-deposit" },
    secret: "key",
  })),
}));

vi.mock("@/lib/holded/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHoldedClient: () => ({
    findContactByTaxId: mocks.findContactByTaxId,
    listEstimatesByContact: mocks.listEstimatesByContact,
    updateContact: mocks.updateContact,
    createContact: mocks.createContact,
    readService: mocks.readService,
  }),
}));

import { db } from "@/lib/db";
import {
  changeBookingCustomer,
  findBookingCustomerCandidate,
  inspectCustomerContact,
  linkExistingEstimate,
  updateCustomerContact,
} from "@/modules/booking/services/contact-sync";

const CUSTOMER = {
  name: "Juventud para Cristo",
  email: "hola@example.test",
  phone: "654513598",
  addressLine: "Carrer Example 1",
  city: "Barcelona",
  province: "Barcelona",
  postalCode: "08014",
  country: "España",
};

/** Holded keeps the number under `mobile`, which the client folds into phone. */
const HOLDED_CONTACT = {
  id: "contact-1",
  name: CUSTOMER.name,
  taxId: "X1",
  email: CUSTOMER.email,
  phone: CUSTOMER.phone,
  addressLine: CUSTOMER.addressLine,
  city: CUSTOMER.city,
  province: CUSTOMER.province,
  postalCode: CUSTOMER.postalCode,
  country: CUSTOMER.country,
};

describe.skipIf(!runIntegrationTests)("holded contact synchronisation", () => {
  const customerIds: string[] = [];

  async function booking(customerOverrides: Partial<typeof CUSTOMER> = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: {
        ...CUSTOMER,
        ...customerOverrides,
        taxId: `C${suffix}`.slice(0, 20),
      },
    });
    customerIds.push(customer.id);

    const request = await db.bookingRequest.create({
      data: {
        gravityEntryId: `contact-${suffix}`,
        customerId: customer.id,
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
    bookingIds.push(request.id);
    return request;
  }

  async function otherCustomer(taxId: string) {
    const customer = await db.customer.create({
      data: { ...CUSTOMER, name: "Another organisation", email: "other@example.test", taxId },
    });
    customerIds.push(customer.id);
    return customer;
  }

  function uniqueTaxId() {
    const taxId = `T${Date.now()}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    taxIds.push(taxId);
    return taxId;
  }

  afterEach(async () => {
    mocks.contact = null;
    mocks.estimates = [];
    vi.clearAllMocks();
  });

  const bookingIds: string[] = [];
  const taxIds: string[] = [];

  afterAll(async () => {
    await db.bookingRequest.deleteMany({
      where: { OR: [{ customerId: { in: customerIds } }, { id: { in: bookingIds } }] },
    });
    await db.customer.deleteMany({
      where: { OR: [{ id: { in: customerIds } }, { taxId: { in: taxIds } }] },
    });
    await db.$disconnect();
  });

  it("reports a tax identifier Holded has never seen", async () => {
    const request = await booking();

    await expect(inspectCustomerContact(request.id)).resolves.toMatchObject({
      status: "missing",
    });
  });

  it("treats a contact whose details agree as a match", async () => {
    mocks.contact = HOLDED_CONTACT;
    const request = await booking();

    await expect(inspectCustomerContact(request.id)).resolves.toMatchObject({
      status: "matches",
      contactId: "contact-1",
      differences: [],
    });
  });

  it("treats Catalan and Spanish names for Spain as the same country", async () => {
    mocks.contact = { ...HOLDED_CONTACT, country: "España" };
    const request = await booking({ country: "Espanya" });

    await expect(inspectCustomerContact(request.id)).resolves.toMatchObject({
      status: "matches",
      contactId: "contact-1",
      differences: [],
    });
  });

  it("names only the fields that actually differ", async () => {
    mocks.contact = {
      ...HOLDED_CONTACT,
      // Casing and padding are not differences worth an operator's attention.
      name: "  juventud PARA cristo ",
      addressLine: "c/Example 1",
      country: null,
    };
    const request = await booking();

    const result = await inspectCustomerContact(request.id);
    expect(result.status).toBe("differs");
    if (result.status !== "differs") return;

    expect(result.differences.map((difference) => difference.field)).toEqual([
      "addressLine",
      "country",
    ]);
    expect(result.differences[0]).toEqual({
      field: "addressLine",
      ours: "Carrer Example 1",
      theirs: "c/Example 1",
    });
  });

  it("sends the whole record when updating, so Holded cannot blank the rest", async () => {
    mocks.contact = { ...HOLDED_CONTACT, email: "old@example.test" };
    const request = await booking();

    await updateCustomerContact(request.id);

    expect(mocks.updateContact).toHaveBeenCalledWith(
      "contact-1",
      expect.objectContaining({
        email: CUSTOMER.email,
        name: CUSTOMER.name,
        address: CUSTOMER.addressLine,
        postalCode: CUSTOMER.postalCode,
      }),
    );
  });

  it("refuses to attach an estimate that belongs to somebody else", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();

    await expect(
      linkExistingEstimate(request.id, "estimate-of-another-customer"),
    ).rejects.toMatchObject({ code: "not_in_holded" });

    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
  });

  it("records an estimate the contact really owns", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1", totalCents: 100_000 }];
    const request = await booking();

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.holdedDocument.findFirst({ where: { bookingRequestId: request.id } }),
    ).resolves.toMatchObject({
      type: "ESTIMATE",
      holdedId: "estimate-1",
      documentNumber: "E1",
      totalCents: 100_000,
    });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      advanceCents: 30_000,
      depositCents: 22_500,
    });
    expect(mocks.listEstimatesByContact).toHaveBeenCalledWith("contact-1", {
      fresh: true,
    });
    expect(mocks.readService).toHaveBeenCalledWith("service-deposit", {
      fresh: true,
    });
  });

  it("repairs a historical linked estimate without duplicating it or changing state", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [
      {
        id: "estimate-1",
        number: "E260386",
        date: "2026-09-13",
        totalCents: 170_000,
      },
    ];
    mocks.readService.mockResolvedValueOnce({ priceCents: 20_000, accountId: null });
    const request = await booking();
    const linkedAt = new Date("2026-09-16T00:00:00.000Z");
    const document = await db.holdedDocument.create({
      data: {
        bookingRequestId: request.id,
        type: "ESTIMATE",
        holdedId: "estimate-1",
        documentNumber: null,
        totalCents: null,
        issuedAt: linkedAt,
      },
    });
    await db.bookingRequest.update({
      where: { id: request.id },
      data: { state: "AWAITING_PAYMENT", decidedAt: linkedAt },
    });

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.holdedDocument.findMany({ where: { bookingRequestId: request.id } }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: document.id,
        documentNumber: "E260386",
        totalCents: 170_000,
        issuedAt: new Date("2026-09-13T00:00:00.000Z"),
      }),
    ]);
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      state: "AWAITING_PAYMENT",
      decidedAt: linkedAt,
      advanceCents: 51_000,
      depositCents: 20_000,
    });
    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
  });

  it("preserves the Holded estimate date as the approval date", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [
      {
        id: "estimate-1",
        number: "E1",
        date: "2026-09-13",
        totalCents: 100_000,
      },
    ];
    const request = await booking();

    await linkExistingEstimate(request.id, "estimate-1");

    const approvalDate = new Date("2026-09-13T00:00:00.000Z");
    await expect(
      db.holdedDocument.findFirstOrThrow({
        where: { bookingRequestId: request.id, type: "ESTIMATE" },
      }),
    ).resolves.toMatchObject({ issuedAt: approvalDate });
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({
      state: "AWAITING_PAYMENT",
      decidedAt: approvalDate,
    });
  });

  it("asks for the deposit, because the estimate is the contract", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1", totalCents: 100_000 }];
    const request = await booking();

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "AWAITING_PAYMENT" });

    const events = await db.bookingAuditEvent.findMany({
      where: { bookingRequestId: request.id },
    });
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      ["IN_REVIEW", "AWAITING_PAYMENT"],
    ]);
  });

  it("leaves a request that has already moved on where it is", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1", totalCents: 100_000 }];
    const request = await booking();
    await db.bookingRequest.update({
      where: { id: request.id },
      data: { state: "CONFIRMED" },
    });

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("attaches nothing when the approval cannot be recorded", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1", totalCents: 100_000 }];
    const request = await booking();

    // An actor that does not exist fails the audit row's foreign key, standing
    // in for any late failure once the document has already been written.
    await expect(
      linkExistingEstimate(request.id, "estimate-1", "missing-user-id"),
    ).rejects.toThrow();

    // Neither half may survive: a contract without its approval is the drift
    // this transaction exists to prevent.
    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "IN_REVIEW" });
  });

  describe("changing the customer before approval", () => {
    it("finds a known customer however the tax identifier is typed", async () => {
      const request = await booking();
      const taxId = uniqueTaxId();
      await otherCustomer(taxId);
      const typed = ` ${taxId.slice(0, 4).toLowerCase()}-${taxId.slice(4)} `;

      await expect(findBookingCustomerCandidate(request.id, typed)).resolves.toEqual({
        taxId,
        name: "Another organisation",
        email: "other@example.test",
        source: "booking",
        current: false,
      });
      expect(mocks.findContactByTaxId).not.toHaveBeenCalled();
    });

    it("recognises the request's own customer", async () => {
      const request = await booking();
      const { taxId } = await db.customer.findUniqueOrThrow({ where: { id: request.customerId } });

      await expect(findBookingCustomerCandidate(request.id, taxId)).resolves.toMatchObject({
        current: true,
      });
    });

    it("falls back to a Holded contact nobody has booked with yet", async () => {
      const request = await booking();
      const taxId = uniqueTaxId();
      mocks.contact = { ...HOLDED_CONTACT, id: "contact-9", taxId, name: "Holded only" };

      await expect(findBookingCustomerCandidate(request.id, taxId)).resolves.toEqual({
        taxId,
        name: "Holded only",
        email: CUSTOMER.email,
        source: "holded",
        current: false,
      });
      await expect(db.customer.count({ where: { taxId } })).resolves.toBe(0);
    });

    it("reports a tax identifier that is neither known nor in Holded", async () => {
      const request = await booking();

      await expect(
        findBookingCustomerCandidate(request.id, uniqueTaxId()),
      ).rejects.toMatchObject({ code: "customer_not_found" });
    });

    it("refuses a Holded contact the quote could not be sent to", async () => {
      const request = await booking();
      const taxId = uniqueTaxId();
      mocks.contact = { ...HOLDED_CONTACT, taxId, email: null };

      await expect(findBookingCustomerCandidate(request.id, taxId)).rejects.toMatchObject({
        code: "customer_without_email",
      });
    });

    it("moves the request to a known customer and records who did it", async () => {
      const request = await booking();
      const taxId = uniqueTaxId();
      const target = await otherCustomer(taxId);
      const email = `operator-${taxId.toLowerCase()}@example.test`;
      const actor = await db.user.create({
        data: { email, normalizedEmail: email, name: "Operator" },
      });

      try {
        await changeBookingCustomer(request.id, taxId.toLowerCase(), actor.id);

        await expect(
          db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
        ).resolves.toMatchObject({ customerId: target.id, state: "IN_REVIEW" });
        await expect(
          db.bookingOperationEvent.findMany({
            where: { bookingRequestId: request.id },
            select: { type: true, actorUserId: true },
          }),
        ).resolves.toEqual([{ type: "CUSTOMER_CHANGED", actorUserId: actor.id }]);
      } finally {
        await db.bookingOperationEvent.deleteMany({ where: { bookingRequestId: request.id } });
        await db.user.delete({ where: { id: actor.id } });
      }
    });

    it("creates the customer from Holded, already linked to its contact", async () => {
      const request = await booking();
      const taxId = uniqueTaxId();
      mocks.contact = { ...HOLDED_CONTACT, id: "contact-9", taxId, name: "Holded only" };

      await changeBookingCustomer(request.id, taxId);

      const created = await db.customer.findUniqueOrThrow({ where: { taxId } });
      expect(created).toMatchObject({
        name: "Holded only",
        email: CUSTOMER.email,
        city: CUSTOMER.city,
        holdedContactId: "contact-9",
      });
      await expect(
        db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({ customerId: created.id });
    });

    it("records nothing when the customer is already the request's", async () => {
      const request = await booking();
      const { taxId } = await db.customer.findUniqueOrThrow({ where: { id: request.customerId } });

      await changeBookingCustomer(request.id, taxId);

      await expect(
        db.bookingOperationEvent.count({ where: { bookingRequestId: request.id } }),
      ).resolves.toBe(0);
    });

    it("leaves an approved request with the customer its quote names", async () => {
      const request = await booking();
      await db.bookingRequest.update({
        where: { id: request.id },
        data: { state: "AWAITING_PAYMENT" },
      });
      const taxId = uniqueTaxId();
      await otherCustomer(taxId);

      await expect(changeBookingCustomer(request.id, taxId)).rejects.toMatchObject({
        code: "customer_locked",
      });
      await expect(
        db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({ customerId: request.customerId });
    });

    it("leaves a request with a linked estimate alone, without creating anyone", async () => {
      const request = await booking();
      await db.holdedDocument.create({
        data: {
          bookingRequestId: request.id,
          type: "ESTIMATE",
          holdedId: "estimate-1",
          issuedAt: new Date(),
        },
      });
      const taxId = uniqueTaxId();
      mocks.contact = { ...HOLDED_CONTACT, taxId };

      await expect(changeBookingCustomer(request.id, taxId)).rejects.toMatchObject({
        code: "customer_locked",
      });
      await expect(db.customer.count({ where: { taxId } })).resolves.toBe(0);
    });
  });
});
