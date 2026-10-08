import { z } from "zod";

export const wordpressConfigSchema = z.object({
  origin: z.url().max(2048).refine((input) => {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash
      && (!url.port || url.port === "443") && url.hostname.includes(".")
      && !url.hostname.endsWith(".local");
  }),
  username: z.string().trim().min(1).max(320),
  writesEnabled: z.boolean().default(false),
  automaticSync: z.boolean().default(false),
}).strict();

export type WordpressConfig = z.infer<typeof wordpressConfigSchema>;

export const principalSchema = z.object({
  id: z.number().int().positive(),
  holded_contact_id: z.string(),
  email: z.string(),
  name: z.string(),
  managed: z.boolean(),
  meta: z.record(z.string(), z.string()),
});

export type Principal = z.infer<typeof principalSchema>;

export const delegateSchema = z.object({
  id: z.number().int().positive(),
  email: z.email(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string(),
  status: z.enum(["pending", "active", "revoked"]),
  generation: z.number().int().positive(),
  invited_at: z.string(),
  holded_person_id: z.string(),
  projection_status: z.enum(["queued", "retrying", "idle"]),
});

export type Delegate = z.infer<typeof delegateSchema>;

export const delegateCommandSchema = z.object({
  principal_id: z.number().int().positive(),
  holded_contact_id: z.string().regex(/^[a-f0-9]{24}$/u),
  delegate_id: z.number().int().positive().optional(),
  generation: z.number().int().positive().optional(),
  expected_status: z.enum(["pending", "active", "revoked"]).optional(),
  action: z.enum(["invite", "update", "resend", "revoke", "reinvite"]),
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(320).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
}).strict().superRefine((command, context) => {
  const fields = command.action === "invite" || command.action === "update"
    ? ["first_name", "last_name", "email", "phone"] as const : [];
  for (const field of fields) {
    if (!command[field]) context.addIssue({ code: "custom", path: [field], message: "required" });
  }
  if (command.action !== "invite" && (!command.delegate_id || !command.generation || !command.expected_status)) {
    context.addIssue({ code: "custom", message: "required_delegate_version" });
  }
});