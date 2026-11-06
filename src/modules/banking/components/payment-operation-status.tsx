"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import type { BankPaymentOperationSummary } from "@/modules/banking/types";

export function PaymentOperationStatus({ operation }: { operation: BankPaymentOperationSummary }) {
  const t = useTranslations("BankMovements.payment");
  const router = useRouter();
  const active = ["PENDING", "IN_FLIGHT", "FAILED"].includes(operation.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return (
    <Alert variant={["UNKNOWN", "BLOCKED", "FAILED"].includes(operation.status) ? "destructive" : "default"}>
      <AlertDescription className="flex flex-col gap-2">
        <p role="status">{t(`statuses.${operation.status}`)}</p>
        <p>{t("stage", { stage: t(`stages.${operation.stage}`) })}</p>
        <Link className="underline" href={`/bookings/${operation.bookingRequestId}`}>{t("booking")}</Link>
        <Button type="button" variant="outline" onClick={() => router.refresh()}>{t("refresh")}</Button>
      </AlertDescription>
    </Alert>
  );
}
