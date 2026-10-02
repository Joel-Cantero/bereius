# Implementation Plan

Reuse console navigation, booking authorization, encrypted IntegrationSettings and server actions. Add CALENDAR_ICS through a forward-only enum migration. Use ical.js for RFC5545 parsing and recurrence; render a responsive monthly grid with accessible previous/next/today controls. Fetch server-side via bounded HTTPS with pinned public DNS, no redirects and no URL logging. Use noindex metadata and no sitemap entry.

## Verification Strategy

Vitest tests cover exclusive ends, folded text, recurrence, unsafe URLs and bounded network failure. Component tests cover monthly navigation and localized empty states. Run lint, typecheck, tests and SpecKit compliance. Perform a read-only live check with the requested source and start the local development server. Rollback application code only; the additive provider enum may remain safely in the database.

## Constitution Check

Preserve Docker portability, domain ownership, encrypted secrets, structured redacted logs, trusted session authorization and all three locales. The authenticated calendar is non-indexable and excluded from the sitemap. The feature changes no source availability or public booking workflow.

**Migration Strategy**: Add CALENDAR_ICS to the PostgreSQL enum using a forward-only migration before deploying application code. No rows or credentials are rewritten.

**Recovery Strategy**: Restore previous application code if needed; retain the harmless additive enum value and any encrypted configuration. Never rewrite applied migrations.