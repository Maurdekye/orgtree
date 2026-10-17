# Custom user-mail tags (4.4.0)

The user can find related mail without scrolling through every announcement.
Agents attach `metadata.tags` to `orgtree_message` addressed to `user`; the
user's Inbox offers a typed tag filter with suggestions and clickable chips.
The feature is 4.4.0 only (user 2026-10-17 12:39Z).

## Contract and rulings

User-approved defaults at 12:40Z: at most **8** input tags, each 1-32 Unicode
characters after trimming, case-insensitive matching and deduplication, one
active filter, no legacy backfill and no tags over the mail hub. Blank,
non-string or control-character tags are refused. An empty list is untagged.
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
across incoming pending/read mail. `before` is exclusive. Tag suggestions are
bounded to 200 keys and may use a prefix; the editable filter still accepts an
exact tag beyond those suggestions. No count/full-history materialization is
needed for paging. `tags_only=true` requests just suggestions.

## User inbox

The filter intersects the existing sender/body search. Clearing it restores the
ordinary feed, including untagged mail and asks. The user can click a chip in a
row or its reading pane. Ordinary neighbour views, Sent and Record keep their
existing behavior. A new mail reference clears the active tag filter so it can
open its target. The ordinary unread badge keeps the whole inbox count.

Filtered mail uses bounded reads on filter changes, automatic scroll paging and
pushed inbox membership changes, with no additional poll timer. Superseded
requests cannot replace the current filter. Filter failures offer Retry rather
than masquerading as an empty result. Mark-read keeps the ordinary local read
and confirmation paths.

User 12:45Z requested chip colours. `canvas/mailtags.ts` hashes the normalized
key with 32-bit FNV-1a over Unicode code points and maps it to a fractional hue.
Every chip uses that same helper, independent of order/session. Saturation and
lightness are fixed by the dark/light contrast palette in `styles.css`; only
hue comes from the hash. Hashes are deterministic, not a guarantee that all
possible names can have distinct colours.

## Verification

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
