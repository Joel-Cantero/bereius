import "server-only";

import { createHash } from "node:crypto";

import { auth, calendar as calendarApi } from "@googleapis/calendar";
import type { calendar_v3 } from "@googleapis/calendar";

import { googleCalendarConfigSchema, parseGoogleServiceAccountJson } from "@/modules/calendar/schema";

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export class GoogleCalendarError extends Error {
  constructor(readonly code: "invalid_credentials" | "calendar_not_found" | "insufficient_access" | "unavailable" | "event_conflict") {
    super(code);
    this.name = "GoogleCalendarError";
  }
}

export interface GoogleCalendarReservation {
  id: string;
  customerName: string;
  headcount: number;
  boardType: "SELF_CATERING" | "FULL_BOARD";
  startDate: Date;
  endDate: Date;
}

export function googleCalendarEventId(bookingRequestId: string): string {
  return `a${createHash("sha256").update(bookingRequestId).digest("hex")}`;
}

export function toGoogleCalendarEvent(booking: GoogleCalendarReservation): calendar_v3.Schema$Event {
  return {
    id: googleCalendarEventId(booking.id),
    summary: booking.customerName,
    description: `${booking.headcount} personas\nRégimen: ${booking.boardType === "SELF_CATERING" ? "Derecho a cocina" : "Pensión completa"}`,
    start: { date: booking.startDate.toISOString().slice(0, 10) },
    end: { date: booking.endDate.toISOString().slice(0, 10) },
  };
}

function createCalendarClient(config: unknown, secret: string) {
  const parsedConfig = googleCalendarConfigSchema.safeParse(config);
  const parsedSecret = parseGoogleServiceAccountJson(secret);
  if (!parsedConfig.success || !parsedSecret) {
    throw new GoogleCalendarError("invalid_credentials");
  }

  const credentials = new auth.GoogleAuth({
    credentials: {
      client_email: parsedSecret.credentials.client_email,
      private_key: parsedSecret.credentials.private_key,
    },
    scopes: [CALENDAR_EVENTS_SCOPE],
  });

  return {
    api: calendarApi({ version: "v3", auth: credentials }),
    calendarId: parsedConfig.data.calendarId,
  };
}

export async function verifyGoogleCalendarAccess(config: unknown, secret: string): Promise<void> {
  const { api, calendarId } = createCalendarClient(config, secret);
  try {
    const response = await api.events.list(
      { calendarId, maxResults: 1 },
      { timeout: 10_000 },
    );
    const role = response.data.accessRole;
    if (role !== "writer" && role !== "owner") {
      throw new GoogleCalendarError("insufficient_access");
    }
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) throw new GoogleCalendarError("calendar_not_found");
    if (status === 401) throw new GoogleCalendarError("invalid_credentials");
    if (status === 403) throw new GoogleCalendarError("insufficient_access");
    throw new GoogleCalendarError("unavailable");
  }
}

function providerStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function mapGoogleError(error: unknown): GoogleCalendarError {
  const status = providerStatus(error);
  if (status === 404) return new GoogleCalendarError("calendar_not_found");
  if (status === 401) return new GoogleCalendarError("invalid_credentials");
  if (status === 403) return new GoogleCalendarError("insufficient_access");
  return new GoogleCalendarError("unavailable");
}

function sameEvent(existing: calendar_v3.Schema$Event, expected: calendar_v3.Schema$Event): boolean {
  return existing.id === expected.id && existing.summary === expected.summary &&
    existing.description === expected.description &&
    existing.start?.date === expected.start?.date && existing.end?.date === expected.end?.date;
}

async function getEvent(api: ReturnType<typeof calendarApi>, calendarId: string, eventId: string) {
  return api.events.get({ calendarId, eventId }, { timeout: 10_000 });
}

async function findExistingEvent(
  api: ReturnType<typeof calendarApi>,
  calendarId: string,
  expected: calendar_v3.Schema$Event,
): Promise<calendar_v3.Schema$Event | null> {
  try {
    const response = await getEvent(api, calendarId, expected.id!);
    const existing = response.data;
    if (!sameEvent(existing, expected)) throw new GoogleCalendarError("event_conflict");
    return existing;
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    if (providerStatus(error) === 404) return null;
    throw mapGoogleError(error);
  }
}

export async function ensureGoogleCalendarEvent(
  config: unknown,
  secret: string,
  booking: GoogleCalendarReservation,
): Promise<{ eventId: string; created: boolean }> {
  const { api, calendarId } = createCalendarClient(config, secret);
  await verifyGoogleCalendarAccess(config, secret);
  const expected = toGoogleCalendarEvent(booking);
  const existing = await findExistingEvent(api, calendarId, expected);
  if (existing) return { eventId: expected.id!, created: false };

  try {
    await api.events.insert({ calendarId, requestBody: expected }, { timeout: 10_000 });
    return { eventId: expected.id!, created: true };
  } catch (insertError) {
    // The insert may have succeeded even if its response was lost. Reuse its
    // deterministic ID and verify the resulting event before any retry.
    try {
      const afterInsert = await findExistingEvent(api, calendarId, expected);
      if (afterInsert) return { eventId: expected.id!, created: false };
    } catch (reconcileError) {
      if (reconcileError instanceof GoogleCalendarError && reconcileError.code === "event_conflict") {
        throw reconcileError;
      }
    }
    throw mapGoogleError(insertError);
  }
}

export async function deleteGoogleCalendarEvent(
  config: unknown,
  secret: string,
  eventId: string,
): Promise<void> {
  const { api, calendarId } = createCalendarClient(config, secret);
  await verifyGoogleCalendarAccess(config, secret);
  try {
    await api.events.delete({ calendarId, eventId }, { timeout: 10_000 });
  } catch (error) {
    const status = providerStatus(error);
    if (status === 404 || status === 410) return;
    throw mapGoogleError(error);
  }
}