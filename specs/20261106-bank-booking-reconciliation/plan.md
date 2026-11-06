# Implementation Plan: Bank Booking Reconciliation

## Architecture

Reuse Next.js Server Actions, banking queries/UI, booking lifecycle, Holded client,
PostgreSQL/Prisma, DocumentDelivery and IntegrationJob. A unique BankPaymentOperation
reserves a booking and movement and freezes the receipt, contact and estimate. Its
durable stage advances only after each bounded remote step.

Strict proposals and manual bank candidates enqueue the same operation. The worker
creates a linked draft through conversion, replaces and verifies its lines, approves,
registers and verifies payment, reconciles the movement with the collection, sends once,
then commits payment, proposal decision, audit, confirmation and notification outbox.

## Constitution Check

Reuse the installed stack, private non-indexable routes, server-only services, authorized
actions, PostgreSQL outbox and sanitized logger. No new service, credential or dependency.
Automated tests use synthetic providers and isolated PostgreSQL, never live fiscal writes.

**Migration Strategy**: apply the additive BankPaymentOperation migration before starting
the new image; no historical backfill or destructive data change.

**Recovery Strategy**: preserve external IDs and completed stages, park ambiguous writes,
and resume only after evidence-based review. Restore backups only for actual database loss.

## Verified Public API Contract

Source: `https://api.holded.com/openapi/es.json`, OpenAPI 3.1.0, inspected 2026-11-06.

- `POST /api/v2/documents/convert`: source_type=estimate, source_id, target_type=invoice,
  draft=true, dates and number_line_id; response id. Original unchanged, target linked.
- `PUT /api/v2/invoices/{invoiceId}`: partial update with replacement items.
- `GET /api/v2/invoices/{invoiceId}`: `from.id/doc_type`, draft, approved_at,
  payments_total/pending/detail (id, amount, date, bank_id).
- `POST /api/v2/invoices/{invoiceId}/payments`: amount decimal string, treasury_id,
  date, description. HTTP 201; no response body required.
- `POST /api/v2/treasury/accounts/{bankingAccountId}/bank-movements/{movementId}/reconcile`:
  documents array of document_id and document_type, including collection. HTTP 200.
  Never omit documents: that would mark a movement reconciled without linking a document.
- Existing invoice approve/send and treasury movement pagination remain in use.

Conversion/payment require sales:invoices.write; reconciliation requires
accounting:banks.write, with matching read permissions. A displayed 0% on the screenshot
does not prove non-subject tax: use and verify the configured non-subject tax key.

## Persistence & Recovery

Add forward-only enum/table migration with unique booking and movement claims.
Snapshot amount, date, narrative, contact and estimate IDs. Save converted invoice ID
before subsequent reads. Mutations use PENDING -> IN_FLIGHT -> PENDING at the next
stage; definitive rejection can retry, unknown or interrupted writes require review.
Delivery reuses its existing UNKNOWN protections.

No SQL transaction spans HTTP. Final local commit includes notification enqueue. All
booking transitions lock the booking and reject conflicts with an unfinished operation.
Retention excludes operation-linked movements. Historical jobs retain their old handler.

## Validation

Focused Vitest tests, real PostgreSQL integration, synthetic provider transport and
Playwright localized flow. Lint, typecheck, tests, coverage/build/E2E and SpecKit checks
as available. No live fiscal writes or email. Add documentation for failures, recovery,
migration and compatibility; code rollback does not undo schema or fiscal documents.

### Local verification evidence

- Additive migration applied successfully to isolated PostgreSQL databases; Prisma generation,
  lint, typecheck, production build and diff whitespace checks pass.
- Full suite: `RUN_INTEGRATION_TESTS=true pnpm test:coverage --maxWorkers=2`:
  169 files, 2,557 passed tests, one skipped. Coverage: statements 86.55%, branches 79.95%,
  functions 87.25%, lines 88.66%, above the enforced thresholds.
- Production standalone Playwright banking journeys: eight passed, including English/Spanish/Catalan
  selection, deferred confirmation, the complete synthetic Holded HTTP flow and a 320px dialog.
  The critical complete financial journey also passed five consecutive repetitions.
- SpecKit compliance passes for the new feature and for all existing repository features.
- Production dependency audit passes the configured high-severity gate; existing three low and
  two moderate findings remain outside this feature's dependency scope.
- No production database, fiscal provider write, real email or deployment was used.
