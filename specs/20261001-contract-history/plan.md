# Implementation Plan: Full Contract and Unified History

## Constitution Check

Reuse the Holded boundary, booking services, UI primitives, and nearby tests. Preserve authentication, outbox idempotency, unknown-outcome blocking, and provider-read validation. Keep the private booking route non-indexable.

## Design

Remove negative payment lines from new quote generation. On explicit resend, read and retain the existing contract lines and remove only recognized negative deposit/advance deductions, preserving tax mode and other line attributes. Merge and fold persisted history for display without deleting records. Use existing Tooltip and lucide status icons.

**Migration Strategy**: No database migration or historical rewrite is needed; this is a provider-payload and history-presentation change.

**Recovery Strategy**: Roll back application code if necessary. Do not alter or resend production contracts as part of development or deployment. Existing contracts are corrected only through an explicit resend.

## Verification

Use provider HTTP fixtures for correction payloads, real-PostgreSQL quote tests for creation/resend/idempotency, localized UI tests for timeline grouping/status/tooltip, and Playwright for hover, focus, ordering, and mobile fit. Run lint, typecheck, standard Vitest, and SpecKit compliance before opening the PR. Record any unavailable release gate without weakening it.

## Verification Results

- Lint and typecheck passed after excluding temporary build output; no configuration change is included.
- Standard Vitest: 1,936 passed, 359 database-dependent cases skipped.
- Focused quote integration: 42 passed against isolated PostgreSQL, including correction failure, approval retry, frozen recipients, and accepted-delivery idempotency. Document-delivery integration: 6 passed.
- Holded boundary: 95 passed; booking-detail/history unit tests: 18 passed, including hover/focus explanations in all three locales.
- Production build passed. Booking-review Playwright: 10 passed, including all locales at desktop and 320px mobile widths. Screenshots captured for all six localized viewport cases.
- Full integration coverage and the complete E2E suite were not rerun for this patch. CI remains authoritative; prior global coverage runs did not complete successfully and are not represented as a passing gate here.
- No production document, email, stack, or database was modified during development.