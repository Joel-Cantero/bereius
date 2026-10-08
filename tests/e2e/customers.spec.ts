import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import en from "../../src/messages/en.json";
import es from "../../src/messages/es.json";
import ca from "../../src/messages/ca.json";
import { seedAuthenticatedUser, installAuthSessionCookie, cleanupAuthenticatedUsers } from "./helpers/authenticated-user";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await cleanupAuthenticatedUsers(); });

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for customer E2E fixtures");
  return new Pool({ connectionString });
}

for (const [locale, messages, route] of [["en", en, "/customers"], ["es", es, "/es/customers"], ["ca", ca, "/ca/customers"]] as const) {
  test(`administrator customers in ${locale}`, async ({ page, context, baseURL }) => {
    test.skip(!process.env.E2E_PROVIDER_HTTP_URL, "Requires local WordPress provider fixture");
    const actor = await seedAuthenticatedUser();
    const pool = getPool();
    try { await pool.query('UPDATE "User" SET "role" = $2 WHERE "id" = $1', [actor.userId, "ADMINISTRATOR"]); }
    finally { await pool.end(); }
    await installAuthSessionCookie(context, actor.sessionToken, baseURL!);
    await page.goto(route);
    await expect(page.getByRole("heading", { name: messages.Customers.title, exact: true })).toBeVisible();
    await page.getByText(messages.Customers.settings, { exact: true }).click();
    await page.getByLabel(messages.Customers.origin).fill("https://wordpress.example.test");
    await page.getByLabel(messages.Customers.username).fill("synthetic-service");
    await page.getByLabel(messages.Customers.password).fill("test-only-application-password");
    await page.getByRole("button", { name: messages.Customers.save, exact: true }).click();
    await expect(page.getByRole("status", { name: "" }).filter({ hasText: messages.Customers.outcomes.saved })).toBeVisible();
    await page.getByRole("searchbox").fill("fiscal@example");
    await page.getByRole("link", { name: /Synthetic fiscal customer/ }).click();
    await expect(page.getByRole("heading", { name: "Synthetic fiscal customer" })).toBeVisible();
    if (locale === "en") {
      await page.locator("summary").filter({ hasText: messages.Customers.invite }).click();
      await page.getByLabel(messages.Customers.fields.first_name).fill("Synthetic");
      await page.getByLabel(messages.Customers.fields.last_name).fill("Delegate");
      await page.getByLabel(messages.Customers.fields.email).fill("delegate@example.test");
      await page.getByLabel(messages.Customers.fields.phone).fill("600000000");
      await page.getByRole("button", { name: messages.Customers.invite }).click();
      await expect(page.getByText(messages.Customers.statuses.pending, { exact: true })).toBeVisible();
      const delegate = page.getByRole("article").filter({ hasText: "Synthetic Delegate" });
      await delegate.getByRole("button", { name: messages.Customers.resend }).click();
      await expect(delegate.getByRole("status")).toHaveText(messages.Customers.outcomes.saved);
      await delegate.getByLabel(messages.Customers.fields.phone).fill("600000001");
      await delegate.getByRole("button", { name: messages.Customers.save, exact: true }).click();
      await expect(delegate.getByLabel(messages.Customers.fields.phone)).toHaveValue("600000001");
      await delegate.getByRole("button", { name: messages.Customers.revoke }).click();
      await page.getByRole("dialog").getByRole("button", { name: messages.Customers.revoke }).click();
      await expect(page.getByText(messages.Customers.statuses.revoked, { exact: true })).toBeVisible();
      await delegate.getByRole("button", { name: messages.Customers.reinvite }).click();
      await expect(page.getByText(messages.Customers.statuses.pending, { exact: true })).toBeVisible();
    }
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await page.screenshot({ path: test.info().outputPath("customers-desktop.png"), fullPage: true });
  });
}

test("operator cannot access customer administration", async ({ page, context, baseURL }) => {
  const actor = await seedAuthenticatedUser();
  await installAuthSessionCookie(context, actor.sessionToken, baseURL!);
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/bookings/);
  await expect(page.getByRole("link", { name: en.Console.links.customers.label, exact: true })).toHaveCount(0);
});

test("customers fit the narrow viewport @mobile", async ({ page, context, baseURL }) => {
  const actor = await seedAuthenticatedUser();
  const pool = getPool();
  try { await pool.query('UPDATE "User" SET "role" = $2 WHERE "id" = $1', [actor.userId, "ADMINISTRATOR"]); }
  finally { await pool.end(); }
  await installAuthSessionCookie(context, actor.sessionToken, baseURL!);
  await page.goto("/ca/customers");
  await expect(page.getByRole("heading", { name: ca.Customers.title, exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Synthetic fiscal customer/ }).click();
  await expect(page.getByRole("heading", { name: "Synthetic fiscal customer" })).toBeVisible();
  await page.locator("summary").filter({ hasText: ca.Customers.invite }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("customers-mobile.png"), fullPage: true });
});