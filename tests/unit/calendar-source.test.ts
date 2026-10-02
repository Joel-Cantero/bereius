// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { fetchCalendarSource } from "@/modules/calendar/source";

describe("bounded calendar download", () => {
  let outgoing: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  let response: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
  let content: Buffer;

  beforeEach(() => {
    vi.clearAllMocks();
    content = Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: vi.fn() });
    outgoing = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    mocks.request.mockImplementation((_url, options, onResponse) => {
      outgoing.end.mockImplementation(() => options.lookup("example.test", {}, (error: Error | null) => {
        if (error) outgoing.emit("error", error);
        else {
          onResponse(response);
          response.emit("data", content);
          response.emit("end");
        }
      }));
      return outgoing;
    });
  });
  it("downloads with an abort deadline and a public pinned DNS lookup", async () => {
    expect(await fetchCalendarSource("https://example.test/feed.ics")).toContain("BEGIN:VCALENDAR");
    expect(mocks.lookup).toHaveBeenCalledWith("example.test", { all: true, family: 4 });
    expect(mocks.request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects DNS resolving to a private address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "192.168.1.2", family: 4 }]);
    await expect(fetchCalendarSource("https://example.test/feed.ics")).rejects.toThrow("calendar_unavailable");
  });
  it("rejects mixed public and private DNS answers", async () => {
    mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(fetchCalendarSource("https://example.test/feed.ics")).rejects.toThrow();
  });
  it("does not follow redirects", async () => {
    response.statusCode = 302;
    response.headers.location = "https://127.0.0.1/private";
    await expect(fetchCalendarSource("https://example.test/feed.ics")).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized downloads even without a content length", async () => {
    content = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(fetchCalendarSource("https://example.test/feed.ics")).rejects.toThrow();
    expect(outgoing.destroy).toHaveBeenCalled();
  });
  it("rejects an oversized declared length", async () => {
    response.headers["content-length"] = "3000000";
    await expect(fetchCalendarSource("https://example.test/feed.ics")).rejects.toThrow();
  });
});