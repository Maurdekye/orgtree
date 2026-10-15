# Multi-replies

The internal desk and user inbox collect several targets within one transcript
or conversation, regardless of author (USER correction 2026-10-14 23:11Z).
Reply appends and deduplicates; each target can be removed and Cancel All clears
the set. Different authors are allowed; another transcript is refused by both
the collector and engine. There is one recipient and no fan-out. The external org-inbox viewer
remains a viewer under the signed October 12 rule.

`orgtree_message` accepts `metadata.replies`, a list of 1–50 message IDs from
the mail the caller may already read. Optional `reply_to` must match the first.
All snapshots resolve before admission; inaccessible or cross-conversation targets
refuse the send. Recipient filtering retains only references belonging to that
conversation and reports omitted links. Legacy single `reply_to` stays valid.
Plural tool replies require one recipient. The global user inbox keys collection
by its recipient agent; mail from several authors inside one agent's transcript
is unrestricted. Operator event references must belong to the endpoint's agent;
plural mailbox references must be mail that agent received or sent.

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

## Sender correction verification — 2026-10-15, Rig round 445

The corrected source removes author-based checks from the desk/mail collectors,
tool/domain admission and whole-turn quotes, while retaining source identity,
visibility, generation, bounds and transcript/conversation membership. New
focused cases combine agent/user events and mail from several authors, keep
every reference and one recipient, and refuse another transcript or fan-out.
The revised renderer predecessor control includes `eventReply.ts` as well as
desk/mail. Rig-sol-b measured the final candidate Orgtree `37b00ff` and Hubchat
`0ddfa14` under the shared lock and kernel Jobs:

- Actual-engine scratch proof passes20/20. Initial18/20 had two proof contract
  mistakes, corrected only in `e346e03`: user recipient_name is canonically
  `@user`, and HTTP reply snapshots use the existing one-line `gist(text,4000)`.
  Original event content and visible paragraph projection remain unchanged.
  The corrected proof reused the same product-identical `05729d5` engine;
  original failed receipts remain preserved.
- Mounted desk/inbox checks pass6/6. Exact `a47bb16` desk/mail/eventReply
  collectors produce exactly4 target failures and2 passing controls.
- Hubchat focused core passes4/4. Mixed-author browser checks pass35/35;
  exact `9d46e62` Conversation red gives4 named failures and31 controls.
  Preparation regression passes40/40. Rig inspected all18 green/red captures.
- Engine units pass255/255 and all-targets check passes. Clippy retains106
  baseline warning lines, with none newly attributed to changed locations.
  Root and Hubchat typechecks pass. Strict renderer/tests diagnostics remain
  baseline29/830, with no added or removed normalized diagnostics.

The full renderer does not pass:3519 pass,88 baseline failures and4 skips
(not executed). Rig attributed the one added failure name to the existing
context-menu B4 assertion under its new title, reproduced at untouched base;
the allocation-failing worklifecycle case remains explicitly skipped, not fixed.
Source audits retain6 baseline hub-isolation environment errors. These are
qualified source-specific results, not a clean full-suite claim.

All runtime used synthetic scratch state/fake CLI and browser/DOM fixtures.
No native installed-app, real Android device or external-hub transport
acceptance is claimed. The coordinator integrated the verified source locally
at rust-engine `8d4c570` and Hubchat main `0ddfa14`; it was not yet in a built
alpha at that point. Build/delivery are separate coordinator steps; the source
author ran no competing runtime/build jobs.

## Historical verification — 2026-10-14, Rig round 438

These receipts predate the 23:11Z correction. The sender-refusal checks from
that round verify the superseded interpretation and are replaced in the
current focused cases; unchanged reference/quote behavior remains covered.

Rig-opus approved Orgtree `d2d56f9` on `0f8638f` and Hubchat `c5cf473` on
`4f3db23`. Checks ran under the shared build lock and per-step kernel Jobs,
using synthetic data. Measured results:

- Engine build and all-targets check pass; clippy retains the base diagnostics
  with none on changed lines. The focused engine unit union passes 39/39.
- `tools/rig/proofs/multi-replies.mjs` passes 16/16. Eleven neighbouring rig
  proofs pass, covering mailbox, hub replies, isolation, user audience, phone
  linking, question options and conversation recall.
- Migration 0021 on a copy of a scratch database filled by the old engine passes
  17/17. Legacy mail/inbox rows remain byte-identical except the new empty
  `replies` field; old snapshots normalize on read, without history backfill.
- Mounted desk/inbox multi-reply checks pass 6/6; replacing only desk/mail with
  the predecessor produces exactly five target failures and a passing legacy
  control, in both the standard harness and the portable verifier. Focused
  chatreply/replysource/multireply suites pass 30/30. The later source control
  reproduces the immutable stream-quote and nested-source identity regressions.
- Root typecheck has zero errors. Strict renderer and test configurations have
  the same 29 and 825 errors as their baselines. The full 3,493-test renderer
  run retains baseline failures: worklifecycle's allocation failure reproduces
  at base (the tip aborts that file); the other six tests pass separately.
  A GL-mode failure clears on two isolated 15/15 reruns. No persistent new
  renderer regression remains in the measured comparisons.
- Hubchat browser multi-reply checks pass 33/33, with exactly 22 predecessor
  target failures and all 11 controls passing. The full three-question phone
  sequence runs in the Android browser layout; desktop mixed sending is also
  covered by the mounted composer proof, which passes 40/40 with exactly 23
  predecessor target failures. Full questions pass 84/84, core 229/229,
  Escape 8/8 and first-send 6/6; typecheck passes with no new clippy issues.

Limits are retained: hosted real-hub transport of `meta.replies` was not
measured; native payload builders and synthetic delivery seams were exercised.
There was no native app build, device acceptance, install, live-data write or
real chat send. Generated-event drift and the stale mailhub-version assertion
match base. The transfer-upload restart check failed once in four tip runs
(three base runs passed); timing is suspected, but its cause is unproved.
Python verification lacks `anyio` in the measured environment, and source
audits retain the base environment errors. These are not clean-suite claims.
