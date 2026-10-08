import type { Metadata } from "next";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { redirect } from "@/i18n/navigation";
import { noIndexMetadata } from "@/lib/seo";
import { requireBookingActor, AuthorizationError } from "@/modules/booking/authorization";
import { readIntegrationConfig, listIntegrationStatus } from "@/modules/booking/services/settings";
import { parseLoginLocale } from "@/modules/login/schema";
import { CustomerDirectory, CustomerSyncControls, DelegateForm, WordpressSettingsForm } from "@/modules/customers/components/customer-controls";
import { customerRunHistory, getCustomerDirectory, getCustomerDelegates } from "@/modules/customers/services/management";
import { wordpressConfigSchema } from "@/modules/customers/schema";

interface Props { params: Promise<{ locale: string }>; searchParams: Promise<{ principal?: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Customers" });
  return noIndexMetadata({ title: t("title"), description: t("title") });
}

export default async function CustomersPage({ params, searchParams }: Props) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  try { await requireBookingActor("ADMINISTRATOR"); }
  catch (error) {
    if (error instanceof AuthorizationError) redirect({ href: error.code === "forbidden" ? "/bookings" : { pathname: "/login", query: { callbackUrl: "/customers" } }, locale });
    throw error;
  }
  const t = await getTranslations({ locale, namespace: "Customers" });
  const [config, statuses, history, directory] = await Promise.all([
    readIntegrationConfig("WORDPRESS"), listIntegrationStatus(), customerRunHistory(),
    getCustomerDirectory().then((items) => ({ items, unavailable: false })).catch(() => ({ items: [], unavailable: true })),
  ]);
  const settings = wordpressConfigSchema.safeParse(config);
  const selection = z.coerce.number().int().positive().safeParse((await searchParams).principal);
  const selected = selection.success ? directory.items.find((principal) => principal.id === selection.data) : undefined;
  const delegates = selected ? await getCustomerDelegates(selected.id, selected.holded_contact_id).then((items) => ({ items, unavailable: false })).catch(() => ({ items: [], unavailable: true })) : { items: [], unavailable: false };
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const resultsSchema = z.array(z.object({ contactId: z.string(), principalId: z.number().optional(), kind: z.enum(["create", "update", "unchanged", "conflict", "orphan_review"]) }));
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
    <h1 className="text-2xl font-semibold">{t("title")}</h1>
    <WordpressSettingsForm config={settings.success ? settings.data : null} hasSecret={statuses.find((status) => status.provider === "WORDPRESS")?.hasSecret ?? false} />
    <CustomerSyncControls writesEnabled={settings.success && settings.data.writesEnabled} />
    {directory.unavailable ? <p role="status">{t("unavailable")}</p> : null}
    <div className="grid min-w-0 gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <CustomerDirectory principals={directory.items.map(({ id, name, email, managed }) => ({ id, name, email, managed }))} selectedId={selected?.id} />
      <section className="flex min-w-0 flex-col gap-6">
        {selected ? <>
          <header className="flex flex-col gap-2"><h2 className="break-words text-xl font-semibold">{selected.name}</h2><p className="break-all text-sm">{selected.email}</p><p className="text-sm text-muted-foreground">{selected.meta.holded_vat_number}</p><p className="break-words text-sm text-muted-foreground">{[selected.meta.billing_address_1, selected.meta.billing_city, selected.meta.billing_postcode].filter(Boolean).join(", ")}</p></header>
          <h3 className="font-semibold">{t("delegates")}</h3>
          {delegates.unavailable ? <p role="alert">{t("unavailable")}</p> : <>
            {delegates.items.map((delegate) => <article key={`${delegate.id}:${delegate.generation}:${delegate.status}`} className="flex min-w-0 flex-col gap-4 border-b pb-6"><header className="flex flex-wrap items-center gap-2"><h4 className="break-words font-medium">{delegate.first_name} {delegate.last_name}</h4><Badge variant="secondary">{t(`statuses.${delegate.status}`)}</Badge><Badge variant="outline">{t(`projection.${delegate.projection_status}`)}</Badge></header><DelegateForm principalId={selected.id} contactId={selected.holded_contact_id} delegate={delegate} /></article>)}
            {!delegates.items.length ? <p className="text-sm text-muted-foreground">{t("noDelegates")}</p> : null}
            <details><summary className="cursor-pointer font-medium">{t("invite")}</summary><div className="mt-4"><DelegateForm principalId={selected.id} contactId={selected.holded_contact_id} /></div></details>
          </>}
        </> : <p className="text-sm text-muted-foreground">{t("selectCustomer")}</p>}
      </section>
    </div>
    <section className="flex flex-col gap-3 border-t pt-6"><h2 className="text-lg font-semibold">{t("history")}</h2>
      {!history.length ? <p className="text-sm text-muted-foreground">{t("noRuns")}</p> : null}
      {history.map((run) => {
        const parsed = resultsSchema.safeParse(run.results);
        const results = parsed.success ? parsed.data : [];
        return <details key={run.id} className="border-b pb-3"><summary className="cursor-pointer text-sm">{date.format(run.startedAt)} · {t(`modes.${run.mode}`)} · {t(`runStatuses.${run.status}`)}</summary>
          <div className="mt-3 flex flex-wrap gap-3">{(["create", "update", "unchanged", "conflict", "orphan_review"] as const).map((kind) => <span key={kind} className="text-sm">{t(`changes.${kind}`)}: {results.filter((result) => result.kind === kind).length}</span>)}</div>
          {run.failureCode ? <p className="mt-2 text-sm">{t("runFailed")}</p> : null}
          <ul className="mt-2 flex flex-col gap-1">{results.filter((result) => result.kind === "conflict" || result.kind === "orphan_review").slice(0, 100).map((result, index) => <li key={index} className="break-all text-sm">{result.contactId} · {t(`changes.${result.kind}`)}</li>)}</ul>
        </details>;
      })}
    </section>
  </main>;
}