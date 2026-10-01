# Implementation Plan: Quote Recovery and Operation Logs

## Technical Context

Use the existing Next.js Server Action, booking authorization, Prisma/PostgreSQL, outbox, Holded client, document-delivery service, and localized booking detail. No new infrastructure or dependencies.

## Constitution Check

Preserve server-only domain boundaries and session provenance. Validate input with Zod. Use row locking and conditional job updates rather than process-local locks. Keep ambiguous deliveries parked and frozen recipients unchanged. Log fixed categories only, with no raw provider errors. Add a forward-only migration and reuse nearby test suites. No production mutation is part of development validation.

## Design

- Add a booking-owned operation-event relation with optional server-derived actor and finite event types.
- Serialize explicit requests on the booking row; conditionally reset only inactive quoting jobs and enforce a 60-second cooldown.
- Reuse the same idempotency key so automatic and explicit work cannot overlap.
- Resume incomplete generation, or verify and reuse completed estimates without repricing.
- Make delivery outcome records atomic with the corresponding local delivery state.
- Show a localized resend control in Documents and a separate chronological Logs section.

**Migration Strategy**: Deploy the additive operation-event enum/table/index/foreign keys before the new application, through the existing migration job. Existing document and booking records remain unchanged. Verify migration deployment against isolated PostgreSQL fixtures.

**Recovery Strategy**: Preserve the new table if rolling application code back. Use a corrective forward migration for schema corrections. Do not retry ambiguous deliveries or delete provider documents; inspect and reconcile them separately. No live host restart or production migration is authorized by local validation.

## Verification

Run real PostgreSQL integration tests for recovery, concurrency, partial failures, accepted resends, and unknown outcomes. Run authorization and localized component tests, then lint, typecheck, complete Vitest, SpecKit compliance, and browser checks for the changed booking workflow.