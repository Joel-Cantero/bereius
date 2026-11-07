# Tasks: Google Calendar Booking Sync

**Input**: Design documents from `/specs/20261107-google-calendar-sync/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`

**Tests**: Tests are required for provider mapping, secret handling, payment and booking transactions, retry/idempotency, cancellation, and localized UI.

**Organization**: Tasks are grouped by user story and ordered by dependency.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel in different files without unfinished dependencies.
- **[Story]**: User-story label for story-phase tasks.
- All implementation descriptions name the relevant project paths.

## Phase 1: Setup

**Purpose**: Add the supported Google Calendar client dependency.

- [X] T001 Add the focused official Google Calendar client dependency `@googleapis/calendar` to `package.json` and update `pnpm-lock.yaml`.

## Phase 2: Foundational

**Purpose**: Add durable event identity and schema required by all user stories.

- [X] T002 Add the `GOOGLE_CALENDAR` integration provider, event-sync status, and `GoogleCalendarBookingEvent` relation to `prisma/schema.prisma`.
- [X] T003 Create and validate the forward-only migration for the new provider and event-link model under `prisma/migrations/`; regenerate `src/generated/prisma/`.
- [X] T004 Add synthetic service-account and booking fixtures for Google event records in `tests/integration/google-calendar-bookings.test.ts`.

## Phase 3: User Story 1 - Configure the writable calendar (Priority: P1)

**Goal**: An administrator configures and verifies a distinct writable Google Calendar without exposing credentials or changing the ICS integration.

**Independent Test**: Save and test a service-account credential against a controlled Google API response; verify writer access, safe errors, and encrypted write-only storage.

### Tests for User Story 1

- [X] T005 [P] [US1] Test Google Calendar config validation, encrypted credential preservation, and safe integration status in `tests/integration/booking-settings.test.ts`.
- [X] T006 [P] [US1] Test admin-only save and connection-test action results, including invalid credentials and insufficient calendar access, in `tests/unit/calendar-actions.test.ts`.

### Implementation for User Story 1

- [X] T007 [US1] Add strict Google Calendar config parsing and typed `resolveIntegration` support in `src/modules/booking/services/settings.ts` and `src/modules/calendar/schema.ts`.
- [X] T008 [US1] Implement authorized save and test actions using a bounded Calendar `events.list` call and writer-role check in `src/modules/booking/actions/settings.ts` and `src/modules/calendar/services/google-calendar.ts`.
- [X] T009 [US1] Build the server-only Calendar v3 client from validated service-account JSON with the narrow event scope in `src/modules/calendar/services/google-calendar.ts`.
- [X] T010 [US1] Add a localized Google destination settings form and connect it to the existing booking integration settings page in `src/modules/calendar/components/google-calendar-settings-form.tsx` and `src/app/[locale]/(console)/bookings/settings/page.tsx`.
- [X] T011 [P] [US1] Add Google Calendar configuration, status, test, and safe error copy to `src/messages/en.json`, `src/messages/es.json`, and `src/messages/ca.json`.
- [X] T012 [US1] Document Calendar API enablement, calendar sharing, and credential entry in `README.md` and `docs/google-calendar-bookings.md`.

**Checkpoint**: Administrators can configure and verify the writable destination while the read-only ICS source remains unchanged.

## Phase 4: User Story 2 - Confirm a reservation with a Google event (Priority: P1)

**Goal**: Record payment, keep the booking awaiting payment while the event is pending, and confirm only after the stable all-day Google event has been reconciled.

**Independent Test**: With a controlled provider and PostgreSQL, verify event payload, payment preservation, one state transition, safe retry after failure, and duplicate suppression after an unknown response.

### Tests for User Story 2

- [X] T013 [P] [US2] Test stable Google event ID generation, reservation-to-event mapping, all-day exclusive checkout, event comparison, and provider error mapping in `tests/unit/google-calendar.test.ts`.
- [X] T014 [P] [US2] Test manual payment persistence and retry-action authorization/result states when Google event creation fails in `tests/integration/booking-decisions.test.ts` and `tests/unit/google-calendar-booking-actions.test.ts`.
- [X] T015 [US2] Add real-PostgreSQL tests for payment persistence, outbox retry, duplicate confirmation jobs, event uniqueness, and final confirmation in `tests/integration/google-calendar-bookings.test.ts`.

### Implementation for User Story 2

- [X] T016 [US2] Implement deterministic valid Google event IDs and create/get/reconcile operations with safe provider outcomes in `src/modules/calendar/services/google-calendar.ts`.
- [X] T017 [US2] Implement event-link creation, persisted calendar-ID snapshots, provider payload construction, and confirmation finalization in `src/modules/calendar/services/booking-sync.ts`.
- [X] T018 [US2] Change manual payment handling to persist the payment and enqueue one confirmation job without transitioning to `CONFIRMED` in `src/modules/booking/services/decisions.ts` and `src/modules/calendar/services/booking-sync.ts`.
- [X] T019 [US2] Change the completed bank-payment flow to persist payment and enqueue the same confirmation job while preserving bank and proposal evidence in `src/modules/banking/services/payment-operation.ts`.
- [X] T020 [US2] Register the Google confirmation job with the scheduler, keep provider calls outside database transactions, and finalize booking/audit/proposals/mail only after event success in `src/modules/booking/services/scheduler.ts` and `src/modules/calendar/services/booking-sync.ts`.
- [X] T021 [US2] Prevent expiry from expiring bookings that already have a payment awaiting calendar confirmation in `src/modules/booking/services/expiry.ts`.
- [X] T022 [US2] Add an administrator/operator-authorized action that requeues the same exhausted confirmation job without changing its event identity in `src/modules/calendar/actions/booking-sync.ts`.
- [X] T023 [US2] Show pending and failed calendar synchronization state plus a retry control on the booking detail page in `src/app/[locale]/(console)/bookings/[id]/page.tsx` and `src/modules/calendar/components/booking-calendar-sync-status.tsx`.
- [X] T024 [P] [US2] Add localized pending, failure, retry, and success copy for event synchronization in `src/messages/en.json`, `src/messages/es.json`, and `src/messages/ca.json`.
- [X] T025 [US2] Add browser journeys for Google settings, failed/pending booking sync, and bank payment handoff in `tests/e2e/calendar.spec.ts` and `tests/e2e/bank-movements.spec.ts`.

**Checkpoint**: Manual and bank payments remain durable while Google is unavailable; a reservation confirms once its event is safely reconciled.

## Phase 5: User Story 3 - Remove the event when cancelling a reservation (Priority: P2)

**Goal**: Delete the stored Google event before accepting cancellation; leave the booking confirmed when deletion cannot be verified.

**Independent Test**: With PostgreSQL and a controlled Calendar client, verify successful deletion precedes cancellation and provider failure preserves booking/event state for retry.

### Tests for User Story 3

- [X] T026 [P] [US3] Test provider deletion success, already-deleted handling, inaccessible destination, and safe error mapping in `tests/unit/google-calendar.test.ts`.
- [X] T027 [US3] Add real-PostgreSQL tests for cancellation transaction ordering, retry after deletion success/local failure, and unchanged state after provider failure in `tests/integration/google-calendar-bookings.test.ts`.

### Implementation for User Story 3

- [X] T028 [US3] Delete by the stored calendar ID/event ID before transitioning to `CANCELLED`; persist `DELETED` only after verified provider success in `src/modules/calendar/services/booking-sync.ts` and `src/modules/booking/services/decisions.ts`.
- [X] T029 [US3] Map safe calendar cancellation failures through the booking decision action without exposing provider response details in `src/modules/booking/actions/decisions.ts` and `src/messages/en.json`, `src/messages/es.json`, `src/messages/ca.json`.
- [X] T030 [US3] Verify cancellation ordering and failure recovery with the authorized booking action and real-PostgreSQL provider-boundary tests in `tests/unit/booking-decision-actions.test.ts` and `tests/integration/google-calendar-bookings.test.ts`; live Google E2E is deferred until service-account access is available.

**Checkpoint**: A confirmed booking cannot be cancelled locally while its managed Google event may still be active.

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validate recovery, deployment, documentation, and all relevant quality gates.

- [X] T031 [P] Update `docs/bank-payment-reconciliation.md` with the distinct calendar-finalization stage and evidence-based recovery rules.
- [X] T032 Verify migration ordering, compatibility, and backup/recovery steps in `specs/20261107-google-calendar-sync/quickstart.md` and `docs/google-calendar-bookings.md`.
- [X] T033 Run focused provider, settings, payment, expiry, cancellation, and outbox tests; then run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm test:e2e`.
- [X] T034 Run the repository SpecKit compliance check and confirm all accepted requirements map to tested implementation tasks in `specs/20261107-google-calendar-sync/`.

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Adds the provider client dependency.
- **Foundational (Phase 2)**: Depends on Setup; schema and migration block user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational; enables secure destination configuration.
- **User Story 2 (Phase 4)**: Depends on User Story 1 and Foundational; uses configured credentials and event identity.
- **User Story 3 (Phase 5)**: Depends on User Story 2; deletes events created by its confirmation flow.
- **Polish (Phase 6)**: Depends on all accepted stories.

### User Story Dependencies

- **US1 (P1)**: Independent after foundational schema; can be validated before payment-flow changes.
- **US2 (P1)**: Requires US1 configuration and creates the event link/job state used by later cancellation.
- **US3 (P2)**: Requires the persisted event identity produced by US2.

### Parallel Opportunities

- T005 and T006 can be developed in parallel after the configuration contract is fixed.
- T011 is independent of backend settings implementation once the copy is agreed.
- T013 and T014 can be written in parallel; T015 validates the shared database boundary.
- T026 can be written in parallel with T027 after the deletion contract is fixed.

## Implementation Strategy

### MVP First

1. Complete dependency and schema migration.
2. Complete US1 so the destination can be safely configured and verified.
3. Complete US2 so both payment paths preserve payment, retry event synchronization, and confirm only after event success.
4. Validate US2 with controlled provider tests and PostgreSQL before proceeding.
5. Complete US3 cancellation and its failure recovery.

### Incremental Delivery

Do not enable the new confirmation gate until configuration, durable event identity, retry UI, and both manual/bank payment paths are deployed together. Existing ICS read-only behavior must remain available throughout.