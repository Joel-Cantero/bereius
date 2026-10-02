import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { groupCalendarEntries, madridDate, monthSchema, monthWindow, occursOn } from "@/modules/calendar/dates";
import type { CalendarEntry } from "@/modules/calendar/ical";

const columnStarts = ["col-start-1", "col-start-2", "col-start-3", "col-start-4", "col-start-5", "col-start-6", "col-start-7"];
const columnSpans = ["col-span-1", "col-span-2", "col-span-3", "col-span-4", "col-span-5", "col-span-6", "col-span-7"];

export interface CalendarLabels {
  previous: string;
  next: string;
  today: string;
  unnamed: string;
  allDay: string;
  empty: string;
  agenda: string;
  confirmed?: string;
  review?: string;
}

export function CalendarMonth({ month, today, locale, entries, labels }: {
  month: string;
  today: string;
  locale: string;
  entries: CalendarEntry[];
  labels: CalendarLabels;
}) {
  const window = monthWindow(month);
  const heading = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(window.first);
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const shortDay = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(window.start);
    date.setUTCDate(date.getUTCDate() + index);
    return { date, day: date.toISOString().slice(0, 10) };
  });
  const displayEntries = groupCalendarEntries(entries);
  const monthEntries = displayEntries.filter((entry) => days.some(({ day }) => day.startsWith(month) && occursOn(entry, day)));
  const weeks = Array.from({ length: 6 }, (_, index) => {
    const weekDays = days.slice(index * 7, index * 7 + 7);
    const segments = displayEntries.flatMap((entry) => {
      const occupied = weekDays.flatMap(({ day }, dayIndex) => occursOn(entry, day) ? [dayIndex] : []);
      if (!occupied.length) return [];
      return [{ entry, start: occupied[0], end: occupied.at(-1)! }];
    }).toSorted((first, second) => first.start - second.start || second.end - first.end || first.entry.id.localeCompare(second.entry.id));
    const laneEnds: number[] = [];
    const events = segments.map((segment) => {
      const available = laneEnds.findIndex((end) => end < segment.start);
      const lane = available === -1 ? laneEnds.length : available;
      laneEnds[lane] = segment.end;
      return { ...segment, lane };
    });
    return { days: weekDays, events, lanes: Math.max(laneEnds.length, 1) };
  });

  function eventDates(entry: CalendarEntry) {
    const first = entry.allDay ? entry.start : madridDate(new Date(entry.start));
    const lastInstant = new Date(new Date(entry.end).getTime() - 1);
    const last = entry.allDay ? lastInstant.toISOString().slice(0, 10) : madridDate(lastInstant);
    return dayFormat.formatRange(new Date(first), new Date(last < first ? first : last));
  }

  function eventLabel(entry: CalendarEntry) {
    return `${entry.title || labels.unnamed}: ${eventDates(entry)}`;
  }

  function bookingLinks(entry: CalendarEntry) {
    return entry.bookings?.map((booking) => <Link key={booking.id} href={`/bookings/${booking.id}`} title={booking.label} className={cn("block truncate text-xs font-medium underline", booking.needsReview && "text-destructive")}>{booking.needsReview ? labels.review : labels.confirmed}: {booking.label}</Link>);
  }

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="calendar-month">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="calendar-month" className="text-xl font-semibold capitalize">{heading}</h2>
        <div className="flex items-center gap-2">
          <Button nativeButton={false} variant="outline" size="icon" disabled={!monthSchema.safeParse(window.previous).success} aria-label={labels.previous} title={labels.previous} render={<Link role="link" href={{ pathname: "/calendar", query: { month: window.previous } }} />}><ChevronLeft aria-hidden="true" /></Button>
          <Button nativeButton={false} variant="outline" render={<Link role="link" href="/calendar" />}><CalendarDays aria-hidden="true" data-icon="inline-start" />{labels.today}</Button>
          <Button nativeButton={false} variant="outline" size="icon" disabled={!monthSchema.safeParse(window.next).success} aria-label={labels.next} title={labels.next} render={<Link role="link" href={{ pathname: "/calendar", query: { month: window.next } }} />}><ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-7 border-b bg-muted/40">
          {days.slice(0, 7).map(({ date, day }) => <div key={day} className="min-w-0 p-2 text-center text-xs font-medium">{shortDay.format(date)}</div>)}
        </div>
        <div>
          {weeks.map((week, weekIndex) => (
            <div key={week.days[0].day} className={cn("relative min-h-20", weekIndex !== 5 && "border-b")}>
              <div className="absolute inset-0 grid grid-cols-7">
              {week.days.map(({ date, day }, dayIndex) => {
                const count = displayEntries.filter((entry) => occursOn(entry, day)).length;
                return (
                  <div key={day} aria-label={dayFormat.format(date)} className={cn("flex min-w-0 flex-col gap-1 p-1 sm:p-1.5", dayIndex !== 6 && "border-r", !day.startsWith(month) && "bg-muted/30 text-muted-foreground")}>
                    <time dateTime={day} aria-current={day === today ? "date" : undefined} className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs", day === today && "bg-primary font-semibold text-primary-foreground")}>{date.getUTCDate()}</time>
                    {count ? <span className="text-center text-xs font-medium text-primary sm:hidden" aria-label={`${count} ${labels.agenda}`}>{count}</span> : null}
                  </div>
                );
              })}
              </div>
              <div className="relative hidden flex-col pt-8 pb-8 sm:flex">
              {Array.from({ length: week.lanes }, (_, lane) => (
                <div key={lane} className={cn("grid grid-cols-7", week.events.some((event) => event.lane === lane && event.entry.bookings?.length) ? "min-h-24" : "h-16")}>
                {week.events.filter((event) => event.lane === lane).map(({ entry, start, end }) => (
                <article key={entry.id} aria-label={eventLabel(entry)} title={eventLabel(entry)} data-calendar-event="" data-calendar-start={week.days[start].day} data-calendar-last={week.days[end].day} className={cn("mx-1 mb-1 min-w-0 overflow-hidden rounded-sm border-l-2 border-primary bg-primary/10 px-2 py-1 text-xs break-words", columnStarts[start], columnSpans[end - start], occursOn(entry, new Date(week.days[0].date.getTime() - 86400000).toISOString().slice(0, 10)) && "rounded-l-none", occursOn(entry, new Date(week.days[6].date.getTime() + 86400000).toISOString().slice(0, 10)) && "rounded-r-none")}>
                  <span className={entry.bookings?.length ? "line-clamp-2" : "line-clamp-3"}>{entry.title || labels.unnamed}</span>
                  {bookingLinks(entry)}
                </article>
                ))}
                </div>
              ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {monthEntries.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{labels.empty}</p> : (
        <section className="flex flex-col gap-2 sm:hidden" aria-label={labels.agenda}>
          <h3 className="text-sm font-semibold">{labels.agenda}</h3>
          <ul className="divide-y">
            {monthEntries.map((entry) => <li key={entry.id} className="flex flex-col gap-1 py-3 text-sm break-words"><span className="font-medium">{entry.title || labels.unnamed}</span><span className="text-xs text-muted-foreground">{entry.allDay ? `${labels.allDay} ${eventDates(entry)}` : `${entry.start} / ${entry.end}`}</span>{bookingLinks(entry)}</li>)}
          </ul>
        </section>
      )}
    </section>
  );
}