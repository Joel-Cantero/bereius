import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";

import caMessages from "../../src/messages/ca.json";
import enMessages from "../../src/messages/en.json";
import esMessages from "../../src/messages/es.json";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

interface TreasuryAccountFixture {
  id: string;
  holdedAccountId: string;
  displayName: string;
}

interface BookingFixture {
  id: string;
  customerId: string;
}

const accountIds = new Set<string>();
const bookingIds = new Set<string>();
const customerIds = new Set<string>();

const localeTargets = [
  { locale: "en", path: "/bank-movements", messages: enMessages.BankMovements },
  { locale: "es", path: "/es/bank-movements", messages: esMessages.BankMovements },
  { locale: "ca", path: "/ca/bank-movements", messages: caMessages.BankMovements },
] as const;

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for bank movement E2E fixtures");
  }
  return new Pool({ connectionString });
}

function localId() {
  return `c${randomUUID().replaceAll("-", "")}`;
}

function providerId() {
  return randomBytes(12).toString("hex");
}

async function seedActor(role: "OPERATOR" | "ADMINISTRATOR") {
  const seeded = await seedAuthenticatedUser({ name: `${role} Banking User` });
  if (role === "ADMINISTRATOR") {
    const pool = getPool();
    try {
      await pool.query(`UPDATE "User" SET "role" = $2 WHERE "id" = $1`, [
        seeded.userId,
        role,
      ]);
    } finally {
      await pool.end();
    }
  }
  return seeded;
}

async function seedTreasuryAccount(options: {
  configuredById: string;
  active?: boolean;
  displayName?: string;
  lastSuccessfulAt?: Date | null;
}): Promise<TreasuryAccountFixture> {
  const fixture = {
    id: localId(),
    holdedAccountId: providerId(),
    displayName: options.displayName ?? "E2E treasury account",
  };
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "HoldedTreasuryAccount"
         ("id","holdedAccountId","displayName","currency","importStartDate","active",
          "configuredById","nextScheduledAt","lastSuccessfulAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'EUR','2025-01-01',$4,$5,'2100-01-01',$6,NOW(),NOW())`,
      [
        fixture.id,
        fixture.holdedAccountId,
        fixture.displayName,
        options.active ?? false,
        options.configuredById,
        options.lastSuccessfulAt === undefined
          ? new Date()
          : options.lastSuccessfulAt,
      ],
    );
  } finally {
    await pool.end();
  }
  accountIds.add(fixture.id);
  return fixture;
}

async function seedMovement(
  account: TreasuryAccountFixture,
  options: {
    amountMinor: bigint;
    narrative: string;
    bookingDate?: string;
  },
) {
  const id = localId();
  const holdedMovementId = providerId();
  const direction = options.amountMinor > BigInt(0) ? "INCOME" : "EXPENSE";
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "BankMovement"
         ("id","accountId","holdedMovementId","bookingDate","valueDate","narrative",
          "amountMinor","currency","providerStatus","direction","firstSeenAt","lastSeenAt","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,$6,'EUR','booked',$7,NOW(),NOW(),NOW())`,
      [
        id,
        account.id,
        holdedMovementId,
        options.bookingDate ?? "2025-02-01",
        options.narrative,
        options.amountMinor.toString(),
        direction,
      ],
    );
  } finally {
    await pool.end();
  }
  return { id, holdedMovementId };
}

async function seedSynchronizationRun(
  account: TreasuryAccountFixture,
  options: {
    status: "SUCCEEDED" | "RETRYING";
    failureCode?: "PROVIDER_UNAVAILABLE";
  },
) {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "BankSyncRun"
         ("id","accountId","trigger","status","windowStartDate","pageCount","itemCount",
          "insertedCount","incidentCount","attemptCount","nextAttemptAt","failureCode",
          "startedAt","exhaustedAt","finishedAt","createdAt","updatedAt")
       VALUES ($1,$2,'SCHEDULED',$3,'2025-01-01',1,1,1,$4,1,$5,$6,NOW(),$7,$7,NOW(),NOW())`,
      [
        localId(),
        account.id,
        options.status,
        options.failureCode ? 1 : 0,
        options.status === "RETRYING" ? "2100-01-01" : new Date(),
        options.failureCode ?? null,
        options.status === "SUCCEEDED" ? new Date() : null,
      ],
    );
  } finally {
    await pool.end();
  }
}

async function seedBooking(state: "IN_REVIEW" | "AWAITING_PAYMENT") {
  const fixture = { id: localId(), customerId: localId() };
  const suffix = randomUUID().slice(0, 8);
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "Customer"
         ("id","taxId","name","email","holdedContactId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
      [
        fixture.customerId,
        `E2E${suffix}`.toUpperCase(),
        `E2E Banking Group ${suffix}`,
        `banking-${suffix}@example.test`,
        providerId(),
      ],
    );
    await pool.query(
      `INSERT INTO "BookingRequest"
         ("id","gravityEntryId","customerId","state","boardType","startDate","endDate",
          "headcount","advanceCents","depositCents","paymentDueAt","submittedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'SELF_CATERING','2027-06-01','2027-06-03',40,$5,$6,$7,NOW(),NOW(),NOW())`,
      [
        fixture.id,
        `e2e-bank-${suffix}`,
        fixture.customerId,
        state,
        state === "AWAITING_PAYMENT" ? 10_000 : null,
        state === "AWAITING_PAYMENT" ? 20_000 : null,
        state === "AWAITING_PAYMENT" ? new Date("2027-05-01T00:00:00.000Z") : null,
      ],
    );
  } finally {
    await pool.end();
  }
  customerIds.add(fixture.customerId);
  bookingIds.add(fixture.id);
  return fixture;
}

async function seedProposal(
  movementId: string,
  booking: BookingFixture,
  estimateNumber: string,
) {
  const proposalId = localId();
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "HoldedDocument"
         ("id","bookingRequestId","type","holdedId","documentNumber","totalCents","issuedAt")
       VALUES ($1,$2,'ESTIMATE',$3,$4,30000,'2025-01-31')`,
      [localId(), booking.id, providerId(), estimateNumber],
    );
    await pool.query(
      `INSERT INTO "BankReconciliationProposal"
         ("id","movementId","bookingRequestId","status","createdAt","updatedAt")
       VALUES ($1,$2,$3,'PENDING',NOW(),NOW())`,
      [proposalId, movementId, booking.id],
    );
  } finally {
    await pool.end();
  }
  return proposalId;
}

async function readBookingState(bookingId: string) {
  const pool = getPool();
  try {
    const result = await pool.query<{ state: string }>(
      `SELECT "state" FROM "BookingRequest" WHERE "id" = $1`,
      [bookingId],
    );
    return result.rows[0]?.state;
  } finally {
    await pool.end();
  }
}

async function readManualRun(accountId: string) {
  const pool = getPool();
  try {
    const result = await pool.query<{
      status: string;
      trigger: string;
      requestedById: string | null;
    }>(
      `SELECT "status","trigger","requestedById" FROM "BankSyncRun"
       WHERE "accountId" = $1 AND "trigger" = 'MANUAL'
       ORDER BY "createdAt" DESC LIMIT 1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

async function readReconciliation(proposalId: string, bookingId: string) {
  const pool = getPool();
  try {
    const [proposal, booking, payment] = await Promise.all([
      pool.query<{ status: string; decidedById: string | null }>(
        `SELECT "status","decidedById" FROM "BankReconciliationProposal" WHERE "id" = $1`,
        [proposalId],
      ),
      pool.query<{ state: string }>(
        `SELECT "state" FROM "BookingRequest" WHERE "id" = $1`,
        [bookingId],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "Payment" WHERE "bookingRequestId" = $1`,
        [bookingId],
      ),
    ]);
    return {
      proposalStatus: proposal.rows[0]?.status,
      decidedById: proposal.rows[0]?.decidedById,
      bookingState: booking.rows[0]?.state,
      paymentCount: payment.rows[0]?.count ?? 0,
    };
  } finally {
    await pool.end();
  }
}

async function cleanupBankingFixtures() {
  if (accountIds.size === 0 && bookingIds.size === 0 && customerIds.size === 0) {
    return;
  }
  const trackedAccounts = [...accountIds];
  const trackedBookings = [...bookingIds];
  const trackedCustomers = [...customerIds];
  const pool = getPool();
  try {
    await pool.query(`DELETE FROM "IntegrationJob" WHERE "idempotencyKey" IN (
      SELECT 'banking.payment:' || "id" FROM "BankPaymentOperation" WHERE "bookingRequestId" = ANY($1::text[])
    )`, [trackedBookings]);
    await pool.query(`DELETE FROM "BankPaymentOperation" WHERE "bookingRequestId" = ANY($1::text[])`, [trackedBookings]);
    await pool.query(
      `DELETE FROM "IntegrationJob"
       WHERE "idempotencyKey" LIKE ANY($1::text[])`,
      [trackedBookings.map((id) => `%:${id}`)],
    );
    await pool.query(
      `DELETE FROM "BankReconciliationProposal"
       WHERE "bookingRequestId" = ANY($1::text[])
          OR "movementId" IN (
            SELECT "id" FROM "BankMovement" WHERE "accountId" = ANY($2::text[])
          )`,
      [trackedBookings, trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "Payment" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "HoldedDocument" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "BookingAuditEvent" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "BookingRequest" WHERE "id" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(`DELETE FROM "Customer" WHERE "id" = ANY($1::text[])`, [
      trackedCustomers,
    ]);
    await pool.query(
      `DELETE FROM "BankSyncRun" WHERE "accountId" = ANY($1::text[])`,
      [trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "BankMovement" WHERE "accountId" = ANY($1::text[])`,
      [trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "HoldedTreasuryAccount" WHERE "id" = ANY($1::text[])`,
      [trackedAccounts],
    );
  } finally {
    accountIds.clear();
    bookingIds.clear();
    customerIds.clear();
    await pool.end();
  }
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

function formatEuros(value: number) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "never",
  }).format(value);
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await cleanupBankingFixtures();
  await cleanupAuthenticatedUsers();
});

test("redirects signed-out banking routes to each localized login", async ({ page }) => {
  const targets = [
    ["/bank-movements", "/login?callbackUrl=%2Fbank-movements"],
    ["/es/bank-movements", "/es/login?callbackUrl=%2Fbank-movements"],
    ["/ca/bank-movements", "/ca/login?callbackUrl=%2Fbank-movements"],
  ] as const;

  for (const [path, expected] of targets) {
    await page.goto(path);
    await expect(page).toHaveURL(
      new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`),
    );
  }
});

test("allows operator and administrator roles across all locales with noindex", async ({
  page,
  context,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const operator = await seedActor("OPERATOR");
  await installAuthSessionCookie(context, operator.sessionToken, appUrl);

  for (const target of localeTargets) {
    const response = await page.goto(target.path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", target.locale);
    await expect(
      page.getByRole("heading", { level: 1, name: target.messages.title }),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/i,
    );
  }

  const administrator = await seedActor("ADMINISTRATOR");
  await installAuthSessionCookie(context, administrator.sessionToken, appUrl);
  await context.addCookies([
    {
      name: "NEXT_LOCALE",
      value: "en",
      url: new URL(appUrl).origin,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/bank-movements");
  await expect(
    page.getByRole("heading", { level: 1, name: enMessages.BankMovements.title }),
  ).toBeVisible();
});

test("shows only income when historical expenses exist", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    displayName: "Totals account",
  });
  for (let index = 0; index < 51; index += 1) {
    await seedMovement(account, {
      amountMinor: BigInt(100),
      narrative: `Income movement ${String(index).padStart(2, "0")}`,
    });
  }
  await seedMovement(account, {
    amountMinor: BigInt(-200),
    narrative: "Needle expense movement",
    bookingDate: "2025-01-31",
  });

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(page.locator('tbody tr[data-direction="income"]')).toHaveCount(50);
  const totals = page.getByRole("region", {
    name: enMessages.BankMovements.totals.title,
  });
  await expect(totals).toContainText(formatEuros(51));
  await expect(totals).not.toContainText(formatEuros(2));
  await expect(
    page.getByRole("navigation", { name: "Page 1 of 2" }),
  ).toBeVisible();

  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.goto(
    `/bank-movements?account=${account.holdedAccountId}&direction=expense`,
  );
  await expect(page.locator('tbody tr[data-direction="income"]')).toHaveCount(50);
  await expect(page.locator('tbody tr[data-direction="expense"]')).toHaveCount(0);
  await expect(page.getByText("Needle expense movement", { exact: true })).toHaveCount(0);
  await expect(totals).toContainText(formatEuros(51));
});

test("requests a manual refresh by keyboard and exposes durable queued progress", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    active: true,
  });
  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  const refresh = page.getByRole("button", {
    name: enMessages.BankMovements.synchronization.refresh,
  });
  await tabTo(page, refresh);
  await page.keyboard.press("Enter");

  await expect(
    page.getByText(enMessages.BankMovements.synchronization.accepted),
  ).toBeVisible();
  await expect.poll(() => readManualRun(account.id)).toMatchObject({
    trigger: "MANUAL",
    requestedById: actor.userId,
  });
  await expect(
    page.getByText(
      /Waiting to synchronize|Synchronization in progress/u,
    ),
  ).toBeVisible();
});

test("queues a reconciliation proposal manually by keyboard without premature confirmation", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({ configuredById: actor.userId });
  const estimateNumber = `EST-${randomUUID().slice(0, 8)}`;
  const movement = await seedMovement(account, {
    amountMinor: BigInt(30_000),
    narrative: `Transfer for ${estimateNumber}`,
  });
  const booking = await seedBooking("AWAITING_PAYMENT");
  const proposalId = await seedProposal(movement.id, booking, estimateNumber);

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(
    page.getByText(enMessages.BankMovements.proposals.title, { exact: true }),
  ).toBeVisible();
  const confirm = page.getByRole("button", {
    name: enMessages.BankMovements.proposals.confirm,
  });
  await tabTo(page, confirm);
  await page.keyboard.press("Enter");

  await expect.poll(() => readReconciliation(proposalId, booking.id)).toEqual({
    proposalStatus: "PENDING",
    decidedById: null,
    bookingState: "AWAITING_PAYMENT",
    paymentCount: 0,
  });
  await expect(page.getByText(enMessages.BankMovements.payment.stage.replace("{stage}", enMessages.BankMovements.payment.stages.PREPARED))).toBeVisible();
});

test("selects a booking from a movement and completes linked Holded payment and delegate delivery", async ({ page, context, baseURL, request }) => {
  test.setTimeout(120_000);
  const fixtureUrl = process.env.E2E_PROVIDER_HTTP_URL;
  const secretKey = process.env.BOOKING_SECRET_KEY;
  test.skip(!fixtureUrl || !secretKey, "Requires the isolated synthetic provider and encryption key");
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(context, actor.sessionToken, baseURL ?? "http://127.0.0.1:3100");
  const account = await seedTreasuryAccount({ configuredById: actor.userId });
  const movement = await seedMovement(account, { amountMinor: BigInt(30_100), narrative: "Income without contract reference" });
  const booking = await seedBooking("AWAITING_PAYMENT");
  await seedProposal(movement.id, booking, "E-1");
  const pool = getPool();
  const original = (await pool.query<Record<string, unknown>>('SELECT * FROM "IntegrationSettings" WHERE "provider" = $1', ["HOLDED"])).rows[0];
  try {
    const identities = await pool.query<{ contactId: string; estimateId: string }>(
      `SELECT c."holdedContactId" AS "contactId",d."holdedId" AS "estimateId"
       FROM "Customer" c JOIN "BookingRequest" b ON b."customerId"=c."id"
       JOIN "HoldedDocument" d ON d."bookingRequestId"=b."id" WHERE b."id"=$1`, [booking.id],
    );
    const identity = identities.rows[0];
    const configured = await request.post(`${fixtureUrl}/control/holded/payment`, { data: {
      ...identity, accountId: account.holdedAccountId, movementId: movement.holdedMovementId,
      amount: "301.00", bankDate: "2025-02-01",
    } });
    expect(configured.ok()).toBe(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(secretKey!, "base64"), iv);
    const ciphertext = Buffer.concat([cipher.update(`synthetic-${randomUUID()}`, "utf8"), cipher.final()]);
    await pool.query(`DELETE FROM "IntegrationSettings" WHERE "provider" = 'HOLDED'`);
    await pool.query(`INSERT INTO "IntegrationSettings"
      ("provider","config","secretCiphertext","secretIv","secretAuthTag","createdAt","updatedAt")
      VALUES ('HOLDED',$1,$2,$3,$4,NOW(),NOW())`, [
      JSON.stringify({ advanceServiceId: "1".repeat(24), depositServiceId: "2".repeat(24),
        serviceIdsBySku: {}, negotiatedTaxIds: [], language: "ca" }), ciphertext, iv, cipher.getAuthTag(),
    ]);
    for (const target of localeTargets) {
      await page.goto(`${target.path}?account=${account.holdedAccountId}`);
      const trigger = page.getByRole("button", { name: "Income without contract reference" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: target.messages.payment.title })).toBeVisible();
      await expect(dialog.getByRole("link", { name: /E2E Banking Group/u })).toBeVisible();
      if (target.locale !== "ca") {
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      } else {
        await dialog.getByRole("button", { name: target.messages.payment.reconcile }).click();
      }
    }
    await expect.poll(() => readBookingState(booking.id), { timeout: 90_000 }).toBe("CONFIRMED");
    const captured = await request.get(`${fixtureUrl}/control/requests`);
    const { requests } = await captured.json() as { requests: { logicalUrl: string; method: string; body: string }[] };
    const writes = requests.filter((item) => item.method !== "GET" && item.logicalUrl.includes("api.holded.com"));
    expect(writes.filter((item) => item.logicalUrl.endsWith("/documents/convert"))).toHaveLength(1);
    expect(JSON.parse(writes.find((item) => item.method === "PUT")!.body)).toMatchObject({
      items: [{ price: 101, taxes: ["s_iva_10"] }, { price: 200, taxes: ["s_iva_nosujeto"] }],
    });
    expect(JSON.parse(writes.find((item) => item.logicalUrl.endsWith("/payments"))!.body)).toMatchObject({ amount: "301.00", treasury_id: account.holdedAccountId });
    expect(JSON.parse(writes.find((item) => item.logicalUrl.endsWith("/reconcile"))!.body)).toEqual({
      documents: [{ document_id: "3".repeat(24), document_type: "collection" }],
    });
    expect(JSON.parse(writes.find((item) => item.logicalUrl.endsWith("/send"))!.body)).toMatchObject({ cc: ["delegate@example.test"] });
  } finally {
    await pool.query(`DELETE FROM "IntegrationSettings" WHERE "provider" = 'HOLDED'`);
    if (original) await pool.query(`INSERT INTO "IntegrationSettings"
      ("provider","config","secretCiphertext","secretIv","secretAuthTag","verifiedAt","updatedById","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      original.provider, original.config, original.secretCiphertext, original.secretIv, original.secretAuthTag,
      original.verifiedAt, original.updatedById, original.createdAt, original.updatedAt,
    ]);
    await request.post(`${fixtureUrl}/control/reset`);
    await pool.end();
  }
});

test("keeps movements and unrelated booking decisions available during Holded outage", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    active: true,
    lastSuccessfulAt: new Date("2025-01-01T00:00:00.000Z"),
  });
  await seedMovement(account, {
    amountMinor: BigInt(12_500),
    narrative: "Retained movement during outage",
  });
  await seedSynchronizationRun(account, {
    status: "RETRYING",
    failureCode: "PROVIDER_UNAVAILABLE",
  });

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(
    page.getByText(enMessages.BankMovements.synchronization.state.retrying),
  ).toBeVisible();
  await expect(
    page.getByText(
      enMessages.BankMovements.synchronization.incidents.PROVIDER_UNAVAILABLE,
    ),
  ).toBeVisible();
  await expect(page.getByText("Retained movement during outage")).toBeVisible();
  await expect(
    page.getByText(enMessages.BankMovements.synchronization.retainedData),
  ).toBeVisible();
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({
    status: "ok",
    database: "ok",
  });

  const booking = await seedBooking("IN_REVIEW");
  await page.goto(`/bookings/${booking.id}`);
  await page.getByLabel("Reason").fill("Unavailable dates during banking outage");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => readBookingState(booking.id)).toBe("REJECTED");
});

test(
  "keeps a long banking view contained and usable at 320px",
  { tag: "@mobile" },
  async ({ page, context, baseURL }) => {
    const actor = await seedActor("OPERATOR");
    await installAuthSessionCookie(
      context,
      actor.sessionToken,
      baseURL ?? "http://127.0.0.1:3100",
    );
    const account = await seedTreasuryAccount({
      configuredById: actor.userId,
      displayName: "Long treasury account name for narrow viewport validation",
    });
    await seedMovement(account, {
      amountMinor: BigInt(12_345),
      narrative:
        "A deliberately long synthetic movement concept that must stay inside the scrollable table",
    });

    await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
    expect(page.viewportSize()?.width).toBe(320);
    await expect(
      page.getByRole("heading", { level: 1, name: enMessages.BankMovements.title }),
    ).toBeVisible();
    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const tableContainer = document.querySelector<HTMLElement>(
        '[data-slot="table-container"]',
      );
      const controls = [
        ...document.querySelectorAll<HTMLElement>("main button, main input, main select"),
      ].filter((element) => element.getClientRects().length > 0);
      return {
        rootOverflow: root.scrollWidth > root.clientWidth + 1,
        tableScrolls: Boolean(
          tableContainer && tableContainer.scrollWidth > tableContainer.clientWidth,
        ),
        outOfBounds: controls.filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < -0.5 || box.right > window.innerWidth + 0.5;
        }).length,
      };
    });
    expect(geometry).toEqual({
      rootOverflow: false,
      tableScrolls: true,
      outOfBounds: 0,
    });
    await page.getByRole("button", { name: /A deliberately long synthetic movement concept/u }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: enMessages.BankMovements.payment.title })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  },
);