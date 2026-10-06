import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  createGravityFormsClient,
  parseGravityFormsTimestamp,
  type GravityFormsClient,
  type GravityFormsCursor,
} from "@/lib/gravity-forms/client";
import { logger } from "@/lib/logger";
import {
  createBookingSubmissionParser,
  DEFAULT_GRAVITY_FORM_FIELDS,
  type BookingSubmission,
  type GravityFormFieldMap,
} from "@/modules/booking/schema";
import { countNights } from "@/modules/booking/services/pricing";
import { resolveIntegration } from "@/modules/booking/services/settings";

export const INTAKE_SOURCE = "gravity-forms";

export interface IntakeSummary {
  read: number;
  created: number;
  /** Already imported: the entry resolves to an existing booking. */
  skipped: number;
  rejected: number;
  cursor: string | null;
}

async function readCursor(): Promise<GravityFormsCursor | null> {
  const row = await db.intakeCursor.findUnique({
    where: { source: INTAKE_SOURCE },
    select: { lastEntryId: true, lastEntryCreatedAt: true },
  });
  return row ? { entryId: row.lastEntryId, createdAt: row.lastEntryCreatedAt } : null;
}

function compareEntryIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/** Each bound only moves forward, so a stale overlapping run cannot rewind either. */
async function advanceCursor(entryId: string, createdAt: Date): Promise<string> {
  for (;;) {
    const current = await db.intakeCursor.findUnique({
      where: { source: INTAKE_SOURCE },
      select: { lastEntryId: true, lastEntryCreatedAt: true },
    });

    if (!current) {
      try {
        await db.intakeCursor.create({
          data: {
            source: INTAKE_SOURCE,
            lastEntryId: entryId,
            lastEntryCreatedAt: createdAt,
          },
        });
        return entryId;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue;
        }
        throw error;
      }
    }

    const lastEntryId =
      compareEntryIds(entryId, current.lastEntryId) > 0 ? entryId : current.lastEntryId;
    const lastEntryCreatedAt =
      current.lastEntryCreatedAt &&
      current.lastEntryCreatedAt.getTime() >= createdAt.getTime()
        ? current.lastEntryCreatedAt
        : createdAt;

    if (
      lastEntryId === current.lastEntryId &&
      lastEntryCreatedAt === current.lastEntryCreatedAt
    ) {
      return lastEntryId;
    }

    const advanced = await db.intakeCursor.updateMany({
      where: {
        source: INTAKE_SOURCE,
        lastEntryId: current.lastEntryId,
        lastEntryCreatedAt: current.lastEntryCreatedAt,
      },
      data: { lastEntryId, lastEntryCreatedAt },
    });
    if (advanced.count === 1) return lastEntryId;
  }
}

async function persistSubmission(submission: BookingSubmission): Promise<boolean> {
  const { customer, stay } = submission;

  // Rejects an impossible stay before it reaches an operator's queue.
  countNights(stay.startDate, stay.endDate);

  try {
    await db.$transaction(async (tx) => {
      const existingCustomer = await tx.customer.findUnique({
        where: { taxId: customer.taxId },
        select: { id: true },
      });

      const customerId = existingCustomer
        ? (
            await tx.customer.update({
              where: { id: existingCustomer.id },
              data: {
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                addressLine: customer.addressLine,
                city: customer.city,
                province: customer.province,
                postalCode: customer.postalCode,
                country: customer.country,
              },
              select: { id: true },
            })
          ).id
        : (
            await tx.customer.create({
              data: customer,
              select: { id: true },
            })
          ).id;

      await tx.bookingRequest.create({
        data: {
          gravityEntryId: submission.entryId,
          customerId,
          boardType: stay.boardType,
          startDate: stay.startDate,
          endDate: stay.endDate,
          headcount: stay.headcount,
          submittedAt: parseGravityFormsTimestamp(submission.submittedAt),
        },
      });
    });
    return true;
  } catch (error) {
    // Entry id plus creation time is the idempotency key: a re-read is not a failure.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

export interface RunIntakeOptions {
  client?: GravityFormsClient;
  fieldMap?: GravityFormFieldMap;
}

/**
 * Reads new Gravity Forms entries and turns them into booking requests.
 *
 * The cursor advances entry by entry, and only after that entry is committed,
 * so an interrupted batch resumes exactly where it stopped instead of skipping
 * the remainder.
 */
export async function runIntake(
  options: RunIntakeOptions = {},
): Promise<IntakeSummary> {
  const configured = options.client
    ? null
    : await resolveIntegration("GRAVITY_FORMS");
  const client =
    options.client ??
    createGravityFormsClient({
      apiUrl: configured!.config.apiUrl,
      formId: configured!.config.formId,
      consumerKey: configured!.config.consumerKey,
      consumerSecret: configured!.secret,
    });
  const parser = createBookingSubmissionParser(
    options.fieldMap ?? configured?.config.fieldMap ?? DEFAULT_GRAVITY_FORM_FIELDS,
  );

  const startingCursor = await readCursor();
  const entries = await client.fetchEntriesAfter(startingCursor);

  const summary: IntakeSummary = {
    read: entries.length,
    created: 0,
    skipped: 0,
    rejected: 0,
    cursor: startingCursor?.entryId ?? null,
  };

  for (const entry of entries) {
    // Only the creation-time bound can return such an entry.
    if (startingCursor && compareEntryIds(entry.id, startingCursor.entryId) <= 0) {
      logger.warn(
        { event: "booking_intake_entry_id_reused", entryId: entry.id },
        "Gravity Forms reused an entry id at or below the intake cursor",
      );
    }

    const parsed = parser.parse(entry);

    if (!parsed.ok) {
      summary.rejected += 1;
      logger.warn(
        {
          event: "booking_intake_entry_rejected",
          entryId: parsed.entryId,
          issues: parsed.issues,
        },
        "booking intake rejected a malformed entry",
      );
    } else if (await persistSubmission(parsed.submission)) {
      summary.created += 1;
    } else {
      summary.skipped += 1;
    }

    summary.cursor = await advanceCursor(
      entry.id,
      parseGravityFormsTimestamp(entry.date_created),
    );
  }

  logger.info(
    { event: "booking_intake_batch", ...summary },
    "booking intake batch completed",
  );

  return summary;
}
