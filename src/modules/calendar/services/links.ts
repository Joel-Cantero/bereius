import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { openSecret } from "@/lib/booking/secrets";
import type { CalendarEntry, CalendarBookingCandidate } from "@/modules/calendar/ical";
import { readCalendar, type CalendarResult } from "@/modules/calendar/services/calendar";
import { calendarEventKey, calendarSelection, calendarSourceKey } from "@/modules/calendar/services/identity";

export class CalendarLinkError extends Error {
  constructor(readonly code: "state_changed" | "conflict" | "unavailable" | "not_configured") {
    super(code);
    this.name = "CalendarLinkError";
  }
}

const linkSelect = {
  id: true, bookingRequestId: true, sourceKey: true, eventKey: true,
  eventTitle: true, eventStart: true, eventEnd: true, allDay: true,
  bookingStartDate: true, bookingEndDate: true,
} satisfies Prisma.CalendarBookingLinkSelect;

type LinkSnapshot = Prisma.CalendarBookingLinkGetPayload<{ select: typeof linkSelect }>;
type BookingDates = { startDate: Date; endDate: Date; state: string };

function changed(link: LinkSnapshot, entry: CalendarEntry, booking: BookingDates) {
  return link.eventStart !== entry.start || link.eventEnd !== entry.end ||
    link.eventTitle !== entry.title || link.allDay !== entry.allDay ||
    link.bookingStartDate.getTime() !== booking.startDate.getTime() ||
    link.bookingEndDate.getTime() !== booking.endDate.getTime() ||
    !["CONFIRMED", "COMPLETED"].includes(booking.state);
}

function bookingWindow(booking: BookingDates, link?: LinkSnapshot | null) {
  const first = Math.min(booking.startDate.getTime(), link ? new Date(link.eventStart).getTime() : Infinity);
  const last = Math.max(booking.endDate.getTime(), link ? new Date(link.eventEnd).getTime() : -Infinity);
  return { from: new Date(first - 14 * 86400000), to: new Date(last + 14 * 86400000) };
}

function normalizeName(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

export interface BookingCalendarView {
  status: "ok" | "unavailable" | "not_configured";
  link: { id: string; title: string; start: string; end: string; allDay: boolean; review: "changed" | "missing" | "source_changed" | "unverified" | null } | null;
  candidates: CalendarBookingCandidate[];
  history: { id: string; action: "LINKED" | "UNLINKED"; title: string; actor: string | null; at: string }[];
}

export async function getBookingCalendar(bookingRequestId: string): Promise<BookingCalendarView | null> {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: {
      state: true, startDate: true, endDate: true, customer: { select: { name: true } },
      calendarLink: { select: linkSelect },
      calendarAuditEvents: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20,
        select: { id: true, action: true, eventTitle: true, createdAt: true, actor: { select: { name: true } } },
      },
    },
  });
  if (!booking) return null;
  const history = booking.calendarAuditEvents.map((event) => ({ id: event.id, action: event.action, title: event.eventTitle, actor: event.actor?.name ?? null, at: event.createdAt.toISOString() }));
  if (booking.state !== "CONFIRMED" && !booking.calendarLink) return { status: "ok", link: null, candidates: [], history };
  const window = bookingWindow(booking, booking.calendarLink);
  const calendar = await readCalendar(window.from, window.to);
  const link = booking.calendarLink;
  const linkedEntry = calendar.status === "ok" && link && link.sourceKey === calendar.sourceKey
    ? calendar.entries.find((entry) => calendarEventKey(entry) === link.eventKey) : undefined;
  const review = !link ? null : calendar.status !== "ok" ? "unverified"
    : link.sourceKey !== calendar.sourceKey ? "source_changed"
    : !linkedEntry ? "missing" : changed(link, linkedEntry, booking) ? "changed" : null;
  const owners = calendar.status === "ok" && !link && booking.state === "CONFIRMED"
    ? await db.calendarBookingLink.findMany({ where: { sourceKey: calendar.sourceKey }, select: { eventKey: true } }) : [];
  const owned = new Set(owners.map((owner) => owner.eventKey));
  const name = normalizeName(booking.customer.name);
  const start = booking.startDate.toISOString().slice(0, 10);
  const end = booking.endDate.toISOString().slice(0, 10);
  const candidates = calendar.status === "ok" && !link && booking.state === "CONFIRMED"
    ? calendar.entries.filter((entry) => calendarEventKey(entry) && !owned.has(calendarEventKey(entry)!))
      .map((entry) => ({ entry, selection: calendarSelection(calendar.sourceKey, entry),
        score: (entry.start.slice(0, 10) === start && entry.end.slice(0, 10) === end ? 4 : new Date(entry.start) < booking.endDate && new Date(entry.end) > booking.startDate ? 2 : 0) + (name && normalizeName(entry.title).includes(name) ? 1 : 0) }))
      .filter((candidate) => candidate.selection !== null)
      .toSorted((first, second) => second.score - first.score || first.entry.start.localeCompare(second.entry.start))
      .map(({ entry, selection }) => ({ selection: selection!, title: entry.title, start: entry.start, end: entry.end, allDay: entry.allDay })) : [];
  return {
    status: calendar.status,
    link: link ? { id: link.id, title: link.eventTitle, start: link.eventStart, end: link.eventEnd, allDay: link.allDay, review } : null,
    candidates, history,
  };
}

export async function linkBookingCalendar(input: { bookingRequestId: string; selection: string; actorUserId: string }) {
  const booking = await db.bookingRequest.findUnique({ where: { id: input.bookingRequestId }, select: { state: true, startDate: true, endDate: true } });
  if (!booking || booking.state !== "CONFIRMED") throw new CalendarLinkError("state_changed");
  const window = bookingWindow(booking);
  const calendar = await readCalendar(window.from, window.to);
  if (calendar.status !== "ok") throw new CalendarLinkError(calendar.status);
  const entry = calendar.entries.find((candidate) => calendarSelection(calendar.sourceKey, candidate) === input.selection);
  if (!entry?.uid) throw new CalendarLinkError("state_changed");
  const eventKey = calendarEventKey(entry)!;
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${input.bookingRequestId} FOR UPDATE`;
      const current = await tx.bookingRequest.findUnique({ where: { id: input.bookingRequestId }, select: { state: true, startDate: true, endDate: true } });
      if (!current || current.state !== "CONFIRMED" || current.startDate.getTime() !== booking.startDate.getTime() || current.endDate.getTime() !== booking.endDate.getTime()) throw new CalendarLinkError("state_changed");
      await tx.$queryRaw`SELECT "provider" FROM "IntegrationSettings" WHERE "provider" = 'CALENDAR_ICS' FOR SHARE`;
      const settings = await tx.integrationSettings.findUnique({ where: { provider: "CALENDAR_ICS" }, select: { secretCiphertext: true, secretIv: true, secretAuthTag: true } });
      if (!settings?.secretCiphertext || !settings.secretIv || !settings.secretAuthTag || calendarSourceKey(openSecret({ ciphertext: settings.secretCiphertext, iv: settings.secretIv, authTag: settings.secretAuthTag })) !== calendar.sourceKey) throw new CalendarLinkError("state_changed");
      await tx.calendarBookingLink.create({ data: {
        bookingRequestId: input.bookingRequestId, sourceKey: calendar.sourceKey, eventKey,
        eventUid: entry.uid!, occurrenceId: entry.occurrenceId ?? "", eventTitle: entry.title,
        eventStart: entry.start, eventEnd: entry.end, allDay: entry.allDay,
        bookingStartDate: current.startDate, bookingEndDate: current.endDate, linkedById: input.actorUserId,
      } });
      await tx.calendarBookingAuditEvent.create({ data: { bookingRequestId: input.bookingRequestId, actorUserId: input.actorUserId, action: "LINKED", eventTitle: entry.title, sourceKey: calendar.sourceKey, eventKey } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new CalendarLinkError("conflict");
    throw error;
  }
}

export async function unlinkBookingCalendar(input: { bookingRequestId: string; linkId: string; actorUserId: string }) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BookingRequest" WHERE "id" = ${input.bookingRequestId} FOR UPDATE`;
    const link = await tx.calendarBookingLink.findUnique({ where: { bookingRequestId: input.bookingRequestId }, select: linkSelect });
    if (!link || link.id !== input.linkId) throw new CalendarLinkError("state_changed");
    await tx.calendarBookingLink.delete({ where: { id: link.id } });
    await tx.calendarBookingAuditEvent.create({ data: { bookingRequestId: input.bookingRequestId, actorUserId: input.actorUserId, action: "UNLINKED", eventTitle: link.eventTitle, sourceKey: link.sourceKey, eventKey: link.eventKey } });
  });
}

export async function readCalendarWithBookings(from: Date, to: Date): Promise<CalendarResult> {
  const calendar = await readCalendar(from, to);
  if (calendar.status !== "ok") return calendar;
  const links = await db.calendarBookingLink.findMany({ select: { ...linkSelect, bookingRequest: { select: { state: true, startDate: true, endDate: true, customer: { select: { name: true } } } } } });
  const entries = calendar.entries.map((entry) => ({ ...entry, bookings: [] as NonNullable<CalendarEntry["bookings"]> }));
  for (const link of links) {
    const entry = link.sourceKey === calendar.sourceKey ? entries.find((candidate) => calendarEventKey(candidate) === link.eventKey) : undefined;
    const badge = { id: link.bookingRequestId, label: link.bookingRequest.customer.name, needsReview: !entry || changed(link, entry, link.bookingRequest) };
    if (entry) entry.bookings.push(badge);
    else if (new Date(link.eventStart) < to && new Date(link.eventEnd) > from) entries.push({ id: `linked:${link.id}`, title: link.eventTitle, start: link.eventStart, end: link.eventEnd, allDay: link.allDay, bookings: [badge] });
  }
  return { ...calendar, entries };
}