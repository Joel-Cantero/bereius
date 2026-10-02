import "server-only";

import { createHash, createHmac } from "node:crypto";
import { getEnv } from "@/lib/env";
import type { CalendarEntry } from "@/modules/calendar/ical";

export function calendarSourceKey(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

export function calendarEventKey(entry: CalendarEntry) {
  if (!entry.uid) return null;
  return createHash("sha256").update(JSON.stringify([entry.uid, entry.occurrenceId ?? ""])).digest("hex");
}

export function calendarSelection(sourceKey: string, entry: CalendarEntry) {
  const eventKey = calendarEventKey(entry);
  const key = getEnv().BOOKING.secretKey;
  if (!eventKey || !key) return null;
  const signature = createHmac("sha256", key)
    .update(JSON.stringify([sourceKey, eventKey, entry.start, entry.end, entry.allDay, entry.title]))
    .digest("hex");
  return `${eventKey}:${signature}`;
}