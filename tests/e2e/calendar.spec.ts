import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import en from "../../src/messages/en.json";
import es from "../../src/messages/es.json";
import ca from "../../src/messages/ca.json";
import { cleanupAuthenticatedUsers, installAuthSessionCookie, seedAuthenticatedUser } from "./helpers/authenticated-user";

test.describe.configure({ mode: "serial" });
let original: Record<string, unknown> | undefined;

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for calendar fixtures");
  return new Pool({ connectionString });
}

async function installCalendarFixture() {
  const secretKey = process.env.BOOKING_SECRET_KEY;
  if (!secretKey) throw new Error("BOOKING_SECRET_KEY is required for calendar fixtures");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secretKey, "base64"), iv);
  const ciphertext = Buffer.concat([cipher.update("https://calendar.example.test/feed.ics", "utf8"), cipher.final()]);
  const pool = getPool();
  try {
    await pool.query(`INSERT INTO "IntegrationSettings" ("provider", "config", "secretCiphertext", "secretIv", "secretAuthTag", "createdAt", "updatedAt") VALUES ($1,'{}',$2,$3,$4,NOW(),NOW())`, ["CALENDAR_ICS", ciphertext, iv, cipher.getAuthTag()]);
  } finally { await pool.end(); }
}

async function clearCalendarFixture() {
  const pool = getPool();
  try { await pool.query('DELETE FROM "IntegrationSettings" WHERE "provider" = $1', ["CALENDAR_ICS"]); }
  finally { await pool.end(); }
}

test.beforeAll(async () => {
  const pool = getPool();
  try {
    original = (await pool.query<Record<string, unknown>>('SELECT * FROM "IntegrationSettings" WHERE "provider" = $1', ["CALENDAR_ICS"])).rows[0];
    await pool.query('DELETE FROM "IntegrationSettings" WHERE "provider" = $1', ["CALENDAR_ICS"]);
  } finally { await pool.end(); }
});

test.afterAll(async () => {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM "IntegrationSettings" WHERE "provider" = $1', ["CALENDAR_ICS"]);
    if (original) {
      await pool.query(`INSERT INTO "IntegrationSettings" ("provider", "config", "secretCiphertext", "secretIv", "secretAuthTag", "verifiedAt", "updatedById", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [original.provider, original.config, original.secretCiphertext, original.secretIv, original.secretAuthTag, original.verifiedAt, original.updatedById, original.createdAt, original.updatedAt]);
    }
  } finally {
    await pool.end();
    await cleanupAuthenticatedUsers();
  }
});

for (const [locale, prefix, messages] of [["en", "", en], ["es", "/es", es], ["ca", "/ca", ca]] as const) {
  test(`operator calendar navigation and private metadata in ${locale}`, async ({ page, context, baseURL }, testInfo) => {
    const user = await seedAuthenticatedUser();
    await installAuthSessionCookie(context, user.sessionToken, baseURL!);
    await page.goto(`${prefix}/calendar?month=2026-10`);
    await expect(page.getByRole("heading", { name: messages.Calendar.title, exact: true })).toBeVisible();
    await expect(page.getByText(messages.Calendar.not_configured)).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("link", { name: messages.Calendar.integrations, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: messages.Calendar.next }).click();
    await expect(page).toHaveURL(/month=2026-11/);
    await expect(page.locator("#calendar-month")).toHaveText(new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date("2026-11-01")));
    await page.screenshot({ path: testInfo.outputPath(`calendar-${locale}.png`), fullPage: true });
  });
}

test("calendar mobile layout @mobile", async ({ page, context, baseURL }, testInfo) => {
  const user = await seedAuthenticatedUser();
  await installAuthSessionCookie(context, user.sessionToken, baseURL!);
  await page.goto("/es/calendar?month=2026-10");
  await expect(page.getByRole("heading", { name: es.Calendar.title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("calendar-mobile.png"), fullPage: true });
});

test("administrator can parameterize a write-only ICS source", async ({ page, context, baseURL }) => {
  const user = await seedAuthenticatedUser();
  const pool = getPool();
  try { await pool.query('UPDATE "User" SET "role" = $1 WHERE "id" = $2', ["ADMINISTRATOR", user.userId]); }
  finally { await pool.end(); }
  await installAuthSessionCookie(context, user.sessionToken, baseURL!);
  await page.goto("/es/bookings/settings");
  const section = page.getByRole("region", { name: es.Calendar.integrationTitle });
  await expect(section.getByLabel(es.Calendar.url)).toHaveAttribute("type", "password");
  await section.getByLabel(es.Calendar.url).fill("https://127.0.0.1/private");
  await section.getByRole("button", { name: es.Bookings.settings.save, exact: true }).click();
  await expect(section.getByRole("alert")).toBeVisible();
});

test("centers the calendar and spans a three-day stay once on wide desktop", async ({ page, context, baseURL }, testInfo) => {
  test.skip(!process.env.E2E_PROVIDER_HTTP_URL, "Requires the isolated calendar HTTP fixture");
  await installCalendarFixture();
  try {
    const user = await seedAuthenticatedUser();
    await installAuthSessionCookie(context, user.sessionToken, baseURL!);
    await page.setViewportSize({ width: 2560, height: 1100 });
    await page.goto("/es/calendar?month=2026-10");
    const weekend = page.getByRole("article", { name: /^Synthetic weekend:/ });
    await expect(weekend).toHaveCount(1);
    await expect(weekend).toBeVisible();
    await expect(weekend).toHaveAttribute("data-calendar-last", "2026-10-04");
    const friday = await page.locator('time[datetime="2026-10-02"]').locator("..").boundingBox();
    const band = await weekend.boundingBox();
    expect(friday).not.toBeNull();
    expect(band).not.toBeNull();
    expect(Math.abs(band!.width - (friday!.width * 3 - 8))).toBeLessThan(2);
    const overlap = await page.getByRole("article", { name: /^Synthetic overlapping stay:/ }).boundingBox();
    expect(overlap!.y).toBeGreaterThanOrEqual(band!.y + band!.height);
    await expect(page.getByRole("article", { name: /^Synthetic month boundary:/ })).toHaveCount(2);
    const bounds = await page.getByRole("main").last().evaluate((element) => {
      const view = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return { width: view.width, left: view.left - parent.left, right: parent.right - view.right };
    });
    expect(bounds.width).toBeLessThanOrEqual(1152);
    expect(bounds.left).toBeGreaterThan(100);
    expect(Math.abs(bounds.left - bounds.right)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("calendar-bands-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(weekend).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("calendar-bands-tablet.png"), fullPage: true });
  } finally { await clearCalendarFixture(); }
});

test("groups multi-day stays once in the mobile agenda @mobile", async ({ page, context, baseURL }, testInfo) => {
  test.skip(!process.env.E2E_PROVIDER_HTTP_URL, "Requires the isolated calendar HTTP fixture");
  await installCalendarFixture();
  try {
    const user = await seedAuthenticatedUser();
    await installAuthSessionCookie(context, user.sessionToken, baseURL!);
    await page.goto("/es/calendar?month=2026-10");
    const agenda = page.getByRole("region", { name: es.Calendar.agenda });
    await expect(agenda.getByText("Synthetic weekend", { exact: true })).toHaveCount(1);
    await expect(agenda.getByText("Synthetic weekend", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("calendar-bands-mobile.png"), fullPage: true });
  } finally { await clearCalendarFixture(); }
});

for (const mobile of [false, true]) {
test(`${mobile ? "@mobile " : ""}operator links a paid booking, opens it from the calendar and unlinks with audit`, async ({ page, context, baseURL }, testInfo) => {
  test.skip(!process.env.E2E_PROVIDER_HTTP_URL, "Requires the isolated calendar HTTP fixture");
  await installCalendarFixture();
  const user = await seedAuthenticatedUser();
  const customerId = `calendar-customer-${randomUUID()}`;
  const bookingId = `calendar-booking-${randomUUID()}`;
  const pool = getPool();
  try {
    await pool.query('INSERT INTO "Customer" ("id", "taxId", "name", "email", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,NOW(),NOW())', [customerId, randomUUID(), "Calendar fixture group", user.email]);
    await pool.query(`INSERT INTO "BookingRequest" ("id", "gravityEntryId", "customerId", "state", "boardType", "startDate", "endDate", "headcount", "advanceCents", "depositCents", "submittedAt", "createdAt", "updatedAt") VALUES ($1,$2,$3,'CONFIRMED','SELF_CATERING','2026-10-02','2026-10-05',40,43200,20000,NOW(),NOW(),NOW())`, [bookingId, randomUUID(), customerId]);
    await pool.query('INSERT INTO "Payment" ("id", "bookingRequestId", "amountCents", "receivedAt", "recordedById", "createdAt") VALUES ($1,$2,63200,NOW(),$3,NOW())', [randomUUID(), bookingId, user.userId]);
    await installAuthSessionCookie(context, user.sessionToken, baseURL!);
    await page.goto(`/es/bookings/${bookingId}`);
    const panel = page.getByRole("region", { name: es.Calendar.bookingLinks.title });
    await expect(panel.getByLabel(es.Calendar.bookingLinks.event)).toBeVisible();
    const firstEvent = await panel.getByRole("option", { name: /^Synthetic weekend/ }).first().getAttribute("value");
    expect(firstEvent).not.toBeNull();
    await panel.getByLabel(es.Calendar.bookingLinks.event).selectOption(firstEvent!);
    await panel.getByLabel(es.Calendar.bookingLinks.confirm).check();
    await panel.getByRole("button", { name: es.Calendar.bookingLinks.link, exact: true }).click();
    await expect(panel.getByRole("button", { name: es.Calendar.bookingLinks.unlink, exact: true })).toBeVisible();
    await panel.getByRole("link", { name: es.Calendar.bookingLinks.openCalendar }).click();
    const linked = page.getByRole("link", { name: "Reserva confirmada: Calendar fixture group", exact: true });
    await expect(linked).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("calendar-linked-booking.png"), fullPage: true });
    await linked.click();
    await expect(page).toHaveURL(new RegExp(`/es/bookings/${bookingId}$`));
    await panel.getByRole("button", { name: es.Calendar.bookingLinks.unlink, exact: true }).click();
    await expect(panel.getByLabel(es.Calendar.bookingLinks.event)).toBeVisible();
    const audit = await pool.query('SELECT "action", "actorUserId" FROM "CalendarBookingAuditEvent" WHERE "bookingRequestId" = $1 ORDER BY "createdAt"', [bookingId]);
    expect(audit.rows).toEqual([{ action: "LINKED", actorUserId: user.userId }, { action: "UNLINKED", actorUserId: user.userId }]);
    expect((await pool.query<{ state: string }>('SELECT "state" FROM "BookingRequest" WHERE "id" = $1', [bookingId])).rows[0].state).toBe("CONFIRMED");
    expect((await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM "Payment" WHERE "bookingRequestId" = $1', [bookingId])).rows[0].count).toBe(1);
  } finally {
    await pool.query('DELETE FROM "BookingRequest" WHERE "id" = $1', [bookingId]);
    await pool.query('DELETE FROM "Customer" WHERE "id" = $1', [customerId]);
    await pool.end();
    await clearCalendarFixture();
  }
});
}