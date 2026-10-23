# Selection replies

User decision 2026-10-23: implement Reply to selection for 4.4.3 on mail,
settled transcript prose/tool inputs/results/displayed thoughts, Markdown
presentations and docket fields. Keep plain replies; exclude interactive HTML
and persistent comment threads. This document records the engine foundation;
desktop capture and source mapping follow in their own slice.

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

## Verification scope

Focused source fixtures cover exact whitespace/Unicode/ranges, stale digests,
unique and ambiguous relocation including overlapping matches, continuation,
schema/refusal/aggregate bounds, redaction, visible-user projection, range-aware
dedupe, split/flat tool contracts and log/wire privacy. Phase 1 uses a cheap
predecessor control, one focused Rust run and cargo check. These are not live
database, installed-app, external transport or native mouse acceptance claims.
