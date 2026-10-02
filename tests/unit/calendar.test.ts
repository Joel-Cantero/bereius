import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCalendar } from "@/modules/calendar/ical";
import { calendarUrlSchema, isPublicAddress } from "@/modules/calendar/source";
import { monthWindow, occursOn } from "@/modules/calendar/dates";

const wrap = (event: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${event}\r\nEND:VCALENDAR`;
const event = "BEGIN:VEVENT\r\nUID:fixture\r\nDTSTART;VALUE=DATE:20261013\r\nDTEND;VALUE=DATE:20261015\r\nSUMMARY:Test group\r\nEND:VEVENT";

describe("ICS calendar", () => {
  it.each(["http://example.com/feed.ics", "https://127.0.0.1/feed", "https://[::1]/feed", "https://user:password@example.com/feed", "https://example.com:8443/feed", "https://device.local/feed"])("rejects unsafe source %s", (url) => {
    expect(calendarUrlSchema.safeParse(url).success).toBe(false);
  });
  it.each(["10.0.0.1", "192.168.1.1", "169.254.169.254", "::ffff:127.0.0.1", "fc00::1", "100.64.0.1"])("rejects private address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("accepts a public HTTPS source with query parameters", () => {
    expect(calendarUrlSchema.safeParse("https://example.com/?feed=fixture.ics").success).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
  });
  it("preserves exclusive all-day ends", () => {
    const entries = parseCalendar(wrap(event), new Date("2026-10-01"), new Date("2026-11-01"));
    expect(entries[0]).toMatchObject({ start: "2026-10-13", end: "2026-10-15", allDay: true, title: "Test group" });
    expect(parseCalendar(wrap(event), new Date("2026-10-15"), new Date("2026-10-16"))).toEqual([]);
  });
  it("expands recurrence within the requested month", () => {
    const recurring = event.replace("SUMMARY:", "RRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:");
    expect(parseCalendar(wrap(recurring), new Date("2026-10-01"), new Date("2026-11-01"))).toHaveLength(3);
  });
  it("unfolds and unescapes summaries", () => {
    const folded = event.replace("Test group", "Test\\,\r\n group");
    expect(parseCalendar(wrap(folded), new Date("2026-10-01"), new Date("2026-11-01"))[0].title).toBe("Test,group");
  });
  it("rejects malformed input", () => {
    expect(() => parseCalendar("not ICS", new Date(), new Date())).toThrow();
  });
  it("starts the monthly grid on Monday and covers six weeks", () => {
    const window = monthWindow("2026-10");
    expect(window.start.toISOString().slice(0, 10)).toBe("2026-09-28");
    expect(window.end.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(window.previous).toBe("2026-09");
    expect(window.next).toBe("2026-11");
  });
  it("does not occupy the departure date", () => {
    const entry = parseCalendar(wrap(event), new Date("2026-10-01"), new Date("2026-11-01"))[0];
    expect(occursOn(entry, "2026-10-13")).toBe(true);
    expect(occursOn(entry, "2026-10-14")).toBe(true);
    expect(occursOn(entry, "2026-10-15")).toBe(false);
  });
  it("places UTC events on Madrid dates and excludes midnight end", () => {
    const entry = { id: "timed", title: "Fixture", start: "2026-10-12T23:00:00Z", end: "2026-10-13T22:00:00Z", allDay: false };
    expect(occursOn(entry, "2026-10-12")).toBe(false);
    expect(occursOn(entry, "2026-10-13")).toBe(true);
    expect(occursOn(entry, "2026-10-14")).toBe(false);
  });
  it("uses embedded time zones", () => {
    const timezone = "BEGIN:VTIMEZONE\r\nTZID:Fixture/Zone\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0200\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
    const timed = event.replace("DTSTART;VALUE=DATE:20261013", "DTSTART;TZID=Fixture/Zone:20261013T100000").replace("DTEND;VALUE=DATE:20261015", "DTEND;TZID=Fixture/Zone:20261013T110000");
    const entries = parseCalendar(wrap(timezone + timed), new Date("2026-10-01"), new Date("2026-11-01"));
    expect(entries[0].start).toBe("2026-10-13T08:00:00.000Z");
  });
});