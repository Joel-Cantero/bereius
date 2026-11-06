import "server-only";

import type { BoardType, BookingState } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  createHoldedClient,
  HoldedError,
  type HoldedClient,
  type HoldedContact,
  type HoldedContactInput,
  type HoldedEstimateSummary,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  transitionBooking,
  type BookingTransactionClient,
} from "@/modules/booking/services/lifecycle";
import {
  calculateConfirmationAmounts,
  countNights,
  type ConfirmationAmounts,
} from "@/modules/booking/services/pricing";
import {
  normalizeTaxId,
  resolveIntegration,
} from "@/modules/booking/services/settings";

export const CONTACT_FIELDS = [
  "name",
  "email",
  "phone",
  "addressLine",
  "city",
  "province",
  "postalCode",
  "country",
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

export interface ContactDifference {
  field: ContactField;
  ours: string | null;
  theirs: string | null;
}

export type ContactInspection =
  | { status: "no_key" | "unavailable" }
  | { status: "missing" }
  | {
      status: "matches" | "differs";
      contactId: string;
      differences: ContactDifference[];
      estimates: HoldedEstimateSummary[];
    };

export class ContactSyncError extends Error {
  constructor(
    readonly code:
      | "unknown_booking"
      | "not_in_holded"
      | "incomplete_configuration"
      | "missing_estimate_total"
      | "customer_not_found"
      | "customer_without_email"
      | "customer_locked"
      | "estimate_linked",
  ) {
    super(code);
    this.name = "ContactSyncError";
  }
}

async function loadCustomer(bookingRequestId: string) {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: { customerId: true, customer: true, state: true },
  });

  if (!booking) throw new ContactSyncError("unknown_booking");
  return booking;
}

function toInput(customer: {
  name: string;
  taxId: string;
  email: string;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
}): HoldedContactInput {
  return {
    name: customer.name,
    code: customer.taxId,
    email: customer.email,
    phone: customer.phone,
    address: customer.addressLine,
    city: customer.city,
    province: customer.province,
    postalCode: customer.postalCode,
    country: customer.country,
  };
}

function normalized(value: string | null): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

/** Trailing spaces and casing are not differences an operator should be shown. */
function same(ours: string | null, theirs: string | null): boolean {
  return normalized(ours) === normalized(theirs);
}

function normalizedCountry(value: string | null): string {
  const country = normalized(value);
  return country === "espanya" || country === "españa" ? "spain" : country;
}

function compare(
  customer: Record<ContactField, string | null>,
  contact: HoldedContact,
): ContactDifference[] {
  return CONTACT_FIELDS.filter(
    (field) =>
      field === "country"
        ? normalizedCountry(customer[field]) !== normalizedCountry(contact[field])
        : !same(customer[field], contact[field]),
  ).map((field) => ({ field, ours: customer[field], theirs: contact[field] }));
}

async function connect(): Promise<HoldedClient | null> {
  try {
    const { secret } = await resolveIntegration("HOLDED");
    return createHoldedClient(secret, undefined, "booking.contacts");
  } catch {
    return null;
  }
}

/**
 * Reads the customer's Holded contact so an operator can see, before a document
 * is issued, whether the accounting system already knows them and agrees.
 */
export async function inspectCustomerContact(
  bookingRequestId: string,
): Promise<ContactInspection> {
  const { customer } = await loadCustomer(bookingRequestId);
  const client = await connect();
  if (!client) return { status: "no_key" };

  try {
    const contact = await client.findContactByTaxId(customer.taxId);
    if (!contact) return { status: "missing" };

    const differences = compare(
      {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        addressLine: customer.addressLine,
        city: customer.city,
        province: customer.province,
        postalCode: customer.postalCode,
        country: customer.country,
      },
      contact,
    );

    return {
      status: differences.length === 0 ? "matches" : "differs",
      contactId: contact.id,
      differences,
      estimates: await client.listEstimatesByContact(contact.id),
    };
  } catch (error) {
    logger.warn(
      {
        event: "booking_contact_inspection_failed",
        bookingRequestId,
        code: error instanceof HoldedError ? error.code : "unexpected",
      },
      "holded contact inspection failed",
    );
    return { status: "unavailable" };
  }
}

export async function createCustomerContact(bookingRequestId: string): Promise<void> {
  const { customerId, customer } = await loadCustomer(bookingRequestId);
  const { secret } = await resolveIntegration("HOLDED");

  const { id } = await createHoldedClient(secret, undefined, "booking.contacts").createContact(toInput(customer));
  await db.customer.update({ where: { id: customerId }, data: { holdedContactId: id } });

  logger.info(
    { event: "booking_contact_created", bookingRequestId, customerId },
    "holded contact created from a booking request",
  );
}

export async function updateCustomerContact(bookingRequestId: string): Promise<void> {
  const { customerId, customer } = await loadCustomer(bookingRequestId);
  const { secret } = await resolveIntegration("HOLDED");
  const client = createHoldedClient(secret, undefined, "booking.contacts");

  const contact = await client.findContactByTaxId(customer.taxId);
  if (!contact) throw new ContactSyncError("not_in_holded");

  await client.updateContact(contact.id, toInput(customer));
  await db.customer.update({
    where: { id: customerId },
    data: { holdedContactId: contact.id },
  });

  logger.info(
    { event: "booking_contact_updated", bookingRequestId, customerId },
    "holded contact updated from a booking request",
  );
}

interface EstimateTerms {
  estimate: HoldedEstimateSummary;
  totalCents: number;
  amounts: ConfirmationAmounts;
  approvedAt: Date;
}

/** What a Holded estimate commits the customer to pay, read before any write. */
async function readEstimateTerms(
  client: HoldedClient,
  depositServiceId: string,
  estimate: HoldedEstimateSummary,
): Promise<EstimateTerms> {
  if (estimate.totalCents === null) {
    throw new ContactSyncError("missing_estimate_total");
  }

  const depositService = await client.readService(depositServiceId, { fresh: true });
  const amounts = calculateConfirmationAmounts(
    estimate.totalCents,
    depositService.priceCents,
  );
  const estimateDate = estimate.date?.match(/^\d{4}-\d{2}-\d{2}$/u)
    ? new Date(`${estimate.date}T00:00:00.000Z`)
    : null;
  const approvedAt =
    estimateDate &&
    !Number.isNaN(estimateDate.getTime()) &&
    estimateDate.toISOString().slice(0, 10) === estimate.date
      ? estimateDate
      : new Date();

  return { estimate, totalCents: estimate.totalCents, amounts, approvedAt };
}

async function recordEstimateLink(
  tx: BookingTransactionClient,
  command: {
    bookingRequestId: string;
    state: BookingState;
    terms: EstimateTerms;
    actorUserId: string | null;
  },
): Promise<void> {
  const { bookingRequestId, terms } = command;
  const document = {
    holdedId: terms.estimate.id,
    documentNumber: terms.estimate.number,
    totalCents: terms.totalCents,
    issuedAt: terms.approvedAt,
  };

  await tx.holdedDocument.upsert({
    where: { bookingRequestId_type: { bookingRequestId, type: "ESTIMATE" } },
    create: { bookingRequestId, type: "ESTIMATE", ...document },
    update: document,
  });

  await tx.bookingRequest.update({
    where: { id: bookingRequestId },
    data: {
      advanceCents: terms.amounts.advanceCents,
      depositCents: terms.amounts.depositCents,
    },
  });

  // The estimate is the contract, so a request that has one has been agreed
  // and the deposit can be asked for. Quoting is deliberately not queued: it
  // would issue a second estimate.
  if (command.state === "IN_REVIEW") {
    await transitionBooking(
      {
        bookingRequestId,
        to: "AWAITING_PAYMENT",
        actorUserId: command.actorUserId,
        decidedAt: terms.approvedAt,
        expectedFrom: "IN_REVIEW",
      },
      tx,
    );
  }
}

/**
 * Records an estimate that already exists in Holded against this request, so
 * quoting leaves it alone instead of issuing a second one.
 */
export async function linkExistingEstimate(
  bookingRequestId: string,
  holdedId: string,
  actorUserId: string | null = null,
): Promise<void> {
  const { customer, state } = await loadCustomer(bookingRequestId);
  const { config, secret } = await resolveIntegration("HOLDED");
  const client = createHoldedClient(secret, undefined, "booking.contacts");

  if (!config.depositServiceId) {
    throw new ContactSyncError("incomplete_configuration");
  }

  const contact = await client.findContactByTaxId(customer.taxId);
  if (!contact) throw new ContactSyncError("not_in_holded");

  // Only an estimate that belongs to this customer may be attached.
  const estimates = await client.listEstimatesByContact(contact.id, { fresh: true });
  const estimate = estimates.find((candidate) => candidate.id === holdedId);
  if (!estimate) throw new ContactSyncError("not_in_holded");

  const terms = await readEstimateTerms(client, config.depositServiceId, estimate);

  // The document and the approval move together: a request must never end up
  // holding a contract while still sitting in review.
  await db.$transaction((tx) =>
    recordEstimateLink(tx, { bookingRequestId, state, terms, actorUserId }),
  );

  logger.info(
    {
      event: "booking_estimate_linked",
      bookingRequestId,
      holdedId,
      approved: state === "IN_REVIEW",
    },
    "existing holded estimate linked to a booking request",
  );
}

export interface ContractBookingCommand {
  holdedId: string;
  boardType: BoardType;
  startDate: Date;
  endDate: Date;
  headcount: number;
  actorUserId: string | null;
}

/** Marks requests that came from a Holded contract rather than the booking form. */
export function contractEntryId(holdedId: string): string {
  return `holded:${holdedId}`;
}

/**
 * Opens a request for a contract agreed outside the booking form, so the stay
 * can still be paid, reconciled and invoiced like any other. The customer is
 * whoever the estimate's Holded contact is, never a choice of the operator.
 */
export async function createBookingFromContract(
  command: ContractBookingCommand,
): Promise<string> {
  // Rejects an impossible stay before anything reaches Holded.
  countNights(command.startDate, command.endDate);

  const { config, secret } = await resolveIntegration("HOLDED");
  const client = createHoldedClient(secret, undefined, "booking.contacts");
  if (!config.depositServiceId) {
    throw new ContactSyncError("incomplete_configuration");
  }

  const estimate = await client.getEstimate(command.holdedId);
  if (!estimate?.contactId) throw new ContactSyncError("not_in_holded");
  const contact = await client.getContact(estimate.contactId, { fresh: true });
  if (!contact) throw new ContactSyncError("not_in_holded");
  const taxId = contact.taxId?.trim() ? normalizeTaxId(contact.taxId) : "";
  if (!taxId) throw new ContactSyncError("customer_not_found");

  const terms = await readEstimateTerms(client, config.depositServiceId, estimate);

  const bookingRequestId = await db.$transaction(async (tx) => {
    // Two operators, or a double click, must not open two requests for one contract.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${contractEntryId(estimate.id)}))`;

    const linked = await tx.holdedDocument.findFirst({
      where: { holdedId: estimate.id, type: "ESTIMATE" },
      select: { id: true },
    });
    if (linked) throw new ContactSyncError("estimate_linked");

    const known = await tx.customer.findFirst({
      where: {
        OR: taxIdVariants(contact.taxId ?? taxId).map((variant) => ({
          taxId: { equals: variant, mode: "insensitive" as const },
        })),
      },
      select: { id: true, holdedContactId: true },
      orderBy: { updatedAt: "desc" },
    });

    let customerId: string;
    if (known) {
      customerId = known.id;
      // The reserve invoice is addressed to this contact.
      if (!known.holdedContactId) {
        await tx.customer.update({
          where: { id: known.id },
          data: { holdedContactId: contact.id },
        });
      }
    } else {
      const email = contact.email?.trim();
      if (!email) throw new ContactSyncError("customer_without_email");
      customerId = (
        await tx.customer.create({
          data: {
            taxId,
            name: contact.name,
            email,
            phone: contact.phone,
            addressLine: contact.addressLine,
            city: contact.city,
            province: contact.province,
            postalCode: contact.postalCode,
            country: contact.country,
            holdedContactId: contact.id,
          },
          select: { id: true },
        })
      ).id;
    }

    const booking = await tx.bookingRequest.create({
      data: {
        gravityEntryId: contractEntryId(estimate.id),
        customerId,
        boardType: command.boardType,
        startDate: command.startDate,
        endDate: command.endDate,
        headcount: command.headcount,
        submittedAt: terms.approvedAt,
      },
      select: { id: true },
    });

    await recordEstimateLink(tx, {
      bookingRequestId: booking.id,
      state: "IN_REVIEW",
      terms,
      actorUserId: command.actorUserId,
    });

    return booking.id;
  });

  logger.info(
    { event: "booking_created_from_contract", bookingRequestId, holdedId: estimate.id },
    "booking request opened from a holded contract",
  );

  return bookingRequestId;
}

export interface CustomerCandidate {
  taxId: string;
  name: string;
  email: string;
  /** Whether the customer is already known here or only exists in Holded. */
  source: "booking" | "holded";
  /** Already the customer of this request. */
  current: boolean;
}

type ResolvedCustomer =
  | {
      source: "booking";
      customer: { id: string; taxId: string; name: string; email: string };
    }
  | { source: "holded"; contact: HoldedContact; taxId: string; email: string };

/** Operators type identifiers with spaces, dots or dashes; try both spellings. */
function taxIdVariants(taxId: string): string[] {
  return [...new Set([taxId.trim(), normalizeTaxId(taxId)])].filter(Boolean);
}

/**
 * Finds whoever a tax identifier belongs to: a customer this application
 * already knows, otherwise a Holded contact. A Holded failure propagates, so
 * the operator is told the lookup failed instead of that nobody matched.
 */
async function resolveCustomerByTaxId(taxId: string): Promise<ResolvedCustomer> {
  const variants = taxIdVariants(taxId);
  if (variants.length === 0) throw new ContactSyncError("customer_not_found");

  const known = await db.customer.findFirst({
    where: {
      OR: variants.map((variant) => ({
        taxId: { equals: variant, mode: "insensitive" as const },
      })),
    },
    select: { id: true, taxId: true, name: true, email: true },
    orderBy: { updatedAt: "desc" },
  });
  if (known) return { source: "booking", customer: known };

  const client = await connect();
  if (client) {
    for (const variant of variants) {
      const contact = await client.findContactByTaxId(variant);
      if (!contact) continue;

      // A customer needs an address to receive the quote.
      const email = contact.email?.trim();
      if (!email) throw new ContactSyncError("customer_without_email");

      return {
        source: "holded",
        contact,
        taxId: contact.taxId?.trim() || normalizeTaxId(taxId),
        email,
      };
    }
  }

  throw new ContactSyncError("customer_not_found");
}

/** Previews who a request would be reassigned to, without changing anything. */
export async function findBookingCustomerCandidate(
  bookingRequestId: string,
  taxId: string,
): Promise<CustomerCandidate> {
  const { customerId } = await loadCustomer(bookingRequestId);
  const resolved = await resolveCustomerByTaxId(taxId);

  if (resolved.source === "booking") {
    return {
      taxId: resolved.customer.taxId,
      name: resolved.customer.name,
      email: resolved.customer.email,
      source: "booking",
      current: resolved.customer.id === customerId,
    };
  }

  return {
    taxId: resolved.taxId,
    name: resolved.contact.name,
    email: resolved.email,
    source: "holded",
    current: false,
  };
}

/**
 * Reassigns a request to another customer, so the quote is issued to the right
 * Holded contact. Only possible before approval: once an estimate exists, it
 * already names a contact and changing ours would make the two disagree.
 */
export async function changeBookingCustomer(
  bookingRequestId: string,
  taxId: string,
  actorUserId: string | null = null,
): Promise<void> {
  const resolved = await resolveCustomerByTaxId(taxId);

  const customerId = await db.$transaction(async (tx) => {
    const booking = await tx.bookingRequest.findUnique({
      where: { id: bookingRequestId },
      select: { customerId: true },
    });
    if (!booking) throw new ContactSyncError("unknown_booking");

    const nextCustomerId =
      resolved.source === "booking"
        ? resolved.customer.id
        : (
            await tx.customer.upsert({
              where: { taxId: resolved.taxId },
              create: {
                taxId: resolved.taxId,
                name: resolved.contact.name,
                email: resolved.email,
                phone: resolved.contact.phone,
                addressLine: resolved.contact.addressLine,
                city: resolved.contact.city,
                province: resolved.contact.province,
                postalCode: resolved.contact.postalCode,
                country: resolved.contact.country,
                holdedContactId: resolved.contact.id,
              },
              update: {},
              select: { id: true },
            })
          ).id;

    if (nextCustomerId === booking.customerId) return null;

    const { count } = await tx.bookingRequest.updateMany({
      where: {
        id: bookingRequestId,
        customerId: booking.customerId,
        state: "IN_REVIEW",
        documents: { none: { type: "ESTIMATE" } },
      },
      data: { customerId: nextCustomerId },
    });
    if (count === 0) throw new ContactSyncError("customer_locked");

    await tx.bookingOperationEvent.create({
      data: { bookingRequestId, type: "CUSTOMER_CHANGED", actorUserId },
    });
    return nextCustomerId;
  });

  if (customerId) {
    logger.info(
      {
        event: "booking_customer_changed",
        bookingRequestId,
        customerId,
        source: resolved.source,
      },
      "booking request reassigned to another customer",
    );
  }
}
