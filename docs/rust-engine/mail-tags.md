# Custom user-mail tags (4.4.0)

The user can find related mail without scrolling through every announcement.
Agents attach `metadata.tags` to `orgtree_message` addressed to `user`; the
user's Inbox offers a searchable dropdown of wrapping coloured tag toggles.
The feature is 4.4.0 only (user 2026-10-17 12:39Z).

## Contract and rulings

User-approved defaults at 12:40Z: at most **8** input tags, each 1-32 Unicode
characters after trimming, case-insensitive matching and deduplication, no legacy backfill and no tags over the mail hub. Blank,
non-string or control-character tags are refused. An empty list is untagged.
User feedback at 19:15-19:54Z replaces the single filter with multiple selected
tags, requiring ALL of them (AND). The list contains only tags actually used by
retained user mail and updates on arrivals/deletions. Selected cards toggle on
and off, search narrows choices, and the closed control shows selections.

The coordinator confirmed an org-wide dictionary keyed by trimmed lowercase
form at 12:41Z: the first committed use supplies the shared display spelling.

Fan-out remains per recipient. A user delivery carries the tags; each non-user
recipient refuses **before attachments or transport**, with the user-only rule.
A mixed list can therefore partially succeed; its result identifies each route.
This does not expand audiences or alter ordinary mail reach. Tagged passive
mail uses `orgtree_message` with `notice:true`; `orgtree_send_notice` retains
its small routing/body schema. The standalone user MCP sends to agents, so it
also refuses nonempty tags.

## Durable storage and reads

Migration 0026 adds `ot.mail_tags(org_id,key,label)` and ordered
`ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)`. No list is embedded in
`ot.mail.extra`. Mail and tags commit together before feed publication.
Dictionary insert keys are sorted to avoid opposite-order lock acquisition;
`ON CONFLICT DO NOTHING` keeps the first committed spelling. Labels are joined
on reads, so every message uses that spelling. Removing mail cascades its
memberships; removing an org cascades its dictionary.

The default user feed and exact-id reads project at most eight labels per
message. Untagged and legacy rows omit the field. `GET /inbox?tag=...` matches
indexed normalized membership **before** a newest-first 200-row cursor window,
across incoming pending/read mail. `before` is exclusive. The multi-select
POST `/inbox/filter` accepts `{tags,before}` (an optional opaque string cursor) and applies every normalized selected
key before the same bounded window; duplicates cannot duplicate mail. Selecting
more than eight distinct tags is valid and returns no matches, because a mail
can carry at most eight tags. Legacy GET single-tag reads remain supported.

`tags_only=true&prefix=...&after=...` returns `tag_choices` and
`next_tag_cursor`. Distinct used keys are cursor-paged by bounded indexed seeks
through memberships; unused dictionary labels never become choices. Search is
case-insensitive substring matching. Its cursor follows scanned keys, including
zero-match pages, so later matches stay reachable. The client continues empty
search pages and offers scroll/Load more for remaining pages. No fixed catalog
cutoff or full-history materialization is needed.

A constant-size `org/user_mail_revision` feed record changes only when a
UserMail invalidation is applied, including successful Inbox Delete. Its opaque
incarnation/revision marker forces a filtered-mail/catalog refresh even when a
deleted older message was outside both visible windows. Unrelated turn/cost
records do not cause tag reads. The renderer projects it as `mail_revision`.

## User inbox

The filter intersects the existing sender/body search. Clearing it restores the
ordinary feed, including untagged mail and asks. The user can click a chip in a
row or its reading pane to toggle that selection. Clicking an already selected
tag removes its filter everywhere: mail rows, the reading pane, filter chips and
the browse popover (user 2026-10-18 10:58Z). Each picker choice closes the popover
and returns focus to its trigger; reopen it to add or remove another tag. Escape
and an outside pointer still dismiss it without changing the selection. Filter
chips are separate buttons beside the browse trigger, without nested buttons.
A fixed tag popover overrides the modal centering transform to stay anchored to
its control.

The filter bar is one field (user 2026-10-18 11:32Z: "it does not look good",
replacing three separate 24px boxes). A single 24px border-box control, also
inside a settings modal, holds a quiet tag-icon trigger, the selected chips, the
message text filter and, while tags are selected, the clear button at its right
end. The trigger reads "all tags" when nothing is chosen. `MailList` passes its
text filter to `MailTagPicker` as `children`; a mailbox without tags shows the
same field holding only the text. Only the field draws a frame: a quiet fill at
rest, the input fill and accent edge while typing, and a hairline between the
tags and the text. Clear still removes only the tags and returns focus to the
trigger; the typed text stays. The popover search is the same compact 24px field.
Ordinary neighbour views, Sent and Record keep their
existing behavior. A new mail reference clears the active tag filter so it can
open its target. The ordinary unread badge keeps the whole inbox count.

Filtered mail uses bounded reads on filter changes, automatic scroll paging and
pushed inbox membership changes, with no additional poll timer. Superseded
requests cannot replace the current filter. Filter failures offer Retry rather
than masquerading as an empty result. Mark-read keeps the ordinary local read
and confirmation paths.

User 12:45Z requested chip colours. `canvas/mailtags.ts` hashes the normalized
key with 32-bit FNV-1a over Unicode code points and maps it to a fractional hue.
Every chip uses that same helper, independent of order/session. Lightness,
chroma and alpha come from one palette per contrast family in `styles.css`
(`--mail-tag-ink`, `--mail-tag-tint`, `--mail-tag-fill`, `--mail-tag-edge` and
their `-on` variants for hover and pressed); only hue comes from the hash. A chip
is a tint of its surface with the hue carried by its text (user 2026-10-18
11:32Z asked for calmer chips; the previous opaque L .88 C .12 fill lay outside
sRGB for most hues and rendered as neon). Every palette value stays inside sRGB
for all 360 hues and keeps 4.5:1 text on each theme's `--bg`, `--input`,
`--panel` and `--panel-2`, at rest and pressed; `tests/mail-filter-bar.test.tsx`
recomputes this from the stylesheet. All surfaces use the same 10px sans nowrap
pill with an ellipsis for long labels, including the mono reading-pane header.
Rows put one tag plus a neutral +N pill at the start of the existing preview
line, on its baseline, keeping sender/kind/time space and the row height.
Pressed popover choices carry a check as well as a stronger tint.
The user inbox omits only the reply.mail kind label/icon, retaining its quote and other kinds. Hashes are deterministic, not a guarantee that all
possible names can have distinct colours.

## Verification

### Selection and hidden unread mail (2026-10-18)

Under a tag filter, the last selected matching message survives reopen and
filter changes. A new mail replaces it only if it carries every selected tag;
unrelated or partially matching arrivals do not move the selection. A deliberate
exact-id read restores an older remembered row without scanning retained history
or assuming a missing client page means deletion. Superseded identity requests
and explicit selections invalidate late lookup answers.

The filtered response includes `hidden_unread`, counted over the server's current
unread set before paging, plus `oldest_unread_id`, the global oldest unread mail
by send time and numeric id. Both apply the same external-inbox visibility policy
as ordinary user mail. More than eight selected tags match no mail but still
return the unread summary. The compact `(x unread)` button is a sibling below
the filter bar, before mail rows. It appears only with active tags and a positive
hidden count. Clicking clears the tags and opens that oldest target through the
existing exact-id route, admitting the returned row to the list with its server
read state. It does not estimate the count from a 200/500-row window.

The pointer-away rule covers the trigger and portal popup in their owning
document, each expanded by 100px. Moving beyond both starts a 250ms grace period;
returning cancels it. Nonempty search text or a held key cancels pointer closing.
Pointer movement from touch is ignored. Closing, unmounting and surface changes
remove listeners and timers; pick, Escape and outside-click behavior is retained.

Focused renderer cases live in `inbox-tag-behavior.test.tsx`; the single compact
row capture is `inbox-behavior-layout.tsx`. Phase-1 validation does not claim a
database/rig proof of the aggregate SQL.

Red checkpoint 9f38a5d executed six engine cases and four mounted UI cases,
all failing at the intended missing behavior. The first UI case reached its
six-mail positive control. Green validation covers normalization, limits,
user-only routes, projections, filter/search/clear/chip interactions, stable
hues, older-match paging and stale-response exclusion. Synthetic author proof
`tools/rig/proofs/mail-tags.mjs` exercises actual migration/tool/API/SQL routes,
including first spelling, partial fan-out, older-than-window results, bounded
pages and opposite-order concurrent tag sets. Record the measured results in
the docket; prepared or skipped checks are not passes. Real provider calls and
live data are outside these tests.

## Deleting a user-inbox message (4.4.0)

The user may permanently delete one incoming message from its row context menu;
the action asks for confirmation and has no toolbar, keyboard or bulk-delete
entry. `DELETE /api/orgs/{slug}/inbox/{id}` removes only the `recipient_kind =
'user'` copy in a short transaction, then prunes tag dictionary labels that no
longer have memberships and publishes `Change::UserMail`. That refreshes inbox,
unread and tag/search views. Sender transcript rows, other recipients' copies
and attachment files are left intact. A non-user mailbox id is not deletable
through this route.

## Feedback verification (prepared)

The rebased engine red de4b832 executes ten cases (three intended failures and
seven controls). Its renderer executes eleven cases: eight intended failures,
one passing control and two invalid reply fixtures, corrected in f5df1f2.
Corrected UI red at3f2cae4 executes eleven cases: ten pass, with one intended
user-inbox reply-label failure after the quote/header/other-kind positive
controls pass. The scoped removal follows that valid red.
`tools/rig/proofs/mail-tags-multi.mjs` covers actual AND ordering/cursors, >200
used tags, orphan exclusion, substring search and Delete-to-revision with an
unchanged visible window. Prepared checks are not passes; the docket records
exact author green/SQL/native-renderer evidence after execution.
