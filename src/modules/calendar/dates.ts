import { z } from "zod";
import type { CalendarEntry } from "@/modules/calendar/ical";

export const monthSchema = z.string().regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/);

export function madridDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function monthWindow(month: string) {
  const valid = monthSchema.parse(month);
  const first = new Date(`${valid}-01T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 42);
  const previous = new Date(first);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const next = new Date(first);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { first, start, end, previous: previous.toISOString().slice(0, 7), next: next.toISOString().slice(0, 7) };
}

export function occursOn(entry: CalendarEntry, day: string): boolean {
  const start = entry.allDay ? entry.start : madridDate(new Date(entry.start));
  const end = entry.allDay ? entry.end : madridDate(new Date(new Date(entry.end).getTime() - 1));
  return start <= day && (entry.allDay ? end > day : end >= day);
}

export function groupCalendarEntries(entries: CalendarEntry[]): CalendarEntry[] {
  const allDay = entries.filter((entry) => entry.allDay).toSorted((first, second) =>
    first.title.localeCompare(second.title) || first.start.localeCompare(second.start) || first.end.localeCompare(second.end));
  const grouped: CalendarEntry[] = [];
  for (const entry of allDay) {
    const previous = grouped.at(-1);
    if (entry.title && previous?.title === entry.title && entry.start <= previous.end) {
      if (entry.end > previous.end) previous.end = entry.end;
      if (entry.bookings?.length) previous.bookings = [...new Map([...(previous.bookings ?? []), ...entry.bookings].map((booking) => [booking.id, booking])).values()];
    } else {
      grouped.push({ ...entry });
    }
  }
  return [...grouped, ...entries.filter((entry) => !entry.allDay)].toSorted((first, second) =>
    first.start.localeCompare(second.start) || first.end.localeCompare(second.end) || first.id.localeCompare(second.id));
}