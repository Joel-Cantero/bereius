"use client";

import { useActionState, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Link } from "@/i18n/navigation";
import type { MovementBookingCandidate, MovementCandidatesResult, ReconciliationActionState } from "@/modules/banking/types";

export interface MovementCandidateActions {
  loadCandidatesAction: (input: { movementId: string; page: number }) => Promise<MovementCandidatesResult>;
  confirmCandidateAction: (previous: ReconciliationActionState, data: FormData) => Promise<ReconciliationActionState>;
}

function Candidate({ candidate, movementId, receivedCents, confirmCandidateAction, claimed }: {
  candidate: MovementBookingCandidate; movementId: string; receivedCents: number;
  claimed: boolean;
} & Pick<MovementCandidateActions, "confirmCandidateAction">) {
  const t = useTranslations("BankMovements.payment");
  const errors = useTranslations("BankMovements.proposals.errors");
  const locale = useLocale();
  const [state, action, pending] = useActionState<ReconciliationActionState, FormData>(
    confirmCandidateAction, { status: "idle" },
  );
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(value / 100);
  const difference = receivedCents - Number(candidate.expectedAmountMinor);
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
  return (
    <li className="flex flex-col gap-3 border-t py-4">
      <div className="flex flex-wrap justify-between gap-2">
        <Link className="font-medium underline underline-offset-4" href={`/bookings/${candidate.bookingRequestId}`}>{candidate.customerName}</Link>
        <span className="text-sm text-muted-foreground">{candidate.estimateNumber}</span>
      </div>
      <p className="text-sm">{date(candidate.startDate)} — {date(candidate.endDate)}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm tabular-nums">
        <dt>{t("expected")}</dt><dd className="text-right">{money(Number(candidate.expectedAmountMinor))}</dd>
        <dt>{t("difference")}</dt><dd className="text-right">{money(difference)} ({(difference * 100 / Number(candidate.expectedAmountMinor)).toLocaleString(locale, { maximumFractionDigits: 2 })}%)</dd>
      </dl>
      <form action={action}>
        <input type="hidden" name="bookingRequestId" value={candidate.bookingRequestId} />
        <input type="hidden" name="movementId" value={movementId} />
        <Button type="submit" disabled={pending || claimed || state.status === "processing" || receivedCents <= 20_000 || receivedCents > 2_147_483_647}>
          {pending ? t("starting") : t("reconcile")}
        </Button>
      </form>
      {state.status === "processing" ? <p role="status" className="text-sm">{t("started")}</p> : null}
      {state.status === "error" ? <p role="alert" className="text-sm text-destructive">{errors(state.reason)}</p> : null}
    </li>
  );
}

export function MovementBookingDialog({ movementId, amountMinor, concept, loadCandidatesAction, confirmCandidateAction }: {
  movementId: string; amountMinor: string; concept: string | null;
} & MovementCandidateActions) {
  const t = useTranslations("BankMovements.payment");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<MovementCandidatesResult | null>(null);
  const [page, setPage] = useState(1);
  const [claimed, setClaimed] = useState(false);
  const [loading, startTransition] = useTransition();
  const receivedCents = Number(amountMinor);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(value / 100);
  function load(nextPage: number) {
    setPage(nextPage);
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await loadCandidatesAction({ movementId, page: nextPage }));
      } catch {
        setResult({ status: "error", reason: "unavailable" });
      }
    });
  }
  async function confirm(previous: ReconciliationActionState, data: FormData) {
    const state = await confirmCandidateAction(previous, data);
    if (state.status === "processing") setClaimed(true);
    return state;
  }
  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) load(1); }}>
      <DialogTrigger className="w-full max-w-28 cursor-pointer whitespace-normal text-left underline decoration-dotted underline-offset-4 focus-visible:outline-2 sm:max-w-full">
        {concept ?? t("open")}
      </DialogTrigger>
      <DialogContent closeLabel={t("close")}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-2xl font-semibold tabular-nums">{money(receivedCents)}</p>
          {concept ? <p className="break-words text-sm text-muted-foreground">{concept}</p> : null}
          {receivedCents > 20_000 ? <p className="text-sm">{t("breakdown", { deposit: money(20_000), advance: money(receivedCents - 20_000) })}</p> : null}
          {receivedCents <= 20_000 ? <p role="alert">{t("tooSmall")}</p> : null}
          {loading ? <p role="status">{t("loading")}</p> : null}
          {result?.status === "error" ? <div role="alert" className="flex flex-col gap-2">
            <p>{t("error")}</p><Button variant="outline" onClick={() => load(page)}>{t("retry")}</Button>
          </div> : null}
          {result?.status === "ready" ? (
            <>
              <p className="text-sm text-muted-foreground">{t("count", { count: result.total })}</p>
              {result.total === 0 ? <p>{t("empty")}</p> : <ul>
                {result.candidates.map((candidate) => (
                  <Candidate key={candidate.bookingRequestId} candidate={candidate} movementId={movementId}
                    receivedCents={receivedCents} confirmCandidateAction={confirm} claimed={claimed} />
                ))}
              </ul>}
              <div className="flex justify-between gap-2">
                <Button variant="outline" disabled={claimed || loading || page === 1} onClick={() => load(page - 1)}>{t("previous")}</Button>
                <Button variant="outline" disabled={claimed || loading || page * 25 >= result.total} onClick={() => load(page + 1)}>{t("next")}</Button>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
