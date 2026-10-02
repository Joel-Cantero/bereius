"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Save, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SettingsActionState } from "@/modules/booking/actions/settings";

const idle: SettingsActionState = { status: "idle" };

export function CalendarSettingsForm({ action, onTest, configured }: {
  action: (previous: SettingsActionState, data: FormData) => Promise<SettingsActionState>;
  onTest: () => Promise<SettingsActionState>;
  configured: boolean;
}) {
  const t = useTranslations("Calendar");
  const settings = useTranslations("Bookings.settings");
  const errors = useTranslations("Bookings.errors");
  const [state, save, pending] = useActionState(action, idle);
  const [testState, test, testing] = useActionState(onTest, idle);
  const hasSource = configured || state.status === "saved";
  const feedback = (result: SettingsActionState) => result.status === "idle" ? null : (
    <p role={result.status === "error" ? "alert" : "status"} className="text-sm">
      {result.status === "error" ? errors(result.reason === "storage_unavailable" ? "unknown" : result.reason) : settings(result.status === "verified" ? "verified" : "saved")}
    </p>
  );

  return (
    <section className="flex flex-col gap-4" aria-labelledby="calendar-settings-title">
      <h2 id="calendar-settings-title" className="text-lg font-semibold">{t("integrationTitle")}</h2>
      <form action={save} className="flex flex-col gap-4">
        <FieldGroup>
          <Field data-invalid={state.status === "error" && state.reason === "invalid"}>
            <FieldLabel htmlFor="calendar-url">{t("url")}</FieldLabel>
            <Input id="calendar-url" name="calendarUrl" type="password" autoComplete="new-password" required maxLength={2048} aria-invalid={state.status === "error" && state.reason === "invalid"} />
          </Field>
        </FieldGroup>
        <p className="text-sm text-muted-foreground">{hasSource ? settings("configured") : settings("notConfigured")}</p>
        <div><Button type="submit" disabled={pending || testing}><Save aria-hidden="true" data-icon="inline-start" />{settings("save")}</Button></div>
        {feedback(state)}
      </form>
      <form action={test} className="flex flex-col items-start gap-2">
        <Button type="submit" variant="outline" disabled={!hasSource || pending || testing}><Plug aria-hidden="true" data-icon="inline-start" />{settings("test")}</Button>
        {feedback(testState)}
      </form>
    </section>
  );
}