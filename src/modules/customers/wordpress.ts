import "server-only";

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { z } from "zod";
import { isPublicAddress } from "@/modules/calendar/source";
import { delegateSchema, principalSchema, wordpressConfigSchema, type WordpressConfig } from "./schema";

export class WordpressError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WordpressError";
  }
}

export type WordpressTransport = (path: string, method: "GET" | "POST", body?: unknown) => Promise<unknown>;

export function nativeWordpressTransport(config: WordpressConfig, password: string): WordpressTransport {
  const origin = wordpressConfigSchema.parse(config).origin;
  return (path, method, body) => new Promise((resolve, reject) => {
    const fail = () => reject(new WordpressError(method === "POST" ? "outcome_unknown" : "wordpress_unavailable"));
    const outgoing = request(new URL(`/wp-json/berea/v1/admin/${path}`, origin), {
      method,
      signal: AbortSignal.timeout(15000),
      family: 4,
      headers: {
        Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": "Bereius/1.0",
        Authorization: `Basic ${Buffer.from(`${config.username}:${password}`).toString("base64")}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      lookup: (hostname, _options, callback) => {
        lookup(hostname, { all: true, family: 4 }).then((addresses) => {
          if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
            callback(new Error("unsafe_wordpress_address"), "", 4);
          } else callback(null, addresses[0].address, addresses[0].family);
        }).catch(() => callback(new Error("wordpress_dns_failed"), "", 4));
      },
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400
        || Number(response.headers["content-length"] ?? 0) > 2 * 1024 * 1024) {
        response.destroy(); outgoing.destroy(); fail(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { response.destroy(); outgoing.destroy(); fail(); }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            const failure = z.object({ code: z.string().regex(/^berea_[a-z_]+$/u) }).safeParse(result);
            reject(new WordpressError(failure.success ? failure.data.code : "wordpress_rejected"));
          } else resolve(result);
        } catch { fail(); }
      });
      response.on("error", fail);
      response.on("aborted", fail);
    });
    outgoing.on("error", fail);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const pageSchema = z.object({ items: z.array(principalSchema).max(100), page: z.number().int(), has_more: z.boolean() });
const delegatesSchema = z.object({ principal_id: z.number().int().positive(), holded_contact_id: z.string(), delegates: z.array(delegateSchema).max(100) });

export function createWordpressClient(config: WordpressConfig, password: string, transport = nativeWordpressTransport(config, password)) {
  return {
    async listPrincipals() {
      const items: z.infer<typeof principalSchema>[] = [];
      const seen = new Set<number>();
      for (let page = 1; page <= 20; page++) {
        const parsed = pageSchema.safeParse(await transport(`customers?page=${page}`, "GET"));
        if (!parsed.success || parsed.data.page !== page || parsed.data.has_more && !parsed.data.items.length) {
          throw new WordpressError("incomplete_snapshot");
        }
        for (const item of parsed.data.items) {
          if (seen.has(item.id)) throw new WordpressError("incomplete_snapshot");
          seen.add(item.id); items.push(item);
        }
        if (!parsed.data.has_more) return items;
      }
      throw new WordpressError("incomplete_snapshot");
    },
    async savePrincipal(payload: unknown) {
      const parsed = principalSchema.safeParse(await transport("customers", "POST", payload));
      if (!parsed.success) throw new WordpressError("outcome_unknown");
      return parsed.data;
    },
    async getDelegates(principalId: number, contactId: string) {
      const query = new URLSearchParams({ principal_id: String(principalId), holded_contact_id: contactId });
      const parsed = delegatesSchema.safeParse(await transport(`delegations?${query}`, "GET"));
      if (!parsed.success || parsed.data.principal_id !== principalId || parsed.data.holded_contact_id !== contactId) {
        throw new WordpressError("principal_mismatch");
      }
      return parsed.data.delegates;
    },
    async mutateDelegate(payload: { action: string }) {
      const { action, ...rest } = payload;
      const result = await transport(action === "invite" ? "delegations" : "delegations/action", "POST", action === "invite" ? rest : payload);
      if (action !== "invite" && !delegateSchema.safeParse(result).success) throw new WordpressError("outcome_unknown");
      if (action === "invite" && !z.object({ delegate_id: z.number().int().positive(), status: z.enum(["pending", "active"]) }).safeParse(result).success) {
        throw new WordpressError("outcome_unknown");
      }
    },
  };
}