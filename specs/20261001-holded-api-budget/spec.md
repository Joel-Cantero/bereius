# Feature Specification: Holded API Budget

**Feature Branch**: `20261001-holded-api-budget`
**Created**: 2026-10-01
**Status**: Implementing

## Requirements

- Cache estimate lists persistently for one hour, scoped by credential and query, surviving process restarts. Invalidate after estimate mutations and support explicitly fresh reads.
- Import bank movements only after an authorized manual refresh, including pagination and bounded retries of that requested run. Do not enqueue periodic, initial, or expiry-driven scans.
- Preserve expiry safety: without sufficiently fresh, complete bank evidence, defer cancellation. Evaluate eligible expirations after a successful manually requested scan.
- Log every outgoing Bereius Holded request with sanitized endpoint, method, caller, and outcome, never credentials, query values, personal data, or raw provider bodies.
- Investigate contact-group calls read-only; explicitly distinguish verified callers from unknown external token consumers.

## Non-Goals

No production reconfiguration or deployment without authorization, no unverified attribution to n8n/WordPress, and no changes to payment matching or document delivery safety.

## Security & Privacy Implications

Cached estimate data remains private, validated and scoped to its credential, with bounded retention. No raw credentials are stored in cache keys. Logging uses route templates and caller identifiers only.

## Threats & Abuse Cases

Prevent cross-credential cache disclosure, concurrent cache-fill storms, stale estimates after writes, and automatic cancellation based on outdated bank data. Retain manual synchronization authorization, rate limits, and idempotency.