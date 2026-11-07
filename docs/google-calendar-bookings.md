# Google Calendar bookings

## Configuration

1. Enable Google Calendar API in the Google Cloud project.
2. Create a service account for Bereius.
3. Share the destination calendar with the service account's `client_email` and grant **Make changes to events** (`writer`). The current feature does not require domain-wide delegation or attendee invitations.
4. As an administrator, open **Bookings → Integrations** and enter the destination calendar ID and service-account JSON in **Writable Google Calendar**.
5. Save, then test the connection. The test verifies writer access without displaying the stored credential again.

The service-account credential is encrypted with `BOOKING_SECRET_KEY` in PostgreSQL. Do not commit the JSON key, add it to fixtures, or paste it into logs or chat. Back up the database and `BOOKING_SECRET_KEY` according to the existing recovery procedure.

The ICS feed remains an independent read-only source. Google writes never modify ICS or WordPress availability.

## Event and confirmation lifecycle

- The event title is the reservation customer/group name.
- The description contains the party size and board type.
- The stay is an all-day event. Check-in is inclusive and checkout is the exclusive end date.
- A recorded payment is retained while the booking remains AWAITING_PAYMENT until the Google event is safely reconciled.
- Event create, booking confirmation/audit, and confirmation-email enqueue are separated by an outbox boundary. No database transaction stays open during a Google request.
- Cancellation deletes the linked event before the local booking transitions to CANCELLED. If Google is unreachable or access was revoked, the cancellation is refused and can be retried after access is restored.
- Confirmed reservations are not backfilled. This feature does not edit confirmed reservation details or issued Holded documents.

## Failure recovery

Transient Google failures use the existing bounded exponential outbox retries. A dead confirmation job is visible on the booking detail; an authorized operator can requeue the same job after restoring calendar access. Requeueing preserves the payment and deterministic Google event ID.

If an insert times out, the worker looks up the same event ID before attempting any further insert. If an event exists with unexpected content, or Google cannot establish the result, do not create a replacement ID. Keep the reservation awaiting payment and review the event using the stored calendar ID and event ID. Google cannot guarantee strict exactly-once behavior for all ambiguous distributed failures.

If cancellation cannot delete its event, the reservation remains unchanged. Retry cancellation from the booking detail after restoring service-account writer access. The stored calendar ID is used even if the configured destination has since changed.

## Testing

Automated tests use an injected Calendar client or controlled API fixture and synthetic credentials only. Live verification is an administrator step after the Google Cloud project, API, shared calendar, and service-account key are configured; production credentials must never be used by test suites.