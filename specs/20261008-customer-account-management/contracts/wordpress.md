# WordPress Administration Contract

All endpoints are under berea/v1/admin, require HTTPS and authenticated user-management administrative privileges. Requests and results are bounded. No endpoint accepts a caller-supplied role.

- GET customers?page=1: complete page of principal records, profile mapping and managed eligibility, explicit pagination metadata.
- POST customers: canonical principal payload and immutable Holded ID. Creates a marked cliente account or updates only a verified managed principal. Email/user collisions are conflicts. Readback confirms canonical fields; no account deletions.
- GET delegations?principal_id=ID&holded_contact_id=ID: principal identity and live delegates with profile, access state and projection status (queued/retrying/idle), without raw projection errors. Existing principal_email lookup remains compatible.
- POST delegations: existing invitation response includes delegate_id, principal_id, status and created; no duplicate account or automatic resend.
- POST delegations/action: principal_id, holded_contact_id, delegate_id, generation, expected_status, action (update/resend/revoke/reinvite), optional canonical profile. Ownership and version are verified before mutation. WordPress performs lifecycle changes and emits projection events. Returns the delegate profile with id.

Ambiguous invitation or resend outcomes are surfaced; Bereius does not automatically resend. Errors expose stable codes and no raw provider responses. WordPress returns the authoritative post-operation account state.