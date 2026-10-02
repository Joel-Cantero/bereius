"use client";

import { useActionState } from "react";
import { Link2, Unlink } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { linkBookingCalendarAction, unlinkBookingCalendarAction, type CalendarLinkActionState } from "@/modules/calendar/actions/links";
import type { CalendarBookingCandidate } from "@/modules/calendar/ical";

const idle: CalendarLinkActionState = { status: "idle" };

export function BookingCalendarForm({ bookingRequestId, linkId, candidates }: { bookingRequestId: string; linkId?: string; candidates: CalendarBookingCandidate[] }) {
  const t = useTranslations("Calendar.bookingLinks");
  const locale = useLocale();
  const [state, action, pending] = useActionState(linkId ? unlinkBookingCalendarAction : linkBookingCalendarAction, idle);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Madrid" });
  const selectId = `calendar-selection-${bookingRequestId}`;
  return (
    <form action={action} className="flex min-w-0 flex-col items-start gap-3">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      {linkId ? <input type="hidden" name="linkId" value={linkId} /> : (
        <>
          <label htmlFor={selectId} className="text-sm font-medium">{t("event")}</label>
          <select id={selectId} name="selection" required defaultValue="" disabled={pending || candidates.length === 0} className="h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3 text-sm">
            <option value="">{t("choose")}</option>
            {candidates.map((candidate) => <option key={candidate.selection} value={candidate.selection}>{candidate.title || t("unnamed")} · {dateFormat.format(new Date(candidate.start))} – {dateFormat.format(new Date(new Date(candidate.end).getTime() - 1))}</option>)}
          </select>
          {candidates.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t("noCandidates")}</p> : <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" value="yes" required disabled={pending} className="mt-0.5 size-4 shrink-0 accent-primary" />{t("confirm")}</label>}
        </>
      )}
      {state.status === "error" ? <p role="alert" className="text-sm text-destructive">{t(`errors.${state.reason}`)}</p> : null}
      <Button type="submit" variant={linkId ? "outline" : "default"} disabled={pending || (!linkId && candidates.length === 0)}>{linkId ? <Unlink aria-hidden="true" /> : <Link2 aria-hidden="true" />}{t(linkId ? "unlink" : "link")}</Button>
    </form>
  );
}