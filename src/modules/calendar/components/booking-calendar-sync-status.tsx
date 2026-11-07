"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { GoogleCalendarBookingActionState } from "@/modules/calendar/actions/booking-sync";
import type { GoogleCalendarBookingSyncView } from "@/modules/calendar/types";

const idle: GoogleCalendarBookingActionState = { status: "idle" };

export function BookingCalendarSyncStatus({
  bookingRequestId,
  view,
  action,
}: {
  bookingRequestId: string;
  view: Exclude<GoogleCalendarBookingSyncView, { status: "none" }>;
  action: (previous: GoogleCalendarBookingActionState, data: FormData) => Promise<GoogleCalendarBookingActionState>;
}) {
  const t = useTranslations("Calendar.googleBookingSync");
  const [state, formAction, pending] = useActionState(action, idle);

  if (view.status === "created") {
    return <p role="status" className="text-sm text-green-700 dark:text-green-400">{t("created")}</p>;
  }
  if (view.status === "pending") {
    return <p role="status" className="text-sm text-muted-foreground">{t("pending")}</p>;
  }

  return (
    <section className="flex flex-col items-start gap-2" aria-labelledby={`google-sync-${bookingRequestId}`}>
      <h2 id={`google-sync-${bookingRequestId}`} className="text-sm font-medium">{t("title")}</h2>
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t("failed")}</p>
      <form action={formAction} className="flex flex-col items-start gap-2">
        <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {t("retry")}
        </Button>
        {pending ? <p role="status" className="text-sm text-muted-foreground">{t("retrying")}</p> : null}
        {state.status === "error" ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t(`errors.${state.reason}`)}</p>
        ) : null}
      </form>
    </section>
  );
}