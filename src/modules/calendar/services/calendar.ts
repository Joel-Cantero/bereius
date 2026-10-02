import "server-only";

import { logger } from "@/lib/logger";
import { IntegrationSettingsError, resolveIntegration } from "@/modules/booking/services/settings";
import { parseCalendar, type CalendarEntry } from "@/modules/calendar/ical";
import { fetchCalendarSource } from "@/modules/calendar/source";

export type CalendarResult =
  | { status: "ok"; entries: CalendarEntry[] }
  | { status: "not_configured" | "unavailable"; entries: [] };

export async function readCalendar(from: Date, to: Date): Promise<CalendarResult> {
  try {
    const { secret } = await resolveIntegration("CALENDAR_ICS");
    const source = await fetchCalendarSource(secret);
    return { status: "ok", entries: parseCalendar(source, from, to) };
  } catch (error) {
    if (error instanceof IntegrationSettingsError && error.code === "not_configured") {
      return { status: "not_configured", entries: [] };
    }
    logger.warn({ event: "calendar_source_unavailable" }, "calendar source unavailable");
    return { status: "unavailable", entries: [] };
  }
}