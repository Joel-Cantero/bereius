# Feature Specification: Customer Account Management

**Feature Branch**: `20261008-customer-account-management`
**Created**: 2026-10-08
**Status**: Approved for implementation
**Input**: Move principal customer synchronization from n8n to Bereius and let administrators invite, edit, revoke, resend and reinvite customer delegates from Bereius.

## User Scenarios & Testing

### User Story 1 - Reconcile Principal Accounts (Priority: P1)

An administrator configures the WordPress connection and previews reconciliation before enabling writes or a daily schedule.

**Why this priority**: Stable fiscal identity is required before administrative delegation.
**Independent Test**: A preview reports missing and changed principals without writes, and an enabled run reconciles only managed principal accounts.

**Acceptance Scenarios**:
1. Given fiscal customers and managed principals, when preview runs, then proposed creations, updates and review items are reported without remote mutations.
2. Given writes are enabled, when reconciliation runs, then identity is matched by Holded contact ID, not mutable email, and delegates and unrelated users remain untouched.
3. Given incomplete provider reads, duplicate identities or email collisions, when a run occurs, then it fails safely or records a conflict without overwriting another account.
4. Given a principal absent from a complete fiscal snapshot, when reconciliation runs, then it is reported for review and never deleted automatically.

### User Story 2 - Manage Delegates (Priority: P1)

An administrator opens a customer's delegates and manages access without signing in as that customer.

**Why this priority**: Removes manual backend administration while preserving the existing lifecycle.
**Independent Test**: Invite, edit, resend, revoke and reinvite work through the authoritative customer system with explicit pending, active and revoked states.

**Acceptance Scenarios**:
1. Given a principal, when an administrator invites a delegate, then one pending account and invitation are created and no Holded person appears before acceptance.
2. Given a delegate, when profile fields change, then WordPress applies the change and queues its existing person projection; changed email requires a new invitation before restoring access.
3. Given an active delegate, when access is removed, then sessions and login tokens are invalidated immediately and managed-person archival is queued.
4. Given a revoked delegate, when reinvited, then the generation increments and the account remains pending until acceptance.
5. Given another principal's delegate or an unrelated user, when a mutation targets it, then the operation is rejected without changes.

### Edge Cases

- Provider outage, pagination loops, oversized responses and incomplete snapshots fail closed.
- Concurrent runs cannot both create the same principal or duplicate an invitation.
- A mail failure is not reported as a delivered invitation; an ambiguous mutation is not automatically resent.
- Editing a revoked account does not restore access; pending edits do not create a Holded person.
- Existing principals lacking explicit management flags are review items, not silently adopted.

## Requirements

### Functional Requirements

- **FR-001**: Holded remains authoritative for fiscal customer data; WordPress remains authoritative for delegate identity, membership, status and generation.
- **FR-002**: Bereius may call WordPress for principal reconciliation and privileged administrative delegate operations. This supersedes FR-010 and the no-WordPress-call statements in `20260912-customer-delegates`; delivery discovery and frozen recipients remain unchanged.
- **FR-003**: Only Bereius administrators may configure credentials, reconcile accounts or mutate delegates; credentials are encrypted and never returned to clients or logged.
- **FR-004**: Principal reconciliation excludes person contacts, empty emails and invalid identities; duplicate contact IDs and duplicate emails are conflicts rather than arbitrary winners.
- **FR-005**: Existing-account writes require role cliente, principal account type, explicit management flag and matching Holded ID. No user is identified or overwritten solely by email.
- **FR-006**: Preview is the default. Daily automatic synchronization requires explicit configuration and completed reconciliation validation; manual preview and write runs remain available.
- **FR-007**: Reconciliation reports creation, update, unchanged, conflict and orphan-review outcomes. It never automatically deletes principal users.
- **FR-008**: Delegate operations use WordPress's existing invite, resend, revoke and reinvite lifecycle, preserve limits and queued Holded projection, and expose synchronization status.
- **FR-009**: Deleting a delegate means revoking access, not physically deleting the user. A changed email invalidates prior access and requires mailbox acceptance.
- **FR-010**: Repeated invitations do not duplicate accounts or resend email. Mutations have bounded execution and ambiguous results require authoritative readback rather than blind retries.
- **FR-011**: Runs are serialized across instances and retain bounded history; administrative events record actor ID, operation, technical target identifiers and safe outcomes without names, phones, email addresses or secrets in logs.
- **FR-012**: A non-indexable, localized customer screen supports client search, delegate list and all defined administrative actions on desktop and mobile.

### Key Entities

- **WordPress connection**: trusted HTTPS origin, encrypted service credentials and explicit synchronization settings.
- **Fiscal customer**: immutable Holded identifier, fiscal attributes and associated principal account.
- **Reconciliation run**: mode, initiator, lease, safe summary and review outcomes.
- **Delegate**: authoritative WordPress account with principal relation, profile, invitation state and projection state; Bereius does not persist a delegate directory.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Preview performs zero writes and produces deterministic outcomes for the same snapshots.
- **SC-002**: Reconciliation and delegation tests demonstrate zero modifications to unrelated accounts or another principal's delegates.
- **SC-003**: Revocation ends WordPress access before any external archival completes.
- **SC-004**: Administrators can complete each delegation operation from one customer's screen without a separate customer login.
- **SC-005**: Provider failures expose no credentials or personal data and do not cause duplicate invitations or fiscal-contact replacement.

## Assumptions

- Existing WordPress Magic Login, SMTP and delegate projection remain in use.
- Principal fields retain the documented Holded-to-WordPress mapping and holded_<id> usernames.
- Administrators explicitly enable reconciliation writes after preview; automatic synchronization is initially disabled.

## Non-Goals

- Move delegated authentication or acceptance into Bereius, directly mutate managed Holded people, or change document recipient discovery.
- Automatically delete users, adopt unrelated accounts, reactivate n8n or deploy changes to production without an explicit deployment request.

## Security & Privacy Implications

Server-derived authorization, bounded trusted-origin HTTP requests, encrypted credentials, ownership checks on every mutation and safe audit metadata are mandatory. WordPress is responsible for its session invalidation and mailbox verification. Failed or ambiguous invitations are not silently replayed.

## Threats & Abuse Cases

- Unauthorized administration: derive the administrator role from the authenticated database actor on each action; WordPress separately requires administrative user-management capabilities.
- Cross-principal access and stale forms: verify immutable fiscal identity, delegate ownership, generation and expected status before mutation. Email collisions never adopt another account.
- SSRF and credential exfiltration: validate a root HTTPS origin, reject private DNS answers at connection time, disallow redirects and bound requests and response sizes.
- Invitation spam and ambiguous delivery: apply actor and native lifecycle rate limits; never automatically replay mail-affecting requests. Refresh authoritative state before an explicit retry.
- Overlapping reconciliation: serialize claims with a PostgreSQL advisory lock, renew fenced leases, check configuration before writes and serialize administrative WordPress mutations with a database named lock.
- Destructive reconciliation and privacy leakage: use complete snapshots, explicit managed eligibility and preview approval; report orphans without deleting them. Retain only bounded technical audit/run metadata, never profile data or credentials.

## Operational Impact

Add a WordPress integration and daily leased reconciliation task to the existing scheduler. Roll out WordPress endpoint changes before Bereius writes; start with preview and keep n8n unpublished. Provider failure must not stop other scheduled jobs. Any new database migration is additive and forward-only. Reverting application code never reverses migrations.