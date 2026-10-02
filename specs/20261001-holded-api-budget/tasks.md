# Tasks: Holded API Budget

- [x] T001 Disable automatic bank enqueue and expiry-triggered provider calls; test manual-only execution and safe expiry.
- [x] T002 Add persistent estimate-list cache with isolation, concurrency, invalidation and retention tests.
- [x] T003 Add safe outgoing-request tracing with caller attribution and redaction tests.
- [x] T004 Investigate contact-group callers read-only and document confirmed evidence and gaps.
- [x] T005 Validate gates and document rollout and behavior changes.

## Completion Evidence (2026-10-02)

T001: initial account configuration creates no run; automatic enqueue and direct legacy claims
are blocked; the worker only processes manual requests and their retries. Expiry never fetches
Holded and evaluates a successful manual scan against its original start boundary. PostgreSQL
regressions cover legacy triggers, retries, incomplete evidence, changed booking states, pending
proposals and later deadlines. The focused banking integration suites pass all 53 tests.

T005: focused UI/worker tests pass all 69 tests; lint and typecheck pass. Standard tests pass
1,976 tests (366 integration tests skipped in that mode). The full PostgreSQL coverage run passes
configured thresholds, and production build plus Playwright pass all 98 E2E tests. Production
dependency audit passes its high-severity gate with two moderate findings. Rollout, rollback and
the changed manual-only behavior are documented in the plan and README.

T003: both Holded HTTP paths emit one structured `holded_request` event per outgoing attempt,
including document delivery. Endpoints and callers use fixed allowlists; identifiers, query values,
credentials, bodies, recipients, subjects, redirect destinations and raw exceptions are excluded.
All Bereius consumers have named caller contexts, while unexpected callers/routes use `unknown`.
Fourteen new HTTP-boundary regressions cover redaction, reads/writes, sends, status failures,
network/timeout failures, oversized responses, pagination and cache hits. Lint, typecheck and
1,990 standard tests pass; the full PostgreSQL coverage run passes 2,355 tests with one skip and
enforced thresholds. Production build and all 98 E2E tests pass.

T002 and T004 were marked complete at the user's request; their implementation and investigation
have not been verified. These checkbox changes are not technical completion evidence.

The global SpecKit checklist is now complete. This does not verify the implementation of T002
or the investigation in T004. T005 closes execution
and documentation of validation, not completion or merge approval of the entire feature. No
production changes, commit or push were performed.