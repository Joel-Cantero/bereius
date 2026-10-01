import { render as renderTree, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import caMessages from "@/messages/ca.json";
import { BookingHistory } from "@/modules/booking/components/history";

function render(tree: React.ReactNode, locale = "en", messages = enMessages) {
  return renderTree(
    <NextIntlClientProvider locale={locale} messages={messages}>{tree}</NextIntlClientProvider>,
  );
}

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getBookingDetail: vi.fn(),
  listBookingPaymentCandidates: vi.fn(),
  inspectCustomerContact: vi.fn(),
  requireBookingActor: vi.fn(),
  getTranslations: vi.fn(),
  setRequestLocale: vi.fn(),
}));

function translate(key: string) {
  const value = key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, enMessages.Bookings);
  if (typeof value !== "string") throw new Error(`Missing Bookings.${key}`);
  return value;
}

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
  setRequestLocale: mocks.setRequestLocale,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/holded/links", () => ({
  holdedEstimateUrl: (id: string) => `https://holded.example/estimate/${id}`,
}));
vi.mock("@/modules/booking/authorization", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireBookingActor: mocks.requireBookingActor,
}));
vi.mock("@/modules/booking/services/contact-sync", () => ({
  inspectCustomerContact: mocks.inspectCustomerContact,
}));
vi.mock("@/modules/booking/services/queries", () => ({
  getBookingDetail: mocks.getBookingDetail,
}));
vi.mock("@/modules/banking/services/queries", () => ({
  listBookingPaymentCandidates: mocks.listBookingPaymentCandidates,
}));
vi.mock("@/modules/banking/actions/reconciliation", () => ({
  confirmBookingPaymentCandidateAction: vi.fn(),
  dismissBookingPaymentCandidateAction: vi.fn(),
}));
vi.mock("@/modules/booking/actions/contact", () => ({
  createContactAction: vi.fn(),
  linkEstimateAction: vi.fn(),
  updateContactAction: vi.fn(),
}));
vi.mock("@/modules/booking/actions/decisions", () => ({
  approveBookingAction: vi.fn(),
  cancelBookingAction: vi.fn(),
  recordPaymentAction: vi.fn(),
  rejectBookingAction: vi.fn(),
}));
vi.mock("@/modules/booking/actions/quotes", () => ({ resendQuoteAction: vi.fn() }));

import BookingDetailPage from "@/app/[locale]/(console)/bookings/[id]/page";

function bookingWithDelivery(status: "ACCEPTED" | "UNKNOWN") {
  return {
    id: "booking-1",
    state: "COMPLETED",
    boardType: "FULL_BOARD",
    startDate: new Date("2027-05-10T00:00:00.000Z"),
    endDate: new Date("2027-05-12T00:00:00.000Z"),
    headcount: 30,
    advanceCents: 20_000,
    depositCents: 10_000,
    paymentDueAt: null,
    customer: {
      name: "Example organisation",
      taxId: "B12345678",
      email: "fiscal@example.test",
      phone: null,
      addressLine: null,
      postalCode: null,
      city: null,
      province: null,
    },
    documents: [
      {
        id: "document-1",
        type: "ESTIMATE",
        holdedId: "estimate-1",
        documentNumber: "P-1",
        delivery: { status },
      },
    ],
    documentIssuances: [],
    payments: [],
    auditEvents: [],
    operationEvents: [],
  };
}

function bookingWithReserveInvoice(
  issuanceStatus: "PREPARED" | "ISSUED" | "BLOCKED" | "UNKNOWN",
  deliveryStatus?: "ACCEPTED" | "UNKNOWN",
) {
  const booking = bookingWithDelivery("ACCEPTED");
  return {
    ...booking,
    documents:
      issuanceStatus === "ISSUED"
        ? [
            ...booking.documents,
            {
              id: "document-2",
              type: "RESERVE_INVOICE",
              holdedId: "invoice-1",
              documentNumber: "F-1",
              delivery: deliveryStatus ? { status: deliveryStatus } : null,
            },
          ]
        : booking.documents,
    documentIssuances: [{ status: issuanceStatus }],
  };
}

describe("unified booking history", () => {
  const timestamp = "2026-10-01T12:05:00.000Z";
  function operation(id: string, type: string, createdAt = timestamp, failureCode: string | null = null) {
    return { id, type, createdAt, timeLabel: createdAt, actorLabel: null, failureCode };
  }

  it("merges lifecycle and operations newest-first without losing retries or pending attempts", () => {
    render(<BookingHistory operations={[
      operation("start", "DELIVERY_STARTED"), operation("accepted", "DELIVERY_ACCEPTED"),
      operation("start-2", "DELIVERY_STARTED", "2026-10-01T12:07:00.000Z"),
      operation("failed", "DELIVERY_FAILED", "2026-10-01T12:08:00.000Z", "invalid_request"),
      operation("pending", "DELIVERY_STARTED", "2026-10-01T12:09:00.000Z"),
    ]} lifecycle={[{ id: "state", toState: "CONFIRMED", createdAt: "2026-10-01T12:06:00.000Z", timeLabel: "12:06", actorLabel: "Operator", reason: "Bank payment" }]} />);
    const history = within(screen.getByRole("region", { name: enMessages.Bookings.detail.history }));
    const items = history.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(enMessages.Bookings.operations.events.DELIVERY_STARTED);
    expect(items[1]).toHaveTextContent(enMessages.Bookings.operations.events.DELIVERY_FAILED);
    expect(items[2]).toHaveTextContent("Bank payment");
    expect(items[3]).toHaveTextContent(enMessages.Bookings.operations.events.DELIVERY_ACCEPTED);
    expect(history.getByRole("img", { name: enMessages.Bookings.operations.events.DELIVERY_ACCEPTED })).toHaveClass("text-green-600");
  });

  it.each(Object.entries({ en: enMessages, es: esMessages, ca: caMessages }))("explains failures on hover and keyboard focus in %s", async (locale, messages) => {
    const user = userEvent.setup();
    render(<BookingHistory operations={[
      operation("started", "DELIVERY_STARTED"), operation("result", "DELIVERY_FAILED", timestamp, "invalid_request"),
    ]} lifecycle={[]} />, locale, messages);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    const failure = screen.getByRole("button", { name: messages.Bookings.operations.events.DELIVERY_FAILED });
    expect(failure.querySelector("svg")).toHaveClass("text-red-600");
    await user.hover(failure);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(messages.Bookings.operations.reasons.invalid_request);
    await user.unhover(failure);
    await user.tab();
    expect(failure).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(messages.Bookings.operations.reasons.invalid_request);
  });

  it("preserves unknown outcomes and hides untrusted failure text", async () => {
    const user = userEvent.setup();
    render(<BookingHistory operations={[operation("unknown", "DELIVERY_UNKNOWN", timestamp, "private@example.test")]} lifecycle={[]} />);
    expect(screen.queryByRole("img", { name: enMessages.Bookings.operations.events.DELIVERY_ACCEPTED })).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: enMessages.Bookings.operations.events.DELIVERY_UNKNOWN }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(enMessages.Bookings.operations.reasons.unexpected);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("private@example.test");
  });
});

describe("booking detail estimate delivery warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ id: "operator-1" });
    mocks.inspectCustomerContact.mockResolvedValue({
      status: "no_key",
      differences: [],
      estimates: [],
    });
    mocks.listBookingPaymentCandidates.mockResolvedValue([]);
    mocks.getTranslations.mockResolvedValue(translate);
  });

  it("shows a stable non-PII warning for an unknown Holded outcome", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("UNKNOWN"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      enMessages.Bookings.detail.deliveryUnknown,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("fiscal@example.test");
  });

  it("does not warn after Holded accepted delivery", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("ACCEPTED"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: enMessages.Bookings.actions.resendQuote })).toBeEnabled();
  });

  it("disables resend for an unknown estimate delivery", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("UNKNOWN"));
    render(await BookingDetailPage({ params: Promise.resolve({ locale: "en", id: "booking-1" }) }));
    expect(screen.getByRole("button", { name: enMessages.Bookings.actions.resendQuote })).toBeDisabled();
  });

  it("shows durable document events in the lifecycle history", async () => {
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      operationEvents: [
        { id: "event-1", type: "ESTIMATE_CREATED", createdAt: new Date("2026-10-01T09:00:00Z"), actor: null, failureCode: null },
        { id: "event-2", type: "DELIVERY_ACCEPTED", createdAt: new Date("2026-10-01T09:01:00Z"), actor: null, failureCode: null },
      ],
    });
    render(await BookingDetailPage({ params: Promise.resolve({ locale: "en", id: "booking-1" }) }));
    expect(screen.queryByRole("region", { name: "Logs" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: enMessages.Bookings.detail.history })).toHaveTextContent(enMessages.Bookings.operations.events.ESTIMATE_CREATED);
    expect(screen.getByRole("region", { name: enMessages.Bookings.detail.history })).toHaveTextContent(enMessages.Bookings.operations.events.DELIVERY_ACCEPTED);
    expect(screen.getByRole("heading", { name: enMessages.Bookings.detail.history })).toBeVisible();
  });

  it.each([
    ["PREPARED", "reserveInvoiceProcessing"],
    ["ISSUED", "reserveInvoiceSent"],
    ["BLOCKED", "reserveInvoiceBlocked"],
    ["UNKNOWN", "reserveInvoiceUnknown"],
  ] as const)(
    "shows the safe reserve invoice status for %s",
    async (issuanceStatus, messageKey) => {
      mocks.getBookingDetail.mockResolvedValue(
        bookingWithReserveInvoice(
          issuanceStatus,
          issuanceStatus === "ISSUED" ? "ACCEPTED" : undefined,
        ),
      );

      render(
        await BookingDetailPage({
          params: Promise.resolve({ locale: "en", id: "booking-1" }),
        }),
      );

      expect(screen.getByText(enMessages.Bookings.detail[messageKey])).toBeVisible();
    },
  );

  it("shows an unknown invoice delivery without claiming it was sent", async () => {
    mocks.getBookingDetail.mockResolvedValue(
      bookingWithReserveInvoice("ISSUED", "UNKNOWN"),
    );

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(
      screen.getByText(enMessages.Bookings.detail.reserveInvoiceDeliveryUnknown),
    ).toBeVisible();
    expect(
      screen.queryByText(enMessages.Bookings.detail.reserveInvoiceSent),
    ).not.toBeInTheDocument();
  });

  it("shows the exact amount expected to confirm the booking", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("ACCEPTED"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    const money = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "EUR",
    });
    expect(screen.getByText(money.format(200))).toBeVisible();
    expect(screen.getByText(money.format(100))).toBeVisible();
    expect(screen.getByText(money.format(300))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh linked estimate" }),
    ).not.toBeInTheDocument();
  });

  it("offers to repair a linked estimate whose payment amounts are missing", async () => {
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "AWAITING_PAYMENT",
      advanceCents: null,
      depositCents: null,
      documents: [
        {
          id: "document-1",
          type: "ESTIMATE",
          holdedId: "6aa65f996fc9e17ce706fe70",
          documentNumber: null,
          totalCents: null,
          delivery: null,
        },
      ],
    });

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByText(
        "The linked estimate is missing information needed to match payments.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Refresh linked estimate" }),
    ).toBeEnabled();
  });

  it("shows matching bank income while a booking awaits payment", async () => {
    const money = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "EUR",
    });
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "AWAITING_PAYMENT",
    });
    mocks.listBookingPaymentCandidates.mockResolvedValue([
      {
        movementId: "movement-1",
        bookingDate: "2026-09-11",
        narrative: "Synthetic payment without estimate reference",
        amountMinor: "31500",
        expectedAmountMinor: "30000",
        differenceMinor: "1500",
        currency: "EUR",
        estimateReferenceFound: false,
      },
    ]);

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Matching bank income" }),
    ).toBeVisible();
    expect(
      screen.getByText("Synthetic payment without estimate reference"),
    ).toBeVisible();
    expect(screen.getByText(money.format(315))).toBeVisible();
    expect(screen.getAllByText(money.format(300))).toHaveLength(2);
    expect(screen.getByText(money.format(15))).toBeVisible();
    expect(screen.getByText("No estimate reference found")).toBeVisible();
    expect(screen.getByRole("button", { name: "Link payment" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("labels an unnumbered estimate without exposing its Holded id", async () => {
    const holdedId = "6aa65f996fc9e17ce706fe70";
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "IN_REVIEW",
      documents: [],
    });
    mocks.inspectCustomerContact.mockResolvedValue({
      status: "matches",
      contactId: "contact-1",
      differences: [],
      estimates: [
        {
          id: holdedId,
          number: null,
          description: "10/05/27 - 12/05/27 - 30 persones PC",
          date: "2027-05-01",
          totalCents: 170_001,
          status: "draft",
          contactId: "contact-1",
          contactName: "Example organisation",
        },
      ],
    });

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Estimate without number")).toBeVisible();
    expect(screen.queryByText(holdedId)).not.toBeInTheDocument();
  });
});