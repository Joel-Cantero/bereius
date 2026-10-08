# Implementation Plan: Customer Account Management

**Branch**: `20261008-customer-account-management` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/20261008-customer-account-management/spec.md`

**Note**: This template is filled in by the `/speckit-plan` skill; its definition describes the execution workflow.

## Summary

Add a customer domain using the existing encrypted integration settings, admin authorization and scheduler. WordPress exposes bounded principal reconciliation and administrative delegation endpoints and remains the delegate authority. Bereius reads complete Holded fiscal snapshots, previews differences and executes explicitly enabled writes. Reconciliation uses database leases and records safe run history. A localized admin-only Clients page hosts connection settings, search, run history and delegate controls.

## Technical Context

**Language/Version**: TypeScript 6.0.x on Node.js 24 LTS

**Package Manager**: pnpm

**Primary Dependencies**: Next.js 16, React 19, Tailwind CSS 4, Prisma 7, Zod 4, NextAuth 4, Pino, native Node HTTPS for WordPress

**Storage**: PostgreSQL (via Prisma)

**Testing**: Vitest + jsdom + Testing Library (unit/component); Playwright for production-artifact smoke tests and feature-specific E2E. Authentication features MUST test the selected real provider boundary; tests must not substitute an unverified transport contract.

**Target Platform**: Docker (Linux containers) on Raspberry Pi (ARM64), portable to VPS; ingress via Cloudflare Tunnel -> Traefik

**Project Type**: Web application - single Next.js full-stack `app` container (+ `db`, optional `worker`)

**Deployment**: Docker Compose; networks `traefik_network` (external ingress) + `internal` (private); services use `restart: unless-stopped`

**CI/CD**: GitHub Actions on a self-hosted runner

**Secrets**: dev uses a local `.env`; prod uses **no** `.env` file - non-sensitive config in GitHub **Variables**, secrets in GitHub **Secrets**, injected into the containers at deploy time. Never committed.

**Observability**: Healthcheck endpoint + structured logging (Pino -> stdout JSON) + Docker logs + log rotation

**Migration Strategy**: Add WORDPRESS integration enum value and customer run/audit persistence through a new additive migration. Deploy compatible WordPress endpoints before enabling writes. Preserve existing integration rows and booking behavior.

**Recovery Strategy**: Disable automatic reconciliation and write mode, retain history, reconcile ambiguous results against WordPress before retry. Restore database backup only for destructive operator recovery; do not reverse migrations or delete accounts to compensate.

**Performance Goals**: Bound each remote request to 15 seconds and 2 MiB; cap contact snapshots at 20 pages and reconciliation batches at 100 accounts. Use sequential writes and a fenced lease with renewal.

**Constraints**: No personal data in logs, no credential exposure, HTTPS origin validation, connection-time public DNS enforcement, no redirects and no automatic retries of mail-affecting mutations.

**Scale/Scope**: Existing customer base; 2,000-contact bounded snapshots; one localized administrative section and no persisted delegate directory.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- PASS: Spec precedes code and explicitly supersedes the previous WordPress integration prohibition.
- PASS: Existing domain service direction, Next.js application deployment and database are retained.
- PASS: Credentials encrypted with BOOKING_SECRET_KEY; all remote work is server-only.
- PASS: Additive migration and disable-first recovery; no automatic deletion.
- PASS: Unit, real PostgreSQL lease/invariant, component and E2E verification planned.
- PASS: Clients is administrative and non-indexable with no sitemap inclusion.

## Project Structure

### Documentation (this feature)

```text
specs/20261008-customer-account-management/
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
src/
|-- app/                    # Next.js App Router: UI, layouts, pages
|   |-- api/                # Route handlers (REST/webhooks/health)
|   `-- globals.css         # Tailwind/global styles
|-- components/             # Shared React components (UI primitives)
|-- modules/                # Customer domain: customers/{schema,actions,components,services}
|-- server/                 # Server-only logic (never imported by client)
|   |-- actions/            # Server Actions
|   `-- services/           # Domain/business logic
|-- lib/                    # Shared utilities
|   |-- auth.ts             # Auth.js (NextAuth) config
|   |-- db.ts               # Prisma client singleton (imports @/generated/prisma/client)
|   `-- validation/         # Zod schemas
`-- generated/
    `-- prisma/             # Generated Prisma client (gitignored; run `prisma generate`)

prisma/
|-- schema.prisma          # Data model
`-- migrations/            # Versioned migrations
prisma.config.ts            # Prisma 7 config: the datasource URL lives here (required)

worker/                     # OPTIONAL: background/scheduled jobs (built as another Dockerfile target)
`-- src/

tests/
|-- unit/                  # Vitest unit tests
|-- integration/           # API/route + DB integration tests
`-- e2e/                   # Playwright (optional)

docker/
`-- Dockerfile             # Multi-stage: builds the `app` and `migrate` (migrator) images

docker-compose.yml          # Dev: db only (run the app on the host with `pnpm dev`)
docker-compose.prod.yml     # Prod: app + migrate + db (no public db ports; log rotation)
.env.example                # Placeholder env vars (dev `.env`; also the prod Variables/Secrets reference)
```

**Structure Decision**: Production runs a single Next.js full-stack `app` container (UI + SSR + API
routes + Server Actions + auth), a one-shot `migrate` service that applies Prisma migrations before
`app` starts, and a `db` (PostgreSQL) service - wired through Docker Compose on `traefik_network`
(ingress) + `internal` (private) networks (`worker` optional). In development, `docker-compose.yml`
runs only the `db`; the app runs on the host via `pnpm dev`. Frontend and backend are intentionally
NOT split (constitution Principle II). Business behavior is organized in cohesive domain modules
under `src/modules/<domain>/`; cross-cutting infrastructure remains in `app`/`components`/`server`/
`lib` and is not duplicated into modules.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | Existing infrastructure reused | No additional service introduced |