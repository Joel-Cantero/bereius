"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logger } from "@/lib/logger";
import {
  BankingAuthorizationError,
  requireBankingActor,
} from "@/modules/banking/authorization";
import {
  bookingPaymentCandidateActionInputSchema,
  proposalActionInputSchema,
} from "@/modules/banking/schema";
import {
  confirmBookingPaymentCandidate,
  confirmReconciliationProposal,
  dismissBookingPaymentCandidate,
  dismissReconciliationProposal,
  ReconciliationError,
} from "@/modules/banking/services/reconciliation";
import type { ReconciliationActionState } from "@/modules/banking/types";
import type { MovementCandidatesResult } from "@/modules/banking/types";
import { listMovementBookingCandidates } from "@/modules/banking/services/queries";

export type { ReconciliationActionState } from "@/modules/banking/types";

export async function movementBookingCandidatesAction(input: unknown): Promise<MovementCandidatesResult> {
  try {
    await requireBankingActor();
    const parsed = z.object({
      movementId: z.string().min(1).max(191),
      page: z.number().int().min(1).max(10_000),
    }).strict().safeParse(input);
    if (!parsed.success) {
      logger.warn({ event: "bank_candidates_invalid" }, "Invalid candidate query");
      return { status: "error", reason: "unavailable" };
    }
    return await listMovementBookingCandidates(parsed.data.movementId, parsed.data.page);
  } catch (error) {
    logger.warn({ event: "bank_candidates_failed",
      reason: error instanceof BankingAuthorizationError ? error.code : "unavailable" }, "Candidate query failed");
    return { status: "error", reason: error instanceof BankingAuthorizationError ? "forbidden" : "unavailable" };
  }
}

function errorState(error: unknown): ReconciliationActionState {
  if (error instanceof BankingAuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof ReconciliationError) {
    return { status: "error", reason: error.code };
  }
  return { status: "error", reason: "unknown" };
}

function parseProposalId(formData: FormData) {
  return proposalActionInputSchema.safeParse({
    proposalId: formData.get("proposalId"),
  });
}

function parseBookingCandidate(formData: FormData) {
  return bookingPaymentCandidateActionInputSchema.safeParse({
    bookingRequestId: formData.get("bookingRequestId"),
    movementId: formData.get("movementId"),
  });
}

export async function confirmBookingPaymentCandidateAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseBookingCandidate(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const result = await confirmBookingPaymentCandidate({
      ...parsed.data,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath("/bookings");
    revalidatePath(`/bookings/${result.bookingRequestId}`);
    return { status: "processing", bookingRequestId: result.bookingRequestId };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_booking_candidate_confirm_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "booking payment candidate confirmation refused",
    );
    return state;
  }
}

export async function dismissBookingPaymentCandidateAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseBookingCandidate(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    await dismissBookingPaymentCandidate({
      ...parsed.data,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath(`/bookings/${parsed.data.bookingRequestId}`);
    return { status: "dismissed" };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_booking_candidate_dismiss_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "booking payment candidate dismissal refused",
    );
    return state;
  }
}

export async function confirmReconciliationProposalAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseProposalId(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const result = await confirmReconciliationProposal({
      proposalId: parsed.data.proposalId,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath("/bookings");
    revalidatePath(`/bookings/${result.bookingRequestId}`);
    return { status: "processing", bookingRequestId: result.bookingRequestId };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_reconciliation_confirm_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "bank reconciliation confirmation refused",
    );
    return state;
  }
}

export async function dismissReconciliationProposalAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseProposalId(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    await dismissReconciliationProposal({
      proposalId: parsed.data.proposalId,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    return { status: "dismissed" };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_reconciliation_dismiss_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "bank reconciliation dismissal refused",
    );
    return state;
  }
}