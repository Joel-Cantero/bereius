# ICS Calendar

## Requirements

- Operators and administrators can open a read-only monthly calendar from its own sidebar section.
- Administrators configure, replace and test an HTTPS ICS URL in Integrations without redeployment.
- The source remains authoritative; viewing it never changes bookings or WordPress availability.
- Honor exclusive DTEND, all-day events, time zones and bounded recurrence expansion.
- Include English, Spanish and Catalan navigation, feedback, empty and failure states.

## Security & Privacy Implications

The page is authenticated and non-indexable. Store the URL encrypted using the existing integration envelope because feed URLs may contain access tokens. Never log URLs, response bodies or event titles. Reject non-HTTPS, credentials, private/reserved IPs and redirects; pin DNS resolution for the request. Bound download time, bytes, event count and recurrence expansion.

## Threats & Abuse Cases

SSRF and DNS rebinding are prevented by public-address validation and pinned HTTPS lookup. Malicious feeds are bounded to 2 MiB, 10 seconds, 10,000 components, 50,000 recurrence steps and 1,000 visible events. Unauthorized configuration is blocked by trusted administrator authorization. Event content is rendered as escaped text. Tokens remain encrypted and write-only.

## Acceptance

Configure the supplied Berea feed, test the connection, open the calendar, navigate months and verify multi-day events end before DTEND. An unconfigured source and failed downloads have explicit localized states. Non-administrators cannot save or test settings.

## Non-Goals

Editing events, importing bookings, changing the existing outbound feed, or deploying to production.