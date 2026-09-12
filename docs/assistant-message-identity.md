# Assistant transcript message identity

Readable assistant prose has one visual row per provider message occurrence. A
partial, a completed live message and its native transcript record are successive
representations of that occurrence. Two messages with identical words remain two
messages when their occurrence identities differ.

This contract covers an agent's own assistant transcript messages. Mail, status,
system notices, tools, reasoning and command output keep their existing behavior.

## Why the earlier fixes were incomplete

The audit started at `b7f3329` and covered these fixes and their tests:

| Earlier change | What it established | Remaining gap |
| --- | --- | --- |
| `329d887`, `9a98409` | One event ID per view, with the freshest copy | Drafts, final messages and native records still used different identity domains |
| `4aa9fe2`, `e6a93cd`, `3b874bf` | Shared native UUID for live/final rows; rendering prefers native IDs to reply IDs | Partial text had no corresponding native identity; a global draft handover could retire another message |
| `80b4e72`, `eb74702` | Correct projection of replay and automatic-wake inputs | Input projection did not solve assistant partial/final reconciliation |

Reply event IDs intentionally identify immutable quote revisions. They change as
text grows, so they cannot identify the visual message. The remaining text-prefix
and timestamp rules could also mistake a distinct identical message for a saved
copy. Those inference rules are no longer used to retire assistant prose.

## Identity and transport

`assistant_id` identifies an occurrence and stays constant as its text changes.
It is a UUID derived from source and provider identity, never message words or
arrival time. `assistant_scope` binds it to the transcript incarnation and native
session. Clearing reply quotes does not change that scope. A different session
does; an archived predecessor keeps its own scope.

| Producer | Occurrence identity |
| --- | --- |
| Claude and Claude-compatible lanes | Native message ID plus text-block ordinal, within the native source generation |
| Codex | Native turn ID plus item ID, within the session; an attempt token covers protocols without a turn ID |
| Antigravity | Attempt token plus provider step index, within the session |
| Owned journals | The emitter's explicit `assistant_id` is copied into the native record |
| Historical native prose without a message ID | Native record UUID, when available; unidentified records are kept separately |

Claude can emit several records with one message ID. The parser counts text
blocks, including empty blocks, and reuses the assignment when a record UUID is
replayed. Tail reads include the response boundary so requesting more history
does not change those ordinals. A native record containing several blocks carries
`assistant_ids` for all of them and replaces their partial representations.

Provider text batching preserves the owning item of every fragment, including
interleaved items. Its flush holds the emission lock through delivery, so a final
callback cannot overtake an already-extracted timer batch. Codex adopts the actual
thread ID in `on_thread`, before publishing held output; input acceptance and
account confirmation keep their existing later transitions.

Every outgoing typed prose event carries `assistant_row`: a **full snapshot**,
with a monotonic `assistant_revision`, `partial` or `complete` state, and its first
observation's time and order. Repeated or reversed websocket deliveries therefore
never append the same text twice. The existing `event_id` and `reply_quote` still
identify the exact quoted revision independently of the visual row.

## Durable state and reconciliation

The existing `transcript-records.sqlite3` stores two additional tables:

- `assistant_messages`: the latest observed snapshot, committed before it is
  published, with a stable first-observation order and a materialization flag.
- `assistant_receipts`: identities proved present by native transcript projection.

A receipt remains valid after a row leaves the current page, after a backend
restart and after its provider file disappears. Repeated reads of established
receipts do not write again. An index bounds the pending-snapshot lookup to the
requested conversation and materialization state.

| Current evidence | Incoming evidence | Result |
| --- | --- | --- |
| None | Partial snapshot | Insert one partial row |
| Partial revision N | Partial revision greater than N | Update the same row |
| Partial revision N | Duplicate or older partial | Keep revision N |
| Partial | Completed snapshot | Replace text and mark complete in the same row |
| Complete | Late partial or repeated completion | Keep complete |
| Snapshot | Matching native record | Native row replaces it; retain a durable receipt |
| Native receipt, including a paged-out receipt | Delayed stream event | Carry `assistant_materialized`; refresh without reviving the snapshot |
| Interrupted/failed/idle turn without a native receipt | Refresh or restart | Retain the partial and label it `partial response` |
| Any occurrence A | Distinct occurrence B with equal words | Keep both |

The browser applies the same rule at stream ingestion, current-page refresh,
history gap filling, older-page loading and final rendering. Native records beat
retained snapshots; complete beats partial; otherwise revision decides freshness.
Rows keep their first position and React key. All mounted views use the same
conversation state. A changed session discards the old session's pending state and
rejects its delayed frames.

## Covered lifecycle cases

Backend coverage lives in `tests/test_assistant_identity.py`; renderer coverage in
`apps/desktop/renderer/tests/assistantidentity.test.tsx`. The backend tests use real
isolated SQLite databases and journals. Adapter tests execute the production
Codex and Antigravity event callbacks with isolated transports, not copied logic
or a provider process. Renderer tests mount `DeskChat` in jsdom and inspect both
the visible rows and committed conversation state.

| Case | Backend | Renderer |
| --- | --- | --- |
| Partial grows, then final and native record replace it | Stable identity; immutable quote revisions | Same DOM node; one row at every observed state |
| Native arrives before final websocket event | Native receipt wins | No second row |
| Native saved before this window has ever seen it | Receipt travels with late event | Paged-out message does not revive |
| Duplicate/reversed websocket snapshots | Full revision snapshots | Older text cannot replace newer text |
| Replayed native record or item completion | Same occurrence remains one row | Native representation wins |
| Late delta after completion | Completion is monotonic | Complete row cannot reopen |
| Interleaved items; reversed completions | Codex items and Antigravity steps retain their identities/order | Equal independent occurrences stay separate |
| Equal words and equal timestamps | Different IDs survive | Two visible rows |
| Raw Codex item ID reused in another turn | Different occurrence IDs | Covered by distinct-ID controls |
| Missing Codex item ID | Separate local occurrence through completion | Identity-free rows never collapse by words |
| First Codex thread publication barrier | Actual session adopted before held output | Session scope guard |
| Claude split records, empty text blocks, multi-block records | Matching ordinals/aliases across small and large tail windows | Multi-block row absorbs each owned partial |
| Failed/interrupted/idle turn | Partial retained | Partial remains readable when idle |
| Backend restart | Verified in a fresh Python interpreter | Reconnect plus cleared conversation state reconstructs rows |
| Retire/rehire and compaction predecessor | Same-session partial preserved; successor isolated | Session-change guard |
| Provider transcript file removed | SQLite history stays readable | Normal native-row rendering |
| Older pages and partial-only history | No skipped or repeated occurrences at page boundaries | Older native page replaces retained partial with the same row ID |
| Clear saved reply quotes | Transcript identity stays stable | Existing reply/event suites remain compatible |
| Two windows on the same agent | Shared persisted identity | Both windows show the same single representation |
| Tool, reasoning, command, mail and system compatibility | Existing live/reply/transcript suites | Full renderer suite, including event deduplication and replies |

## Validation and limits

At the review checkpoint: 20 new backend lifecycle tests, 97 related backend tests,
1,474 renderer tests and TypeScript checking pass. The related backend suites are
live durable identity (25), chat windows (21), transcript records (24), transcript
ingestion (3), managed transcripts (3), reply snapshots (5), reply lifecycle (4),
Codex account-switch resume (7), native resume (2), and pending chat identity (3).

Negative controls distinguish passing code from ineffective tests: the parent
`_sweep_live` implementation erases the second identical message and fails the new
preservation test; the patch passes it. Disabling reconciliation only in a built
renderer test bundle fails two targeted tests while seven controls still pass.

The change retains interrupted partial prose as a transcript row with a small
`partial response` label. Reply IDs continue to name exact snapshots; their source
resolution must be preserved when integrating other reply-preview work.

The guarantee relies on provider occurrence IDs and ordered provider delta
protocols. Arbitrary replay of an identity-free raw delta is indistinguishable
from a genuinely repeated fragment. Such events and historical records are never
collapsed by text guesses. Raw provider processes and visible application windows
were not used for this verification. The patch awaits coordinator review and
integration; it has not been landed, pushed or deployed.
