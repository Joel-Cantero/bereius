# Feature Specification: Quote Recovery and Operation Logs

**Feature Branch**: `20261001-quote-recovery`
**Created**: 2026-10-01
**Status**: Implemented; release coverage gate pending
**Input**: Operators need an explicit "Enviar de nou el pressupost" action and visible records of creation, delivery, and failures.

## User Scenarios & Testing

### User Story 1 - Recover or Resend a Quote (Priority: P1)

An authenticated operator requests another delivery from the booking detail.

**Independent Test**: Recover a dead quoting job against a real PostgreSQL fixture, then resend a linked estimate using a fake Holded provider; verify there is only one estimate and one delivery per explicit request.

**Acceptance Scenarios**:

1. Given an awaiting-payment booking without an estimate, requesting recovery reactivates its dead job and creates, approves, and sends the estimate.
2. Given a completed quote, requesting resend verifies and reuses the linked Holded estimate without changing its lines, amounts, booking state, or payment deadline.
3. Given a partially generated estimate, recovery finishes generation before sending it.
4. Concurrent requests, active jobs, and requests within 60 seconds cannot queue overlapping sends.
5. Unknown or in-flight delivery outcomes block resend; automatic job retries never clear them or resend accepted mail.
6. A missing or mismatched remote estimate is an error, not permission to create a duplicate.

### User Story 2 - Inspect Document Operations (Priority: P1)

Staff inspect chronological logs alongside the existing lifecycle history.

**Independent Test**: Verify that successful generation and delivery, provider failure, and unknown outcomes produce persisted, localized records without provider response bodies, credentials, or recipient addresses.

## Functional Requirements

- **FR-001**: Authenticate and authorize every resend action, validate the booking identifier, and derive its actor from the server session.
- **FR-002**: Queue external work through the existing outbox, transactionally preventing overlapping manual requests.
- **FR-003**: Permit creation only for awaiting-payment bookings; permit reuse for awaiting-payment, confirmed, and completed bookings.
- **FR-004**: Preserve frozen delivery recipients and normal retry idempotency. Explicit resend resets only a definitive delivery outcome.
- **FR-005**: Persist requests, estimate creation/reuse/approval, delivery attempts, accepted outcomes, and safe failure categories, including automatic processing.
- **FR-006**: Expose pending, queued, and error states and operation logs in English, Spanish, and Catalan.
- **FR-007**: Keep lifecycle audit events unchanged and add storage with a forward-only migration and booking-retention cascade.

## Success Criteria

- **SC-001**: A previously dead creation job can complete without a database edit by the operator.
- **SC-002**: Resending a completed quote creates no estimate, invoice, price update, or deadline change.
- **SC-003**: Concurrent and unknown-outcome scenarios never send duplicate email.
- **SC-004**: Staff distinguish provider acceptance from unknown delivery; no log claims inbox receipt.

## Non-Goals

No production resend during development, bulk mailing, repricing completed estimates, changing booking decisions, or resolving ambiguous provider outcomes automatically. Historical application logs are not backfilled into the new operation history.

## Security & Privacy Implications

Only existing authorized booking actors can queue work or view logs. Actor identity comes from the session. Store finite event types and allowlisted error codes rather than addresses, credentials, or provider response bodies. Operation records cascade with booking retention, and actor deletion removes the actor reference.

## Threats & Abuse Cases

Direct action calls cannot bypass authorization or forge an actor. A PostgreSQL booking-row lock, conditional inactive-job reset, and 60-second cooldown prevent overlapping or rapid sends. Unknown/in-flight delivery outcomes remain parked. Remote identity is verified before resending a completed quote; a missing or mismatched estimate never creates a replacement automatically.