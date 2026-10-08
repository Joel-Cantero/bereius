"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireBookingActor, AuthorizationError } from "@/modules/booking/authorization";
import { saveIntegrationSettings } from "@/modules/booking/services/settings";
import { wordpressConfigSchema, delegateCommandSchema } from "../schema";
import { CustomerManagementError, runCustomerSync, verifyWordpressConnection, mutateCustomerDelegate, reserveCustomerAdminAttempt, finishCustomerAdminAttempt } from "../services/management";

export type CustomerActionState = { status: "idle" | "saved" | "verified" | "completed" } | { status: "error"; reason: "invalid" | "forbidden" | "connection" | "unknown" | "writes_disabled" | "preview_required" | "sync_busy" | "rate_limited" | "settings_changed" };

function publicError(error: unknown): CustomerActionState {
  if (error instanceof AuthorizationError) return { status: "error", reason: "forbidden" };
  if (error instanceof z.ZodError) return { status: "error", reason: "invalid" };
  if (error instanceof CustomerManagementError) {
    const reason = z.enum(["writes_disabled", "preview_required", "sync_busy", "rate_limited", "settings_changed"]).safeParse(error.code);
    return { status: "error", reason: reason.success ? reason.data : error.code === "outcome_unknown" ? "unknown" : "connection" };
  }
  return { status: "error", reason: "connection" };
}

async function perform(operation: string, callback: (actorId: string) => Promise<CustomerActionState>, audit = true): Promise<CustomerActionState> {
  let attemptId: string | undefined;
  try {
    const actor = await requireBookingActor("ADMINISTRATOR");
    if (audit) attemptId = (await reserveCustomerAdminAttempt(actor.userId, operation)).id;
    const result = await callback(actor.userId);
    if (attemptId) await finishCustomerAdminAttempt(attemptId, "succeeded");
    revalidatePath("/[locale]/customers", "page");
    revalidatePath("/[locale]/bookings/settings", "page");
    return result;
  } catch (error) {
    const result = publicError(error);
    if (attemptId) await finishCustomerAdminAttempt(attemptId, result.status === "error" ? result.reason : "failed").catch(() => undefined);
    revalidatePath("/[locale]/customers", "page");
    return result;
  }
}

export async function saveWordpressSettings(_previous: CustomerActionState, form: FormData): Promise<CustomerActionState> {
  return perform("configure", async (actorId) => {
    const config = wordpressConfigSchema.parse({ origin: form.get("origin"), username: form.get("username"), writesEnabled: form.get("writesEnabled") === "on", automaticSync: form.get("automaticSync") === "on" });
    const password = z.string().max(512).parse(form.get("password") ?? "").trim();
    await saveIntegrationSettings({ provider: "WORDPRESS", config, secret: password || undefined, updatedById: actorId });
    return { status: "saved" };
  });
}

export async function verifyWordpressAction(): Promise<CustomerActionState> {
  return perform("verify", async () => { await verifyWordpressConnection(); return { status: "verified" }; });
}

export async function synchronizeCustomersAction(_previous: CustomerActionState, form: FormData): Promise<CustomerActionState> {
  return perform("synchronize", async (actorId) => {
    await runCustomerSync(z.enum(["PREVIEW", "APPLY"]).parse(form.get("mode")), actorId);
    return { status: "completed" };
  });
}

export async function manageDelegateAction(_previous: CustomerActionState, form: FormData): Promise<CustomerActionState> {
  return perform("delegate", async (actorId) => {
    const command = delegateCommandSchema.parse({
      principal_id: Number(form.get("principal_id")), holded_contact_id: form.get("holded_contact_id"),
      delegate_id: form.has("delegate_id") ? Number(form.get("delegate_id")) : undefined,
      generation: form.has("generation") ? Number(form.get("generation")) : undefined,
      expected_status: form.get("expected_status") ?? undefined, action: form.get("action"),
      first_name: form.get("first_name") ?? undefined, last_name: form.get("last_name") ?? undefined,
      email: form.get("email") ?? undefined, phone: form.get("phone") ?? undefined,
    });
    await mutateCustomerDelegate(actorId, command);
    return { status: "saved" };
  }, false);
}