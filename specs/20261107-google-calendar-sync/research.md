# Research: Google Calendar Booking Sync

## Service account and calendar sharing

**Decision**: Use direct server-to-server service-account access. The calendar owner shares the destination calendar with the service account's `client_email` and grants writer access. Do not use domain-wide delegation or a service-account API key.

**Rationale**: The application writes to one explicitly selected shared calendar and does not act as a Workspace user or invite attendees.

**Alternatives considered**: OAuth user consent, rejected because the user selected a service account; domain-wide delegation, rejected because it is broader than required.

**Sources**:
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/calendar/api/concepts/sharing
- https://developers.google.com/calendar/api/v3/reference/acl

## API scopes and connection verification

**Decision**: Use `https://www.googleapis.com/auth/calendar.events`. Test the configured calendar with a bounded `events.list` request and require its `accessRole` to be `writer` or `owner`.

**Rationale**: This scope supports event creation, retrieval, update, and deletion without granting broad calendar management.

**Alternatives considered**: Full `calendar` scope, broader than needed; `calendar.events.owned`, unsuitable for a calendar shared to the service account; read-only scope, insufficient for mutations.

**Sources**:
- https://developers.google.com/calendar/api/auth#calendar-api-scopes
- https://developers.google.com/calendar/api/v3/reference/events/list#authorization
- https://developers.google.com/calendar/api/v3/reference/events/insert#authorization
- https://developers.google.com/calendar/api/v3/reference/events/delete#authorization

## Node.js client library

**Decision**: Use the official `@googleapis/calendar` generated submodule rather than hand-rolling JWT signing or HTTP requests. Create an auth client from validated service-account JSON and instantiate Calendar v3 with the event scope.

**Rationale**: The official Google Node client provides typed Calendar methods and service-account authentication. Its per-API submodule keeps this server-only integration focused.

**Sources**:
- https://developers.google.com/calendar/api/quickstart/nodejs
- https://github.com/googleapis/google-api-nodejs-client#installation
- https://github.com/googleapis/google-api-nodejs-client#service-account-credentials

## Stable event identity and unknown insert outcome

**Decision**: Persist a deterministic Google-valid event ID per reservation and always reuse it. Before inserting on retry, fetch by the same ID; if found, verify its calendar-owned fields and mark it reconciled. A duplicate-ID response triggers the same fetch/reconcile path. Never generate a replacement ID because a request timed out.

**Rationale**: A stable provider identity is the strongest available protection against duplicate inserts after a response is lost.

**Limit**: Google documents that its globally distributed system might not detect every ID collision at event creation time. Therefore the application cannot promise strict exactly-once behavior for all ambiguous outcomes. Unexpected event contents or unresolved ambiguity must remain visible for operator recovery rather than be overwritten blindly.

**Sources**:
- https://developers.google.com/calendar/api/v3/reference/events#resource
- https://developers.google.com/calendar/api/guides/errors#409_the_requested_identifier_already_exists
- https://developers.google.com/calendar/api/guides/version-resources#conditional-modification

## All-day event dates

**Decision**: Send `start.date` as the booking check-in date and `end.date` as the checkout date. Do not send `dateTime` or a time zone for this all-day reservation.

**Rationale**: Google all-day event start is inclusive and end is exclusive, matching the existing booking date convention and ICS parser.

**Sources**:
- https://developers.google.com/calendar/api/v3/reference/events#resource
- https://developers.google.com/calendar/api/concepts/events-calendars#types-of-events

## Deletion and failure handling

**Decision**: Delete by the stored calendar ID and stable event ID. Treat `410 Gone` as already deleted. A `404` is not sufficient by itself to prove absence because it can also mean the calendar is unavailable; verify destination access before treating missing events as deleted. Use bounded retries/backoff for transient rate limits and server errors; do not retry unchanged malformed requests or invalid credentials automatically forever.

**Rationale**: Local cancellation must not commit while an event may still be active in the destination.

**Sources**:
- https://developers.google.com/calendar/api/v3/reference/events/delete
- https://developers.google.com/calendar/api/guides/errors
- https://developers.google.com/calendar/api/guides/version-resources#conditional-modification