import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import caMessages from "@/messages/ca.json";
import { AdvanceEditor } from "@/modules/booking/components/decision-forms";

const catalogs = { en: enMessages, es: esMessages, ca: caMessages };

describe.each(Object.entries(catalogs))("advance editor in %s", (locale, messages) => {
  function setup(action = vi.fn().mockResolvedValue({ status: "done" })) {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <AdvanceEditor action={action} bookingRequestId="booking-1" amountLabel="240,08 €" defaultAmount="240.08" />
      </NextIntlClientProvider>,
    );
    return action;
  }

  it("edits the advance from the pencil and closes after saving", async () => {
    const action = setup();
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.editAdvance }));
    const input = screen.getByLabelText(messages.Bookings.actions.advanceLabel);
    expect(input).toHaveValue(240.08);
    await userEvent.clear(input);
    await userEvent.type(input, "300");
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.saveAdvance }));

    const data = action.mock.calls[0]?.[1] as FormData;
    expect(data.get("bookingRequestId")).toBe("booking-1");
    expect(data.get("advance")).toBe("300");
    expect(await screen.findByRole("button", { name: messages.Bookings.actions.editAdvance })).toBeVisible();
  });

  it("keeps the editor open and announces a refused change", async () => {
    setup(vi.fn().mockResolvedValue({ status: "error", reason: "state_changed" }));
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.editAdvance }));
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.saveAdvance }));
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.Bookings.errors.state_changed);
    await userEvent.click(screen.getByRole("button", { name: messages.Bookings.actions.cancelEdit }));
    expect(screen.getByText("240,08 €")).toBeVisible();
  });
});
