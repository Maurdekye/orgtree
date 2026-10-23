# Selection replies

User decision 2026-10-23: implement Reply to selection for 4.4.4 (renumbered by the user on 2026-10-23) on mail,
settled transcript prose/tool inputs/results/displayed thoughts, Markdown
presentations and docket fields. Keep plain replies; exclude interactive HTML
and persistent comment threads. All supported desktop surfaces use the same engine contract.

## Identity, validation and storage

Legacy reply strings and typed identities keep their meaning. A new reply target
can wrap an identity as `{target, selection}`. The selection supplies a known
part/tool/pointer/list entry, `projection: source-v1`, a SHA256 of exact UTF-8
source bytes, `unit: unicode-scalar` and half-open `start`/`end`. Submitted quote
prose is refused. One indexed authorized source lookup derives the immutable
exact excerpt, up to 256 UTF-8 bytes of context on either side, captured revision
and original selector inside the existing JSON reply snapshot. No migration,
historical rewrite or comment service is needed. Dedupe includes the selector,
so two different passages of one source coexist with its whole-object reply.

At send resolution, a changed digest refuses without a delivery. Captured
snapshots retain whitespace/newlines and are never passed through `gist()`.
Limits: eight selected passages, 4,096 UTF-8 bytes per excerpt, 48 KiB combined
selection metadata and a 1 MiB canonical part. Existing fifty-target limits
remain. Source reads return at most 4,096 UTF-8 bytes per window with scalar
offsets and digest-bound continuation. JSON inputs use decoded strings or
deterministic pretty JSON; keys use an explicit object-property role.

## Authority and privacy

The shared domain source loader has an explicit user/agent reader. Agent mail
uses ordinary sent/received custody; transcript parts require inspection and
self/downward access plus generation; docket text uses its existing ACL;
Markdown presentations require authorship or current project reach. User source
reads use authenticated org routes. Missing sources, machine state/envelopes,
unretained parts, HTML and current running transcript turns refuse. Sources
never read native provider files, consume mail/queue custody or mark documents
viewed. Ordinary tool-input redaction runs before projecting a part.

List entries without durable IDs refuse duplicate text, and remain confined to
their captured field/index. Relocation never searches another list entry or
object. A current exact digest/range is exact; otherwise only a unique exact
excerpt **and** its captured nearby context can relocate. Zero/multiple matches
are Source changed; unavailable authority/source remains Source unavailable.
In all cases the delivered original snapshot remains readable as mail.

Selection/source-window payloads may contain displayed thoughts. They are omitted
from verbose logging, including nested JSON/MCP text representations. The private
HTTP source route omits bodies before authentication and on rejected child routes.

## Agent and desktop interfaces

`orgtree_read_reply_source` is inspection-gated and returns canonical windows and
the digest used by `orgtree_message` selection wrappers in split/flat shapes.
`orgtree_read_transcript` retains bounded recent rows, adding event/revision IDs
and current generation for exact source discovery. Selection snapshots remain in
ordinary inbox fetch/chunk/project copies under existing custody. Internal
recipients only in this slice: there is no Hubchat selection transport contract.

`POST /api/orgs/{slug}/reply-source` accepts `target`, `part`, optional scalar
`offset`, `expected_sha256`, and a previously delivered `selection` for a verified
`location` result. It is read-only. Ordinary desk send resolvers derive selected
quotes server-side and recheck transcript/conversation membership.

## Desktop mapping and composer custody

Markdown capture compares the full non-whitespace semantic projection against
the owning DOM before returning source offsets. Lexical token positions preserve
repeated-text identity without matching a selected string to a guessed occurrence.
Ref chips and math are atomic; code/canonical source retains exact UTF-8/CRLF.
Unknown projections and gestures crossing parts refuse. Captured descriptors and
the nearest concrete composer are fixed before focus/metadata work. Source digest
checks run at staging and send. The selection context-menu override is explicit
and limited to noneditable text; ordinary native menus remain unchanged.

The mail reply box carries separate selected targets, keeps unrelated explicit
whole-message targets, and restores failed selections/drafts under the original
recipient key. Read quotes show their retained exact excerpt and nearby context;
current source checks never replace that snapshot with newly edited text.
Embedded docket sends merge an explicit object target with every staged selected
passage, in either staging order, through the same plural target wire as mail
and presentations. [verified: `canvas/docket.tsx`,
`tests/objectcomposer.test.tsx`; 2026-10-23]

The source-read tool is marked deferred via the existing per-card hint. This
defers it only on harnesses that honor native tool-search/deferred loading; do
not claim a universal zero prefix cost. The focused card snapshot test records
compact UTF-8 bytes for this definition and the base/extended split/flat message
cards, with the schema costs separated. These are bytes, not tokenizer estimates.

Desk draft conversion must retain the durable mail ID for string mail targets,
typed mail-card targets and event targets: `mail:<id>` requires matching
`mail_id` at source admission. The `presentation` identity alias uses the same
document draft field as `document`. [verified: `eventReply.ts`,
`selectionreply.test.tsx`; 2026-10-23]

## Verification scope

Focused source fixtures cover exact whitespace/Unicode/ranges, stale digests,
unique and ambiguous relocation including overlapping matches, continuation,
schema/refusal/aggregate bounds, redaction, visible-user projection, range-aware
dedupe, split/flat tool contracts and log/wire privacy. Phase 1 uses a cheap
predecessor control, one focused Rust run and cargo check. These are not live
database, installed-app, external transport or native mouse acceptance claims.

## Transcript slice and prefix budget

The desktop now maps settled prose and displayed thoughts through their exact event identity, including original source offsets for ordered content blocks. Expanded tool input/result scalar fields use RFC6901 pointers; raw views must match the exact canonical projection. Full retained failed-shell output is supported. Current-turn admission is still rechecked by the engine, and no hidden/sealed source is exposed.

Selection snapshots survive transcript reply persistence, multi-reply deduplication, pending cards and sent quote rendering. The source navigation registry accepts only a server-verified range/digest, reverses the same conservative DOM projection, and scrolls the nearest overflow owner. Existing fold/paging/object routes still open the source; no quote substring search is used for navigation.

The eager message definition retains its prior identity schema and adds a minimal wrapper only. Detailed selection explanation lives in the deferred source-read definition and Guide. A focused serialized-card control compares both split and flat schemas with the frozen exact 4.4.2 schema and caps the eager delta at 800 compact UTF-8 bytes.

## Presentation and docket replies

Markdown presentation title/body capture stages in the nearest owning reader reply box. Its existing direct reply or project broadcast callback carries the selected targets; no new fan-out route is invented. HTML capture is disabled. Docket title/objective/current reason/progress entries/evidence notes use distinct parts and list indices. The canonical docket reply endpoint validates all selections before mail send and attention clearing, retains its current recipient roles, and refuses selection targets belonging to another item. Ordinary replies keep the old path.

Folded source navigation reveals the existing disclosure and highlights only after the exact current projection matches the server-verified digest. A missing/mismatched rendering keeps the captured excerpt. This is a plain reply feature, with no resolve/unresolve thread state.

Clipped prose/plain tool displays verify their entire shown prefix against digest-bound canonical windows before staging, so the clipped copy never substitutes its digest for the retained full part. Pending transcript cards keep a local captured snapshot while outgoing wires remain selector-only. The recursive dispatcher/listener Send proof is erased at the existing watchdog fire-action heap boundary, retaining awaited order and task-local depth. The local source-read boundary and larger compiler recursion limit did not resolve the contained compile failure and were removed.

Transcript discovery retains bounded supplied thinking, sealed/truncated markers and incomplete/interrupted flags alongside selection event/revision IDs. A mixed readable/sealed row can expose its supplied readable summary; a sealed-only empty part remains unavailable. Ciphertext is never a source part.
