import "server-only";

import { db } from "@/lib/db";

export type BankExpiryEvidence =
  | { ready: true; runId: string }
  | {
      ready: false;
      reason:
        | "not_configured"
        | "running"
        | "retrying"
        | "partial"
        | "failed"
        | "unavailable";
    };

interface ExpiryEvidenceOptions {
  clock?: () => Date;
}

async function inspectRun(
  runId: string,
  expiryAttemptStartedAt: Date,
): Promise<BankExpiryEvidence | null> {
  const run = await db.bankSyncRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      exhaustedAt: true,
    },
  });
  if (!run) return { ready: false, reason: "unavailable" };

  const fresh = Boolean(
    run.startedAt && run.startedAt >= expiryAttemptStartedAt,
  );
  if (run.status === "SUCCEEDED") {
    return fresh && run.exhaustedAt
      ? { ready: true, runId: run.id }
      : null;
  }
  if (run.status === "RETRYING") {
    return { ready: false, reason: "retrying" };
  }
  if (run.status === "PARTIAL" && fresh) {
    return { ready: false, reason: "partial" };
  }
  if (run.status === "FAILED" && fresh) {
    return { ready: false, reason: "failed" };
  }
  if (run.status === "QUEUED" || run.status === "RUNNING") {
    return { ready: false, reason: "running" };
  }
  return null;
}

export async function ensureFreshBankEvidenceForExpiry(
  expiryAttemptStartedAt: Date,
  options: ExpiryEvidenceOptions = {},
): Promise<BankExpiryEvidence> {
  void options;
  const account = await db.holdedTreasuryAccount.findFirst({
    where: { active: true },
    select: { id: true },
  });
  if (!account) return { ready: false, reason: "not_configured" };

  const latestRun = await db.bankSyncRun.findFirst({
    where: { accountId: account.id, trigger: "MANUAL" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return latestRun
    ? (await inspectRun(latestRun.id, expiryAttemptStartedAt)) ?? { ready: false, reason: "unavailable" }
    : { ready: false, reason: "unavailable" };
}