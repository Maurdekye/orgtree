# Shift+F4 mention navigation

The main-window function-key table binds Shift+F4, including while typing.
Separate presses visit the newest then older recorded `@user` mentions in the
current org. It includes seen entries, does not wrap, and restarts at the newest
when a newer entry arrives. Empty history says “No @user mentions yet”; the end
says “No older @user mentions”. Failed reads leave the position unchanged.
Queued presses are serialized; changing org invalidates in-flight responses.

History starts at 4.4.2. Startup seeds each active org once from at most 2,000
still-pending candidates per source: live-agent markers, active ticket markers
and recent pending user-inbox envelopes. It does not scan old transcripts or delivered
mail, or backfill cleared markers. The feed retains the newest 2,000 mentions per
org, ordered by timestamp and identity, independently of attention/read state.
It uses the existing transcript-per-turn and ticket marker identities and the
mail producer's existing prose mention parser, including its code exclusions.

Migration 0053 creates a dedicated indexed feed. Agent/ticket marker triggers
record in the producer transaction; ordinary mail, local cross-org publication
and mail-hub inbox/outbox writes record their existing envelopes in the same
transaction. Mail body and urgency-reason prose use the existing mention parser.
Same-identity excerpt updates preserve the
original ordering. An org-local state row serializes insertion/pruning; reads
use `(org_id, at DESC, id DESC)` cursors with one destination per response and
no inactive-history scan. The org FK key-share precedes the feed guard, and
cross-org envelope pairs record in org-id order. Agent renames update destinations. Source deletion
removes its entries; retirement and reading do not.

Agent jumps reuse the desk's exact event identity, history loading and mention
highlight behavior, with generation checks. Mail/ticket jumps use their existing
readers. Matching original prose is centered and highlighted; when an edit has
removed it, a clearly labelled retained excerpt supplies the recorded mention
and timestamp. Deleted or no-longer-readable destinations keep the readers'
existing refusal behavior rather than redirecting to another item.

This is UI navigation. Agent tool parity already exists through
`orgtree_read_transcript`, `orgtree_inbox` and `orgtree_work get`; no new
agent authority or tool is added. Settings renders the same function-key table
as the matcher. The glossary's `orgtree-app-keyboard-shortcuts` page owns the
user-facing reference.

Sources: user m5c9a92bca6d8 chose Shift+F4 (2026-10-22); the coordinator's flagged
defaults choose backward stepping/no wrap/seen inclusion and the 4.4.2 baseline
(m6003e46e8f81, mec06fbc099af). The 2,000-entry retention is an implementation
choice within that assignment. Migration 0052 belongs to the held DnD work;
check 0053 numbering again during integration.
