import "server-only";

import { z } from "zod";
import type { BankPaymentStage } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { createHoldedClient, HoldedError, HoldedMutationError, HoldedDeliveryError, type HoldedClient } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { holdedBankMovementSchema } from "@/modules/banking/schema";
import { isAutomaticReconciliationMatch, isBookingPaymentCandidate } from "@/modules/banking/services/payment-matching";
import { ReconciliationError } from "@/modules/banking/services/reconciliation-error";
import { enqueueJob, MAX_ATTEMPTS, type OutboxJob } from "@/modules/booking/services/outbox";
import { BookingTransitionError } from "@/modules/booking/services/lifecycle";
import { prepareDocumentDelivery, deliverPreparedDocument } from "@/modules/booking/services/document-delivery";
import { isCompatibleReserveInvoice } from "@/modules/booking/services/reserve-invoice";
import { resolveIntegration, type HoldedConfig } from "@/modules/booking/services/settings";
import { RECEIVED_ADVANCE_LINE, DEPOSIT_LINE, bookingManagementSubject, stayDescription, quoteNotes } from "@/modules/booking/wording";
import { billableHeadcount, countNights } from "@/modules/booking/services/pricing";
import { enqueueGoogleCalendarBookingSync } from "@/modules/calendar/services/booking-sync";

export const BANK_PAYMENT_JOB_KIND = "banking.payment";
export const RESERVE_DEPOSIT_CENTS = 20_000;

export async function recoverInterruptedBankPayments(now = new Date()): Promise<void> {
  const jobs = await db.integrationJob.findMany({
    where: { kind: BANK_PAYMENT_JOB_KIND, status: "CLAIMED", claimedAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
    select: { id: true, payload: true },
  });
  for (const job of jobs) {
    const parsed = z.object({ operationId: z.string() }).safeParse(job.payload);
    if (!parsed.success) {
      await db.integrationJob.updateMany({
        where: { id: job.id, status: "CLAIMED" },
        data: { status: "DEAD", lastError: "invalid_bank_payment_payload" },
      });
      logger.error({ event: "bank_payment_invalid_job", jobId: job.id }, "Invalid bank payment job requires review");
      continue;
    }
    await db.$transaction(async (tx) => {
      const claimed = await tx.integrationJob.updateMany({
        where: { id: job.id, status: "CLAIMED", claimedAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
        data: { status: "PENDING", runAfter: now, lastError: "interrupted_bank_payment" },
      });
      if (claimed.count !== 1) return;
      await tx.bankPaymentOperation.updateMany({
        where: { id: parsed.data.operationId, status: { in: ["IN_FLIGHT", "PENDING", "FAILED"] }, stage: { not: "SENT" } },
        data: { status: "UNKNOWN", lastFailureCode: "interrupted_worker" },
      });
    });
    logger.warn({ event: "bank_payment_interrupted", jobId: job.id }, "Interrupted bank payment requires review");
  }
}

export function receivedInvoiceAmounts(amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= RESERVE_DEPOSIT_CENTS ||
      amountCents > 2_147_483_647) throw new ReconciliationError("amount_mismatch");
  return { advanceCents: amountCents - RESERVE_DEPOSIT_CENTS, depositCents: RESERVE_DEPOSIT_CENTS };
}

export async function beginBankPayment(command: {
  bookingRequestId: string; movementId: string; actorUserId: string; strict?: boolean;
}): Promise<{ bookingRequestId: string }> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${command.bookingRequestId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "BankMovement" WHERE "id" = ${command.movementId} FOR UPDATE`;
      const [booking, movement] = await Promise.all([
        tx.bookingRequest.findUnique({
          where: { id: command.bookingRequestId },
          include: {
            customer: true, bankPaymentOperation: true, payments: true,
            documents: { where: { type: { in: ["ESTIMATE", "RESERVE_INVOICE"] } } },
          },
        }),
        tx.bankMovement.findUnique({
          where: { id: command.movementId },
          include: { payment: true, paymentOperation: true },
        }),
      ]);
      if (!booking || !movement) throw new ReconciliationError("not_found");
      if (booking.state !== "AWAITING_PAYMENT" || booking.bankPaymentOperation || booking.payments.length) {
        throw new ReconciliationError("state_changed");
      }
      const quoteJob = await tx.integrationJob.findUnique({
        where: { idempotencyKey: `booking.quote:${booking.id}` }, select: { status: true },
      });
      if (quoteJob && ["PENDING", "CLAIMED"].includes(quoteJob.status)) {
        throw new ReconciliationError("state_changed");
      }
      if (movement.payment || movement.paymentOperation) throw new ReconciliationError("movement_already_used");
      const estimates = booking.documents.filter((doc) => doc.type === "ESTIMATE");
      const estimate = estimates[0];
      if (!estimate || !booking.customer.holdedContactId ||
          booking.documents.some((doc) => doc.type === "RESERVE_INVOICE")) {
        throw new ReconciliationError("movement_ineligible");
      }
      const match = { ...booking, documents: estimates };
      if (!(command.strict ? isAutomaticReconciliationMatch(movement, match) : isBookingPaymentCandidate(movement, match))) {
        throw new ReconciliationError("movement_ineligible");
      }
      if (movement.amountMinor > BigInt(2_147_483_647)) throw new ReconciliationError("amount_mismatch");
      const amountCents = Number(movement.amountMinor);
      receivedInvoiceAmounts(amountCents);
      const proposal = await tx.bankReconciliationProposal.upsert({
        where: { movementId_bookingRequestId: { movementId: movement.id, bookingRequestId: booking.id } },
        update: {},
        create: { movementId: movement.id, bookingRequestId: booking.id },
      });
      if (proposal.status !== "PENDING") throw new ReconciliationError("proposal_changed");
      const operation = await tx.bankPaymentOperation.create({
        data: {
          bookingRequestId: booking.id, movementId: movement.id,
          actorUserId: command.actorUserId, amountCents,
          receivedAt: movement.bookingDate, reference: movement.narrative,
          contactId: booking.customer.holdedContactId, estimateId: estimate.holdedId,
        },
      });
      await enqueueJob({
        kind: BANK_PAYMENT_JOB_KIND, idempotencyKey: `${BANK_PAYMENT_JOB_KIND}:${operation.id}`,
        payload: { operationId: operation.id },
      }, tx);
      return { bookingRequestId: booking.id };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new ReconciliationError("movement_already_used");
    }
    throw error;
  }
}

export type BankPaymentClient = Pick<HoldedClient,
  "getEstimate" | "listNumberingSeries" | "readService" | "convertEstimateToInvoice" |
  "configureReserveInvoice" | "getInvoice" | "getInvoiceEvidence" | "approveInvoice" |
  "registerInvoicePayment" | "reconcileBankPayment" | "listBankMovements" |
  "listDelegateEmails" | "sendEstimate" | "sendInvoice">;

class PaymentOperationBlocked extends Error {
  constructor(readonly code: string) { super(code); }
}

async function readMovement(client: BankPaymentClient, input: {
  accountId: string; movementId: string; date: Date;
}) {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await client.listBankMovements({
      accountId: input.accountId, startDate: input.date.toISOString().slice(0, 10), cursor,
    });
    const row = result.items.find((item) => item.id === input.movementId);
    if (row) {
      const parsed = holdedBankMovementSchema.safeParse(row);
      if (!parsed.success) throw new PaymentOperationBlocked("invalid_remote_movement");
      return parsed.data;
    }
    if (!result.hasMore) break;
    if (!result.cursor || cursors.has(result.cursor)) throw new PaymentOperationBlocked("invalid_remote_cursor");
    cursors.add(result.cursor);
    cursor = result.cursor;
  }
  throw new PaymentOperationBlocked("remote_movement_missing");
}

export async function runBankPaymentJob(
  job: OutboxJob,
  overrides: { client?: BankPaymentClient; config?: HoldedConfig } = {},
): Promise<void> {
  const { operationId } = z.object({ operationId: z.string().min(1) }).strict().parse(job.payload);
  let operation = await db.bankPaymentOperation.findUniqueOrThrow({
    where: { id: operationId },
    include: { movement: { include: { account: true } }, bookingRequest: true },
  });
  if (["UNKNOWN", "BLOCKED", "COMPLETED"].includes(operation.status)) return;
  if (operation.status === "IN_FLIGHT") {
    await db.bankPaymentOperation.updateMany({
      where: { id: operationId, status: "IN_FLIGHT" }, data: { status: "UNKNOWN", lastFailureCode: "interrupted_mutation" },
    });
    logger.warn({ event: "bank_payment_unknown", operationId }, "Interrupted payment operation parked");
    return;
  }
  const { advanceCents, depositCents } = receivedInvoiceAmounts(operation.amountCents);
  const accountId = operation.movement.account.holdedAccountId;
  const bankInput = { accountId, movementId: operation.movement.holdedMovementId, date: operation.receivedAt };

  async function advance(stage: BankPaymentStage, data: { invoiceId?: string; collectionId?: string } = {}) {
    await db.$transaction(async (tx) => {
      const changed = await tx.bankPaymentOperation.updateMany({
        where: { id: operationId, stage: operation.stage, status: { in: ["IN_FLIGHT", "PENDING", "FAILED"] } },
        data: { stage, status: "PENDING", lastFailureCode: null, ...data },
      });
      if (changed.count !== 1) throw new PaymentOperationBlocked("operation_changed");
      operation = await tx.bankPaymentOperation.findUniqueOrThrow({
        where: { id: operationId },
        include: { movement: { include: { account: true } }, bookingRequest: true },
      });
    });
  }

  async function mutate(stage: BankPaymentStage, action: () => Promise<void | { id: string }>) {
    const claimed = await db.bankPaymentOperation.updateMany({
      where: { id: operationId, stage: operation.stage, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "IN_FLIGHT", attemptedAt: new Date(), lastFailureCode: null },
    });
    if (claimed.count !== 1) throw new PaymentOperationBlocked("operation_changed");
    try {
      const result = await action();
      await advance(stage, result ? { invoiceId: result.id } : {});
    } catch (error) {
      const definitive = error instanceof HoldedMutationError && error.outcome === "definitive_failure";
      await db.bankPaymentOperation.updateMany({
        where: { id: operationId, stage: operation.stage, status: "IN_FLIGHT" },
        data: {
          status: definitive ? "FAILED" : "UNKNOWN",
          lastFailureCode: error instanceof HoldedError ? error.code : "mutation_outcome_unknown",
        },
      });
      if (definitive) throw error;
      throw new PaymentOperationBlocked("mutation_outcome_unknown");
    }
  }

  async function complete() {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${operation.bookingRequestId} FOR UPDATE`;
      const currentBooking = await tx.bookingRequest.findUnique({
        where: { id: operation.bookingRequestId },
        select: { state: true },
      });
      if (!currentBooking || currentBooking.state !== "AWAITING_PAYMENT") {
        throw new BookingTransitionError("state_changed", "Booking changed before payment finalization");
      }
      const fresh = await tx.bankPaymentOperation.findUniqueOrThrow({ where: { id: operationId } });
      if (fresh.status === "COMPLETED") return;
      if (fresh.stage !== "SENT" || !["PENDING", "FAILED"].includes(fresh.status)) {
        throw new PaymentOperationBlocked("operation_changed");
      }
      const document = await tx.holdedDocument.findUnique({
        where: { bookingRequestId_type: { bookingRequestId: operation.bookingRequestId, type: "RESERVE_INVOICE" } },
        include: { delivery: { select: { status: true } } },
      });
      if (!document || document.holdedId !== fresh.invoiceId ||
          (!document.sentAt && document.delivery?.status !== "ACCEPTED")) {
        throw new PaymentOperationBlocked("delivery_not_verified");
      }
      const actor = await tx.user.findUnique({ where: { id: operation.actorUserId }, select: { id: true } });
      await tx.payment.create({
        data: { bookingRequestId: operation.bookingRequestId, bankMovementId: operation.movementId,
          amountCents: operation.amountCents, receivedAt: operation.receivedAt,
          reference: operation.reference, recordedById: actor?.id ?? null },
      });
      await enqueueGoogleCalendarBookingSync(operation.bookingRequestId, tx);
      const decidedAt = new Date();
      await tx.bankReconciliationProposal.updateMany({
        where: { bookingRequestId: operation.bookingRequestId, movementId: operation.movementId },
        data: { status: "CONFIRMED", decidedAt, decidedById: actor?.id ?? null },
      });
      await tx.bankReconciliationProposal.updateMany({
        where: { status: "PENDING", OR: [
          { bookingRequestId: operation.bookingRequestId }, { movementId: operation.movementId },
        ] },
        data: { status: "INVALIDATED", invalidatedAt: decidedAt, invalidationCode: "SIBLING_CONFIRMED" },
      });
      await tx.bankPaymentOperation.update({
        where: { id: operationId }, data: { stage: "COMPLETED", status: "COMPLETED", completedAt: decidedAt },
      });
    });
  }

  try {
    if (operation.stage === "SENT") {
      await complete();
      return;
    }
    const resolved = overrides.config ? { config: overrides.config, secret: "" } : await resolveIntegration("HOLDED");
    const client = overrides.client ?? createHoldedClient(resolved.secret, undefined, "banking.payment");
    const config = resolved.config;
    if (!config.advanceServiceId || !config.depositServiceId) throw new PaymentOperationBlocked("missing_invoice_services");
    const [advanceService, depositService] = await Promise.all([
      client.readService(config.advanceServiceId, { fresh: true }),
      client.readService(config.depositServiceId, { fresh: true }),
    ]);
    if (!advanceService.accountId || !depositService.accountId) throw new PaymentOperationBlocked("missing_invoice_accounts");
    async function verifyMovement(reconciled = false) {
      const movement = await readMovement(client, bankInput);
      if (movement.banking_account_id !== accountId || movement.currency !== "EUR" ||
          movement.amount !== (operation.amountCents / 100).toFixed(2) ||
          movement.booking_date.slice(0, 10) !== operation.receivedAt.toISOString().slice(0, 10) ||
          (movement.status === "reconciled") !== reconciled) {
        throw new PaymentOperationBlocked("remote_movement_changed");
      }
    }
    if (operation.stage === "PREPARED") {
      const [estimate, , series] = await Promise.all([
        client.getEstimate(operation.estimateId, { fresh: true }), verifyMovement(),
        client.listNumberingSeries("invoice"),
      ]);
      if (!estimate || estimate.contactId !== operation.contactId || estimate.draft !== false) {
        throw new PaymentOperationBlocked("estimate_not_approved");
      }
      const numberingSeriesId = series.find((item) => item.name.trim().toUpperCase() === "F")?.id;
      if (!numberingSeriesId) throw new PaymentOperationBlocked("missing_invoice_series");
      await mutate("CONVERTED", () => client.convertEstimateToInvoice({
        estimateId: operation.estimateId, date: operation.createdAt, numberingSeriesId,
      }));
    }
    const convertedInvoiceId = operation.invoiceId;
    if (!convertedInvoiceId) throw new PaymentOperationBlocked("invoice_missing");
    const invoiceId = convertedInvoiceId;
    async function verifyReceipt() {
      const paid = await client.getInvoiceEvidence(invoiceId);
      const receipt = paid.payments[0];
      if (paid.source?.id !== operation.estimateId || paid.source.doc_type !== "estimate" ||
          paid.draft || paid.paidCents !== operation.amountCents || paid.pendingCents !== 0 ||
          paid.payments.length !== 1 || !receipt || receipt.amountCents !== operation.amountCents ||
          receipt.bankId !== accountId || receipt.date !== operation.receivedAt.toISOString().slice(0, 10) ||
          (operation.collectionId !== null && operation.collectionId !== receipt.id)) {
        throw new PaymentOperationBlocked("payment_not_verified");
      }
      return receipt;
    }
    const expected = {
      contactId: operation.contactId,
      date: operation.createdAt.toISOString().slice(0, 10),
      dueDate: operation.createdAt.toISOString().slice(0, 10),
      totalCents: operation.amountCents,
      advance: { serviceId: config.advanceServiceId, accountId: advanceService.accountId, amountCents: advanceCents },
      deposit: { serviceId: config.depositServiceId, accountId: depositService.accountId, amountCents: depositCents },
    };
    const evidence = await client.getInvoiceEvidence(invoiceId);
    if (evidence.source?.id !== operation.estimateId || evidence.source.doc_type !== "estimate") {
      throw new PaymentOperationBlocked("invoice_source_mismatch");
    }
    if (operation.stage === "CONVERTED") {
      if (!evidence.draft || evidence.paidCents !== 0) throw new PaymentOperationBlocked("invoice_not_editable");
      const booking = operation.bookingRequest;
      await mutate("CONFIGURED", () => client.configureReserveInvoice(invoiceId, {
        contactId: operation.contactId, date: operation.createdAt, dueDate: operation.createdAt,
        description: stayDescription(booking.startDate, booking.endDate, billableHeadcount(booking.headcount),
          booking.boardType === "FULL_BOARD" ? "PC" : "DC"),
        notes: quoteNotes({
          startDate: booking.startDate, endDate: booking.endDate,
          headcount: billableHeadcount(booking.headcount), nights: countNights(booking.startDate, booking.endDate),
          advanceCents, depositCents, amountToConfirmCents: operation.amountCents,
        }),
        language: config.language, paymentMethodId: config.paymentMethodId,
        items: [
          { ...RECEIVED_ADVANCE_LINE, serviceId: config.advanceServiceId,
            units: 1, price: advanceCents / 100, taxes: ["s_iva_10"], accountId: expected.advance.accountId },
          { ...DEPOSIT_LINE, serviceId: config.depositServiceId,
            units: 1, price: depositCents / 100, taxes: ["s_iva_nosujeto"], accountId: expected.deposit.accountId },
        ],
      }));
    }
    const invoice = await client.getInvoice(invoiceId);
    if (!invoice || invoice.id !== invoiceId || !isCompatibleReserveInvoice(invoice, expected)) {
      throw new PaymentOperationBlocked("invoice_amounts_mismatch");
    }
    if (operation.stage === "CONFIGURED") {
      if (!evidence.draft || evidence.paidCents !== 0) throw new PaymentOperationBlocked("invoice_not_editable");
      await mutate("APPROVED", () => client.approveInvoice(invoiceId));
    }
    if (operation.stage === "APPROVED") {
      await verifyMovement();
      const before = await client.getInvoiceEvidence(invoiceId);
      if (before.draft || before.paidCents !== 0 || before.payments.length !== 0 ||
          before.pendingCents !== operation.amountCents) {
        throw new PaymentOperationBlocked("invoice_payment_conflict");
      }
      await mutate("PAID", () => client.registerInvoicePayment(invoiceId, {
        amountCents: operation.amountCents, accountId, date: operation.receivedAt,
      }));
    }
    if (operation.stage === "PAID") {
      await verifyMovement();
      const receipt = await verifyReceipt();
      await db.bankPaymentOperation.update({ where: { id: operationId }, data: { collectionId: receipt.id } });
      await mutate("RECONCILED", () => client.reconcileBankPayment({ ...bankInput, collectionId: receipt.id }));
    }
    if (operation.stage === "RECONCILED") {
      await verifyMovement(true);
      await verifyReceipt();
      const document = await db.holdedDocument.upsert({
        where: { bookingRequestId_type: { bookingRequestId: operation.bookingRequestId, type: "RESERVE_INVOICE" } },
        create: { bookingRequestId: operation.bookingRequestId, type: "RESERVE_INVOICE",
          holdedId: invoiceId, documentNumber: invoice.number, totalCents: operation.amountCents },
        update: {},
      });
      if (document.holdedId !== invoiceId) throw new PaymentOperationBlocked("local_invoice_conflict");
      const customer = await db.customer.findUniqueOrThrow({ where: { id: operation.bookingRequest.customerId } });
      if (customer.holdedContactId !== operation.contactId) throw new PaymentOperationBlocked("fiscal_contact_changed");
      await prepareDocumentDelivery(document.id, client);
      if (await deliverPreparedDocument(document.id, client, undefined, bookingManagementSubject(config.language)) !== "accepted") {
        throw new PaymentOperationBlocked("delivery_unknown");
      }
      await advance("SENT");
      await complete();
    }
  } catch (error) {
    if (error instanceof PaymentOperationBlocked && error.code === "operation_changed") return;
    if (error instanceof HoldedDeliveryError && error.deliveryOutcome === "unknown") {
      await db.bankPaymentOperation.updateMany({
        where: { id: operationId, status: { in: ["PENDING", "FAILED"] } },
        data: { status: "UNKNOWN", lastFailureCode: "delivery_unknown" },
      });
      logger.warn({ event: "bank_payment_delivery_unknown", operationId }, "Invoice delivery requires review");
      return;
    }
    if (error instanceof PaymentOperationBlocked) {
      await db.bankPaymentOperation.updateMany({
        where: { id: operationId, status: { notIn: ["UNKNOWN", "COMPLETED"] } },
        data: { status: error.code === "delivery_unknown" ? "UNKNOWN" : "BLOCKED", lastFailureCode: error.code },
      });
      logger.warn({ event: "bank_payment_blocked", operationId, code: error.code }, "Payment operation requires review");
      return;
    }
    logger.warn({ event: "bank_payment_failed", operationId,
      code: error instanceof HoldedError ? error.code : "unexpected" }, "Payment operation will retry");
    await db.bankPaymentOperation.updateMany({
      where: { id: operationId, status: { in: ["PENDING", "FAILED"] } },
      data: { status: job.attempts >= MAX_ATTEMPTS ? "BLOCKED" : "FAILED",
        lastFailureCode: error instanceof HoldedError ? error.code : "unexpected" },
    });
    throw error;
  }
}
