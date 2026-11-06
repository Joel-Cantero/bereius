import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push }) }));

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import caMessages from "@/messages/ca.json";
import { ContractBookingForm } from "@/modules/booking/components/contract-booking";

const catalogs = { en: enMessages, es: esMessages, ca: caMessages };
const HOLDED_ID = "6a3e3ba0f62fcd17ee0f4908";
const DEFAULTS = {
  startDate: "2026-11-27",
  endDate: "2026-11-29",
  headcount: 40,
  boardType: "FULL_BOARD" as const,
};

describe.each(Object.entries(catalogs))("contract booking form in %s", (locale, messages) => {
  const copy = messages.Contracts.create;

  function setup(action = vi.fn().mockResolvedValue({ status: "created", bookingRequestId: "booking-9" })) {
    push.mockClear();
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ContractBookingForm action={action} holdedId={HOLDED_ID} defaults={DEFAULTS} />
      </NextIntlClientProvider>,
    );
    return action;
  }

  it("submits the stay read from the contract and opens the new request", async () => {
    const action = setup();

    expect(screen.getByLabelText(copy.startDate)).toHaveValue("2026-11-27");
    expect(screen.getByLabelText(copy.headcount)).toHaveValue(40);
    await userEvent.clear(screen.getByLabelText(copy.headcount));
    await userEvent.type(screen.getByLabelText(copy.headcount), "42");
    await userEvent.click(screen.getByRole("button", { name: copy.submit }));

    const data = action.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(data)).toEqual({
      holdedId: HOLDED_ID,
      startDate: "2026-11-27",
      endDate: "2026-11-29",
      headcount: "42",
      boardType: "FULL_BOARD",
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/bookings/booking-9"));
  });

  it("announces a contract another operator linked first", async () => {
    setup(vi.fn().mockResolvedValue({ status: "error", reason: "contract_linked" }));
    await userEvent.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.Bookings.errors.contract_linked,
    );
    expect(push).not.toHaveBeenCalled();
  });
});
