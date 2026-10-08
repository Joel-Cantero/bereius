import "server-only";

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { createHoldedClient } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { resolveIntegration } from "@/modules/booking/services/settings";
import { delegateCommandSchema, wordpressConfigSchema } from "../schema";
import { reconcileCustomers, type CustomerChange } from "../reconciliation";
import { createWordpressClient, WordpressError } from "../wordpress";

const LEASE_MS = 90_000;
const DAY_MS = 86_400_000;

export class CustomerManagementError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CustomerManagementError"; }
}

async function connectionVersion() {
  const rows = await db.integrationSettings.findMany({ where: { provider: { in: ["WORDPRESS", "HOLDED"] } }, select: { provider: true, updatedAt: true, verifiedAt: true, config: true } });
  const wordpress = rows.find((row) => row.provider === "WORDPRESS");
  const holded = rows.find((row) => row.provider === "HOLDED");
  if (!wordpress || !holded) throw new CustomerManagementError("not_configured");
  return { version: `${wordpress.updatedAt.toISOString()}:${holded.updatedAt.toISOString()}`, verified: wordpress.verifiedAt !== null, config: wordpressConfigSchema.parse(wordpress.config) };
}

export async function claimCustomerRun(input: { mode: "PREVIEW" | "APPLY"; version: string; actorId: string | null; automatic?: boolean }, now = new Date()) {
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('customer-account-sync'))`;
    await transaction.customerSyncRun.updateMany({ where: { status: "RUNNING", leaseExpiresAt: { lte: now } }, data: { status: "FAILED", failureCode: "lease_expired", finishedAt: now } });
    if (await transaction.customerSyncRun.findFirst({ where: { status: "RUNNING" }, select: { id: true } })) {
      throw new CustomerManagementError("sync_busy");
    }
    if (input.automatic && await transaction.customerSyncRun.findFirst({ where: { mode: "APPLY", startedAt: { gt: new Date(now.getTime() - DAY_MS) } }, select: { id: true } })) return null;
    return transaction.customerSyncRun.create({ data: { mode: input.mode, requestedById: input.actorId, settingsVersion: input.version, leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now } });
  });
}

export async function renewCustomerRun(id: string, token: string, now = new Date()) {
  const result = await db.customerSyncRun.updateMany({ where: { id, leaseToken: token, status: "RUNNING", leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
  if (result.count !== 1) throw new CustomerManagementError("lease_lost");
}

function safeResults(changes: CustomerChange[]) {
  return changes.map(({ contactId, principalId, kind, reason }) => ({ contactId: /^[a-f0-9]{24}$/u.test(contactId) ? contactId : "invalid", ...(principalId === undefined ? {} : { principalId }), kind, ...(reason === undefined ? {} : { reason }) }));
}

export async function runCustomerSync(mode: "PREVIEW" | "APPLY", actorId: string | null, automatic = false) {
  const settings = await connectionVersion();
  if (automatic && (!settings.config.automaticSync || !settings.config.writesEnabled || !settings.verified)) return null;
  if (mode === "APPLY") {
    if (!settings.config.writesEnabled || !settings.verified) throw new CustomerManagementError("writes_disabled");
    const preview = await db.customerSyncRun.findFirst({ where: { mode: "PREVIEW", status: "SUCCEEDED", settingsVersion: settings.version, ...(automatic ? {} : { startedAt: { gt: new Date(Date.now() - DAY_MS) } }) }, select: { id: true } });
    if (!preview) throw new CustomerManagementError("preview_required");
  }
  const run = await claimCustomerRun({ mode, version: settings.version, actorId, automatic });
  if (!run) return null;
  let changes: CustomerChange[] = [];
  try {
    const [wordpress, holded] = await Promise.all([resolveIntegration("WORDPRESS"), resolveIntegration("HOLDED")]);
    const client = createWordpressClient(wordpress.config, wordpress.secret);
    const contacts = await createHoldedClient(holded.secret).listFiscalContacts();
    await renewCustomerRun(run.id, run.leaseToken);
    const principals = await client.listPrincipals();
    await renewCustomerRun(run.id, run.leaseToken);
    if ((await connectionVersion()).version !== settings.version) throw new CustomerManagementError("settings_changed");
    changes = reconcileCustomers(contacts, principals);
    if (mode === "APPLY") {
      const writes = changes.filter((change) => change.kind === "create" || change.kind === "update");
      if (writes.length > 100) throw new CustomerManagementError("batch_limit");
      for (const change of writes) {
        const current = await connectionVersion();
        if (current.version !== settings.version || !current.config.writesEnabled || !current.verified) throw new CustomerManagementError("settings_changed");
        await renewCustomerRun(run.id, run.leaseToken);
        const saved = await client.savePrincipal(change.payload);
        if (saved.holded_contact_id !== change.contactId || !saved.managed || saved.email !== change.payload!.email
          || Object.entries(change.payload!.meta).some(([key, value]) => saved.meta[key] !== value)) throw new CustomerManagementError("readback_mismatch");
        change.principalId = saved.id;
      }
    }
    await renewCustomerRun(run.id, run.leaseToken);
    if ((await connectionVersion()).version !== settings.version) throw new CustomerManagementError("settings_changed");
    const final = await db.customerSyncRun.updateMany({ where: { id: run.id, leaseToken: run.leaseToken, status: "RUNNING", leaseExpiresAt: { gt: new Date() } }, data: { status: "SUCCEEDED", results: safeResults(changes), finishedAt: new Date() } });
    if (!final.count) throw new CustomerManagementError("lease_lost");
    logger.info({ event: "customer_sync_completed", runId: run.id, mode, count: changes.length }, "Customer reconciliation completed");
    return run.id;
  } catch (error) {
    const failureCode = error instanceof CustomerManagementError || error instanceof WordpressError ? error.code : "provider_unavailable";
    await db.customerSyncRun.updateMany({ where: { id: run.id, leaseToken: run.leaseToken, status: "RUNNING" }, data: { status: "FAILED", failureCode, results: safeResults(changes), finishedAt: new Date() } });
    logger.warn({ event: "customer_sync_failed", runId: run.id, mode, failureCode }, "Customer reconciliation failed");
    throw new CustomerManagementError(failureCode);
  }
}

export async function runAutomaticCustomerSync() {
  const configured = await db.integrationSettings.findUnique({ where: { provider: "WORDPRESS" }, select: { config: true } });
  const parsed = wordpressConfigSchema.safeParse(configured?.config);
  if (!parsed.success || !parsed.data.automaticSync || !parsed.data.writesEnabled) return { processed: false };
  const runId = await runCustomerSync("APPLY", null, true);
  return { processed: runId !== null, runId };
}

export async function getCustomerDirectory() {
  const integration = await resolveIntegration("WORDPRESS");
  return createWordpressClient(integration.config, integration.secret).listPrincipals();
}

export async function getCustomerDelegates(principalId: number, contactId: string) {
  const integration = await resolveIntegration("WORDPRESS");
  return createWordpressClient(integration.config, integration.secret).getDelegates(principalId, contactId);
}

export async function verifyWordpressConnection() {
  const settings = await db.integrationSettings.findUnique({ where: { provider: "WORDPRESS" }, select: { updatedAt: true } });
  if (!settings) throw new CustomerManagementError("not_configured");
  await getCustomerDirectory();
  const result = await db.integrationSettings.updateMany({ where: { provider: "WORDPRESS", updatedAt: settings.updatedAt }, data: { verifiedAt: new Date() } });
  if (result.count !== 1) throw new CustomerManagementError("settings_changed");
}

export async function reserveCustomerAdminAttempt(actorId: string, operation: string, principalId?: number, delegateId?: number) {
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'customer-admin:' + actorId}))`;
    const count = await transaction.customerAdminEvent.count({ where: { actorId, createdAt: { gt: new Date(Date.now() - 300_000) } } });
    if (count >= 20) throw new CustomerManagementError("rate_limited");
    return transaction.customerAdminEvent.create({ data: { actorId, operation, principalId, delegateId, outcome: "attempted" } });
  });
}

export async function finishCustomerAdminAttempt(id: string, outcome: string) {
  await db.customerAdminEvent.update({ where: { id }, data: { outcome } });
}

export async function mutateCustomerDelegate(actorId: string, input: unknown) {
  const command = delegateCommandSchema.parse(input);
  const attempt = await reserveCustomerAdminAttempt(actorId, command.action, command.principal_id, command.delegate_id);
  try {
    const integration = await resolveIntegration("WORDPRESS");
    const client = createWordpressClient(integration.config, integration.secret);
    await client.mutateDelegate(command);
    const delegates = await client.getDelegates(command.principal_id, command.holded_contact_id);
    await db.customerAdminEvent.update({ where: { id: attempt.id }, data: { outcome: "succeeded" } });
    return delegates;
  } catch (error) {
    const outcome = error instanceof WordpressError ? error.code : "provider_unavailable";
    await db.customerAdminEvent.update({ where: { id: attempt.id }, data: { outcome } });
    throw new CustomerManagementError(outcome);
  }
}

export async function customerRunHistory() {
  return db.customerSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20, select: { id: true, mode: true, status: true, results: true, failureCode: true, startedAt: true, finishedAt: true } });
}

export async function retainCustomerHistory() {
  const before = new Date(Date.now() - 90 * DAY_MS);
  await db.$transaction([
    db.customerSyncRun.deleteMany({ where: { status: { not: "RUNNING" }, startedAt: { lt: before } } }),
    db.customerAdminEvent.deleteMany({ where: { createdAt: { lt: before } } }),
  ]);
}