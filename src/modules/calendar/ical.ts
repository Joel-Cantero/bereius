import ICAL from "ical.js";

export interface CalendarEntry {
  id: string;
  uid?: string;
  occurrenceId?: string;
  bookings?: { id: string; label: string; needsReview: boolean }[];
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}

export type CalendarBookingCandidate = Pick<CalendarEntry, "title" | "start" | "end" | "allDay"> & { selection: string };

export function parseCalendar(text: string, from: Date, to: Date): CalendarEntry[] {
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== "vcalendar") throw new Error("invalid_calendar");
  const components = root.getAllSubcomponents("vevent");
  if (components.length > 10000) throw new Error("calendar_too_large");
  const entries: CalendarEntry[] = [];
  let iterations = 0;
  for (const component of components) {
    if (component.getFirstPropertyValue("status") === "CANCELLED") continue;
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) continue;
    const add = (start: ICAL.Time, end: ICAL.Time, occurrenceEvent = event, occurrenceId = "") => {
      if (occurrenceEvent.component.getFirstPropertyValue("status") === "CANCELLED") return;
      const startsAt = start.toJSDate();
      const endsAt = end.toJSDate();
      if (startsAt < to && endsAt > from) {
        if (entries.length >= 1000) throw new Error("calendar_too_large");
        entries.push({
          id: `${event.uid}:${start.toString()}`,
          uid: event.uid || "",
          occurrenceId,
          title: occurrenceEvent.summary || "",
          start: start.isDate ? start.toString() : startsAt.toISOString(),
          end: end.isDate ? end.toString() : endsAt.toISOString(),
          allDay: start.isDate,
        });
      }
    };
    if (!event.isRecurring()) {
      add(event.startDate, event.endDate);
      continue;
    }
    const iterator = event.iterator();
    let occurrence: ICAL.Time | null;
    while ((occurrence = iterator.next())) {
      if (++iterations > 50000) throw new Error("calendar_too_large");
      if (occurrence.toJSDate() >= to) break;
      const details = event.getOccurrenceDetails(occurrence);
      add(details.startDate, details.endDate, details.item, occurrence.toString());
    }
  }
  return entries.sort((first, second) => first.start.localeCompare(second.start));
}