"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, LoaderCircle, Pencil, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DecisionActionState } from "@/modules/booking/actions/decisions";

type DecisionAction = (
  previous: DecisionActionState,
  formData: FormData,
) => Promise<DecisionActionState>;

const IDLE: DecisionActionState = { status: "idle" };

function ErrorMessage({ state }: { state: DecisionActionState }) {
  const t = useTranslations("Bookings.errors");

  if (state.status !== "error") return null;

  return (
    <p role="alert" className="text-sm text-red-700">
      {t(state.reason)}
    </p>
  );
}

export function DecisionForm({
  action,
  bookingRequestId,
  expectedFrom,
  label,
  requiresReason = false,
  variant = "primary",
}: {
  action: DecisionAction;
  bookingRequestId: string;
  expectedFrom?: "IN_REVIEW";
  label: string;
  requiresReason?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const reasonId = `reason-${bookingRequestId}-${label}`;

  const className =
    variant === "danger"
      ? "rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      : variant === "secondary"
        ? "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
        : "rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60";

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      {expectedFrom ? (
        <input type="hidden" name="expectedFrom" value={expectedFrom} />
      ) : null}

      {requiresReason ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium">
            {t("reasonLabel")}
          </label>
          <textarea
            id={reasonId}
            name="reason"
            required
            rows={3}
            aria-describedby={`${reasonId}-hint`}
            className="rounded-md border border-zinc-300 p-2 text-sm"
          />
          <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
            {t("reasonHint")}
          </p>
        </div>
      ) : null}

      <ErrorMessage state={state} />

      <button type="submit" disabled={pending} className={className}>
        {label}
      </button>
    </form>
  );
}

export function QuoteResendForm({ action, bookingRequestId, disabled = false, label }: {
  action: DecisionAction;
  bookingRequestId: string;
  disabled?: boolean;
  label?: string;
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      <Button type="submit" variant="outline" disabled={disabled || pending || state.status === "done"}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
        {label ?? t("resendQuote")}
      </Button>
      {pending ? <p role="status" className="text-sm text-muted-foreground">{t("queuingQuote")}</p> : null}
      {state.status === "done" ? <p role="status" className="text-sm text-muted-foreground">{t("quoteQueued")}</p> : null}
      <ErrorMessage state={state} />
    </form>
  );
}

export function AdvanceEditor({
  action,
  bookingRequestId,
  amountLabel,
  defaultAmount,
}: {
  action: DecisionAction;
  bookingRequestId: string;
  /** The advance already formatted for the page locale. */
  amountLabel: string;
  /** The advance in euros, as the input's starting value. */
  defaultAmount: string;
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);
  // The state seen when editing opened; a newer successful result closes the editor.
  const [openedFrom, setOpenedFrom] = useState<DecisionActionState | null>(null);
  const editing = openedFrom !== null && (state === openedFrom || state.status === "error");
  const inputId = `advance-${bookingRequestId}`;

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        {amountLabel}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("editAdvance")}
          title={t("editAdvance")}
          onClick={() => setOpenedFrom(state)}
        >
          <Pencil aria-hidden="true" />
        </Button>
      </span>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      <label htmlFor={inputId} className="sr-only">
        {t("advanceLabel")}
      </label>
      <span className="inline-flex items-center gap-1">
        <Input
          id={inputId}
          name="advance"
          type="number"
          step="0.01"
          min="0"
          required
          autoFocus
          defaultValue={defaultAmount}
          className="w-32"
        />
        <Button type="submit" variant="ghost" size="icon-sm" aria-label={t("saveAdvance")} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("cancelEdit")}
          disabled={pending}
          onClick={() => setOpenedFrom(null)}
        >
          <X aria-hidden="true" />
        </Button>
      </span>
      <ErrorMessage state={state} />
    </form>
  );
}

export function PaymentForm({
  action,
  bookingRequestId,
}: {
  action: DecisionAction;
  bookingRequestId: string;
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />

      <div className="flex flex-col gap-1">
        <label htmlFor="amount" className="text-sm font-medium">
          {t("amountLabel")}
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0"
          required
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="receivedAt" className="text-sm font-medium">
          {t("receivedAtLabel")}
        </label>
        <input
          id="receivedAt"
          name="receivedAt"
          type="date"
          required
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="reference" className="text-sm font-medium">
          {t("referenceLabel")}
        </label>
        <input
          id="reference"
          name="reference"
          type="text"
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <ErrorMessage state={state} />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {t("recordPayment")}
      </button>
    </form>
  );
}
