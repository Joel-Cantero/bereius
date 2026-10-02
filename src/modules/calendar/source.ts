import "server-only";

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { z } from "zod";

export function isPublicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}

export const calendarUrlSchema = z.string().trim().max(2048).url().refine((value) => {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "https:" && !url.username && !url.password &&
    !url.hash && (!url.port || url.port === "443") &&
    (ipaddr.isValid(host) ? isPublicAddress(host) : host.includes(".") && !host.endsWith(".local"));
});

export async function fetchCalendarSource(input: string): Promise<string> {
  const url = new URL(calendarUrlSchema.parse(input));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("calendar_unavailable"));
    const outgoing = request(url, {
      signal: AbortSignal.timeout(10000),
      family: 4,
      headers: { Accept: "text/calendar", "Accept-Encoding": "identity" },
      lookup: (hostname, _options, callback) => {
        lookup(hostname, { all: true, family: 4 }).then((addresses) => {
          if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
            callback(new Error("unsafe_calendar_address"), "", 4);
            return;
          }
          callback(null, addresses[0].address, addresses[0].family);
        }).catch(() => callback(new Error("calendar_dns_failed"), "", 4));
      },
    }, (response) => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"] ?? 0) > 2 * 1024 * 1024) {
        response.destroy();
        outgoing.destroy();
        fail();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          response.destroy();
          outgoing.destroy();
          fail();
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", fail);
      response.on("aborted", fail);
    });
    outgoing.on("error", fail);
    outgoing.end();
  });
}