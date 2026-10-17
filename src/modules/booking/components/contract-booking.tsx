"use client";

import { useActionState, useEffect, useId } from "react";
import { useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { ContractBookingState } from "@/modules/booking/actions/contact";

type ContractBookingAction = (
  previous: ContractBookingState,
  formData: FormData,
) => Promise<ContractBookingState>;

const IDLE: ContractBookingState = { status: "idle" };

export interface ContractBookingDefaults {
  startDate: string | null;
  endDate: string | null;
  headcount: number | null;
  boardType: "SELF_CATERING" | "FULL_BOARD" | null;
}

export function ContractBookingForm({
  action,
  holdedId,
  defaults,
}: {
  action: ContractBookingAction;
  holdedId: string;
  defaults: ContractBookingDefaults;
}) {
  const t = useTranslations("Contracts.create");
  const errors = useTranslations("Bookings.errors");
  const boards = useTranslations("Bookings.board");
  const router = useRouter();
  const id = useId();
  const [state, formAction, pending] = useActionState(action, IDLE);

  useEffect(() => {
    if (state.status === "created") router.push(`/bookings/${state.bookingRequestId}`);
  }, [router, state]);

  const busy = pending || state.status === "created";

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="holdedId" value={holdedId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-start`}>{t("startDate")}</Label>
          <Input
            id={`${id}-start`}
            name="startDate"
            type="date"
            required
            defaultValue={defaults.startDate ?? ""}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-end`}>{t("endDate")}</Label>
          <Input
            id={`${id}-end`}
            name="endDate"
            type="date"
            required
            defaultValue={defaults.endDate ?? ""}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-headcount`}>{t("headcount")}</Label>
          <Input
            id={`${id}-headcount`}
            name="headcount"
            type="number"
            min={1}
            step={1}
            required
            defaultValue={defaults.headcount ?? ""}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-board`}>{t("boardType")}</Label>
          <select
            id={`${id}-board`}
            name="boardType"
            required
            defaultValue={defaults.boardType ?? ""}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="" disabled>
              {t("chooseBoard")}
            </option>
            <option value="SELF_CATERING">{boards("SELF_CATERING")}</option>
            <option value="FULL_BOARD">{boards("FULL_BOARD")}</option>
          </select>
        </div>
      </div>
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-red-700">
          {errors(state.reason)}
        </p>
      ) : null}
      <Button type="submit" className="self-start" disabled={busy}>
        {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("submit")}
      </Button>
    </form>
  );
}
