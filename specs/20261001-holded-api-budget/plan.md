# Implementation Plan: Holded API Budget

## Constitution Check

Keep server-only infrastructure and domain services, existing manual-refresh authorization, database transactions and delivery safeguards. This feature supersedes periodic/expiry bank synchronization in the bank-movements specification.

## Design

Persist validated estimate-list cache entries in PostgreSQL, with per-key locking, one-hour freshness, explicit invalidation and bounded cleanup. The worker processes only manually requested bank scans and retries; expiry checks use persisted evidence rather than calling Holded. Add sanitized transport logs and named caller contexts.

**Migration Strategy**: Add a forward-only private cache table. Preserve historic bank triggers and timestamps; new execution paths ignore non-manual queued scans.

**Recovery Strategy**: Roll back code if needed without deleting bank data or audit history. Cache rows can expire normally; a fresh authenticated read bypasses them. Do not modify production during development.

## Verification

Use real PostgreSQL for cross-client/restart cache reuse, credential isolation, invalidation and concurrency. Exercise manual-only banking, expiry deferral, successful manual scan, and existing refresh workflow. Validate transport-log redaction with HTTP fixtures. Run focused tests, lint, typecheck, standard tests and compliance; record unverified gates.