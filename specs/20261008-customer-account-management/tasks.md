# Tasks: Customer Account Management

**Input**: spec.md, plan.md, research.md, data-model.md and contracts/wordpress.md.
**Task Review**: Approved scope and dependency order; automated verification required for both stories.

## Phase 1: Setup

- [x] T001 Define ownership, security, rollout and recovery in specs/20261008-customer-account-management/.

## Phase 2: Foundation

- [x] T002 Add bounded admin WordPress contracts and lifecycle tests in berea.cat/funciones-personalizadas/includes/account-delegations.php and tests/account-access-test.php.
- [x] T003 Add protected principal list/upsert API and ownership tests in berea.cat/funciones-personalizadas/includes/account-customer-sync.php and tests/account-access-test.php.
- [x] T004 Add encrypted WORDPRESS settings and additive run/audit migration in prisma/schema.prisma and src/modules/customers/schema.ts.
- [x] T005 Add trusted-origin WordPress HTTP client and complete Holded fiscal snapshot in src/modules/customers/wordpress.ts and src/lib/holded/client.ts with tests/unit/customer-wordpress.test.ts.

## Phase 3: US1 - Principal Reconciliation

Independent test: Preview has zero writes; apply protects unrelated users, detects conflicts and reports orphans without deletion.

- [x] T006 [US1] Implement deterministic reconciliation and focused tests in src/modules/customers/reconciliation.ts and tests/unit/customer-reconciliation.test.ts.
- [x] T007 [US1] Implement fenced run history, preview approval and scheduler integration in src/modules/customers/services/management.ts and tests/integration/customer-sync.test.ts.

## Phase 4: US2 - Administrative Delegation

Independent test: Admin-only UI calls authoritative lifecycle endpoints and shows current state; email changes require acceptance.

- [x] T008 [US2] Implement authorized settings/run/delegate actions and safe audit events in src/modules/customers/actions/management.ts and tests/unit/customer-actions.test.ts.
- [x] T009 [US2] Add localized Clients screen, navigation and forms in src/app/[locale]/(console)/customers/page.tsx, src/modules/customers/components/ and src/messages/ with component/E2E tests.

## Phase 5: Validation and Rollout

- [x] T010 Update docs/berea-cat-wordpress.md and the superseded delegation contract; document preview-first rollout and validate PHP, migrations, lint, typecheck, unit/integration and relevant E2E checks.
- [x] T011 Execute mandatory SpecKit compliance and quality-gate hooks and record verified outcomes in quickstart.md.

## Dependencies

T001 -> T002/T003 -> T004/T005 -> T006 -> T007 -> T008 -> T009 -> T010 -> T011.

## Parallel Opportunities

Transport fixture review and WordPress API tests can be reviewed independently after the contract is defined. No concurrent edits to shared files.

## Implementation Strategy

Deliver authoritative API first, then deterministic preview and protected writes, then delegate controls. Keep automatic writes disabled. Do not deploy to production as part of implementation.