# Implementation Plan: Holded API Budget

## Constitution Check

Keep server-only infrastructure and domain services, existing manual-refresh authorization, database transactions and delivery safeguards. This feature supersedes periodic/expiry bank synchronization in the bank-movements specification.

## Design

Persist validated estimate-list cache entries in PostgreSQL, with per-key locking, one-hour freshness, explicit invalidation and bounded cleanup. The worker processes only manually requested bank scans and retries; expiry checks use persisted evidence rather than calling Holded. Add sanitized transport logs and named caller contexts.

**Migration Strategy**: Add a forward-only private cache table. Preserve historic bank triggers and timestamps; new execution paths ignore non-manual queued scans.

**Recovery Strategy**: Roll back code if needed without deleting bank data or audit history. Cache rows can expire normally; a fresh authenticated read bypasses them. Do not modify production during development.

## Verification

Use real PostgreSQL for cross-client/restart cache reuse, credential isolation, invalidation and concurrency. Exercise manual-only banking, expiry deferral, successful manual scan, and existing refresh workflow. Validate transport-log redaction with HTTP fixtures. Run focused tests, lint, typecheck, standard tests and compliance; record unverified gates.

## T001 Delivery Behavior

Account configuration no longer creates an initial scan. New scheduled/expiry enqueue requests are
rejected, periodic enqueue is inert, and both worker and direct lease acquisition ignore historic
non-manual runs. An authorized manual refresh retains cooldowns, pagination, leases and bounded
retries. It retires obsolete nonterminal automatic jobs without deleting their history.

Expiry only reads persisted bank evidence. Daily checks defer without a fresh clean completed
manual scan. The worker passes the completed manual run ID to the expiry service; the run's
original start, preserved across retries, bounds eligible payment deadlines. A deadline reached
while scanning cannot be expired by that scan. The transaction rechecks active account, successful
exhaustion, absence of incidents, booking state and pending reconciliation proposals.

## Rollout and Recovery

This change needs no new migration, secret, container or external service. Deploy the combined
calendar/banking PR through the existing migration-first pipeline; the calendar migration remains
required. Stop the previous application worker before starting the new image so it cannot keep
creating automatic scans. No production rollout was performed during this validation.

After rollout, verify that saving settings or merely visiting bank movements creates no bank scan.
Request one authorized manual refresh, check its pages and terminal state, and verify expiry only
for unprotected bookings already due at scan start. Provider failure must preserve visible data,
durable retry state and unexpired bookings. Retention must not start provider requests.

Rollback means deploying compatible prior code without deleting banking data or reversing schema
migrations. It restores automatic initial/periodic/expiry scans and increases API consumption;
obtain operator approval before rollback. Unmatched bookings with later deadlines intentionally
remain awaiting payment until another complete manual refresh.

## Remaining Work

T003 is implemented and verified. T002 (persistent estimate cache) and T004 (contact-group caller
investigation) were checked off at the user's request, without new implementation or investigation
evidence. Their requirements remain in the spec, and their technical completion remains unverified.
Completing the checklist does not establish that evidence. T005 records executed validation and
rollout guidance; it is not an assertion that the whole Holded API Budget feature is merge-ready.

## T003 Delivery and Validation

The shared Holded transport emits one info-level `holded_request` event for each HTTP attempt,
including the separate estimate/invoice send path. Cached reads do not emit outgoing events; each
pagination request does. Event fields are endpoint template, HTTP method, fixed caller identifier,
transport outcome, status, status class, duration and oversized-response flag. `response` means
an HTTP response was received, not that its JSON or business operation was accepted; `network_error`
also covers timeouts. Existing Holded error and uncertain-delivery classifications are unchanged.

Caller identifiers cover banking account discovery and synchronization, integration testing,
contacts, contracts, quoting, reserve invoices and settings. Unknown caller values and unrecognized
paths become `unknown` or `/unknown`. Logs never copy query values, dynamic identifiers, credentials,
request/response bodies, provider exceptions, recipients, templates, subjects or redirect locations.
These events attribute Bereius traffic only; they do not identify other consumers of a shared key.

Fourteen HTTP-fixture regressions exercise these privacy boundaries, pagination and cache reuse.
Updated validation: lint and typecheck pass; standard tests pass 1,990 tests with 366 integration
skips. The real-PostgreSQL coverage run passes 2,355 tests with one skip: statements 85.69%, branches
79.40%, functions 86.29%, lines 87.50%. The production build and all 98 Playwright E2E tests pass.
The global SpecKit check now validates the completed checklist, without proving T002/T004 technical
completion. No production requests, deployment, commit or push were made.

## Validation Record (2026-10-02)

- Focused banking integration tests: 53 passed against a disposable PostgreSQL 17 database with
	synthetic providers; no real Holded requests were made.
- Focused bank settings, movement-page and worker tests: 69 passed.
- `pnpm lint` and `pnpm typecheck`: passed without warnings or errors.
- `pnpm test`: 1,976 passed, 366 skipped (integration opt-in disabled).
- `RUN_INTEGRATION_TESTS=true pnpm test:coverage`: passed, including configured coverage thresholds.
	Statements 85.67%, branches 79.36%, functions 86.26%, lines 87.48%.
- `pnpm audit:prod`: passed the high-severity threshold; two moderate findings remain.
- `pnpm test:e2e`: production build passed and 98 Playwright tests passed, including bank and
	calendar desktop/mobile flows. Its database and application artifacts were isolated from
	development and production.
- Initial `bash .specify/scripts/bash/compliance-check.sh --all`: blocked by the then-pending
	T002-T004. T003 is now implemented; T002/T004 were subsequently checked off by user request.
	No compliance script, CI condition or coverage threshold was weakened.

These results are local validation evidence, not a newly successful GitHub Actions run. The
combined PR remains on its existing branch; no commit, push or production deployment was made.