import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link } from "@/i18n/navigation";
import { noIndexMetadata } from "@/lib/seo";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { CalendarMonth } from "@/modules/calendar/components/calendar-month";
import { madridDate, monthSchema, monthWindow } from "@/modules/calendar/dates";
import { readCalendarWithBookings } from "@/modules/calendar/services/links";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface Props {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Calendar" });
  return noIndexMetadata({ title: t("title"), description: t("description") });
}

export default async function CalendarPage({ params, searchParams }: Props) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  const actor = await requireBookingActor().catch((error: unknown) => {
    if (error instanceof AuthorizationError) {
      redirect(`${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent("/calendar")}`);
    }
    throw error;
  });
  const t = await getTranslations({ locale, namespace: "Calendar" });
  const today = madridDate(new Date());
  const requested = (await searchParams).month;
  const parsed = monthSchema.safeParse(requested ?? today.slice(0, 7));
  const month = parsed.success ? parsed.data : today.slice(0, 7);
  const window = monthWindow(month);
  const from = new Date(window.start.getTime() - 86400000);
  const result = await readCalendarWithBookings(from, window.end);

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 px-3 py-4 sm:px-6 sm:py-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      {!parsed.success ? <Alert variant="destructive"><AlertDescription>{t("invalidMonth")}</AlertDescription></Alert> : null}
      {result.status !== "ok" ? (
        <Alert variant={result.status === "unavailable" ? "destructive" : "default"}><AlertDescription>{t(result.status)} {actor.role === "ADMINISTRATOR" ? <Link href="/bookings/settings" className="underline">{t("integrations")}</Link> : null}</AlertDescription></Alert>
      ) : null}
      <CalendarMonth month={month} today={today} locale={locale} entries={result.entries} labels={{ previous: t("previous"), next: t("next"), today: t("today"), unnamed: t("unnamed"), allDay: t("allDay"), empty: result.status === "ok" ? t("empty") : "", agenda: t("agenda"), confirmed: t("bookingLinks.confirmed"), review: t("bookingLinks.needsReview") }} />
    </main>
  );
}