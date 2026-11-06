import "server-only";

import { db } from "@/lib/db";
import {
  isAutomaticReconciliationMatch,
  isBookingPaymentCandidate,
} from "@/modules/banking/services/payment-matching";
import { beginBankPayment } from "@/modules/banking/services/payment-operation";
import { ReconciliationError } from "@/modules/banking/services/reconciliation-error";
import type { BookingTransactionClient } from "@/modules/booking/services/lifecycle";

export { ReconciliationError } from "@/modules/banking/services/reconciliation-error";

export interface ReconciliationScanResult {
  createdCount: number;
  invalidatedCount: number;
  incidentCount: number;
}

const matchingBookingSelect = {
  id: true,
  state: true,
  decidedAt: true,
  advanceCents: true,
  depositCents: true,
  documents: {
    where: { type: "ESTIMATE" as const },
    take: 1,
    select: { documentNumber: true, issuedAt: true },
  },
} as const;

export async function reconcileBankMovements(
  movementIds: string[],
  transaction?: BookingTransactionClient,
  incidentContext?: { runId: string; pageNumber: number },
): Promise<ReconciliationScanResult> {
  const uniqueMovementIds = [...new Set(movementIds)];
  if (uniqueMovementIds.length === 0) {
    return { createdCount: 0, invalidatedCount: 0, incidentCount: 0 };
  }
  const apply = async (tx: BookingTransactionClient): Promise<ReconciliationScanResult> => {
    const [movements, candidateBookings] = await Promise.all([
      tx.bankMovement.findMany({
        where: { id: { in: uniqueMovementIds } },
        select: {
          id: true, holdedMovementId: true, direction: true, amountMinor: true,
          currency: true, narrative: true, bookingDate: true,
          payment: { select: { id: true, bookingRequestId: true, amountCents: true, receivedAt: true, reference: true } },
          paymentOperation: { select: { id: true } },
          proposals: { select: {
            id: true, status: true, bookingRequestId: true,
            bookingRequest: { select: matchingBookingSelect },
          } },
        },
      }),
      tx.bookingRequest.findMany({
        where: { state: "AWAITING_PAYMENT", bankPaymentOperation: null },
        select: matchingBookingSelect,
      }),
    ]);
    const proposalsToCreate: Array<{ movementId: string; bookingRequestId: string }> = [];
    const proposalsToInvalidate: string[] = [];
    const correctionIncidents: Array<{
      runId: string; code: "CONFIRMED_MATCH_CHANGED"; pageNumber: number;
      itemIndex: null; holdedMovementId: string;
    }> = [];
    for (const movement of movements) {
      const existingByBooking = new Map(
        movement.proposals.map((proposal) => [proposal.bookingRequestId, proposal]),
      );
      for (const proposal of movement.proposals) {
        const confirmedMatch = movement.payment !== null &&
          movement.payment.bookingRequestId === proposal.bookingRequestId &&
          movement.amountMinor === BigInt(movement.payment.amountCents) &&
          movement.direction === "INCOME" && movement.currency === "EUR" &&
          movement.bookingDate.getTime() === movement.payment.receivedAt.getTime() &&
          movement.narrative === movement.payment.reference;
        if (proposal.status === "PENDING" && !movement.paymentOperation &&
            (movement.payment !== null || proposal.bookingRequest.state !== "AWAITING_PAYMENT" ||
            !isAutomaticReconciliationMatch(movement, proposal.bookingRequest))) {
          proposalsToInvalidate.push(proposal.id);
        }
        if (proposal.status === "CONFIRMED" &&
            !confirmedMatch && incidentContext) {
          correctionIncidents.push({
            runId: incidentContext.runId, code: "CONFIRMED_MATCH_CHANGED",
            pageNumber: incidentContext.pageNumber, itemIndex: null,
            holdedMovementId: movement.holdedMovementId,
          });
        }
      }
      if (movement.payment || movement.paymentOperation) continue;
      for (const booking of candidateBookings) {
        if (!existingByBooking.has(booking.id) && isAutomaticReconciliationMatch(movement, booking)) {
          proposalsToCreate.push({ movementId: movement.id, bookingRequestId: booking.id });
        }
      }
    }
    const [created, invalidated] = await Promise.all([
      proposalsToCreate.length
        ? tx.bankReconciliationProposal.createMany({ data: proposalsToCreate, skipDuplicates: true })
        : Promise.resolve({ count: 0 }),
      proposalsToInvalidate.length
        ? tx.bankReconciliationProposal.updateMany({
          where: { id: { in: proposalsToInvalidate }, status: "PENDING" },
          data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidationCode: "MOVEMENT_INELIGIBLE" },
        }) : Promise.resolve({ count: 0 }),
    ]);
    if (correctionIncidents.length) await tx.bankSyncIncident.createMany({ data: correctionIncidents });
    return { createdCount: created.count, invalidatedCount: invalidated.count, incidentCount: correctionIncidents.length };
  };
  return transaction ? apply(transaction) : db.$transaction(apply);
}

export async function confirmReconciliationProposal(command: {
  proposalId: string; actorUserId: string; now?: Date;
}): Promise<{ bookingRequestId: string }> {
  const proposal = await db.bankReconciliationProposal.findUnique({ where: { id: command.proposalId } });
  if (!proposal) throw new ReconciliationError("not_found");
  if (proposal.status !== "PENDING") throw new ReconciliationError("proposal_changed");
  return beginBankPayment({
    bookingRequestId: proposal.bookingRequestId, movementId: proposal.movementId,
    actorUserId: command.actorUserId, strict: true,
  });
}

export async function confirmBookingPaymentCandidate(command: {
  bookingRequestId: string; movementId: string; actorUserId: string; now?: Date;
}): Promise<{ bookingRequestId: string }> {
  return beginBankPayment(command);
}

export async function dismissBookingPaymentCandidate(command: {
  bookingRequestId: string; movementId: string; actorUserId: string; now?: Date;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${command.bookingRequestId} FOR UPDATE`;
    const [booking, movement] = await Promise.all([
      tx.bookingRequest.findUnique({
        where: { id: command.bookingRequestId },
        select: { ...matchingBookingSelect, bankPaymentOperation: { select: { id: true } } },
      }),
      tx.bankMovement.findUnique({
        where: { id: command.movementId },
        select: {
          direction: true, amountMinor: true, currency: true, narrative: true, bookingDate: true,
          payment: { select: { id: true } }, paymentOperation: { select: { id: true } },
        },
      }),
    ]);
    if (!booking || !movement) throw new ReconciliationError("not_found");
    if (booking.bankPaymentOperation || movement.paymentOperation || movement.payment ||
        !isBookingPaymentCandidate(movement, booking)) throw new ReconciliationError("movement_ineligible");
    const proposal = await tx.bankReconciliationProposal.upsert({
      where: { movementId_bookingRequestId: { movementId: command.movementId, bookingRequestId: command.bookingRequestId } },
      update: {}, create: { movementId: command.movementId, bookingRequestId: command.bookingRequestId },
    });
    if (proposal.status !== "PENDING") throw new ReconciliationError("proposal_changed");
    const dismissed = await tx.bankReconciliationProposal.updateMany({
      where: { id: proposal.id, status: "PENDING" },
      data: { status: "DISMISSED", decidedById: command.actorUserId, decidedAt: command.now ?? new Date() },
    });
    if (dismissed.count !== 1) throw new ReconciliationError("proposal_changed");
  });
}

export async function dismissReconciliationProposal(command: {
  proposalId: string; actorUserId: string; now?: Date;
}): Promise<void> {
  const proposal = await db.bankReconciliationProposal.findUnique({ where: { id: command.proposalId } });
  if (!proposal) throw new ReconciliationError("not_found");
  return dismissBookingPaymentCandidate({ ...command, bookingRequestId: proposal.bookingRequestId, movementId: proposal.movementId });
}
