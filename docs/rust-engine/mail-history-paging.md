# Inbox and Sent history

The person's read and Sent feeds contain 200 rows each, with 500 pending
messages. Agent and project mailbox feeds contain 150 rows per folder.
Those live windows are intentional; the missing history path made older mail
unreachable. Before this correction, only a selected user tag enabled the
shared mail list's server paging.

Explicit `folder=inbox|sent` requests on the existing user or node inbox
endpoint now ask for a retained-history page. `before` is a positive PostgreSQL
mail id, kept as a decimal string in the client. Each query seeks `id < before`,
orders by id descending, and reads at most 201 user or 151 node rows. The last
included id becomes `next_cursor` only when the lookahead exists. No OFFSET,
timestamp tie-break guesses, all-history read or total count is required.
Requests without a folder retain their existing live-window contract.

The queries retain the admitted org and node, existing mail indexes, external
inbox visibility gates, incoming read/delivery state and Sent recipient
projection. Project rows retain their existing queue metadata; viewing a page
never claims, acknowledges, releases or marks project mail read. Hubchat uses
its own lazy-history API and is outside this change.

`useMailboxHistory` merges retained pages by message id with the live head,
keeps the older cursor when the head refreshes, and rejects responses from a
previous org/node/folder. The existing 40-row DOM window consumes loaded rows
before asking for another bounded server page. Older rows append after current
rows, retaining scroll offset and selection. User read/delete acknowledgements
also update retained older rows. A failed history request retains the current
list and offers Retry. Tag-filtered mail keeps its existing separate pager.

Live windows normalize missing/null folder arrays before reading membership or
merging pages. An omitted live window still means loading. Partial pages can
omit unused folders, but malformed page bodies, rows or cursors fail before
the React state updater runs, retaining the current rows and cursor for Retry.
The projectdesk fixture explicitly serves mailbox responses; its generic
FakeServer fallback `{ok:true}` is not a mailbox contract.

## Focused evidence and limits

`apps/desktop/renderer/tests/inboxhistory.test.tsx` mounts the actual user panel
and the agent/project shared InboxView. Each fixture holds 650 incoming and
430 sent messages behind a bounded legacy feed. It checks reachability of the
exact oldest message, numeric-id request sequence, retained selection, and
retained scrollTop. The user fixture first failed both oldest-message checks;
after the user commit it passed both while all four agent/project cases still
failed the same assertion. Final green: all six cases passed, with no skips
or cancellations (2.66 seconds). The normal root TypeScript check and engine
`cargo check --offline -p orgtree-engine --bin orgtree-engine -j 2` passed.
An exploratory renderer-only configuration with noUncheckedIndexedAccess
reported diagnostics in untouched files; those results are retained separately.
The first test launcher retained React's MessageChannel and gave no verdict;
its logs were also kept. Exact commits and raw receipts are in the docket.

These are synthetic mounted DOM checks with mocked HTTP responses. They do
not establish native mouse/touch scrolling or actual PostgreSQL query execution
and query-plan timing. Backend queries were compiled and source-inspected.
No live mailbox, device, hub or installed data was used. Phase 1 deliberately
omits an independent review and broad rig/full-suite runs.
