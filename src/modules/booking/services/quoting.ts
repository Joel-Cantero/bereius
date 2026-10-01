import "server-only";

import { db } from "@/lib/db";
import {
  createHoldedClient,
  type HoldedClient,
  type HoldedDocumentLine,
  type HoldedNumberingType,
  type HoldedService,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  deliverPreparedDocument,
  prepareDocumentDelivery,
} from "@/modules/booking/services/document-delivery";
import { enqueueJob, type OutboxJob } from "@/modules/booking/services/outbox";
import { operationFailureCode, recordBookingOperation } from "@/modules/booking/services/operations";
import { paymentDeadlineFrom } from "@/modules/booking/services/expiry";
import {
  quoteStay,
  resolveHeadcountBand,
  VAT_PERCENT,
} from "@/modules/booking/services/pricing";
import {
  normalizeTaxId,
  resolveIntegration,
  type HoldedConfig,
} from "@/modules/booking/services/settings";
import {
  ADVANCE_LINE,
  bookingManagementSubject,
  DEPOSIT_LINE,
  quoteNotes,
  stayDescription,
  stayPhrase as quoteStayPhrase,
} from "@/modules/booking/wording";

/** Holded identifies a rate by key, confirmed against the account's tax list. */
const VAT_TAX_KEY = `s_iva_${VAT_PERCENT}`;

/** The account's series names; matched by name so no identifier is configured. */
const SERIES_NAMES: Record<HoldedNumberingType, string> = {
  estimate: "E",
  invoice: "F",
};

export const QUOTE_JOB_KIND = "booking.quote";

export function quoteJobKey(bookingRequestId: string): string {
  return `${QUOTE_JOB_KIND}:${bookingRequestId}`;
}

export async function enqueueQuote(bookingRequestId: string): Promise<boolean> {
  const queued = await enqueueJob({
    kind: QUOTE_JOB_KIND,
    idempotencyKey: quoteJobKey(bookingRequestId),
    payload: { bookingRequestId },
  });
  if (queued) await recordBookingOperation(bookingRequestId, "QUOTE_REQUESTED");
  return queued;
}

export class QuoteResendError extends Error {
  constructor(readonly code: "busy" | "wrong_state" | "delivery_unknown") {
    super(code);
    this.name = "QuoteResendError";
  }
}

export async function requestQuoteResend(bookingRequestId: string, actorUserId: string): Promise<void> {
  await db.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${bookingRequestId} FOR UPDATE`;
    const booking = await transaction.bookingRequest.findUnique({
      where: { id: bookingRequestId },
      include: { documents: { where: { type: "ESTIMATE" }, include: { delivery: true } } },
    });
    const estimate = booking?.documents[0];
    if (!booking || !["AWAITING_PAYMENT", "CONFIRMED", "COMPLETED"].includes(booking.state) ||
      (!estimate && booking.state !== "AWAITING_PAYMENT")) {
      throw new QuoteResendError("wrong_state");
    }
    if (estimate?.delivery && ["UNKNOWN", "IN_FLIGHT"].includes(estimate.delivery.status)) {
      throw new QuoteResendError("delivery_unknown");
    }
    const key = quoteJobKey(bookingRequestId);
    const job = await transaction.integrationJob.findUnique({ where: { idempotencyKey: key } });
    const recentRequest = await transaction.bookingOperationEvent.findFirst({
      where: { bookingRequestId, type: "QUOTE_REQUESTED", createdAt: { gte: new Date(Date.now() - 60_000) } },
      select: { id: true },
    });
    if ((job && ["PENDING", "CLAIMED"].includes(job.status)) || recentRequest) {
      throw new QuoteResendError("busy");
    }
    const reset = {
      payload: {
        bookingRequestId,
        resend: true,
        resumeCreation: !estimate || Boolean(booking.state === "AWAITING_PAYMENT" &&
          (booking.advanceCents === null || booking.depositCents === null) &&
          !estimate.sentAt && !estimate.delivery),
      },
      status: "PENDING" as const,
      attempts: 0,
      claimedAt: null,
      lastError: null,
      runAfter: new Date(),
    };
    if (job) {
      const changed = await transaction.integrationJob.updateMany({
        where: { id: job.id, status: job.status }, data: reset,
      });
      if (changed.count !== 1) throw new QuoteResendError("busy");
    } else {
      await transaction.integrationJob.create({
        data: { ...reset, kind: QUOTE_JOB_KIND, idempotencyKey: key },
      });
    }
    if (estimate) {
      await transaction.holdedDocument.update({ where: { id: estimate.id }, data: { sentAt: null } });
      await transaction.documentDelivery.updateMany({
        where: { holdedDocumentId: estimate.id, status: { in: ["ACCEPTED", "FAILED", "PREPARED"] } },
        data: { status: "PREPARED", attemptedAt: null, acceptedAt: null, lastFailureCode: null },
      });
    }
    await transaction.bookingOperationEvent.create({
      data: { bookingRequestId, actorUserId, type: "QUOTE_REQUESTED" },
    });
  });
  logger.info({ event: "booking_quote_resend_requested", bookingRequestId, actorUserId }, "quote resend queued");
}

export class QuotingError extends Error {
  constructor(
    readonly code:
      | "unknown_booking"
      | "wrong_state"
      | "no_service"
      | "incomplete_configuration",
    message: string,
  ) {
    super(message);
    this.name = "QuotingError";
  }
}

function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * `PUT /estimates/{id}` has no `service_id` on its lines, so a replaced line
 * cannot inherit the account from its service. Every line carries the account
 * the catalogue holds, which keeps the mapping in Holded and out of here.
 */
function accountOf(service: HoldedService, label: string): string {
  if (!service.accountId) {
    throw new QuotingError(
      "incomplete_configuration",
      `The Holded ${label} service has no accounting account`,
    );
  }
  return service.accountId;
}

/** Without a series the document is created unnumbered and stays a draft. */
async function resolveSeriesId(
  client: HoldedClient,
  type: HoldedNumberingType,
): Promise<string> {
  const wanted = SERIES_NAMES[type];
  const series = await client.listNumberingSeries(type);
  const match = series.find((option) => option.name.trim().toUpperCase() === wanted);

  if (!match) {
    throw new QuotingError(
      "incomplete_configuration",
      `Holded has no ${wanted} numbering series for ${type}s`,
    );
  }
  return match.id;
}

/**
 * Turns an approved booking into a Holded contact and estimate.
 *
 * Every step is guarded by persisted state, so a retry after a partial failure
 * resumes instead of duplicating. The retired workflow chained four dependent
 * calls with no compensation: a failure at the last step left an invoice issued
 * against an estimate that still showed the full amount, and nobody was told.
 */
async function generateQuote(
  job: OutboxJob,
  overrides: { client?: HoldedClient; config?: HoldedConfig } = {},
): Promise<void> {
  const payload = job.payload as { bookingRequestId?: unknown; resend?: unknown; resumeCreation?: unknown };
  const bookingRequestId = String(payload.bookingRequestId ?? "");

  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    include: { customer: true, documents: { include: { delivery: { select: { status: true } } } } },
  });

  if (!booking) {
    throw new QuotingError("unknown_booking", "Booking request not found");
  }
  const linkedEstimate = booking.documents.find((document) => document.type === "ESTIMATE");
  if (booking.state !== "AWAITING_PAYMENT" &&
    !(payload.resend === true && linkedEstimate && ["CONFIRMED", "COMPLETED"].includes(booking.state))) {
    throw new QuotingError(
      "wrong_state",
      `Booking is in ${booking.state}; quoting expects AWAITING_PAYMENT`,
    );
  }

  const resolved = overrides.config
    ? { config: overrides.config, secret: "" }
    : await resolveIntegration("HOLDED");
  const config = resolved.config;
  const client = overrides.client ?? createHoldedClient(resolved.secret);

  const quoteReady = linkedEstimate && (
    payload.resumeCreation !== true || booking.state !== "AWAITING_PAYMENT" ||
    (booking.advanceCents !== null && booking.depositCents !== null) ||
    linkedEstimate.sentAt !== null || linkedEstimate.delivery !== null
  );
  if (payload.resend === true && linkedEstimate && quoteReady) {
    if (linkedEstimate.sentAt || linkedEstimate.delivery?.status === "ACCEPTED") return;
    const estimate = await client.getEstimate(linkedEstimate.holdedId);
    if (!estimate || !booking.customer.holdedContactId || estimate.contactId !== booking.customer.holdedContactId) {
      throw new QuotingError("incomplete_configuration", "Linked estimate could not be verified");
    }
    await client.removeEstimateDeductions(linkedEstimate.holdedId, {
      contactId: booking.customer.holdedContactId,
      names: [DEPOSIT_LINE.name, ADVANCE_LINE.name, "Bestreta"],
      serviceIds: [config.depositServiceId, config.advanceServiceId].filter((id): id is string => Boolean(id)),
    });
    await recordBookingOperation(booking.id, "ESTIMATE_REUSED");
    await client.approveEstimate(linkedEstimate.holdedId);
    await recordBookingOperation(booking.id, "ESTIMATE_APPROVED");
    const delivery = await prepareDocumentDelivery(linkedEstimate.id, client);
    if (delivery) {
      await deliverPreparedDocument(linkedEstimate.id, client, config.mailTemplateId, bookingManagementSubject(config.language));
    }
    return;
  }

  // The settings screen allows saving the API key before the identifiers are
  // chosen, so completeness is enforced here rather than blocking that step.
  if (!config.advanceServiceId || !config.depositServiceId) {
    throw new QuotingError(
      "incomplete_configuration",
      "Holded settings are missing the advance or the deposit service",
    );
  }
  const advanceServiceId = config.advanceServiceId;
  const depositServiceId = config.depositServiceId;

  // Step 1 — contact. Skipped once the Holded identifier is known.
  let holdedContactId = booking.customer.holdedContactId;
  if (!holdedContactId) {
    const details = {
      name: booking.customer.name,
      code: booking.customer.taxId,
      email: booking.customer.email,
      phone: booking.customer.phone,
      address: booking.customer.addressLine,
      city: booking.customer.city,
      province: booking.customer.province,
      postalCode: booking.customer.postalCode,
      country: booking.customer.country,
    };
    const existing = await client.findContactByTaxId(booking.customer.taxId);

    if (existing) {
      holdedContactId = existing.id;
      if (existing.email?.toLowerCase() !== booking.customer.email.toLowerCase()) {
        await client.updateContact(existing.id, details);
      }
    } else {
      holdedContactId = (await client.createContact(details)).id;
    }

    await db.customer.update({
      where: { id: booking.customerId },
      data: { holdedContactId },
    });
  }

  // Step 2 — price. Read from Holded so a rate change needs no deploy.
  // A negotiated customer is billed against one service whatever the group size:
  // the per-customer override wins, then the tax identifiers on the settings.
  const negotiatedByList = config.negotiatedTaxIds
    .map(normalizeTaxId)
    .includes(normalizeTaxId(booking.customer.taxId))
    ? config.negotiatedServiceId
    : undefined;

  const serviceId =
    booking.customer.negotiatedServiceId ??
    negotiatedByList ??
    config.serviceIdsBySku[
      `${booking.boardType === "FULL_BOARD" ? "pc" : "dc"}${resolveHeadcountBand(
        booking.headcount,
      )}`
    ];

  if (!serviceId) {
    throw new QuotingError(
      "no_service",
      "No Holded service is configured for this board type and headcount",
    );
  }

  const [stayService, advanceService, depositService] = await Promise.all([
    client.readService(serviceId, { fresh: true }),
    client.readService(advanceServiceId, { fresh: true }),
    client.readService(depositServiceId, { fresh: true }),
  ]);
  const stayAccountId = accountOf(stayService, "stay");
  accountOf(advanceService, "advance");
  accountOf(depositService, "deposit");

  const quote = quoteStay({
    boardType: booking.boardType,
    headcount: booking.headcount,
    startDate: booking.startDate,
    endDate: booking.endDate,
    unitPriceCents: stayService.priceCents,
    depositCents: depositService.priceCents,
  });

  const description = stayDescription(
    booking.startDate,
    booking.endDate,
    quote.billableHeadcount,
    booking.boardType === "FULL_BOARD" ? "PC" : "DC",
  );
  const stayPhrase = quoteStayPhrase(
    booking.startDate,
    booking.endDate,
    quote.billableHeadcount,
    quote.nights,
  );
  const notes = quoteNotes({
    startDate: booking.startDate,
    endDate: booking.endDate,
    headcount: quote.billableHeadcount,
    nights: quote.nights,
    advanceCents: quote.advanceCents,
    depositCents: quote.depositCents,
    amountToConfirmCents: quote.amountToConfirmCents,
  });

  const stayLine: HoldedDocumentLine = {
    serviceId,
    accountId: stayAccountId,
    units: quote.units,
    price: centsToAmount(quote.unitPriceCents),
    taxes: [VAT_TAX_KEY],
    description: stayPhrase,
  };

  const existingEstimate = booking.documents.find((doc) => doc.type === "ESTIMATE");
  let estimateId = existingEstimate?.holdedId ?? null;
  let estimateDocumentId = existingEstimate?.id ?? null;

  if (!estimateId) {
    const estimate = await client.createEstimate({
      contactId: holdedContactId,
      description,
      notes,
      language: config.language,
      paymentMethodId: config.paymentMethodId,
      numberingSeriesId: await resolveSeriesId(client, "estimate"),
      items: [stayLine],
    });
    estimateId = estimate.id;

    const document = await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "ESTIMATE",
        holdedId: estimate.id,
        documentNumber: estimate.number,
        totalCents: quote.stayTotalCents,
      },
    });
    estimateDocumentId = document.id;
    await recordBookingOperation(booking.id, "ESTIMATE_CREATED");
  } else {
    await recordBookingOperation(booking.id, "ESTIMATE_REUSED");
  }

  const paymentDueAt = booking.paymentDueAt ?? paymentDeadlineFrom(new Date());

  await client.replaceEstimateLines(estimateId, [stayLine]);

  // Step 5 — approve, which takes the estimate out of draft, then send. The
  // customer must receive the final document, not the working copy.
  await client.approveEstimate(estimateId);
  await recordBookingOperation(booking.id, "ESTIMATE_APPROVED");

  if (!estimateDocumentId) {
    throw new QuotingError("unknown_booking", "Estimate document was not persisted");
  }
  const delivery = await prepareDocumentDelivery(estimateDocumentId, client);
  if (delivery) {
    await deliverPreparedDocument(
      estimateDocumentId,
      client,
      config.mailTemplateId,
      bookingManagementSubject(config.language),
    );
  }

  await db.bookingRequest.update({
    where: { id: booking.id },
    data: {
      billableUnits: quote.units,
      unitPriceCents: quote.unitPriceCents,
      advanceCents: quote.advanceCents,
      depositCents: quote.depositCents,
      paymentDueAt,
    },
  });

  logger.info(
    {
      event: "booking_quote_issued",
      bookingRequestId: booking.id,
      units: quote.units,
      advanceCents: quote.advanceCents,
    },
    "booking quote issued in Holded",
  );
}

export async function runQuoteJob(
  job: OutboxJob,
  overrides: { client?: HoldedClient; config?: HoldedConfig } = {},
): Promise<void> {
  try {
    await generateQuote(job, overrides);
  } catch (error) {
    const bookingRequestId = (job.payload as { bookingRequestId?: unknown }).bookingRequestId;
    const failureCode = operationFailureCode(error);
    if (typeof bookingRequestId === "string" && !(error instanceof QuotingError && error.code === "unknown_booking")) {
      await recordBookingOperation(bookingRequestId, "QUOTE_FAILED", failureCode);
    }
    logger.warn({ event: "booking_quote_failed", jobId: job.id, failureCode }, "quote processing failed");
    throw error;
  }
}
