"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Plug, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SettingsActionState } from "@/modules/booking/actions/settings";

const idle: SettingsActionState = { status: "idle" };

export function GoogleCalendarSettingsForm({
  action,
  onTest,
  calendarId,
  configured,
  hasSecret,
}: {
  action: (previous: SettingsActionState, data: FormData) => Promise<SettingsActionState>;
  onTest: () => Promise<SettingsActionState>;
  calendarId?: string;
  configured: boolean;
  hasSecret: boolean;
}) {
  const t = useTranslations("Calendar.googleSettings");
  const settings = useTranslations("Bookings.settings");
  const errors = useTranslations("Bookings.errors");
  const [state, save, pending] = useActionState(action, idle);
  const [testState, test, testing] = useActionState(onTest, idle);
  const canTest = configured || state.status === "saved";
  const feedback = (result: SettingsActionState) => result.status === "idle" ? null : (
    <p role={result.status === "error" ? "alert" : "status"} className="text-sm">
      {result.status === "error"
        ? errors(result.reason === "storage_unavailable" ? "unknown" : result.reason)
        : settings(result.status === "verified" ? "verified" : "saved")}
    </p>
  );

  return (
    <section className="flex flex-col gap-4" aria-labelledby="google-calendar-settings-title">
      <h2 id="google-calendar-settings-title" className="text-lg font-semibold">{t("title")}</h2>
      <form action={save} className="flex flex-col gap-4">
        <FieldGroup>
          <Field data-invalid={state.status === "error" && state.reason === "invalid"}>
            <FieldLabel htmlFor="google-calendar-id">{t("calendarId")}</FieldLabel>
            <Input
              id="google-calendar-id"
              name="calendarId"
              type="text"
              autoComplete="off"
              required
              maxLength={255}
              defaultValue={calendarId}
              aria-invalid={state.status === "error" && state.reason === "invalid"}
            />
          </Field>
          <Field data-invalid={state.status === "error" && state.reason === "invalid"}>
            <FieldLabel htmlFor="google-service-account">{t("serviceAccountJson")}</FieldLabel>
            <textarea
              id="google-service-account"
              name="serviceAccountJson"
              required={!hasSecret}
              maxLength={32_768}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={state.status === "error" && state.reason === "invalid"}
              aria-describedby="google-service-account-hint"
              className="min-h-36 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <p id="google-service-account-hint" className="text-xs text-muted-foreground">
              {hasSecret ? t("storedCredential") : t("shareCalendar")}
            </p>
          </Field>
        </FieldGroup>
        <p className="text-sm text-muted-foreground">{canTest ? settings("configured") : settings("notConfigured")}</p>
        <div>
          <Button type="submit" disabled={pending || testing}>
            <Save aria-hidden="true" data-icon="inline-start" />
            {settings("save")}
          </Button>
        </div>
        {feedback(state)}
      </form>
      <form action={test} className="flex flex-col items-start gap-2">
        <Button type="submit" variant="outline" disabled={!canTest || pending || testing}>
          <Plug aria-hidden="true" data-icon="inline-start" />
          {settings("test")}
        </Button>
        {feedback(testState)}
      </form>
    </section>
  );
}