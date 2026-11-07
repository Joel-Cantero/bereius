import { z } from "zod";

export const googleCalendarConfigSchema = z.object({
  calendarId: z.string().trim().min(1).max(255),
}).strict();

const googleServiceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1),
  project_id: z.string().min(1).optional(),
  token_uri: z.url().optional(),
}).passthrough();

export type GoogleServiceAccount = z.infer<typeof googleServiceAccountSchema>;

export function parseGoogleServiceAccountJson(value: unknown): {
  raw: string;
  credentials: GoogleServiceAccount;
} | null {
  if (typeof value !== "string" || value.length > 32_768) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }

  const parsed = googleServiceAccountSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return { raw: value.trim(), credentials: parsed.data };
}