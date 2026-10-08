import { NextIntlClientProvider } from "next-intl";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ca from "@/messages/ca.json";
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href, ...props }: { children: React.ReactNode; href: { query: { principal: number } } }) => <a href={`/customers?principal=${href.query.principal}`} {...props}>{children}</a> }));
vi.mock("@/modules/customers/actions/management", () => ({ saveWordpressSettings: vi.fn(), verifyWordpressAction: vi.fn(), synchronizeCustomersAction: vi.fn(), manageDelegateAction: vi.fn() }));
import { CustomerDirectory, DelegateForm, WordpressSettingsForm } from "@/modules/customers/components/customer-controls";

describe("localized customer controls", () => {
  it.each([["en", en], ["es", es], ["ca", ca]] as const)("labels delegate fields in %s and preserves the expected generation", (locale, messages) => {
    render(<NextIntlClientProvider locale={locale} messages={messages}><DelegateForm principalId={1} contactId={"a".repeat(24)} delegate={{ id: 2, email: "delegate@example.test", first_name: "Test", last_name: "Delegate", phone: "600000000", status: "revoked", generation: 3, invited_at: "", holded_person_id: "", projection_status: "idle" }} /></NextIntlClientProvider>);
    expect(screen.getByLabelText(messages.Customers.fields.email)).toHaveValue("delegate@example.test");
    expect(screen.getByRole("button", { name: messages.Customers.reinvite })).toBeVisible();
    expect(screen.queryByRole("button", { name: messages.Customers.revoke })).not.toBeInTheDocument();
    expect(document.querySelector('input[name="generation"]')).toHaveValue("3");
  });
  it("filters customers by name or email", async () => {
    render(<NextIntlClientProvider locale="en" messages={en}><CustomerDirectory principals={[{ id: 1, name: "First customer", email: "first@example.test", managed: true }, { id: 2, name: "Second customer", email: "second@example.test", managed: false }]} /></NextIntlClientProvider>);
    await userEvent.type(screen.getByRole("searchbox"), "second@");
    expect(screen.getByRole("link", { name: /Second customer/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /First customer/ })).not.toBeInTheDocument();
  });
  it("requires confirmation before revocation", async () => {
    render(<NextIntlClientProvider locale="en" messages={en}><DelegateForm principalId={1} contactId={"a".repeat(24)} delegate={{ id: 2, email: "delegate@example.test", first_name: "Test", last_name: "Delegate", phone: "600000000", status: "active", generation: 1, invited_at: "", holded_person_id: "", projection_status: "idle" }} /></NextIntlClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: en.Customers.revoke }));
    expect(screen.getByRole("dialog", { name: en.Customers.revokeTitle })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: en.Customers.cancel }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("never renders an existing application password and keeps writes disabled by default", () => {
    render(<NextIntlClientProvider locale="en" messages={en}><WordpressSettingsForm config={null} hasSecret /></NextIntlClientProvider>);
    expect(screen.getByLabelText(en.Customers.password)).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: en.Customers.writesEnabled, hidden: true })).not.toBeChecked();
  });
});