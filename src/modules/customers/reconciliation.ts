import { z } from "zod";
import type { HoldedFiscalContact } from "@/lib/holded/client";
import type { Principal } from "./schema";

export type CustomerPayload = { holded_contact_id: string; email: string; name: string; meta: Record<string, string> };
export type CustomerChange = {
  contactId: string;
  principalId?: number;
  kind: "create" | "update" | "unchanged" | "conflict" | "orphan_review";
  reason?: string;
  payload?: CustomerPayload;
};

function text(input: string | null | undefined): string {
  let value = (input ?? "").replace(/<[^>]*>/gu, "").replace(/[\r\n\t ]+/gu, " ").trim();
  while (/%[a-f0-9]{2}/iu.test(value)) value = value.replace(/%[a-f0-9]{2}/giu, "");
  return value.replace(/ +/gu, " ").trim();
}

function phone(input: string | null | undefined) {
  return (input ?? "").replace(/[^0-9+().\-\s]/gu, "");
}

export function fiscalPayload(contact: HoldedFiscalContact): CustomerPayload {
  const name = text(contact.name);
  const address = contact.bill_address;
  const website = contact.website?.trim() ?? "";
  return {
    holded_contact_id: contact.id,
    email: (contact.email ?? "").trim().toLowerCase(),
    name,
    meta: {
      holded_contact_id: contact.id, holded_name: name,
      holded_vat_number: text(contact.code), holded_code: text(contact.custom_id),
      holded_trade_name: text(contact.trade_name), holded_is_person: "0", holded_contact_type: "client",
      billing_address_1: text(address?.address), billing_city: text(address?.city),
      billing_postcode: text(address?.postal_code), billing_state: text(address?.province),
      billing_country: text(address?.country_code ?? address?.country), billing_phone: phone(contact.phone),
      holded_mobile: phone(contact.mobile), holded_website: /^https?:\/\//iu.test(website) ? website : "",
      holded_tags: text(contact.tags?.join(",")),
    },
  };
}

export function reconcileCustomers(contacts: HoldedFiscalContact[], principals: Principal[]): CustomerChange[] {
  const changes: CustomerChange[] = [];
  const allIds = new Set(contacts.map((contact) => contact.id));
  const eligible = contacts.filter((contact) => contact.type === "client" && contact.is_person === false && contact.email?.trim());
  const byId = new Map<string, Principal[]>();
  for (const principal of principals) byId.set(principal.holded_contact_id, [...(byId.get(principal.holded_contact_id) ?? []), principal]);
  const counts = new Map<string, number>();
  const emails = new Map<string, number>();
  for (const contact of contacts) counts.set(contact.id, (counts.get(contact.id) ?? 0) + 1);
  for (const contact of eligible) {
    const email = contact.email!.trim().toLowerCase();
    emails.set(email, (emails.get(email) ?? 0) + 1);
  }
  const seen = new Set<string>();
  for (const contact of [...eligible].sort((first, second) => first.id.localeCompare(second.id))) {
    if (seen.has(contact.id)) continue;
    seen.add(contact.id);
    const payload = fiscalPayload(contact);
    const matches = byId.get(contact.id) ?? [];
    const principal = matches[0];
    let reason: string | undefined;
    if (!/^[a-f0-9]{24}$/u.test(contact.id) || !payload.name || !z.email().safeParse(payload.email).success) reason = "invalid_record";
    else if (counts.get(contact.id)! > 1 || matches.length > 1) reason = "duplicate_identity";
    else if (emails.get(payload.email)! > 1) reason = "duplicate_email";
    else if (principal && !principal.managed) reason = "unmanaged_account";
    else if (principals.some((item) => item.id !== principal?.id && item.email.toLowerCase() === payload.email)) reason = "email_collision";
    if (reason) {
      changes.push({ contactId: contact.id, principalId: principal?.id, kind: "conflict", reason });
      continue;
    }
    const unchanged = principal && principal.email.toLowerCase() === payload.email && principal.name === payload.name
      && Object.entries(payload.meta).every(([key, value]) => (principal.meta[key] ?? "") === value);
    changes.push({ contactId: contact.id, principalId: principal?.id, kind: principal ? unchanged ? "unchanged" : "update" : "create", payload });
  }
  for (const principal of principals) {
    if (principal.managed && !allIds.has(principal.holded_contact_id)) {
      changes.push({ contactId: principal.holded_contact_id, principalId: principal.id, kind: "orphan_review" });
    }
  }
  return changes.sort((first, second) => first.contactId.localeCompare(second.contactId) || (first.principalId ?? 0) - (second.principalId ?? 0));
}