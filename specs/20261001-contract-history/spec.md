# Feature Specification: Full Contract and Unified History

**Feature Branch**: `20261001-contract-history`
**Created**: 2026-10-01
**Status**: Implemented

## User Scenarios & Testing

Operators send the full stay contract without subtracting the deposit or advance. They inspect one reverse-chronological booking history containing lifecycle and document traces. One delivery attempt has one visible result, with a green check for provider acceptance or a red cross and accessible error tooltip for failure.

## Functional Requirements

- FR-001: New contracts contain the full stay line only. Deposit and advance remain payment conditions in the notes and booking amounts; invoice behavior is unchanged.
- FR-002: Explicit resends remove only recognized negative deposit/advance lines from existing contracts before sending. Preserve unrelated lines, prices, tax mode, identity, recipients, and normal delivery idempotency.
- FR-003: Merge operation and lifecycle records into History, newest first, with deterministic ordering.
- FR-004: Fold delivery-start and result traces into one visible attempt while preserving persisted audit data and individual retries.
- FR-005: Show accepted, failed, unknown, and pending outcomes accessibly. Provide localized safe error explanations on hover and keyboard focus in English, Spanish, and Catalan.

This supersedes the quote-recovery feature's promise not to change completed estimate lines only for recognized negative deposit/advance deductions. All other commercial data remains unchanged. Existing append-only delivery traces are paired chronologically for display; their original records remain available, and each persisted outcome remains visible.

## Success Criteria

Tests prove there are no deposit/advance deductions in new or explicitly resent contracts, payment amounts remain unchanged, and history ordering, attempt folding, icons, and tooltips work on desktop/mobile in all locales.

## Non-Goals

No automatic correction or resend of production documents, changes to invoice issuance, booking decisions, pricing rules, historical audit deletion, or raw provider errors in the UI.

## Security & Privacy Implications

Preserve authorization and server-only services. Display only allowlisted failure categories and existing authorized booking data. Never include credentials or provider response bodies in tooltips.

## Threats & Abuse Cases

Keep unknown deliveries blocked. Fail safely on unreadable remote documents rather than deleting arbitrary lines. Preserve concurrent-request guards and frozen recipients. Presentation grouping must not conceal a pending or failed retry behind an older accepted attempt.