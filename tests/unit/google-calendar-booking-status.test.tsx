import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

import { BookingCalendarSyncStatus } from "@/modules/calendar/components/booking-calendar-sync-status";
import type { GoogleCalendarBookingSyncView } from "@/modules/calendar/types";

const action = vi.fn(async () => ({ status: "done" as const }));
const bookingRequestId = "booking-1";

describe("booking Google Calendar sync status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("announces a pending event sync", () => {
    const view: GoogleCalendarBookingSyncView = { status: "pending", lastFailureCode: null, eventId: null };
    render(<BookingCalendarSyncStatus bookingRequestId={bookingRequestId} view={view} action={action} />);

    expect(screen.getByRole("status")).toHaveTextContent("Calendar.googleBookingSync.pending");
  });

  it("shows a safe failure and an operator retry button", () => {
    const view: GoogleCalendarBookingSyncView = { status: "failed", lastFailureCode: "private-provider-detail", eventId: "stable-id" };
    render(<BookingCalendarSyncStatus bookingRequestId={bookingRequestId} view={view} action={action} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Calendar.googleBookingSync.failed");
    expect(screen.getByRole("button", { name: "Calendar.googleBookingSync.retry" })).toBeVisible();
    expect(screen.queryByText("private-provider-detail")).not.toBeInTheDocument();
  });

  it("announces a successfully created event", () => {
    const view: GoogleCalendarBookingSyncView = { status: "created", lastFailureCode: null, eventId: "stable-id" };
    render(<BookingCalendarSyncStatus bookingRequestId={bookingRequestId} view={view} action={action} />);

    expect(screen.getByRole("status")).toHaveTextContent("Calendar.googleBookingSync.created");
  });
});