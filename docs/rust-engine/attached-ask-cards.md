# One attached question card per request and ticket

User report, 2026-10-07, alpha.8: a two-tab question attached to one docket
item rendered twice. `asks::compose` wrote that item's slug once per question
to `work_items`. `docket::ctx` iterated that array and appended the complete
matching question group for every occurrence. The renderer correctly drew
each entry it received, thus two identical cards for one request ID.

The shared `asks::attached_tabs` groups a single request's questions by exact
ticket slug, preserving original tab indices, text, headers, options and multi
selection. Composition writes unique attachment slugs. The docket reader uses
the same grouping on the stored questions, so existing duplicate work_items
arrays need no migration or live data write. Unattached tabs are not claimed
by a ticket; different request IDs are never collapsed even with identical text.

This matches Python 3.x `Ledger._work_questions` on origin/dev: one entry per
open ask with its matching tab indices. The unchanged renderer resolves the
request ID to the full AskCard. When a batch includes other tickets/tabs, each
ticket shows it once with the existing note that answering resolves every tab.
The user still submits the entire batch, never a silently truncated subset.

## Counts and history

Server `asks_open` counts ask rows; docket pending counts use `count(*)` with
`slug = ANY(work_items)`, attention uses existence, and the summary uses distinct
ticket slugs. Duplicate array values cannot multiply these counts. Answer
settlement updates one request UID, inserts one answer mail and one resolution
event. The docket attached list is open-only, as in 3.x; answered cards remain
in the user's question inbox/history, one per resolved request row.

The renderer's optimistic count had another mismatch: it counted `revs` keys,
but Rust puts ask/credits/scope stamps on one request row. It now subtracts the
distinct open header request IDs covered by the submitted card. This keeps
legacy separate-store headers working and prevents one Rust submit hiding
unrelated question counts. The prior fallback remains for incomplete headers.

## Verification

Measured: `cargo check -j 2` with the owner's E: target and renderer
`npm run typecheck` pass. A small standalone Rust smoke compiled the exact
composition/grouping function bodies (without logging wrappers) against cached
serde_json. Baseline composition produced `[ticket-a,ticket-a]`; fixed output
was `[ticket-a]` with both tabs intact. Cross-ticket, unattached, repeated-text,
tab-index, options and multi-selection controls passed.

The emitted JSON fed a brief production DocketPane static-render smoke in
jsdom: one box/two tabs; one full four-tab card on each of two tickets with the
other-items note; two cards for separate IDs with identical text; selected and
unselected node inbox grouping; one-row optimistic subtraction; answered
handover and removal from open docket cards. No live engine or DB was touched.
The first dynamic fixture attempt failed due to externalized MUI module
interop; normal repository dependency bundling corrected that fixture issue.
Static rendering checks content/grouping, not browser interaction or layout.
Server SQL/history uniqueness was inspected from source, not exercised on a DB.
