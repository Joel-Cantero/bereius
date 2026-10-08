"use client";

import { useActionState, useDeferredValue, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Save, UserPlus, Send, Ban, RefreshCw, Play, Eye, Check } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { saveWordpressSettings, verifyWordpressAction, synchronizeCustomersAction, manageDelegateAction, type CustomerActionState } from "../actions/management";
import type { Delegate, Principal, WordpressConfig } from "../schema";

const idle: CustomerActionState = { status: "idle" };

function Outcome({ state }: { state: CustomerActionState }) {
  const t = useTranslations("Customers");
  if (state.status === "idle") return null;
  return <p role={state.status === "error" ? "alert" : "status"} className="text-sm">{state.status === "error" ? t(`errors.${state.reason}`) : t(`outcomes.${state.status}`)}</p>;
}

export function CustomerDirectory({ principals, selectedId }: { principals: Pick<Principal, "id" | "name" | "email" | "managed">[]; selectedId?: number }) {
  const t = useTranslations("Customers");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const id = useId();
  const matches = principals.filter((principal) => `${principal.name} ${principal.email}`.toLocaleLowerCase().includes(search));
  return <div className="flex min-w-0 flex-col gap-4">
    <Field><FieldLabel htmlFor={id}>{t("search")}</FieldLabel><Input id={id} type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></Field>
    <ul className="max-h-[32rem] overflow-y-auto divide-y">
      {matches.map((principal) => <li key={principal.id}><Link href={{ pathname: "/customers", query: { principal: principal.id } }} aria-current={selectedId === principal.id ? "page" : undefined} className="flex min-w-0 flex-col gap-1 px-2 py-3 aria-[current=page]:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <span className="break-words font-medium">{principal.name || principal.email}</span><span className="break-all text-sm text-muted-foreground">{principal.email}</span>
        {!principal.managed ? <Badge variant="outline">{t("review")}</Badge> : null}
      </Link></li>)}
    </ul>
    {!matches.length ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
  </div>;
}

export function WordpressSettingsForm({ config, hasSecret }: { config: Partial<WordpressConfig> | null; hasSecret: boolean }) {
  const t = useTranslations("Customers");
  const [state, action, pending] = useActionState(saveWordpressSettings, idle);
  const [verification, verify, verifying] = useActionState(verifyWordpressAction, idle);
  const prefix = useId();
  return <details className="border-b pb-5"><summary className="cursor-pointer font-medium">{t("settings")}</summary>
    <form action={action} className="mt-5 flex flex-col gap-5 [&_input[type=checkbox]]:sr-only">
      <FieldGroup>
        <Field><FieldLabel htmlFor={`${prefix}-origin`}>{t("origin")}</FieldLabel><Input id={`${prefix}-origin`} name="origin" type="url" required defaultValue={config?.origin ?? ""} /></Field>
        <Field><FieldLabel htmlFor={`${prefix}-username`}>{t("username")}</FieldLabel><Input id={`${prefix}-username`} name="username" required maxLength={320} autoComplete="off" defaultValue={config?.username ?? ""} /></Field>
        <Field><FieldLabel htmlFor={`${prefix}-password`}>{t("password")}</FieldLabel><Input id={`${prefix}-password`} name="password" type="password" maxLength={512} required={!hasSecret} autoComplete="new-password" /></Field>
        <FieldSet><FieldLegend>{t("synchronization")}</FieldLegend><FieldGroup>
          <Field orientation="horizontal"><Checkbox id={`${prefix}-writes`} name="writesEnabled" value="on" defaultChecked={config?.writesEnabled ?? false} /><FieldLabel htmlFor={`${prefix}-writes`}>{t("writesEnabled")}</FieldLabel></Field>
          <Field orientation="horizontal"><Checkbox id={`${prefix}-automatic`} name="automaticSync" value="on" defaultChecked={config?.automaticSync ?? false} /><FieldLabel htmlFor={`${prefix}-automatic`}>{t("automaticSync")}</FieldLabel></Field>
        </FieldGroup></FieldSet>
      </FieldGroup>
      <div><Button type="submit" disabled={pending}><Save data-icon="inline-start" />{t("save")}</Button></div><Outcome state={state} />
    </form>
    <form action={verify} className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" variant="outline" disabled={verifying || !hasSecret}><Check data-icon="inline-start" />{t("verify")}</Button><Outcome state={verification} /></form>
  </details>;
}

export function CustomerSyncControls({ writesEnabled }: { writesEnabled: boolean }) {
  const t = useTranslations("Customers");
  const [state, action, pending] = useActionState(synchronizeCustomersAction, idle);
  return <form action={action} className="flex flex-wrap items-center gap-3">
    <Button type="submit" name="mode" value="PREVIEW" variant="outline" disabled={pending}><Eye data-icon="inline-start" />{t("preview")}</Button>
    <Button type="submit" name="mode" value="APPLY" disabled={pending || !writesEnabled}><Play data-icon="inline-start" />{t("apply")}</Button>
    <Outcome state={state} />
  </form>;
}

export function DelegateForm({ principalId, contactId, delegate }: { principalId: number; contactId: string; delegate?: Delegate }) {
  const t = useTranslations("Customers");
  const [state, action, pending] = useActionState(manageDelegateAction, idle);
  const id = useId();
  return <form id={id} action={action} className="flex min-w-0 flex-col gap-4">
    <input type="hidden" name="principal_id" value={principalId} /><input type="hidden" name="holded_contact_id" value={contactId} />
    {delegate ? <><input type="hidden" name="delegate_id" value={delegate.id} /><input type="hidden" name="generation" value={delegate.generation} /><input type="hidden" name="expected_status" value={delegate.status} /></> : null}
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      {(["first_name", "last_name", "email", "phone"] as const).map((field) => <Field key={field} data-invalid={state.status === "error" && state.reason === "invalid"}>
        <FieldLabel htmlFor={`${id}-${field}`}>{t(`fields.${field}`)}</FieldLabel>
        <Input id={`${id}-${field}`} name={field} type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} defaultValue={delegate?.[field] ?? ""} required maxLength={field === "email" ? 320 : field === "phone" ? 50 : 100} aria-invalid={state.status === "error" && state.reason === "invalid"} />
      </Field>)}
    </FieldGroup>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" name="action" value={delegate ? "update" : "invite"} disabled={pending}>{delegate ? <Save data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}{t(delegate ? "save" : "invite")}</Button>
      {delegate?.status === "pending" ? <Button type="submit" name="action" value="resend" variant="outline" formNoValidate disabled={pending}><Send data-icon="inline-start" />{t("resend")}</Button> : null}
      {delegate?.status === "revoked" ? <Button type="submit" name="action" value="reinvite" variant="outline" formNoValidate disabled={pending}><RefreshCw data-icon="inline-start" />{t("reinvite")}</Button> : null}
      {delegate && delegate.status !== "revoked" ? <Dialog>
        <DialogTrigger render={<Button type="button" variant="outline" disabled={pending} />}><Ban data-icon="inline-start" />{t("revoke")}</DialogTrigger>
        <DialogContent closeLabel={t("close")}><DialogHeader><DialogTitle>{t("revokeTitle")}</DialogTitle><DialogDescription>{t("revokeBody")}</DialogDescription></DialogHeader><DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{t("cancel")}</DialogClose>
          <DialogClose render={<Button type="submit" form={id} name="action" value="revoke" variant="destructive" formNoValidate disabled={pending} />}><Ban data-icon="inline-start" />{t("revoke")}</DialogClose>
        </DialogFooter></DialogContent>
      </Dialog> : null}
    </div><Outcome state={state} />
  </form>;
}