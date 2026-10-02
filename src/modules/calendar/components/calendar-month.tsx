import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { monthSchema, monthWindow, occursOn } from "@/modules/calendar/dates";
import type { CalendarEntry } from "@/modules/calendar/ical";

export interface CalendarLabels {
  previous: string;
  next: string;
  today: string;
  unnamed: string;
  allDay: string;
  empty: string;
  agenda: string;
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
  const monthEntries = entries.filter((entry) => days.some(({ day }) => day.startsWith(month) && occursOn(entry, day)));

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby="calendar-month">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="calendar-month" className="text-xl font-semibold capitalize">{heading}</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" disabled={!monthSchema.safeParse(window.previous).success} aria-label={labels.previous} title={labels.previous} render={<Link href={{ pathname: "/calendar", query: { month: window.previous } }} />}><ChevronLeft aria-hidden="true" /></Button>
          <Button variant="outline" render={<Link href="/calendar" />}><CalendarDays aria-hidden="true" data-icon="inline-start" />{labels.today}</Button>
          <Button variant="outline" size="icon" disabled={!monthSchema.safeParse(window.next).success} aria-label={labels.next} title={labels.next} render={<Link href={{ pathname: "/calendar", query: { month: window.next } }} />}><ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-7 border-b bg-muted/40">
          {days.slice(0, 7).map(({ date, day }) => <div key={day} className="min-w-0 p-2 text-center text-xs font-medium">{shortDay.format(date)}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map(({ date, day }) => {
            const events = entries.filter((entry) => occursOn(entry, day));
            return (
              <div key={day} aria-label={dayFormat.format(date)} className={cn("flex min-h-20 min-w-0 flex-col gap-1 border-b border-r p-1.5 sm:min-h-28 sm:p-2", !day.startsWith(month) && "bg-muted/30 text-muted-foreground")}>
                <time dateTime={day} aria-current={day === today ? "date" : undefined} className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs", day === today && "bg-primary font-semibold text-primary-foreground")}>{date.getUTCDate()}</time>
                {events.map((entry) => <div key={entry.id} className="hidden min-w-0 rounded-sm border-l-2 border-primary bg-primary/10 px-1.5 py-1 text-xs break-words sm:block" title={entry.title || labels.unnamed}>{entry.title || labels.unnamed}</div>)}
                {events.length ? <span className="text-center text-xs font-medium text-primary sm:hidden" aria-label={`${events.length} ${labels.agenda}`}>{events.length}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
      {monthEntries.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{labels.empty}</p> : (
        <section className="flex flex-col gap-2 sm:hidden" aria-label={labels.agenda}>
          <h3 className="text-sm font-semibold">{labels.agenda}</h3>
          <ul className="divide-y">
            {monthEntries.map((entry) => <li key={entry.id} className="flex flex-col gap-1 py-3 text-sm break-words"><span className="font-medium">{entry.title || labels.unnamed}</span><span className="text-xs text-muted-foreground">{entry.allDay ? labels.allDay : ""} {entry.start} / {entry.end}</span></li>)}
          </ul>
        </section>
      )}
    </section>
  );
}