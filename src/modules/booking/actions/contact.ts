"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { GravityFormsError } from "@/lib/gravity-forms/client";
import { HoldedError } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import {
  changeBookingCustomer,
  ContactSyncError,
  createCustomerContact,
  type CustomerCandidate,
  findBookingCustomerCandidate,
  linkExistingEstimate,
  updateCustomerContact,
} from "@/modules/booking/services/contact-sync";
import { IntegrationSettingsError } from "@/modules/booking/services/settings";

type ContactErrorReason =
  | "unauthenticated"
  | "forbidden"
  | "invalid"
  | "authentication"
  | "connection"
  | "not_found"
  | "rejected"
  | "customer_not_found"
  | "customer_without_email"
  | "state_changed"
  | "unknown";

export type ContactActionState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; reason: ContactErrorReason };

export type CustomerLookupState =
  | { status: "idle" }
  | ({ status: "found" } & CustomerCandidate)
  | { status: "error"; reason: ContactErrorReason };

const bookingSchema = z.object({ bookingRequestId: z.string().min(1) });
const linkSchema = bookingSchema.extend({
  // A 24-character ObjectId, so a stray value never reaches Holded.
  holdedId: z.string().trim().regex(/^[0-9a-f]{24}$/u),
});
const customerSchema = bookingSchema.extend({
  taxId: z.string().trim().min(1).max(32),
});

function toErrorState(error: unknown): { status: "error"; reason: ContactErrorReason } {
  if (error instanceof AuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof ContactSyncError) {
    if (error.code === "customer_not_found" || error.code === "customer_without_email") {
      return { status: "error", reason: error.code };
    }
    if (error.code === "customer_locked") {
      return { status: "error", reason: "state_changed" };
    }
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof z.ZodError) {
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof IntegrationSettingsError) {
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof HoldedError || error instanceof GravityFormsError) {
    if (error.code === "unauthorized") return { status: "error", reason: "authentication" };
    if (error.code === "not_found") return { status: "error", reason: "not_found" };
    return {
      status: "error",
      reason:
        error.code === "unavailable" || error.code === "rate_limited"
          ? "connection"
          : "rejected",
    };
  }
  return { status: "error", reason: "unknown" };
}

function refresh(bookingRequestId: string) {
  revalidatePath(`/bookings/${bookingRequestId}`);
}

async function run(
  event: string,
  bookingRequestId: string,
  work: () => Promise<void>,
): Promise<ContactActionState> {
  try {
    await work();
    refresh(bookingRequestId);
    return { status: "done" };
  } catch (error) {
    const state = toErrorState(error);
    logger.warn({ event, bookingRequestId, reason: state.reason }, "holded contact action failed");
    return state;
  }
}

export async function createContactAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    await requireBookingActor();
    const { bookingRequestId } = bookingSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
    });

    return await run("booking_contact_create_failed", bookingRequestId, () =>
      createCustomerContact(bookingRequestId),
    );
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateContactAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    await requireBookingActor();
    const { bookingRequestId } = bookingSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
    });

    return await run("booking_contact_update_failed", bookingRequestId, () =>
      updateCustomerContact(bookingRequestId),
    );
  } catch (error) {
    return toErrorState(error);
  }
}

export async function linkEstimateAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    const actor = await requireBookingActor();
    const { bookingRequestId, holdedId } = linkSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      holdedId: formData.get("holdedId"),
    });

    return await run("booking_estimate_link_failed", bookingRequestId, async () => {
      await linkExistingEstimate(bookingRequestId, holdedId, actor.userId);
      // The same link is shown from the contract side, which must not go stale.
      revalidatePath("/contracts");
      revalidatePath(`/contracts/${holdedId}`);
    });
  } catch (error) {
    return toErrorState(error);
  }
}

export async function findCustomerAction(
  _previous: CustomerLookupState,
  formData: FormData,
): Promise<CustomerLookupState> {
  try {
    await requireBookingActor();
    const { bookingRequestId, taxId } = customerSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      taxId: formData.get("taxId"),
    });

    return {
      status: "found",
      ...(await findBookingCustomerCandidate(bookingRequestId, taxId)),
    };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function changeCustomerAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    const actor = await requireBookingActor();
    const { bookingRequestId, taxId } = customerSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      taxId: formData.get("taxId"),
    });

    return await run("booking_customer_change_failed", bookingRequestId, async () => {
      await changeBookingCustomer(bookingRequestId, taxId, actor.userId);
      // The customer's name heads the detail page and the queue, in every locale.
      revalidatePath("/[locale]/(console)/bookings/[id]", "page");
      revalidatePath("/[locale]/(console)/bookings", "page");
    });
  } catch (error) {
    return toErrorState(error);
  }
}
