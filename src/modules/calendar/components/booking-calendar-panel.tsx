import { getTranslations } from "next-intl/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link } from "@/i18n/navigation";
import { BookingCalendarForm } from "@/modules/calendar/components/booking-calendar-form";
import type { BookingCalendarView } from "@/modules/calendar/services/links";

export async function BookingCalendarPanel({ bookingRequestId, locale, canLink, view }: { bookingRequestId: string; locale: string; canLink: boolean; view: BookingCalendarView }) {
  const t = await getTranslations({ locale, namespace: "Calendar.bookingLinks" });
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Madrid" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Madrid" });
  if (!canLink && !view.link && !view.history.length) return null;
  return (
    <section aria-labelledby="booking-calendar-heading" className="flex min-w-0 flex-col gap-3 border-t pt-6">
      <h2 id="booking-calendar-heading" className="text-lg font-medium">{t("title")}</h2>
      {view.status !== "ok" ? <Alert><AlertDescription>{t(`errors.${view.status}`)}</AlertDescription></Alert> : null}
      {view.link ? (
        <>
          <p className="text-sm font-medium break-words">{view.link.title || t("unnamed")}</p>
          <p className="text-sm text-muted-foreground">{dates.format(new Date(view.link.start))} – {dates.format(new Date(new Date(view.link.end).getTime() - 1))}</p>
          {view.link.review ? <Alert variant="destructive"><AlertDescription>{t(`review.${view.link.review}`)}</AlertDescription></Alert> : null}
          <Link href={{ pathname: "/calendar", query: { month: view.link.start.slice(0, 7) } }} className="self-start text-sm underline">{t("openCalendar")}</Link>
          <BookingCalendarForm bookingRequestId={bookingRequestId} linkId={view.link.id} candidates={[]} />
        </>
      ) : canLink ? <BookingCalendarForm bookingRequestId={bookingRequestId} candidates={view.candidates} /> : null}
      {view.history.length ? <details className="text-sm"><summary className="cursor-pointer font-medium">{t("history")}</summary><ol className="mt-2 flex flex-col gap-2">{view.history.map((event) => <li key={event.id} className="break-words">{t(event.action === "LINKED" ? "linked" : "unlinked")} · {event.title || t("unnamed")} · {event.actor || t("operator")} · <time dateTime={event.at}>{dateTime.format(new Date(event.at))}</time></li>)}</ol></details> : null}
    </section>
  );
}