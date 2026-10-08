# Data Model

## WordPress integration
Add WORDPRESS to IntegrationProvider. Config: HTTPS origin, service username, writesEnabled=false, automaticSync=false. Store application password only in existing encrypted secret fields. Connection verification and a successful preview are required before automatic writes.

## CustomerSyncRun
Identifier, mode (preview/apply), state, optional initiating administrator ID, lease token/expiry, start/finish times, bounded safe JSON results and counts, failure category. Expired leases become failed and are not automatically replayed as writes. Only the current lease may complete a run.

## CustomerAdminEvent
Identifier, administrator ID, operation, principal/delegate technical IDs, outcome and time. No delegate profile or credential payload. Retain recent run/event records with a bounded retention window.

## WordPress principal
Immutable holded_contact_id and holded_<id> username; role cliente, account type principal, managed flag 1. Holded name/email/address fields retain the existing mapping. Email collisions never adopt another user. Updates require all ownership markers.

## WordPress delegate
Existing account and relation, pending/active/revoked lifecycle and generation. Read profile and projection status live; no copied authoritative directory. Email change of pending/active accounts revokes access, changes profile and reinvites with a new generation. Revoked profile changes remain revoked.