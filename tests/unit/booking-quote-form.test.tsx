import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import caMessages from "@/messages/ca.json";
import type { DecisionActionState } from "@/modules/booking/actions/decisions";
import { QuoteResendForm } from "@/modules/booking/components/decision-forms";

const catalogs = { en: enMessages, es: esMessages, ca: caMessages };

describe.each(Object.entries(catalogs))("quote resend form in %s", (locale, messages) => {
  it("submits the booking id and announces queued rather than sent", async () => {
    const action = vi.fn().mockResolvedValue({ status: "done" });
    render(<NextIntlClientProvider locale={locale} messages={messages}>
      <QuoteResendForm action={action} bookingRequestId="booking-1" />
    </NextIntlClientProvider>);
    const button = screen.getByRole("button", { name: messages.Bookings.actions.resendQuote });
    await userEvent.click(button);
    expect(await screen.findByText(messages.Bookings.actions.quoteQueued)).toHaveAttribute("role", "status");
    expect(button).toBeDisabled();
    expect((action.mock.calls[0]?.[1] as FormData).get("bookingRequestId")).toBe("booking-1");
  });

  it("blocks duplicate clicks during a pending request", async () => {
    const pending = Promise.withResolvers<DecisionActionState>();
    const action = vi.fn(() => pending.promise);
    render(<NextIntlClientProvider locale={locale} messages={messages}>
      <QuoteResendForm action={action} bookingRequestId="booking-1" />
    </NextIntlClientProvider>);
    const button = screen.getByRole("button", { name: messages.Bookings.actions.resendQuote });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(messages.Bookings.actions.queuingQuote);
    await userEvent.click(button);
    expect(action).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ status: "done" }));
  });

  it("announces a safe unknown-outcome error", async () => {
    const action = vi.fn().mockResolvedValue({ status: "error", reason: "quote_delivery_unknown" });
    render(<NextIntlClientProvider locale={locale} messages={messages}>
      <QuoteResendForm action={action} bookingRequestId="booking-1" />
    </NextIntlClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.resendQuote }));
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.Bookings.errors.quote_delivery_unknown);
    expect(screen.queryByText(messages.Bookings.actions.quoteQueued)).not.toBeInTheDocument();
  });
});