import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ca from "@/messages/ca.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname: string; query: { month: string } } }) => <a href={typeof href === "string" ? href : `${href.pathname}?month=${href.query.month}`} {...props}>{children}</a>,
}));

import { CalendarMonth } from "@/modules/calendar/components/calendar-month";
import { CalendarSettingsForm } from "@/modules/calendar/components/calendar-settings-form";

describe("calendar components", () => {
  it.each([["en", en], ["es", es], ["ca", ca]] as const)("renders monthly controls in %s and respects exclusive departure", (locale, messages) => {
    const labels = { ...messages.Calendar };
    render(<CalendarMonth locale={locale} month="2026-10" today="2026-10-01" labels={labels} entries={[{ id: "fixture", title: "Synthetic group", start: "2026-10-13", end: "2026-10-15", allDay: true }]} />);
    expect(screen.getByRole("link", { name: labels.previous })).toHaveAttribute("href", "/calendar?month=2026-09");
    expect(screen.getByRole("link", { name: labels.next })).toHaveAttribute("href", "/calendar?month=2026-11");
    const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
    expect(within(screen.getByLabelText(dateFormat.format(new Date("2026-10-14")))).getByText("Synthetic group")).toBeInTheDocument();
    expect(within(screen.getByLabelText(dateFormat.format(new Date("2026-10-15")))).queryByText("Synthetic group")).toBeNull();
  });
  it("renders a localized empty state", () => {
    render(<CalendarMonth locale="es" month="2026-10" today="2026-10-01" labels={es.Calendar} entries={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(es.Calendar.empty);
  });
  it("saves a write-only source and enables connection testing", async () => {
    const action = vi.fn().mockResolvedValue({ status: "saved" });
    const test = vi.fn().mockResolvedValue({ status: "verified" });
    render(<NextIntlClientProvider locale="es" messages={es}><CalendarSettingsForm action={action} onTest={test} configured={false} /></NextIntlClientProvider>);
    expect(screen.getByRole("button", { name: es.Bookings.settings.test })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(es.Calendar.url), "https://example.com/feed.ics");
    await userEvent.click(screen.getByRole("button", { name: es.Bookings.settings.save }));
    expect(await screen.findByRole("status")).toHaveTextContent(es.Bookings.settings.saved);
    expect(action.mock.calls[0][1].get("calendarUrl")).toBe("https://example.com/feed.ics");
    await userEvent.click(screen.getByRole("button", { name: es.Bookings.settings.test }));
    expect(await screen.findByText(es.Bookings.settings.verified)).toBeInTheDocument();
  });
});