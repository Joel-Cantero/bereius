import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import caMessages from "@/messages/ca.json";
import { CustomerChange } from "@/modules/booking/components/customer-change";

const catalogs = { en: enMessages, es: esMessages, ca: caMessages };

const FOUND = {
  status: "found",
  taxId: "B12345678",
  name: "Another organisation",
  email: "other@example.test",
  source: "holded",
  current: false,
};

describe.each(Object.entries(catalogs))("customer change in %s", (locale, messages) => {
  const copy = messages.Bookings.customerChange;

  function setup(
    lookupAction = vi.fn().mockResolvedValue(FOUND),
    changeAction = vi.fn().mockResolvedValue({ status: "done" }),
  ) {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <CustomerChange bookingRequestId="booking-1" lookupAction={lookupAction} changeAction={changeAction} />
      </NextIntlClientProvider>,
    );
    return { lookupAction, changeAction };
  }

  async function search(taxId: string) {
    await userEvent.click(screen.getByText(copy.title));
    await userEvent.type(screen.getByLabelText(copy.taxId), taxId);
    await userEvent.click(screen.getByRole("button", { name: copy.search }));
  }

  it("previews the customer before assigning the one that was found", async () => {
    const { lookupAction, changeAction } = setup();
    await search("b-12345678");

    const lookup = lookupAction.mock.calls[0]?.[1] as FormData;
    expect(lookup.get("bookingRequestId")).toBe("booking-1");
    expect(lookup.get("taxId")).toBe("b-12345678");
    expect(await screen.findByText("Another organisation")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(copy.source.holded);
    expect(changeAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: copy.assign }));
    const change = changeAction.mock.calls[0]?.[1] as FormData;
    expect(change.get("bookingRequestId")).toBe("booking-1");
    expect(change.get("taxId")).toBe("B12345678");
  });

  it("does not offer to assign the request's own customer", async () => {
    setup(vi.fn().mockResolvedValue({ ...FOUND, source: "booking", current: true }));
    await search("B12345678");

    expect(await screen.findByRole("status")).toHaveTextContent(copy.current);
    expect(screen.queryByRole("button", { name: copy.assign })).not.toBeInTheDocument();
  });

  it("announces a tax identifier nobody has", async () => {
    setup(vi.fn().mockResolvedValue({ status: "error", reason: "customer_not_found" }));
    await search("X0000000");

    expect(await screen.findByRole("alert")).toHaveTextContent(messages.Bookings.errors.customer_not_found);
    expect(screen.queryByRole("button", { name: copy.assign })).not.toBeInTheDocument();
  });

  it("announces a reassignment that came too late", async () => {
    setup(undefined, vi.fn().mockResolvedValue({ status: "error", reason: "state_changed" }));
    await search("B12345678");
    await userEvent.click(await screen.findByRole("button", { name: copy.assign }));

    expect(await screen.findByRole("alert")).toHaveTextContent(messages.Bookings.errors.state_changed);
  });
});
