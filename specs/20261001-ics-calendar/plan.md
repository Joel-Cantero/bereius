# Implementation Plan

Reuse console navigation, booking authorization, encrypted IntegrationSettings and server actions. Add CALENDAR_ICS through a forward-only enum migration. Use ical.js for RFC5545 parsing and recurrence; render a responsive monthly grid with accessible previous/next/today controls. Fetch server-side via bounded HTTPS with pinned public DNS, no redirects and no URL logging. Use noindex metadata and no sitemap entry.

## Verification Strategy

Vitest tests cover exclusive ends, folded text, recurrence, unsafe URLs and bounded network failure. Component tests cover monthly navigation and localized empty states. Run lint, typecheck, tests and SpecKit compliance. Perform a read-only live check with the requested source and start the local development server. Rollback application code only; the additive provider enum may remain safely in the database.

## Multi-Day Display

Group contiguous or overlapping all-day entries with identical non-empty titles for display only;
never modify source entries, combine separate stays across gaps, or merge timed appointments.
Render one band per occupied week, with distinct rows for overlaps and exclusive DTEND preserved.
The mobile agenda lists each grouped stay once and displays inclusive occupied dates.

Constrain and center the whole page, including heading and month controls, to 72rem with responsive
padding. Use static grid-column classes and separate event rows rather than inline styles, which
production CSP deliberately blocks. Do not relax CSP or add a client-side calendar dependency.

Playwright's loopback provider fixture serves a synthetic ICS source through a test-only HTTPS
preload mapping for `calendar.example.test`. This mapping is never used by production and changes
neither the calendar URL validation nor the DNS-pinning implementation. It lets tests verify
three-column spans, overlap rows, week/month boundaries, centered margins at 2560px, layout at
900px and the grouped agenda without overflow at 320px.

## Constitution Check

Preserve Docker portability, domain ownership, encrypted secrets, structured redacted logs, trusted session authorization and all three locales. The authenticated calendar is non-indexable and excluded from the sitemap. The feature changes no source availability or public booking workflow.

## Booking Links

Use a source fingerprint plus original UID and recurrence identity, never display IDs or summaries,
for persisted linkage. Only CONFIRMED bookings can be linked, through authenticated Server Actions
that re-fetch the feed and validate the chosen event. Store event dates/title as a snapshot, keep
one active link per booking and one owner per source event, and append an audit record for linking
or unlinking. Transactions recheck booking state and serialize ownership changes; network reads
stay outside transactions. Do not alter WordPress, payment records, or lifecycle state.

The booking detail presents date/name-ranked overlapping candidates, excludes occupied events and
shows review warnings for changed/missing events, source replacement or feed unavailability.
The calendar joins links before display grouping, preserving all linked bookings in merged bands.
Localized controls use existing primitives. Verify stable identities, real PostgreSQL uniqueness,
concurrent conflicts, audit history, authorization, source revalidation and browser journeys.

**Booking-Link Migration Strategy**: Add private link and audit tables with forward-only migration.
Keep existing calendar and booking data unchanged. Deploy migration before the application image.

**Booking-Link Recovery Strategy**: Roll back compatible application code while retaining link and
audit data. Feed failures defer review; they never cancel a booking or reverse a payment.

**Migration Strategy**: Add CALENDAR_ICS to the PostgreSQL enum using a forward-only migration before deploying application code. No rows or credentials are rewritten.

**Recovery Strategy**: Restore previous application code if needed; retain the harmless additive enum value and any encrypted configuration. Never rewrite applied migrations.