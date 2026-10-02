// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const providerMocks = vi.hoisted(() => ({
  createHoldedClient: vi.fn(),
  listBankMovements: vi.fn(),
  resolveIntegration: vi.fn(),
}));

vi.mock("@/lib/holded/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/holded/client")>();
  return { ...original, createHoldedClient: providerMocks.createHoldedClient };
});
vi.mock("@/modules/booking/services/settings", () => ({
  resolveIntegration: providerMocks.resolveIntegration,
}));

import { db } from "@/lib/db";
import { HoldedError } from "@/lib/holded/client";
import { BANK_SYNC_LEASE_MS } from "@/modules/banking/schema";
import { claimNextBankSync, enqueueBankSync, processBankSync } from "@/modules/banking/services/synchronization";
import { expireUnpaidBookings } from "@/modules/booking/services/expiry";
import { createBankingFixtureScope } from "../helpers/banking";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const scopes = new Set<ReturnType<typeof createBankingFixtureScope>>();
const attemptStartedAt = new Date("2026-09-16T18:00:00.000Z");

function fixtureScope(label: string) {
  const scope = createBankingFixtureScope(label);
  scopes.add(scope);
  return scope;
}

async function dueBooking(label: string, withAccount = true) {
  const scope = fixtureScope(label);
  const customer = await db.customer.create({ data: scope.customer() });
  const booking = await db.bookingRequest.create({
    data: {
      ...scope.booking(customer),
      paymentDueAt: new Date(attemptStartedAt.getTime() - 1),
    },
  });
  const accountData = scope.treasuryAccount();
  const account = withAccount
    ? await db.holdedTreasuryAccount.create({ data: accountData })
    : null;
  return { scope, booking, accountData, account };
}

async function bookingState(id: string) {
  return db.bookingRequest.findUniqueOrThrow({
    where: { id },
    select: { state: true },
  });
}

describe.skipIf(!runIntegrationTests)("bank-evidence booking expiry", () => {
  beforeEach(() => {
    providerMocks.resolveIntegration.mockResolvedValue({
      secret: "synthetic-expiry-credential",
    });
    providerMocks.createHoldedClient.mockReturnValue({
      listBankMovements: providerMocks.listBankMovements,
    });
    providerMocks.listBankMovements.mockResolvedValue({
      items: [],
      hasMore: false,
      cursor: null,
    });
  });

  afterEach(async () => {
    await Promise.all(
      [...scopes].map(async (scope) => {
        await scope.cleanup();
        scopes.delete(scope);
      }),
    );
    vi.clearAllMocks();
  });

  it("defers every due booking when no treasury account is configured", async () => {
    const { booking } = await dueBooking("bank-expiry-unconfigured", false);

    const summary = await expireUnpaidBookings(attemptStartedAt);

    expect(summary).toMatchObject({ examined: 1, expired: 0 });
    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
    expect(providerMocks.listBankMovements).not.toHaveBeenCalled();
  });

  it("defers after an older success without creating an automatic expiry scan", async () => {
    const { scope, booking, accountData, account } = await dueBooking(
      "bank-expiry-old-success",
    );
    if (!account) throw new Error("Expected a treasury account");
    await db.bankSyncRun.create({
      data: {
        ...scope.run(accountData, {
          status: "SUCCEEDED",
          exhaustedAt: new Date(attemptStartedAt.getTime() - 1),
          finishedAt: new Date(attemptStartedAt.getTime() - 1),
        }),
        startedAt: new Date(attemptStartedAt.getTime() - 1),
      },
    });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({ state: "AWAITING_PAYMENT" });
    const runs = await db.bankSyncRun.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "asc" },
      select: {
        trigger: true,
        status: true,
        startedAt: true,
        exhaustedAt: true,
      },
    });
    expect(runs).toHaveLength(1);
    expect(providerMocks.listBankMovements).not.toHaveBeenCalled();
  });

  it("does not let an older in-flight run authorize expiry", async () => {
    const { scope, booking, accountData } = await dueBooking(
      "bank-expiry-old-running",
    );
    await db.bankSyncRun.create({
      data: {
        ...scope.run(accountData, { status: "RUNNING" }),
        startedAt: new Date(attemptStartedAt.getTime() - 1),
        leaseToken: "synthetic-live-lease",
        leaseExpiresAt: new Date(
          attemptStartedAt.getTime() + BANK_SYNC_LEASE_MS,
        ),
        heartbeatAt: attemptStartedAt,
        attemptCount: 1,
      },
    });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
    expect(providerMocks.listBankMovements).not.toHaveBeenCalled();
  });

  it("defers on provider outage and leaves the durable run retrying", async () => {
    const { scope, booking, accountData, account } = await dueBooking("bank-expiry-outage");
    if (!account) throw new Error("Expected a treasury account");
    await db.bankSyncRun.create({ data: {
      ...scope.run(accountData, { status: "RETRYING" }), startedAt: attemptStartedAt,
      failureCode: "PROVIDER_UNAVAILABLE",
    } });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
    await expect(
      db.bankSyncRun.findFirstOrThrow({
        where: { accountId: account.id },
        select: { trigger: true, status: true, failureCode: true },
      }),
    ).resolves.toEqual({
      trigger: "MANUAL",
      status: "RETRYING",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("defers after an exhausted scan containing invalid-item incidents", async () => {
    const { scope, booking, accountData, account } = await dueBooking(
      "bank-expiry-partial",
    );
    if (!account) throw new Error("Expected a treasury account");
    await db.bankSyncRun.create({ data: {
      ...scope.run(accountData, { status: "PARTIAL", exhaustedAt: attemptStartedAt }),
      startedAt: attemptStartedAt, incidentCount: 1,
    } });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
    await expect(
      db.bankSyncRun.findFirstOrThrow({
        where: { accountId: account.id },
        select: { status: true, exhaustedAt: true, incidentCount: true },
      }),
    ).resolves.toMatchObject({
      status: "PARTIAL",
      exhaustedAt: expect.any(Date),
      incidentCount: 1,
    });
  });

  it("defers when a malformed page makes the fresh run fail", async () => {
    const { scope, booking, accountData, account } = await dueBooking("bank-expiry-failed");
    if (!account) throw new Error("Expected a treasury account");
    await db.bankSyncRun.create({ data: {
      ...scope.run(accountData, { status: "FAILED" }), startedAt: attemptStartedAt,
      failureCode: "MISSING_CURSOR",
    } });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
    await expect(
      db.bankSyncRun.findFirstOrThrow({
        where: { accountId: account.id },
        select: { status: true, failureCode: true },
      }),
    ).resolves.toEqual({ status: "FAILED", failureCode: "MISSING_CURSOR" });
  });

  it("accepts a clean exhausted run first leased exactly at the attempt boundary", async () => {
    const { scope, booking, accountData } = await dueBooking(
      "bank-expiry-fresh-boundary",
    );
    await db.bankSyncRun.create({
      data: {
        ...scope.run(accountData, {
          status: "SUCCEEDED",
          exhaustedAt: attemptStartedAt,
          finishedAt: attemptStartedAt,
        }),
        startedAt: attemptStartedAt,
      },
    });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({ state: "EXPIRED" });
    expect(providerMocks.listBankMovements).not.toHaveBeenCalled();
  });

  it("evaluates a successfully retried manual scan without expiring bookings due after its start", async () => {
    const { scope, booking, account } = await dueBooking("bank-expiry-manual-retry");
    if (!account) throw new Error("Expected a treasury account");
    const laterCustomer = await db.customer.create({ data: scope.customer() });
    const laterBooking = await db.bookingRequest.create({ data: {
      ...scope.booking(laterCustomer),
      paymentDueAt: new Date(attemptStartedAt.getTime() + 30 * 60_000),
    } });
    const completedAt = new Date(attemptStartedAt.getTime() + 60 * 60_000);
    const requested = await enqueueBankSync({ accountId: account.id, trigger: "MANUAL", now: attemptStartedAt });
    const firstLease = await claimNextBankSync(attemptStartedAt);
    if (!firstLease) throw new Error("Expected first manual lease");
    providerMocks.listBankMovements.mockRejectedValueOnce(new HoldedError("unavailable", "Synthetic outage"));
    await expect(processBankSync(firstLease, { now: () => attemptStartedAt })).rejects.toBeInstanceOf(HoldedError);
    await expireUnpaidBookings(attemptStartedAt, requested.runId);
    expect(await bookingState(booking.id)).toEqual({ state: "AWAITING_PAYMENT" });
    const retryLease = await claimNextBankSync(completedAt);
    if (!retryLease) throw new Error("Expected manual retry lease");
    await processBankSync(retryLease, { now: () => completedAt });
    await expireUnpaidBookings(completedAt, requested.runId);
    expect(await bookingState(booking.id)).toEqual({ state: "EXPIRED" });
    expect(await bookingState(laterBooking.id)).toEqual({ state: "AWAITING_PAYMENT" });
    expect(await db.bankSyncRun.count({ where: { accountId: account.id } })).toBe(1);
    expect(providerMocks.listBankMovements).toHaveBeenCalledTimes(2);
  });

  it("cannot authorize expiry using a completed legacy scheduled scan", async () => {
    const { scope, booking, accountData } = await dueBooking("bank-expiry-legacy-success");
    const legacy = await db.bankSyncRun.create({ data: {
      ...scope.run(accountData, { trigger: "SCHEDULED", status: "SUCCEEDED", exhaustedAt: attemptStartedAt }),
      startedAt: attemptStartedAt,
    } });
    await expireUnpaidBookings(attemptStartedAt, legacy.id);
    expect(await bookingState(booking.id)).toEqual({ state: "AWAITING_PAYMENT" });
    expect(providerMocks.listBankMovements).not.toHaveBeenCalled();
  });

  it.each(["RETRYING", "PARTIAL", "FAILED"] as const)(
    "rejects a fresh %s run",
    async (status) => {
      const { scope, booking, accountData } = await dueBooking(
        `bank-expiry-${status.toLowerCase()}`,
      );
      await db.bankSyncRun.create({
        data: {
          ...scope.run(accountData, {
            status,
            exhaustedAt: status === "PARTIAL" ? attemptStartedAt : null,
            finishedAt: status === "RETRYING" ? null : attemptStartedAt,
          }),
          startedAt: attemptStartedAt,
          failureCode:
            status === "PARTIAL" ? null : "PROVIDER_UNAVAILABLE",
        },
      });

      await expireUnpaidBookings(attemptStartedAt);

      await expect(bookingState(booking.id)).resolves.toEqual({
        state: "AWAITING_PAYMENT",
      });
    },
  );

  it("rechecks a booking that changes state while the fresh scan runs", async () => {
    const { booking, account } = await dueBooking("bank-expiry-concurrent-state");
    if (!account) throw new Error("Expected a treasury account");
    providerMocks.listBankMovements.mockImplementation(async () => {
      await db.bookingRequest.update({
        where: { id: booking.id },
        data: { state: "CONFIRMED" },
      });
      return { items: [], hasMore: false, cursor: null };
    });

    await enqueueBankSync({ accountId: account.id, trigger: "MANUAL", now: attemptStartedAt });
    const lease = await claimNextBankSync(attemptStartedAt);
    if (!lease) throw new Error("Expected a manual bank scan");
    await processBankSync(lease, { now: () => attemptStartedAt });
    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({ state: "CONFIRMED" });
  });

  it("defers a due booking with a pending reconciliation proposal", async () => {
    const { scope, booking, accountData } = await dueBooking(
      "bank-expiry-pending-proposal",
    );
    await db.bankSyncRun.create({
      data: {
        ...scope.run(accountData, {
          status: "SUCCEEDED",
          exhaustedAt: attemptStartedAt,
          finishedAt: attemptStartedAt,
        }),
        startedAt: attemptStartedAt,
      },
    });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData),
    });
    await db.bankReconciliationProposal.create({
      data: {
        movementId: movement.id,
        bookingRequestId: booking.id,
        status: "PENDING",
      },
    });

    await expireUnpaidBookings(attemptStartedAt);

    await expect(bookingState(booking.id)).resolves.toEqual({
      state: "AWAITING_PAYMENT",
    });
  });
});