# Multi-replies

The internal desk and user inbox collect several targets from the same sender.
Reply appends and deduplicates; each target can be removed and Cancel All clears
the set. Mixed senders are explained before sending, with an independent engine
refusal. There is one recipient and no fan-out. The external org-inbox viewer
remains a viewer under the signed October 12 rule.

`orgtree_message` accepts `metadata.replies`, a list of 1–50 message IDs from
the mail the caller may already read. Optional `reply_to` must match the first.
All snapshots resolve before admission; inaccessible or mixed-sender targets
refuse the send. Recipient filtering retains only references belonging to that
conversation and reports omitted links. Legacy single `reply_to` stays valid.

The engine persists bounded immutable `replies` snapshots beside the first
legacy `reply_to`. Migration 0021 follows 0020 and adds reverse membership links
for new or changed rows. Old rows normalize as singletons when read; inactive
history is not rewritten. Event references are qualified by org, agent,
generation and event ID, with a card ID for individual mail in a delivered turn.
The server verifies source existence and derives sender/visible prose from the
durable row. Machine state/drive segments never enter new event reply quotes.
The desktop collector projects typed user turns through their visible segments,
even when that leaves an empty quote; it never falls back to a raw envelope.
Other event targets retain the server's immutable quote when streamed text grows.

Local @org publication, hub @net publication, inbox fetch/conversation, holder
copies, transcript/event rows and harness IN REPLY TO blocks carry every quote.
On the existing hub contract, the first hub ID remains `reply_to`; opaque
`meta.replies` carries all ordered IDs (2–50, each <=200 characters, total
metadata <=4096 bytes). Old hubs/clients retain the first structured link and
all quote context in fallback body text; the tool explains that fallback.
Untrusted invalid incoming metadata falls back to the valid first legacy link;
IDs are never inferred from body text. Conversation-qualified lookups prevent
cross-contact snapshots. Combined metadata and fallback text count toward
transport bounds before queuing.

Hubchat uses the existing answers metadata without new fields: shared body text
answers text-target cards, while valid picks answer only their own cards. An
empty question reply skips it. Picks/text are exclusive per card within one
send, superseding alpha.4's per-send separation. No hub schema/runtime/pin
change is required. Orgtree records linked replies; it does not invent a new
question-state database or infer answer identities from quote lines.

Verification is pending the assigned Rig batch. The native scratch proof is
`tools/rig/proofs/multi-replies.mjs`; mounted renderer cases are
`apps/desktop/renderer/tests/multireply.test.tsx`. Red desktop controls override
only the base desk/mail collectors, keeping the current reference/rendering
helpers. Source parsing and whitespace inspection are not runtime validation.
No install, real sends, live data or device acceptance is included.
