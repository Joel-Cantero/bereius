import "server-only";

import { z } from "zod";

import {
  executeProviderRequest,
  nativeProviderHttpClient,
  type ProviderHttpOutcome,
} from "@/lib/email/http";
import type { ProviderHttpClient } from "@/lib/email/types";

export const GRAVITY_FORMS_TIMEOUT_MS = 10_000;
export const GRAVITY_FORMS_PAGE_SIZE = 50;

/** Gravity Forms reports `date_created` in UTC, as `YYYY-MM-DD HH:MM:SS`. */
const GRAVITY_FORMS_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

export function parseGravityFormsTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

function formatGravityFormsTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

/** Raw entry: field values arrive keyed by field identifier, not by label. */
const entrySchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    date_created: z.string().regex(GRAVITY_FORMS_TIMESTAMP),
  })
  .catchall(z.unknown());

const entriesResponseSchema = z.object({
  entries: z.array(entrySchema),
});

export type GravityFormsEntry = z.infer<typeof entrySchema>;

export interface GravityFormsCredentials {
  apiUrl: string;
  formId: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface GravityFormsCursor {
  /** Highest entry id read. */
  entryId: string;
  /** Newest creation time read; null for cursors stored before it was tracked. */
  createdAt: Date | null;
}

export class GravityFormsError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "unavailable"
      | "malformed_response",
    message: string,
  ) {
    super(message);
    this.name = "GravityFormsError";
  }
}

function classify(outcome: ProviderHttpOutcome): GravityFormsError | null {
  if (outcome.kind === "network_error") {
    return new GravityFormsError("unavailable", "Gravity Forms is unreachable");
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return new GravityFormsError("unauthorized", "Gravity Forms rejected the credentials");
  }
  if (outcome.status === 404) {
    return new GravityFormsError("not_found", "Gravity Forms form not found");
  }
  if (outcome.status === 429) {
    return new GravityFormsError("rate_limited", "Gravity Forms rate limit reached");
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return new GravityFormsError("unavailable", "Gravity Forms returned an error");
  }
  return null;
}

function entriesUrl(
  credentials: GravityFormsCredentials,
  cursor: GravityFormsCursor | null,
): string {
  const base = credentials.apiUrl.replace(/\/+$/u, "");
  const url = new URL(`${base}/forms/${credentials.formId}/entries`);

  url.searchParams.set("sorting[key]", "id");
  url.searchParams.set("sorting[direction]", "ASC");
  url.searchParams.set("paging[page_size]", String(GRAVITY_FORMS_PAGE_SIZE));

  if (cursor !== null) {
    const afterId = { key: "id", operator: ">", value: cursor.entryId };
    // Both bounds come from WordPress's own entries, so no clock comparison is
    // involved. The date bound finds ids reused after a database restore.
    const fieldFilters =
      cursor.createdAt === null
        ? [afterId]
        : {
            mode: "any",
            0: afterId,
            1: {
              key: "date_created",
              operator: ">",
              value: formatGravityFormsTimestamp(cursor.createdAt),
            },
          };
    url.searchParams.set("search", JSON.stringify({ field_filters: fieldFilters }));
  }

  return url.toString();
}

export interface GravityFormsClient {
  fetchEntriesAfter(cursor: GravityFormsCursor | null): Promise<GravityFormsEntry[]>;
}

export function createGravityFormsClient(
  credentials: GravityFormsCredentials,
  httpClient: ProviderHttpClient = nativeProviderHttpClient,
): GravityFormsClient {
  const authorization = `Basic ${Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
  ).toString("base64")}`;

  return {
    async fetchEntriesAfter(cursor) {
      const outcome = await executeProviderRequest({
        client: httpClient,
        logicalUrl: entriesUrl(credentials, cursor),
        init: {
          method: "GET",
          headers: { accept: "application/json", authorization },
        },
        timeoutMs: GRAVITY_FORMS_TIMEOUT_MS,
      });

      const failure = classify(outcome);
      if (failure) throw failure;
      if (outcome.kind !== "response" || outcome.bodyTooLarge || outcome.body === null) {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms response could not be read",
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(outcome.body);
      } catch {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms returned invalid JSON",
        );
      }

      const parsed = entriesResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms response did not match the expected shape",
        );
      }

      // The API sorts, but the cursor's correctness must not depend on it.
      return parsed.data.entries.toSorted((left, right) =>
        left.id.localeCompare(right.id, undefined, { numeric: true }),
      );
    },
  };
}
