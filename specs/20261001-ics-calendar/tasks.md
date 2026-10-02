# Tasks

- [x] Add bounded ICS parsing and focused tests.
- [x] Add encrypted integration configuration, safe retrieval and administrator actions.
- [x] Add localized calendar page, sidebar section and integration form.
- [x] Verify tests, static checks, live source and local preview.
- [x] Render grouped multi-day weekly bands, center the view and verify desktop/mobile geometry under production CSP.
- [x] Preserve stable ICS identities and add source-scoped booking links with audit history.
- [x] Add confirmed-booking link/unlink actions, localized selection and calendar navigation.
- [x] Verify linking, conflicts, review states and authorization with unit, PostgreSQL and browser tests.

Booking-link verification: stable UID and moved recurrence identities; grouped bands preserve all
booking links. Real PostgreSQL tests cover concurrent ownership conflicts, transaction rechecks,
audited unlinking, stale selections, feed replacement, missing/changed events and failed reads.
Authenticated actions derive the actor server-side and require an explicit confirmation. Full
coverage with RUN_INTEGRATION_TESTS=true passes repository thresholds (85.81% statements,
79.01% branches, 86.45% functions, 87.58% lines). Production build and 102 E2E tests pass,
including paid-booking link/navigation/unlink journeys on desktop and 320px mobile. Lint and
typecheck pass. No payment/lifecycle changes, feed writes, production deployment or new commit.

## Verification Results

Lint and typecheck passed. The standard suite passed 1,975 tests; 362 database-dependent tests were skipped by default. The focused PostgreSQL settings suite passed 10 tests, including encrypted ICS URL storage and replacement. Five Playwright calendar tests passed across English, Spanish, Catalan and a 320-pixel viewport. The supplied live source was downloaded, saved, verified and rendered in a temporary administrator session at desktop and mobile sizes; the original local integration settings were restored afterward. The local development server is available on port 3000. No production configuration or deployment was changed.

## Multi-Day Follow-Up (2026-10-02)

Lint and typecheck pass. All 30 focused calendar tests pass, covering contiguous descriptions,
separate stays, timed/unnamed entries, overlaps and exclusive week/month boundaries. The standard
suite passes 1,994 tests with 366 integration tests skipped in that mode. Production build and all
100 E2E tests pass, including measured three-day width, centered maximum width, separate overlap
rows and a grouped mobile agenda. Desktop (2560px), tablet (900px) and mobile (320px) screenshots
were inspected. The current local preview is `http://localhost:60787/es/calendar`; production was
not modified or deployed.