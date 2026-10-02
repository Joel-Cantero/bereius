# ICS Calendar

## Requirements

- Operators and administrators can open a read-only monthly calendar from its own sidebar section.
- Administrators configure, replace and test an HTTPS ICS URL in Integrations without redeployment.
- The source remains authoritative; viewing it never changes bookings or WordPress availability.
- Honor exclusive DTEND, all-day events, time zones and bounded recurrence expansion.
- Render multi-day events as continuous weekly bands, joining contiguous/overlapping all-day entries with identical non-empty descriptions for display only. Keep separate stays and timed entries distinct.
- Center the calendar title, month and controls in a responsive width-limited layout; retain the mobile agenda and avoid horizontal overflow.
- Include English, Spanish and Catalan navigation, feedback, empty and failure states.
- Operators and administrators can manually link a CONFIRMED booking to an original ICS event, choosing suggestions by stay dates and group name. Never link automatically by description.
- Persist source-scoped UID/occurrence identity and the linked event snapshot. Reject duplicate ownership, allow audited unlinking, and flag changed/missing events or replaced sources for review without changing booking/payment state.
- Linked calendar bands and the mobile agenda provide access to the booking. Preserve every underlying link when several source events are grouped visually.

## Security & Privacy Implications

The page is authenticated and non-indexable. Store the URL encrypted using the existing integration envelope because feed URLs may contain access tokens. Never log URLs, response bodies or event titles. Reject non-HTTPS, credentials, private/reserved IPs and redirects; pin DNS resolution for the request. Bound download time, bytes, event count and recurrence expansion.

## Threats & Abuse Cases

SSRF and DNS rebinding are prevented by public-address validation and pinned HTTPS lookup. Malicious feeds are bounded to 2 MiB, 10 seconds, 10,000 components, 50,000 recurrence steps and 1,000 visible events. Unauthorized configuration is blocked by trusted administrator authorization. Event content is rendered as escaped text. Tokens remain encrypted and write-only.

## Acceptance

Configure the supplied Berea feed, test the connection, open the calendar, navigate months and verify multi-day events end before DTEND. An unconfigured source and failed downloads have explicit localized states. Non-administrators cannot save or test settings.

## Non-Goals

Editing events, importing bookings, changing the existing outbound feed, or deploying to production.