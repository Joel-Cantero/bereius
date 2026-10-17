"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { LoaderCircle, Search, UserRoundPen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ContactActionState,
  CustomerLookupState,
} from "@/modules/booking/actions/contact";

type LookupAction = (
  previous: CustomerLookupState,
  formData: FormData,
) => Promise<CustomerLookupState>;

type ChangeAction = (
  previous: ContactActionState,
  formData: FormData,
) => Promise<ContactActionState>;

const IDLE_LOOKUP: CustomerLookupState = { status: "idle" };
const IDLE_CHANGE: ContactActionState = { status: "idle" };

/**
 * Lets an operator point a request at another customer, found by tax
 * identifier, so the quote is issued to the right Holded contact.
 */
export function CustomerChange({
  bookingRequestId,
  lookupAction,
  changeAction,
}: {
  bookingRequestId: string;
  lookupAction: LookupAction;
  changeAction: ChangeAction;
}) {
  const t = useTranslations("Bookings.customerChange");
  const errors = useTranslations("Bookings.errors");
  const [taxId, setTaxId] = useState("");
  const [lookup, lookupFormAction, searching] = useActionState(lookupAction, IDLE_LOOKUP);
  const [change, changeFormAction, changing] = useActionState(changeAction, IDLE_CHANGE);
  const inputId = `customer-tax-id-${bookingRequestId}`;

  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t("title")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-muted-foreground">{t("hint")}</p>

        <form action={lookupFormAction} className="flex flex-col gap-1">
          <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
          <label htmlFor={inputId} className="font-medium">
            {t("taxId")}
          </label>
          <span className="flex items-center gap-2">
            <Input
              id={inputId}
              name="taxId"
              required
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              value={taxId}
              onChange={(event) => setTaxId(event.target.value)}
              className="w-48"
            />
            <Button type="submit" variant="outline" disabled={searching}>
              {searching ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Search aria-hidden="true" />
              )}
              {t("search")}
            </Button>
          </span>
        </form>

        {lookup.status === "error" ? (
          <p role="alert" className="text-red-700">
            {errors(lookup.reason)}
          </p>
        ) : null}

        {lookup.status === "found" ? (
          <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t("name")}</dt>
              <dd>{lookup.name}</dd>
              <dt className="text-muted-foreground">{t("taxId")}</dt>
              <dd>{lookup.taxId}</dd>
              <dt className="text-muted-foreground">{t("email")}</dt>
              <dd>{lookup.email}</dd>
            </dl>
            <p role="status" className="text-muted-foreground">
              {lookup.current ? t("current") : t(`source.${lookup.source}`)}
            </p>

            {lookup.current ? null : (
              <form action={changeFormAction} className="flex flex-col items-start gap-2">
                <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
                <input type="hidden" name="taxId" value={lookup.taxId} />
                <Button type="submit" disabled={changing}>
                  {changing ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <UserRoundPen aria-hidden="true" />
                  )}
                  {t("assign")}
                </Button>
                {change.status === "error" ? (
                  <p role="alert" className="text-red-700">
                    {errors(change.reason)}
                  </p>
                ) : null}
              </form>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}
