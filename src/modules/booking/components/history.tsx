"use client";

import { Check, Clock3, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface HistoryEvent {
  id: string;
  createdAt: string;
  timeLabel: string;
  actorLabel: string | null;
}

interface OperationEvent extends HistoryEvent {
  type: string;
  failureCode: string | null;
}

interface LifecycleEvent extends HistoryEvent {
  toState: string;
  reason: string | null;
}

type TimelineEvent = (OperationEvent & { kind: "operation" }) | (LifecycleEvent & { kind: "lifecycle" });

export function BookingHistory({ operations, lifecycle }: {
  operations: OperationEvent[];
  lifecycle: LifecycleEvent[];
}) {
  const t = useTranslations("Bookings");
  const visible: TimelineEvent[] = [];
  const pending: OperationEvent[] = [];
  const priority = (type: string) => type === "DELIVERY_STARTED" ? 0 :
    ["DELIVERY_ACCEPTED", "DELIVERY_FAILED", "DELIVERY_UNKNOWN"].includes(type) ? 2 : 1;
  const ordered = [...operations].sort((first, second) => first.createdAt.localeCompare(second.createdAt) || priority(first.type) - priority(second.type) || first.id.localeCompare(second.id));
  for (const event of ordered) {
    if (event.type === "DELIVERY_STARTED") pending.push(event);
    else if (["DELIVERY_ACCEPTED", "DELIVERY_FAILED", "DELIVERY_UNKNOWN"].includes(event.type)) {
      const start = pending.shift();
      if (start) {
        const index = visible.findIndex((entry) => entry.kind === "operation" && entry.id === start.id);
        if (index !== -1) visible.splice(index, 1);
      }
    }
    visible.push({ ...event, kind: "operation" });
  }
  visible.push(...lifecycle.map((event) => ({ ...event, kind: "lifecycle" as const })));
  visible.sort((first, second) => second.createdAt.localeCompare(first.createdAt) ||
    (second.kind === "operation" ? priority(second.type) : 1) - (first.kind === "operation" ? priority(first.type) : 1) || second.id.localeCompare(first.id));

  function failureReason(code: string | null): string {
    return t(`operations.reasons.${code && t.has(`operations.reasons.${code}`) ? code : "unexpected"}`);
  }

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-1">
      <h2 id="history-heading" className="text-lg font-medium">{t("detail.history")}</h2>
      {visible.length === 0 ? <p className="text-sm text-muted-foreground">{t("operations.empty")}</p> : (
        <TooltipProvider>
          <ol className="flex flex-col gap-2 text-sm">
            {visible.map((event) => {
              const operation = event.kind === "operation";
              const accepted = operation && event.type === "DELIVERY_ACCEPTED";
              const failed = operation && ["DELIVERY_FAILED", "QUOTE_FAILED"].includes(event.type);
              const unknown = operation && event.type === "DELIVERY_UNKNOWN";
              const started = operation && event.type === "DELIVERY_STARTED";
              const label = operation ? t(`operations.events.${event.type}`) : t(`states.${event.toState}`);
              return (
                <li key={`${event.kind}:${event.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <time dateTime={event.createdAt} className="col-span-2 text-muted-foreground sm:col-span-1">{event.timeLabel}</time>
                  <span className="min-w-0 break-words">
                    {label}
                    {event.actorLabel ? ` · ${event.actorLabel}` : ""}
                    {!operation && event.reason ? ` · ${event.reason}` : ""}
                  </span>
                  {accepted ? <Check role="img" aria-label={label} className="size-4 shrink-0 text-green-600 dark:text-green-500" /> : null}
                  {started ? <Clock3 role="img" aria-label={label} className="size-4 shrink-0 text-muted-foreground" /> : null}
                  {failed || unknown ? (
                    <Tooltip>
                      <TooltipTrigger aria-label={label} aria-describedby={`history-error-${event.id}`} className="inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                        {unknown ? <TriangleAlert aria-hidden="true" className="size-4 text-amber-600" /> : <X aria-hidden="true" className="size-4 text-red-600 dark:text-red-400" />}
                      </TooltipTrigger>
                      <TooltipContent role="tooltip" id={`history-error-${event.id}`}>{operation ? failureReason(event.failureCode) : null}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </TooltipProvider>
      )}
    </section>
  );
}