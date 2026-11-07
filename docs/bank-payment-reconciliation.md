# Bank payment reconciliation

## Contract and rollout

Apply migrations before starting the new application image. Existing payments, reserve invoices and
queued legacy reserve-invoice jobs are not backfilled, converted or resent.

Both strict reconciliation proposals and manually selected payment candidates enqueue
`banking.payment`. Each operation uniquely claims one booking and one movement. The received amount,
bank date, original narrative, fiscal contact and source estimate are frozen server-side.

Before enabling actual use, verify that the account's API credential can read/write invoices and
treasury reconciliation, that invoice series F exists, and that both configured services have their
sales channels. The advance uses `s_iva_10`; the EUR 200 deposit explicitly uses
`s_iva_nosujeto`, not a generic zero-rate VAT tax. Check these fiscal settings with the account owner.
The source estimate must already be approved. A receipt must exceed EUR 200.

The invoice total is the actual receipt, including any accepted difference within 5% of the expected
booking total. The original estimate and original expected total are unchanged. Conversion creates a
linked draft; the complete stay lines are replaced before approval.

## Durable evidence

Inspect the authorized movement/reservation status and the operation row, its related IntegrationJob,
HoldedDocument and DocumentDelivery. Logs use local IDs and stable failure codes, never fiscal bodies.

| Last completed stage | Evidence retained |
|---|---|
| PREPARED | Unique local claim and frozen source/receipt |
| CONVERTED | Linked Holded invoice ID |
| CONFIGURED | Verified two-line receipt invoice |
| APPROVED | Approved invoice; receipt not yet recorded |
| PAID | Registered receipt; payment amount/account/date must verify |
| RECONCILED | Collection ID and reconciled original movement verified |
| SENT | Invoice submission accepted; frozen fiscal To and active delegate CC |
| COMPLETED | Local Payment and one Google Calendar confirmation job committed together; the booking remains AWAITING_PAYMENT until its event is reconciled |

`FAILED` permits bounded retries from the saved stage; exhausted attempts become `BLOCKED`.
`UNKNOWN` and `BLOCKED` require operator review and never automatically repeat fiscal writes.
An interrupted claimed job is detected after 15 minutes. Its unfinished operation is parked UNKNOWN;
an already SENT operation may safely retry its local transaction without contacting Holded.
These claims also block expiry, manual payment, cancellation, advance editing and estimate relinking.
There is deliberately no destructive cleanup of partial fiscal work.

## Evidence-based recovery

1. Stop or isolate workers for the affected operation before controlled maintenance. Record its local
   operation/job IDs and exact stage/status. Do not clear the claim or create another invoice.
2. Read the actual invoice and its `from` estimate link; check fiscal contact, dates, two lines, taxes,
   actual total and approval. Compare payment collections and the original treasury movement.
3. If a timed-out conversion succeeded, recover its existing invoice ID using that evidence. Never
   convert again merely because no ID was saved locally. If no conclusive evidence exists, keep UNKNOWN.
4. For payment/reconciliation ambiguity, verify the existing collection's ID, amount, date and account,
   and its reconciliation with the original movement. Never register another payment speculatively.
5. For email ambiguity, check Holded submission evidence and the frozen DocumentDelivery recipients.
   Accepted delivery must not be sent again; inconclusive submission remains UNKNOWN. Acceptance does
   not prove delivery to an inbox.
6. Only after resolving the actual provider outcome, have an authorized maintainer transactionally
   repair the saved IDs and last **verified completed** stage, then requeue the same operation/job.
   Do not reset its stage to PREPARED or change receipt/source data. Record the evidence and operator
   decision outside public logs. Restore all status/recipient invariants before resuming the worker.
7. Verify exactly one local Payment and one Google Calendar confirmation job. The bank operation may
   be COMPLETED while the booking remains AWAITING_PAYMENT. Only after the Google event is
   reconciled should one confirmation audit and one confirmation-mail job exist and the booking
   become CONFIRMED.

Rolling back code does not undo the migration, an approved invoice, a collection or an email.
Do not run the old image against unfinished bank operations: it lacks their conflict guards.
Correct fiscal mistakes through the account's authorized accounting process, not by deleting local
evidence or restoring a database backup over newer fiscal activity.

## Google Calendar confirmation handoff

Successful Holded invoice submission and bank reconciliation are necessary but no longer sufficient
to confirm a booking. The final bank transaction persists the payment, completes the bank operation,
and enqueues one idempotent `calendar.booking-event` job. The booking stays AWAITING_PAYMENT until
the worker verifies or creates the event using its stable Google event ID, then commits the booking
transition, audit row, and confirmation-mail job together.

If the Google job is exhausted, retain the payment, invoice, movement, and event-link row. Restore
the service account's writer access and use the booking detail's retry action; it requeues the same
job and event ID. Do not remove the payment or create another bank operation. If the event insert
outcome is ambiguous, inspect the stored calendar/event ID and Google event before any manual repair;
Google does not provide strict exactly-once guarantees for every ambiguous distributed response.
