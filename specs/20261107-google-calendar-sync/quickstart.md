# Quickstart: Google Calendar Booking Sync

## Prerequisites

- Apply the new database migration before starting the application.
- Enable Google Calendar API in the Google Cloud project.
- Create a service account. Share the destination calendar with its service-account email and grant **Make changes to events** (`writer`).
- Do not commit or paste service-account credentials into source code, fixtures, logs, or chat. Configure the JSON credential only through the authenticated settings form.
- The existing `BOOKING_SECRET_KEY` must be available so credentials can be encrypted at rest.

## Local Verification

1. Open booking integration settings as an administrator.
2. Enter the destination calendar ID and service-account JSON; save and test the connection. The test must confirm writer access and never echo the credential.
3. Create a test reservation and move it to awaiting payment. Record a valid payment.
4. Before the Google job succeeds, verify the payment remains recorded and the booking remains `AWAITING_PAYMENT`.
5. Let the outbox process the job. Verify exactly one all-day event exists, with the reservation name as summary, party size and board type in the description, check-in as inclusive start, and checkout as exclusive end. Verify the booking then becomes `CONFIRMED`.
6. Cancel the reservation. Verify the event is deleted before the booking becomes `CANCELLED`.
7. Repeat with a controlled authorization or availability failure. Verify state remains unchanged, the failure is visible, and the authorized retry reuses the same event ID.
8. Configure or retain the existing ICS source and verify calendar viewing and manual ICS linking still work independently.

## Automated Checks

```sh
pnpm exec vitest run tests/unit/google-calendar.test.ts
RUN_INTEGRATION_TESTS=true pnpm exec vitest run tests/integration/google-calendar-bookings.test.ts
pnpm test:e2e -- --grep "Google Calendar"
pnpm lint
pnpm typecheck
```

Use only a controlled HTTP fixture or an injected fake Calendar client in automated tests. Live Google verification is a deployment prerequisite after the user supplies service-account access; tests must not use that live credential.