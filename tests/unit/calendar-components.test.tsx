import { render, screen } from "@testing-library/react";
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
  it("keeps every booking link when identical daily events are grouped", () => {
    render(<CalendarMonth locale="es" month="2026-10" today="2026-10-01" labels={{ ...es.Calendar, confirmed: es.Calendar.bookingLinks.confirmed, review: es.Calendar.bookingLinks.needsReview }} entries={[
      { id: "first", title: "Same description", start: "2026-10-02", end: "2026-10-03", allDay: true, bookings: [{ id: "booking-one", label: "First group", needsReview: false }] },
      { id: "second", title: "Same description", start: "2026-10-03", end: "2026-10-04", allDay: true, bookings: [{ id: "booking-two", label: "Second group", needsReview: true }] },
    ]} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Reserva confirmada: First group" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Revisar: Second group" })[0]).toHaveAttribute("href", "/bookings/booking-two");
  });
  it.each([["en", en], ["es", es], ["ca", ca]] as const)("renders monthly controls in %s and respects exclusive departure", (locale, messages) => {
    const labels = { ...messages.Calendar };
    render(<CalendarMonth locale={locale} month="2026-10" today="2026-10-01" labels={labels} entries={[{ id: "fixture", title: "Synthetic group", start: "2026-10-13", end: "2026-10-15", allDay: true }]} />);
    expect(screen.getByRole("link", { name: labels.previous })).toHaveAttribute("href", "/calendar?month=2026-09");
    expect(screen.getByRole("link", { name: labels.next })).toHaveAttribute("href", "/calendar?month=2026-11");
    const event = screen.getByRole("article");
    expect(event).toHaveTextContent("Synthetic group");
    expect(event).toHaveAttribute("data-calendar-start", "2026-10-13");
    expect(event).toHaveAttribute("data-calendar-last", "2026-10-14");
    expect(event).toHaveClass("col-start-2", "col-span-2");
  });
  it("joins consecutive all-day descriptions into one three-day band without changing the input", () => {
    const entries = [2, 3, 4].map((day) => ({ id: `group-${day}`, title: "Synthetic weekend", start: `2026-10-0${day}`, end: `2026-10-0${day + 1}`, allDay: true }));
    render(<CalendarMonth locale="es" month="2026-10" today="2026-10-01" labels={es.Calendar} entries={entries} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article")).toHaveClass("col-start-5", "col-span-3");
    expect(screen.getByRole("article")).toHaveAttribute("data-calendar-last", "2026-10-04");
    expect(entries[0].end).toBe("2026-10-03");
  });
  it("keeps separate stays separate and gives overlapping events distinct rows", () => {
    render(<CalendarMonth locale="es" month="2026-10" today="2026-10-01" labels={es.Calendar} entries={[
      { id: "first", title: "Synthetic group", start: "2026-10-02", end: "2026-10-05", allDay: true },
      { id: "second", title: "Synthetic group", start: "2026-10-09", end: "2026-10-12", allDay: true },
      { id: "overlap", title: "Another group", start: "2026-10-03", end: "2026-10-04", allDay: true },
    ]} />);
    const events = screen.getAllByRole("article");
    expect(events).toHaveLength(3);
    expect(events[0].parentElement).not.toBe(events[1].parentElement);
    expect(events[2]).toHaveAttribute("data-calendar-start", "2026-10-09");
  });
  it("continues a multi-day event across a week and month boundary without extending its end", () => {
    render(<CalendarMonth locale="es" month="2026-10" today="2026-10-01" labels={es.Calendar} entries={[
      { id: "boundary", title: "Synthetic boundary", start: "2026-10-30", end: "2026-11-03", allDay: true },
    ]} />);
    const events = screen.getAllByRole("article");
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveAttribute("data-calendar-last", "2026-11-01");
    expect(events[1]).toHaveAttribute("data-calendar-last", "2026-11-02");
    expect(events[1]).toHaveClass("col-start-1", "col-span-1");
  });
  it("does not merge unnamed all-day events or separate timed appointments", () => {
    render(<CalendarMonth locale="en" month="2026-10" today="2026-10-01" labels={en.Calendar} entries={[
      { id: "unnamed-first", title: "", start: "2026-10-02", end: "2026-10-03", allDay: true },
      { id: "unnamed-second", title: "", start: "2026-10-03", end: "2026-10-04", allDay: true },
      { id: "morning", title: "Appointment", start: "2026-10-02T08:00:00Z", end: "2026-10-02T09:00:00Z", allDay: false },
      { id: "afternoon", title: "Appointment", start: "2026-10-02T14:00:00Z", end: "2026-10-02T15:00:00Z", allDay: false },
    ]} />);
    expect(screen.getAllByRole("article")).toHaveLength(4);
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