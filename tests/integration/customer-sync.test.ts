// @vitest-environment node
import "dotenv/config";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { claimCustomerRun, renewCustomerRun } from "@/modules/customers/services/management";

const ids: string[] = [];
afterAll(async () => { await db.customerSyncRun.deleteMany({ where: { id: { in: ids } } }); });

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== "true")("customer synchronization PostgreSQL fencing", () => {
  it("serializes competing claims and rejects old leases", async () => {
    const now = new Date();
    const claims = await Promise.allSettled([
      claimCustomerRun({ mode: "PREVIEW", version: "test", actorId: null }, now),
      claimCustomerRun({ mode: "PREVIEW", version: "test", actorId: null }, now),
    ]);
    const successful = claims.filter((claim) => claim.status === "fulfilled");
    expect(successful).toHaveLength(1);
    const run = successful[0].status === "fulfilled" ? successful[0].value! : null;
    if (!run) throw new Error("No acquired lease");
    ids.push(run.id);
    await expect(renewCustomerRun(run.id, "stale-token", now)).rejects.toThrow("lease_lost");
    await renewCustomerRun(run.id, run.leaseToken, now);
    const next = await claimCustomerRun({ mode: "PREVIEW", version: "test", actorId: null }, new Date(now.getTime() + 91_000));
    ids.push(next!.id);
    expect((await db.customerSyncRun.findUniqueOrThrow({ where: { id: run.id } })).failureCode).toBe("lease_expired");
    await expect(renewCustomerRun(run.id, run.leaseToken, new Date(now.getTime() + 91_000))).rejects.toThrow("lease_lost");
  });
});