import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ca from "@/messages/ca.json";
import { MovementBookingDialog, type MovementCandidateActions } from "@/modules/banking/components/movement-booking-dialog";
import { PaymentOperationStatus } from "@/modules/banking/components/payment-operation-status";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: React.ComponentProps<"a">) => <a href={String(href)}>{children}</a>,
  useRouter: () => ({ refresh: vi.fn() }),
}));

const candidate = {
  bookingRequestId: "booking-1", customerName: "Synthetic group", startDate: "2027-06-01",
  endDate: "2027-06-03", estimateNumber: "E-1", expectedAmountMinor: "30000", differenceMinor: "100",
};

function setup(messages = en, locale = "en", overrides: Partial<MovementCandidateActions> = {}) {
  const actions: MovementCandidateActions = {
    loadCandidatesAction: vi.fn<MovementCandidateActions["loadCandidatesAction"]>(async () => ({ status: "ready", total: 1, candidates: [candidate] })),
    confirmCandidateAction: vi.fn<MovementCandidateActions["confirmCandidateAction"]>(async () => ({ status: "processing", bookingRequestId: "booking-1" })),
    ...overrides,
  };
  render(<NextIntlClientProvider messages={messages} locale={locale}>
    <MovementBookingDialog movementId="movement-1" amountMinor="30100" concept="Synthetic transfer" {...actions} />
  </NextIntlClientProvider>);
  return actions;
}

describe("movement booking selection", () => {
  it.each([["en", en], ["es", es], ["ca", ca]] as const)(
    "loads only on opening and previews actual received invoicing in %s", async (locale, messages) => {
      const actions = setup(messages, locale);
      expect(actions.loadCandidatesAction).not.toHaveBeenCalled();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Synthetic transfer" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading", { name: messages.BankMovements.payment.title })).toBeVisible();
      expect(await within(dialog).findByRole("link", { name: candidate.customerName })).toHaveAttribute("href", "/bookings/booking-1");
      await user.click(within(dialog).getByRole("button", { name: messages.BankMovements.payment.reconcile }));
      expect(await within(dialog).findByRole("status")).toHaveTextContent(messages.BankMovements.payment.started);
      expect(actions.confirmCandidateAction).toHaveBeenCalledOnce();
      const data = vi.mocked(actions.confirmCandidateAction).mock.calls[0][1];
      expect(data.get("movementId")).toBe("movement-1");
      expect(data.get("bookingRequestId")).toBe("booking-1");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("announces query failure and permits an explicit retry", async () => {
    const loadCandidatesAction = vi.fn<MovementCandidateActions["loadCandidatesAction"]>()
      .mockResolvedValueOnce({ status: "error", reason: "unavailable" })
      .mockResolvedValueOnce({ status: "ready", candidates: [], total: 0 });
    setup(en, "en", { loadCandidatesAction });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Synthetic transfer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.BankMovements.payment.error);
    await user.click(screen.getByRole("button", { name: en.BankMovements.payment.retry }));
    expect(await screen.findByText(en.BankMovements.payment.empty)).toBeVisible();
  });

  it("pages the matching results rather than silently truncating them", async () => {
    const actions = setup(en, "en", {
      loadCandidatesAction: vi.fn<MovementCandidateActions["loadCandidatesAction"]>(async () => ({ status: "ready", total: 26, candidates: [candidate] })),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Synthetic transfer" }));
    const next = await screen.findByRole("button", { name: en.BankMovements.payment.next });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    await waitFor(() => expect(actions.loadCandidatesAction).toHaveBeenLastCalledWith({ movementId: "movement-1", page: 2 }));
  });

  it.each([["en", en], ["es", es], ["ca", ca]] as const)("shows explicit unknown outcome in %s", (locale, messages) => {
    render(<NextIntlClientProvider messages={messages} locale={locale}>
      <PaymentOperationStatus operation={{ bookingRequestId: "booking-1", stage: "PAID", status: "UNKNOWN" }} />
    </NextIntlClientProvider>);
    expect(screen.getByRole("status")).toHaveTextContent(messages.BankMovements.payment.statuses.UNKNOWN);
  });
});
