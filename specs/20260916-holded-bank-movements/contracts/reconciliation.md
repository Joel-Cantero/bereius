# Contract: Holded Movement Reconciliation

## Ownership Boundary

The banking domain owns movement eligibility, proposals, and proposal decisions. The booking domain
owns payment records, legal booking state transitions, audit events, and confirmation mail.
The [bank booking reconciliation amendment](../../20261106-bank-booking-reconciliation/spec.md)
supersedes immediate local confirmation: human selections now enqueue linked Holded invoice,
payment, collection reconciliation and invoice-delivery writes. Synchronization remains read-only.

## Proposal Generation

After each movement page commits, the banking service evaluates inserted or materially updated
movements against current awaiting-payment bookings.

A `(movement, booking)` pair is eligible only when all conditions are true:

1. movement direction is `INCOME`;
2. signed movement amount is positive and valid;
3. movement currency is `EUR`, matching the current booking pricing currency;
4. booking state is `AWAITING_PAYMENT`;
5. booking has a Holded estimate with a non-empty `documentNumber`;
6. the one stored movement narrative contains that `documentNumber` literally; and
7. movement minor units exactly equal `(advanceCents ?? 0) + (depositCents ?? 0)`, and that expected
   sum is greater than zero.

No case conversion, fuzzy matching, punctuation stripping, keyword classification, amount tolerance,
currency conversion, transfer combination, partial-payment aggregation, or other heuristic is added.

An expense can never pass condition 1, even when its absolute amount/reference match. An invalid or
zero movement has no persisted row and therefore cannot be evaluated.

Repeated scans upsert the same proposal through unique `(movementId, bookingRequestId)`. A previously
dismissed pair stays dismissed. If an unconfirmed movement or booking changes and any condition no
longer holds, its pending proposal becomes `INVALIDATED`; it is never confirmed automatically.

## Proposal Projection

Authorized operators may see:

```text
ReconciliationProposalSummary
|-- id: local proposal ID
|-- status: pending | confirmed | dismissed | invalidated
|-- movementId: local movement ID
|-- bookingRequestId: local booking ID
|-- estimateNumber: existing Holded document number
|-- amountMinor: positive decimal string
|-- currency: EUR
|-- movementDate: YYYY-MM-DD
|-- narrative: bank-provided concept/reference
|-- createdAt: datetime
|-- decidedAt: datetime | null
`-- decidedByDisplay: authorized existing operator projection | null
```

No customer identity, tax identifier, bank account number, raw provider field, or cursor is added to
this projection. Existing booking links provide authorized context when needed.

## Confirm Action

```text
confirmReconciliationProposalAction(previousState, formData)
```

### Input

```text
proposalId: non-empty local cuid
```

Actor identity and role are derived from the trusted session/database. The browser cannot submit
amount, currency, reference, movement ID, booking ID, state, or expected total.

### Result

```text
{ status: "processing", bookingRequestId: string }
{ status: "error", reason:
    "unauthenticated" |
    "forbidden" |
    "invalid" |
    "not_found" |
    "state_changed" |
    "proposal_changed" |
    "movement_ineligible" |
    "amount_mismatch" |
    "movement_already_used" |
    "unknown" }
```

Unknown/unauthorized proposal IDs return the same safe not-found result where disclosure would
otherwise enable enumeration.

### Atomic selection and deferred completion

The selection transaction reloads and locks the booking/movement, checks eligibility, uniquely
creates BankPaymentOperation with frozen receipt/source data and enqueues the same operation.
It creates no Payment, confirmation audit or confirmation mail.

After linked invoicing, receipt registration, verified bank reconciliation and accepted invoice
submission, one final database transaction MUST:

1. lock the booking and reload its operation and source/receipt snapshot;
2. require the verified SENT stage and accepted local invoice-delivery evidence;
3. guard against a completed operation or conflicting booking state;
4. create exactly one existing `Payment` with:
   - `bookingRequestId` from the proposal;
   - positive exact `amountCents` after proving it fits the booking's existing integer range;
   - movement bank date as `receivedAt` using the project's canonical UTC representation;
   - the one movement narrative as nullable `reference`;
   - trusted operator as `recordedById`; and
   - unique `bankMovementId`;
5. mark the selected proposal `CONFIRMED` with actor/time;
6. invalidate other pending proposals for the same movement and booking; and
7. call the existing booking transition with the same transaction, expected state
   `AWAITING_PAYMENT`, destination `CONFIRMED`, and trusted actor, creating the standard audit event.

Enqueue the existing booking-confirmation email within that same transaction. A failure creates
neither a payment nor a decision nor a booking state/audit change. Ambiguous external writes are
parked, not replayed. The [recovery runbook](../../../docs/bank-payment-reconciliation.md) applies.

Opening a movement also offers manually selectable bookings within an inclusive 5% of their expected
total; no narrative reference is required. Strict scan-generated proposals remain exact-reference
and exact-amount matches. All bank-backed entry points share the same deferred workflow.

## Dismiss Action

```text
dismissReconciliationProposalAction(previousState, formData)
```

Input is only `proposalId`. An authorized operator can conditionally move `PENDING` to `DISMISSED`,
recording actor/time in one update. It creates no payment, booking transition, Holded call, or new
matching rule. A stale/non-pending proposal returns `proposal_changed`.

## Provider Corrections

| Existing relation | Corrected movement outcome |
|---|---|
| No proposal | Re-evaluate and create a candidate only if all current rules pass. |
| Pending proposal still eligible | Keep pending and update movement display data. |
| Pending proposal no longer eligible | Mark `INVALIDATED`. |
| Dismissed proposal | Preserve the human decision for the same pair. |
| Confirmed proposal/payment | Update movement, preserve payment/booking decision, record `CONFIRMED_MATCH_CHANGED` incident for review. |

There is no automatic reversal, refund, cancellation, or second payment.

## Expiry Freshness Gate

Before moving any due booking from `AWAITING_PAYMENT` to `EXPIRED`:

1. resolve the active configured treasury account;
2. require a successful complete movement synchronization that includes provider data fetched after
   the expiry attempt began, reusing an already-running fresh run when possible;
3. generate current proposals from that synchronization;
4. if synchronization is unavailable, failed, retrying, or partial, defer expiry and leave the
   booking/account data unchanged; and
5. only then run existing conditional expiry transitions for bookings still awaiting payment.

This gate prevents releasing a booking while an unread transfer exists. It does not auto-confirm a
proposal: a matching payment still awaits an operator, so a due booking with a pending proposal is
also deferred.

## Reconciliation Contract Tests

- Matching income produces one pending proposal across repeated scans.
- Equal expense produces zero proposals.
- Reference-only and amount-only matches produce zero proposals.
- Partial, overpayment, combined transfers, missing estimate number, wrong currency, and zero amount
  produce zero proposals.
- Selection queues one claimed operation without prematurely confirming. Completion after accepted
  delivery creates one linked payment, confirmed proposal, transition and audit atomically.
- Actual-received invoices always contain the EUR 200 non-subject deposit and remaining advance.
- Ambiguous mutations and interrupted workers do not replay writes; recipients remain frozen.
- Dismissal is durable across rescans and records the operator.
- Movement correction updates one row and invalidates an unconfirmed ineligible proposal.
- Correction after confirmation retains the decision and surfaces an incident without automatic
  reversal.
- Expiry proceeds only after a fresh complete scan and defers on outage, partial result, or pending
  proposal.