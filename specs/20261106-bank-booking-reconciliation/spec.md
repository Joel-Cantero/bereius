# Feature Specification: Bank Booking Reconciliation

**Created**: 2026-11-06
**Status**: Implemented and verified locally; not deployed

## User Scenarios & Testing

An operator opens an imported EUR income movement and sees awaiting-payment reservations
whose agreed advance plus deposit matches within an inclusive 5%. Reference text improves
ranking but is not required. The operator explicitly chooses one reservation.

The application reserves that movement and booking, converts its verified Holded estimate
to a linked draft invoice, replaces the draft lines with the received advance and deposit,
approves it, records the receipt, reconciles the original bank movement with that receipt,
and sends the invoice to the fiscal customer and active delegates. Only then is the booking
confirmed. Failures never falsely confirm the booking or duplicate external writes.

## Functional Requirements

- FR-001: Use `abs(received - expected) * 100 <= expected * 5`, in integer cents.
- FR-002: Preserve existing currency, date, human-review and dismissed-pair restrictions.
- FR-003: Invoice exactly the received amount: 200 EUR deposit not subject to VAT and the
  remainder as advance, including 10% VAT. Reject receipts of 200 EUR or less.
- FR-004: Preserve the original estimate and its agreed amounts; invoice source must refer
  to that estimate. Do not copy its complete stay lines into an approved advance invoice.
- FR-005: Uniquely claim both movement and booking before calling Holded. Pending, failed
  and ambiguous operations protect both against reuse, expiry and conflicting decisions.
- FR-006: Confirm only after invoice approval, payment, bank reconciliation and accepted
  invoice delivery. Acceptance is not proof of mailbox delivery.
- FR-007: Freeze recipient To/CC through the existing delegate-discovery delivery service.
- FR-008: Persist progress; never automatically repeat an ambiguous external mutation.
- FR-009: Keep historical payments/invoices unchanged. Do not backfill or resend them.
- FR-010: Apply the new pipeline to both strict proposals and wider bank-backed choices.
  Manual payment entry remains exact and does not issue invoices.

## Security & Privacy Implications

Operator/administrator authorization and validated local IDs are mandatory for every action.
Prices, identity, fiscal contact, dates and provider identifiers come from trusted server data.
Logs contain only local identifiers, operation stages and sanitized failure codes.
No live writes or emails are permitted in automated tests.

## Threats & Abuse Cases

Concurrent selections, replay, stale data and cancellation during remote work are prevented
with row locks, unique constraints and guarded transitions. A remote timeout is parked for
evidence-based operator recovery, never interpreted as permission to repeat a payment.

## Non-Goals

No automatic matching confirmation, multi-booking transfers, refunds, historical correction,
new provider credentials, WordPress delegate lifecycle changes or periodic bank imports.

## Operational Impact

Additive migration; existing PostgreSQL outbox and worker, no extra service. Operations and
partial results are visible from movements and reservation detail. Pages remain private,
non-indexable and excluded from sitemaps in English, Spanish and Catalan.

## Acceptance Criteria

Test exact 95%/105% boundaries, one cent outside, absent reference, competing operators,
both selection surfaces, actual-received invoicing, fiscal source/line verification,
every remote interruption, frozen delegates and deferred confirmation with real PostgreSQL
and synthetic HTTP responses; cover the localized browser journey.
