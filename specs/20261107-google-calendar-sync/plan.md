# Implementation Plan: Google Calendar Booking Sync

**Branch**: `20261107-google-calendar-sync` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20261107-google-calendar-sync/spec.md`

**Note**: This template is filled in by the `/speckit-plan` skill; its definition describes the execution workflow.

## Summary

Add a separately configured, writable Google Calendar using a service account while preserving the existing read-only ICS source. Persist a stable reservation-to-event identity and enqueue confirmation synchronization through the existing PostgreSQL outbox. Payments remain recorded while the booking stays `AWAITING_PAYMENT`; only a successful, reconciled Google event creation allows the booking to transition to `CONFIRMED`. Cancellation deletes the linked event before changing booking state. Google credentials use the existing encrypted integration envelope.

## Technical Context

<!--
  These defaults reflect the project's standard stack (see the constitution at
  .specify/memory/constitution.md). Keep them unless the feature has a justified
  reason to differ; complete feature-specific values during planning.
-->

**Language/Version**: TypeScript 6.0.x on Node.js 24 LTS

**Package Manager**: pnpm

**Primary Dependencies**: Next.js 16, React 19, Prisma 7, Zod 4, Pino, and the official `@googleapis/calendar` client

**Storage**: PostgreSQL (via Prisma)

**Testing**: Vitest unit tests, real-PostgreSQL integration tests, and Playwright coverage for the localized admin and booking workflows. Automated tests use controlled Google API responses and never live credentials.

**Target Platform**: Docker (Linux containers) on Raspberry Pi (ARM64), portable to VPS; ingress via Cloudflare Tunnel -> Traefik

**Project Type**: Web application - single Next.js full-stack `app` container (+ `db`, optional `worker`)

**Deployment**: Docker Compose; networks `traefik_network` (external ingress) + `internal` (private); services use `restart: unless-stopped`

**CI/CD**: GitHub Actions on a self-hosted runner

**Secrets**: dev uses a local `.env`; prod uses **no** `.env` file - non-sensitive config in GitHub **Variables**, secrets in GitHub **Secrets**, injected into the containers at deploy time. Never committed.

**Observability**: Healthcheck endpoint + structured logging (Pino -> stdout JSON) + Docker logs + log rotation

**Migration Strategy**: Additive provider enum and Google-event link migration; apply before the application image. Existing bookings and ICS links are not rewritten.

**Recovery Strategy**: Pending payments and event jobs remain durable. Restore Google access and explicitly requeue the same dead job; never create a second event identity. No destructive migration or data rewrite is planned.

**Performance Goals**: No long-running database transaction spans Google requests; calls use bounded client timeouts and existing outbox backoff.

**Constraints**: Enable Google Calendar API and share the target calendar with the service account as writer. Use the `calendar.events` scope. Events are all-day and checkout is exclusive. Never expose credentials or raw provider errors.

**Scale/Scope**: One destination calendar; one event identity per reservation; English, Spanish, and Catalan UI. No historical backfill or editing of confirmed reservations.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Secrets and security**: Pass. Store service-account JSON in the existing encrypted integration secret; keep only calendar ID in non-secret config. Settings are admin-only and booking actors are derived server-side.
- **Data and migration**: Pass. Additive provider enum and event-link tables only. Existing ICS data and issued Holded documents are unchanged.
- **Transactions and external side effects**: Pass with a strict boundary. Google calls never run inside PostgreSQL transactions; persist intent first, perform the provider call, then conditionally finalize state.
- **Retries and recovery**: Pass. Reuse the database-backed integration job and stable Google event ID. Dead jobs remain visible and can be requeued explicitly; unresolved outcomes require operator review.
- **Testing**: Pass. Provider mapping tests, real PostgreSQL lifecycle/idempotency tests, and localized browser coverage are required.
- **Indexing**: Pass. Only existing authenticated, non-indexable settings and booking detail pages change; no public route is added.
- **Portability and operations**: Pass. No new container or environment variable; configuration and event identity live in backed-up PostgreSQL.

## Project Structure

### Documentation (this feature)

```text
specs/20261107-google-calendar-sync/
|-- plan.md              # This file (/speckit-plan command output)
|-- research.md          # Phase 0 output (/speckit-plan command)
|-- data-model.md        # Phase 1 output (/speckit-plan command)
|-- quickstart.md        # Phase 1 output (/speckit-plan command)
|-- contracts/           # Phase 1 output (/speckit-plan command)
`-- tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  This is the project's standard layout (Next.js App Router + Prisma + Docker),
  per the constitution. Adjust only the paths a feature actually adds or changes.
  Do NOT split frontend/backend - Next.js combines them in the `app` container
  (constitution Principle II). Organize business code by domain under
  src/modules/<domain>/; shared code stays in app/, components/, lib/, and server/.
-->

```text
src/modules/calendar/
|-- actions/                 # Admin settings and authorized retry actions
|-- components/              # Existing ICS UI plus Google settings/sync status
`-- services/
  |-- google-calendar.ts   # Provider adapter and event mapping
  `-- booking-sync.ts      # Durable booking confirmation/cancellation workflow

src/modules/booking/
|-- services/                # Payment and confirmation integration points
`-- components/              # Booking detail sync status/retry UI

prisma/schema.prisma         # Provider enum and Google event-link model
prisma/migrations/           # Forward-only migration
tests/unit/                  # Provider mapping, actions, settings, retry behavior
tests/integration/           # PostgreSQL locking, payments, outbox, uniqueness
tests/e2e/                   # Admin configuration and booking workflows
```

**Structure Decision**: Extend the existing calendar domain and booking/outbox workflows. No new service, worker, public API route, or container is needed. The current single Next.js app and in-process scheduler remain responsible for settings, event synchronization, and retries.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | No constitution violations | N/A |