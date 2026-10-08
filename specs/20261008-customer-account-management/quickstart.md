# Validation Guide

1. Run the plugin PHP tests with the installed PHP interpreter; invite/update/revoke/reinvite, cross-principal rejection and fiscal-account protection must pass.
2. Apply the additive migration to an isolated development PostgreSQL database and generate Prisma Client.
3. Run focused customer, WordPress transport and Holded snapshot Vitest tests. Use mocked providers, never production invitations.
4. Configure a test WordPress origin and encrypted application password as an administrator. Preview must perform no writes and record outcomes.
5. Enable manual writes only after a successful preview. Reconciliation must preserve unrelated accounts and report orphan review rather than deletion.
6. Exercise delegate controls in English, Spanish and Catalan; changed email must require acceptance and revocation must be immediate.
7. Run pnpm lint, pnpm typecheck and pnpm test, database-backed customer tests, relevant Playwright journeys and the SpecKit compliance hook.
8. Keep automatic synchronization disabled during initial rollout; do not execute the old n8n workflow concurrently. Deploy WordPress endpoint updates before Bereius write mode.

## Verified Results (2026-10-08)

- All six standalone WordPress PHP harnesses pass. The new module passes PHP syntax validation.
- The additive migration applies successfully to both local development and disposable PostgreSQL databases; Prisma validation and generation pass.
- The mandatory quality gate passes with RUN_INTEGRATION_TESTS=true against a disposable PostgreSQL 17 database and DOTENV_CONFIG_PATH=/dev/null. Lint and TypeScript pass; 2,423 tests pass and one is skipped.
- Coverage: 85.96% statements, 79.10% branches, 86.54% functions and 87.76% lines, above all enforced thresholds.
- The production standalone build and all five Clients E2E journeys pass, including native invitation response shape, profile update, resend, confirmation-based revoke, reinvite, all three locales, administrator authorization and 320px layout. Desktop/mobile screenshots were inspected.
- The full E2E run reports 101 passed, one failed and five not run. The failure is an existing account-page button contrast violation in global-footer.spec.ts (3.89:1 versus 4.5:1); the Clients journeys all pass. No unrelated screen was modified to bypass it.
- Final SpecKit compliance passes: bash .specify/scripts/bash/compliance-check.sh after recording completed tasks.

No feature code, credentials or migrations were deployed to production. No live invitation was sent for these checks. Principal writes and daily reconciliation default to disabled; WordPress deployment and live provider contract/locking checks remain activation prerequisites in docs/berea-cat-wordpress.md.