// @vitest-environment node

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const migrationRoot = path.join(process.cwd(), "prisma/migrations");
const migrationName = "20261006180438_gravity_entry_reuse";
const openClients = new Set<Client>();
const schemas = new Set<string>();

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function applyMigration(client: Client, directory: string) {
  const sql = await readFile(path.join(migrationRoot, directory, "migration.sql"), "utf8");
  // A new enum value cannot be used in the transaction that adds it.
  const leadingEnumAddition = sql.match(
    /^(ALTER TYPE [^;]+ ADD VALUE(?: IF NOT EXISTS)? [^;]+;)\s*/u,
  );
  if (leadingEnumAddition) {
    await client.query(leadingEnumAddition[1]);
    await client.query(sql.slice(leadingEnumAddition[0].length));
    return;
  }
  await client.query(sql);
}

async function migratedUpToReuse() {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  const schema = `intake_migration_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  openClients.add(client);
  schemas.add(schema);
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);

  const earlier = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort();
  for (const directory of earlier) {
    await applyMigration(client, directory);
  }
  return client;
}

function insertBooking(client: Client, id: string, submittedAt: string) {
  return client.query(
    `INSERT INTO "BookingRequest" (
       "id", "gravityEntryId", "customerId", "state", "boardType", "startDate",
       "endDate", "headcount", "submittedAt", "createdAt", "updatedAt"
     ) VALUES (
       $1, '1110', 'intake-customer', 'AWAITING_PAYMENT', 'SELF_CATERING',
       DATE '2027-09-17', DATE '2027-09-19', 50, $2::timestamp, NOW(), NOW()
     )`,
    [id, submittedAt],
  );
}

afterEach(async () => {
  await Promise.all(
    [...openClients].map(async (client) => {
      await client.end();
      openClients.delete(client);
    }),
  );
});

afterAll(async () => {
  if (!databaseUrl || schemas.size === 0) return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const schema of schemas) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  } finally {
    await client.end();
  }
});

describe.skipIf(!runIntegrationTests || !databaseUrl)("Gravity Forms entry reuse migration", () => {
  it("keeps bookings and the cursor, and admits an entry id WordPress reused", async () => {
    const client = await migratedUpToReuse();
    await client.query(`
      INSERT INTO "Customer" ("id", "taxId", "name", "email", "createdAt", "updatedAt")
      VALUES ('intake-customer', 'INTAKE-CUSTOMER', 'Synthetic Customer',
              'intake-customer@example.test', NOW(), NOW());
      INSERT INTO "IntakeCursor" ("source", "lastEntryId", "updatedAt")
      VALUES ('gravity-forms', '1113', NOW());
    `);
    await insertBooking(client, "imported-booking", "2026-09-28 07:41:29");

    await applyMigration(client, migrationName);

    const cursor = await client.query(
      `SELECT "lastEntryId", "lastEntryCreatedAt" FROM "IntakeCursor"`,
    );
    expect(cursor.rows).toEqual([{ lastEntryId: "1113", lastEntryCreatedAt: null }]);

    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'BookingRequest'
        AND indexname LIKE 'BookingRequest_gravityEntryId%'
    `);
    expect(indexes.rows).toEqual([
      { indexname: "BookingRequest_gravityEntryId_submittedAt_key" },
    ]);

    await expect(
      insertBooking(client, "reused-booking", "2026-10-04 11:14:35"),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      insertBooking(client, "duplicate-booking", "2026-09-28 07:41:29"),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
