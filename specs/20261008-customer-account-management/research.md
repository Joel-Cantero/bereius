# Research

## Ownership
Decision: WordPress lifecycle API; Bereius administrative frontend and reconciliation coordinator.
Rationale: Existing invitation, session invalidation and managed-person ownership rules remain authoritative.
Alternative rejected: duplicating delegate identity and lifecycle in PostgreSQL.

## Credentials and transport
Decision: Reuse IntegrationSettings AES-GCM credentials and a bounded public-HTTPS WordPress transport modeled on the calendar source's connection-time DNS protection.
Rationale: Write-only secrets, no redirects or private-network credential forwarding.
Alternative rejected: browser-side WordPress credentials or unvalidated fetch destinations.

## Synchronization
Decision: Read complete Holded and WordPress snapshots before a deterministic reconciliation plan. Preserve raw Holded-only IDs for orphan detection, excluding persons from writes. A fenced database lease serializes runs; settings changes reset preview approval.
Rationale: Incomplete reads and mutable email must not select or delete accounts.
Alternative rejected: reusing document-recipient discovery as a fiscal snapshot or blind retrying outbox invitations.

## Delegate deletion and email
Decision: Revoke rather than physically delete. Changed email uses revoke/update/reinvite, invalidating old sessions before new mailbox acceptance.
Rationale: Preserve generations, pending-person isolation and archival recovery.
Alternative rejected: immediate active-account email reassignment without verification.