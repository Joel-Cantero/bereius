# Feature Specification: Google Calendar Booking Sync

**Feature Branch**: `[20261107-google-calendar-sync]`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User request to configure a separate writable Google Calendar, create and maintain reservation events there, and preserve the existing read-only ICS calendar.

## User Scenarios & Testing

### User Story 1 - Configure the writable calendar (Priority: P1)

An administrator configures the destination Google Calendar and its authorized service account in booking settings, then verifies that the application can write to it. The existing ICS calendar remains a separate read-only source.

**Why this priority**: A working destination is a prerequisite for safely confirming reservations under the requested policy.

**Independent Test**: An administrator can save valid access details, verify the destination, and later replace the details without exposing the stored credential.

**Acceptance Scenarios**:

1. **Given** a valid service account with writer access to a selected calendar, **When** an administrator saves and tests the configuration, **Then** the application reports that the destination is ready without displaying the private credential again.
2. **Given** invalid credentials, a missing calendar, or insufficient access, **When** an administrator tests the configuration, **Then** the application reports a safe failure and does not change the ICS source.
3. **Given** the existing ICS source is configured, **When** Google Calendar settings are changed, **Then** the ICS source remains available for read-only viewing and manual event linking.

### User Story 2 - Confirm a reservation with a Google event (Priority: P1)

An operator confirms a reservation only after its event has been successfully created in the writable Google Calendar. The event uses the guest or group name as its title and includes party size and board type in its description. Arrival and departure are represented as an all-day stay, with the departure date exclusive.

**Why this priority**: The calendar event is part of the confirmation commitment requested by the user; a confirmed reservation must not silently lack its destination event.

**Independent Test**: Confirm a payable reservation against a controlled Google Calendar provider and verify one all-day event with the expected name, dates, party size, and board type.

**Acceptance Scenarios**:

1. **Given** a payable reservation and a writable destination, **When** an operator confirms it, **Then** one event is created and the reservation becomes confirmed.
2. **Given** the destination is not configured or Google refuses or cannot complete the write, **When** an operator attempts confirmation, **Then** the reservation remains awaiting payment, any already-reconciled payment remains recorded, and the operator can retry.
3. **Given** the same confirmation is retried after an uncertain response, **When** the retry completes, **Then** it reuses the reservation's stable event identity and reconciles any event already created instead of issuing a create with a new identity.

### User Story 3 - Remove the event when cancelling a reservation (Priority: P2)

An operator cancels a confirmed reservation and its corresponding Google event is deleted before the cancellation is accepted.

**Why this priority**: A cancelled stay must not remain as an active event in the writable calendar.

**Independent Test**: Cancel a confirmed reservation against a controlled provider; verify the event is removed and a failed delete leaves the reservation unchanged and retryable.

**Acceptance Scenarios**:

1. **Given** a confirmed reservation with a linked Google event, **When** it is cancelled, **Then** the Google event is deleted before cancellation is accepted.
2. **Given** Google cannot delete the event, **When** an operator attempts cancellation, **Then** the reservation remains confirmed and an operator can retry.

### Edge Cases

- Google access is absent, revoked, rate-limited, or temporarily unavailable.
- Google accepts a write but the application does not receive its response; retry must look up and reconcile the same stable reservation event identity. Google does not guarantee strict exactly-once behavior for all ambiguous distributed failures, so unresolved ambiguity must remain visible for operator recovery.
- The destination calendar is deleted or its identifier changes after configuration.
- A reservation has already-reconciled payment when event creation fails; payment records remain intact while the reservation stays awaiting payment.
- An event is missing or has been externally edited when cancellation is attempted.
- All-day stays preserve the exclusive departure date and the application's Europe/Madrid booking dates.

## Requirements

### Functional Requirements

- **FR-001**: Administrators MUST be able to configure a distinct writable Google Calendar using an authorized service account and a destination calendar identifier.
- **FR-002**: Administrators MUST be able to verify the configured destination, and the application MUST report configuration failures without exposing credentials or provider internals.
- **FR-003**: The existing ICS source MUST remain read-only and separate; Google Calendar writes MUST NOT alter the ICS source or WordPress availability.
- **FR-004**: A reservation MUST NOT enter the confirmed state unless its Google Calendar event has been successfully created.
- **FR-005**: An event MUST contain the reservation's customer or group name, stay dates as an all-day event with an exclusive departure date, party size, and board type.
- **FR-006**: If the destination is unconfigured or an event write fails, the reservation MUST remain awaiting payment; any already-recorded payment MUST remain recorded, and an authorized operator MUST be able to retry.
- **FR-007**: Repeated confirmation attempts MUST reuse one stable event identity per reservation and MUST reconcile an existing event after an uncertain response; they MUST NOT silently retry with a new identity.
- **FR-008**: Cancellation of a confirmed reservation MUST delete its linked Google event before cancellation is accepted.
- **FR-009**: If event creation or deletion fails, the corresponding reservation state transition MUST remain unapplied and MUST be retryable by an authorized operator.
- **FR-010**: Only authorized administrators MUST be able to configure Google Calendar credentials; booking actions MUST use the authenticated operator identity.
- **FR-011**: Stored credentials MUST not be returned to the browser or written to logs, and errors shown to users MUST not disclose credentials or raw provider responses.
- **FR-012**: Existing manual linking between confirmed reservations and read-only ICS events MUST continue to work independently of Google Calendar event creation.

### Key Entities

- **Google Calendar configuration**: The destination calendar identifier and authorized service-account access used by the application.
- **Reservation event link**: The association between one reservation and its event in the writable destination, including enough identity to safely retry updates or deletion.
- **Calendar synchronization attempt**: The outcome of creating, updating, or deleting a reservation event, with a safe operator-visible retry state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every successful transition to confirmed has exactly one matching event in the configured destination calendar.
- **SC-002**: A failed or uncertain Google write leaves the reservation in its previous state; retry reuses and checks the stable event identity before any further create attempt.
- **SC-003**: Every accepted cancellation has no remaining event in the destination.
- **SC-004**: Administrators can configure and verify a destination without redeploying the application or exposing a saved private credential.
- **SC-005**: The current ICS calendar remains read-only and its existing viewing and manual-linking workflows continue to pass their regression tests.

## Non-Goals

- Writing to, importing from, or replacing the existing ICS source.
- Automatically linking a reservation to an event found in the ICS source.
- Backfilling events for reservations that were already confirmed before this feature is enabled.
- Supporting multiple writable destination calendars or user-specific Google accounts.
- OAuth-based Google account authorization.
- Editing confirmed reservations or modifying/rectifying Holded documents after confirmation.

## Security & Privacy Implications

The destination credential grants write access to a private calendar and MUST be protected as a secret. Only administrators can configure it. Reservation names, dates, party size, and board type are personal or operational data and MUST be sent only to the explicitly configured destination. Credentials, event contents, and raw provider responses MUST NOT appear in logs. The feature remains inside authenticated, non-indexable booking workflows.

## Threats & Abuse Cases

- **Credential theft or disclosure**: The service-account JSON grants calendar write access. Accept it only from an authenticated administrator, store it encrypted, never return it in status/config queries, and never log it or raw provider errors.
- **Unauthorized event creation or deletion**: Derive the actor from the server session, restrict settings to administrators, and allow retry/cancel operations only to authorized booking operators.
- **Duplicate creation after retry or timeout**: Persist one stable event ID per reservation, serialize local transitions, fetch and compare that ID before retrying, and never issue a retry with a new ID. Unknown conflicting content stays visible for operator recovery.
- **Wrong-calendar deletion after settings replacement**: Snapshot the destination calendar ID on each event link and delete only through that snapshot; do not silently redirect an existing event operation to the newly configured calendar.
- **Stale or orphaned event during cancellation**: Block a cancellation while the create job is claimed, stop unclaimed create jobs atomically, verify deletion before the local state change, and compensate by deleting an event if the booking changes during creation.
- **Provider outage or deliberate retry pressure**: Use the existing bounded outbox retry/backoff, keep provider calls server-side with request timeouts, retain dead jobs for explicit operator retry, and do not expose a public endpoint for Google operations.
- **Residual ambiguity**: Google Calendar does not guarantee strict exactly-once behavior for every distributed timeout/collision. Preserve the stable identity and stop for operator review when the existing event cannot be safely reconciled.

## Operational Impact

The feature adds an external provider dependency to reservation confirmation and cancellation. When the destination is unavailable, those state changes are intentionally blocked and must be retried after access is restored. Confirmed reservation details and issued Holded documents are not edited by this feature. The existing ICS reader remains independent. Configuration and event identity must survive application restarts and use the application's existing encrypted-secret and database-backup practices.

## Assumptions

- The service account is shared onto the destination calendar with permission to create, update, and delete events.
- The destination Google Calendar is configured before operators confirm reservations.
- The default event title is the customer or group name; the description contains party size and board type.
- All-day event end dates follow the existing booking convention: the departure date is exclusive.
- Retry controls are available to authorized operators from the relevant booking workflow.