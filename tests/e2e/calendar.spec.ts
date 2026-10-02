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