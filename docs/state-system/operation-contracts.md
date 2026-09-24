# P01: executable contract coverage

This bounded package builds on source-inventory commit
83b2fe414ff416418b4bd45bc7a27bfbb16350fd and frozen v6 design
b830a69bd71b0cee052e78acfe1ceff6b399532765db7ed55d05a253f0f84dfd.
It supplies a checked contract format, reservation, material-read, structural
diagnostic and isolated-preview families, with public-boundary fixtures.
**P01 remains incomplete.** It changes no
backend entry point, database, permission, receipt, dependency or product behavior.

## Two separate questions

The default command answers whether the registry is structurally valid and
still bound to the current source:

    python tools/state_operation_contracts.py

The completion command additionally requires every obligation and every
contract dimension to be resolved:

    python tools/state_operation_contracts.py --require-complete --details

Exit 0 means the requested check passed, 1 means invalid or stale contracts,
2 means malformed/unreadable input, 3 means structurally valid **but
incomplete** coverage, and 4 means the wrong interpreter: nothing was checked.
The committed registry deliberately returns 3 for the completion command.
Both commands always report runtime_census=false and
conversion_authorized=false, even for a complete synthetic fixture. Neither
static source review nor a JSON edit can satisfy P02/P03 or authorize conversion.

Run it with the provisioned Python 3.13 runtime (`engine/runtime/python.exe`).
The inventory's `syntax_sha256` fields hash the interpreter's AST dump, which
changes between Python minor versions, so any other version would report every
witness as rebound and the registry as stale (the unguarded CLI reported 22
false errors under 3.10). The CLI therefore refuses any version but 3.13.

There is no automatic write/refresh mode. Source edits require an intentional
inventory refresh AND contract reassessment. Regenerating the inventory alone
does not refresh the contract's pinned digest or line-span hashes.

## Data model

operation-contracts.json uses schema orgtree.state-operation-contracts/v1.

| Part | Checked requirement |
|---|---|
| source_inventory_sha256 | SHA256 of canonical UTF-8 JSON for the full current inventory; sorted keys, compact separators, unescaped Unicode. Whole-module hashes invalidate helper changes, including unrecognized registrations. |
| entries | Exactly one disposition for each of the 319 inventoried registration sites. Pending, mapped or source-backed exclusion. HTTP/WS/tool entries cannot be excluded as false positives. |
| dispatch | Exactly one disposition for each of the 227 selector witnesses. A branch is evidence, not another operation. |
| storage | Exactly one disposition for each of the 15 connection candidates. Unknown sockets/factories remain visible. |
| contracts | Source-entry bindings, optional tool/action selector, explicit argument normalization and conditional variant, domain mode and all nine dimensions. |
| facets | Source-span-bound assertions for authority, reads, writes, predicates, conflicts, wire, receipt, effects and instrumentation. An unresolved facet requires concrete open questions. |
| wire_cases | Executable selector cases for every contract/entry pair; zero, multiple or wrong matches refuse. These are selector fixtures, not complete API-result fixtures. |

Each source reference records path, inclusive start/end lines and SHA256 of
that exact span after universal newline decoding. Paths must be in the pinned
backend module set. Source witness IDs for dispatch/storage are SHA256 of
canonical JSON [group, inventory_row]; registration entries retain the
inventory's site_id. They identify source evidence, not runtime operation IDs.

The small condition language supports always, not, non_null_any and truthy_text.
It never evaluates code. Action normalization is explicit contract data:
identity, str_or_empty, or str_or_empty_strip_lower. A null action means no
action restriction. Other entry families may need additional reviewed selector
operators; they remain pending until their actual behavior is represented.

Facets intentionally contain human-readable source assertions. The validator
checks their source binding, dimensions, references and honest unresolved
status; **it does not prove that prose accurately describes effects**.
Independent review, canonical result/refusal fixtures, native conflict tests and
observed contact comparison remain necessary. Filling every field with plausible
text is not semantic verification.

## Reservation contracts and public boundary

Both tool names bind the same eleven variants: ordinary list, scope-checking
list, landing query, overlap query, acquire, renew, recover, invalidate,
release, release-with-successor and land. All nine public action names are
covered; the alias retains the same behavior while its distinct tool name
remains part of the legacy receipt fingerprint.

The selector cases cover explicit nulls, empty/non-null candidate, base-only
input, action normalization and empty/false successor. Tests compare list's
read/write split with the current pure document helper on synthetic data.
Empty candidate selects the write-capable branch even when validation refuses.
The helper does not perform the actual public transaction.

Important source behavior is retained:

- Every action is TX_POST in the public receipt classifier, including a domain
  read. Domain mode must not be presented as the actual database contact set.
- Integration-key replay precedes the retained-row cap, which precedes ordinary
  same-owner acquire replay. The cap counts all 512 retained rows, including
  terminal rows. Its native admission mechanism remains unresolved.
- A named resource exposes bounded contention metadata, not private item paths,
  receipts or mutation permission.
- Scope changes do not steal a live claim; recovery requires quiet heartbeat
  and an expired lease or non-live owner, using the stored stale threshold.
- A successful release can stage mail/authority effects and a later wake.
  A RELEASED retry returns notified:null. LANDED is terminal and refuses release.
- land reports a Git action; it runs no Git command. A scope mismatch mutates
  the helper's temporary row before raising. The public refusal now has a
  fixture proving that the change is discarded, including after a later save
  and a cold reload.

Within the reservation family, two registration sites and fourteen dispatch
witnesses map to these variants. Source-backed reservation/item authority and
legacy receipt semantics are specified. So are the release notification
(`notify-effect`) and the public wrapper's writes (`wrapper-writes`): what each
outcome commits, measured on the cold-read document, and the one durable
diagnostic row. The wrapper's reads (`wrapper-reads`) and its observed contacts,
including agent-level mail locality (`contacts`), are specified from P02's
per-operation contacts. Native conflicts, full malformed-input parity and
runtime probes remain unresolved. Material reads add two cards and two selectors; structural
diagnostics add two cards and two selectors. Preview adds one card, twelve
simulation selectors and the shared three-tool diagnostic/preview branch.

Current totals are 18 contracts, nine mapped registrations and 36 mapped
dispatch witnesses. **578 obligations remain**: 310 registrations, 191 dispatch
witnesses, 15 storage candidates and 62 unresolved dimension occurrences.
How it got there: 600 was two more registrations than the preceding 598 because the scanner now
recognizes `asyncio.to_thread` hand-offs; both new witnesses are pending and no
existing witness identity, disposition or contract changed.
604 was four more than that 600 because the P02-A1 attempt census adds three
operator HTTP routes under `/api/diagnostics/operation-census` and one
`body.tool` dispatch branch for the agent read door. All four new witnesses are
pending with no contracts and no source evidence, the contract count is
unchanged at 16, and no carried witness changed its disposition, its reason or
the contracts it binds. 141 witness identities were rebound and 521 source spans
relocated because `api.py` grew; each carries its own proof.
610 is six more than that 604 because two later features added surfaces that
were inventoried and left pending, but never counted here or given a reason of
their own: the account capacity-mark work (`80b28bf`) adds GET
`/api/accounts/{account_id}/marks`, POST `.../marks/clear`, the
`orgtree_account_mark` tool card and its `body.tool` branch in `agent_call`, and
the external charter template folders (`b41dcf1`) add GET and PUT
`/api/app-settings/charter-template-dirs`. All six now carry an explicit
pending reason naming their origin; none gained a contract or source evidence,
and no other witness changed.
598 is twelve fewer than that 610 because two shared facets were specified:
`notify-effect` (used by one contract) and `wrapper-writes` (used by all eleven
reservation contracts). No witness changed; only dimension occurrences closed.
587 is eleven fewer than that 598 because `wrapper-reads` (used by all eleven
reservation contracts) was specified from P02's observed per-operation contacts
on synthetic data (`tools/p02_operation_contacts.py`, `p02-operation-contacts.md`).
Its read set is one union per call, and the phases are bounded by refusal and
keyed rows (a reviewed ruling). `contacts` gained the same observed facts but
stays open: the probe is table-granular, so it cannot give the agent-level
mail-locality control that facet asks for. `tests/test_state_p02_contact_facets.py`
re-runs the probe and asserts every observed fact.
576 is eleven fewer than that 587 because `contacts` (used by all eleven
reservation contracts) was specified once P02 observed agent-level mail
locality (6721cad): release-notify's mail contacts belong only to the named
successor, never the sender alone, and a third-agent control fires. The legacy
mail queue is one org-wide row, so that result rests on the logical before/after
reading plus the per-agent `nodes`/`log_d` rows.
578 is two MORE than that 576, and that is expected (S3 ruling 1): the first
P03-prototype candidate maps seven witnesses (two tool cards and five dispatch
branches, -7) to two new contracts, `status.report` and `chart.read`, whose
nine facets P01 cannot close add nine unresolved dimension occurrences (+9).
See "P03-prototype surface" below.

Of the 53 open dimension occurrences on the sixteen legacy-family contracts, 37 (17 facets) cannot be closed at P01
from the evidence that exists. Their questions need observed runtime contacts
(P02) or a chosen and qualified native PostgreSQL design (the separately staffed
conflict/predicate design, then P03/P05). Each such facet keeps its original
question and adds one line naming its owner, the evidence that would close it,
and why the available evidence does not. The P02 real-data replay
(20260924T063643Z) does not replay these tools, so it closes none of them. The
per-operation probe closes `wrapper-reads` and `contacts`. Every other
P02-owned facet still has a
clause the probe does not meet: the JSON backend, malformed state,
legacy/recovery and migration paths, sandbox chown, provider failure modes,
native placement or simulation design, or native controls. The remaining 16 are the
four wire facets. Their legacy parity is now fixtured at the public door:
- malformed-argument matrices, with the 500 serializer's exception-echo body
- the agent/operator/bridge door matrix for every P01 tool
- the preview per-operation matrix
- diagnostic behaviour over corrupt stored nodes

Recorded defects are kept as legacy behaviour, not approved. Examples: NaN
`stale_s` accepted, a corrupt node failing the whole-org inspection,
`revoke_dir` accepting any `dir`, and a bridge org secret acting as any node
(`p05-authority-review-bridge-org-secret-acts-as-a`). Each wire facet stays open
for its native/Rust clause. `material.wire`'s legacy transcript projector is
fixtured too (`p01-transcript-projector-legacy-fixtures`): every row type
`supervisor._read_chat_source` handles, as an agent sees it through
`orgtree_read_transcript`. Two findings are recorded: an envelope prompt with no
prompt-view row reaches the reader raw, and a malformed content block fails
the whole read with a 500.
This is not a runtime operation count or progress percentage. See the separate
family documents for their measurements and remaining obligations.

`reservation-boundary.json` binds to the canonical hash of this registry and
requires both aliases and every variant. It records complete top-level and
reservation-row field sets for each chosen fresh-response fixture, plus the
legacy receipt projection. It is not a schema for every possible response:
terminal replay, malformed inputs and shared-wrapper variants still need
coverage before the wire facet can be closed. The fixture checker refuses a
missing variant/alias, stale binding, extra top-level field or forged
qualification. Registry source hashes separately catch implementation drift.

`tests/test_state_reservation_boundary.py` runs the real `/api/agent` HTTP door
through authentication, dispatch, legacy receipt admission, document mutation
and SQLite commit/reload. Every organization and credential is synthetic, under
temporary data and home roots. The app lifecycle is not started; provider
wakes, delivery text and the UI mail hint are spies. Nothing connects to a live
organization or PostgreSQL. The suite establishes:

- Both tool names produce the expected fresh shape and values for all eleven
  variants. Selected normalization, lease, path and absent/null cases are pinned.
- Docket participants, reviewers, creators and relevant ancestors can read
  reservation metadata, including archived-item placement. Unrelated callers
  receive only the HELD contention projection when they name the resource;
  that projection confers no mutation authority.
- A successor's item access alone does not make it addressable. A failed
  `post_mail` check discards the reservation release. Successful release commits
  reservation, mail, reply-audience grant and keyed receipt before the wake.
- An injected exception before save leaves no domain/mail/grant/receipt change.
  An injected wake failure after commit leaves durable state, and keyed retry
  reports the receipt without repeating the wake. This does not prove eventual
  delivery, crash recovery or exactly-once external effects.
- Keyed reads may append receipts even when reservation data is unchanged.
  Retried requests return a receipt envelope, not the original full response.
  Alias, normalized-argument and action-spelling fingerprints are distinguished.
- The legacy replay path checks authentication but precedes fresh item
  authorization; a captured result remains in the replay after item access is
  revoked. This records existing behavior, not a waiver of v6 current-disclosure
  checks. Native conversion must assess that deliberate difference explicitly.
- A lookup fences an eligible absent key before its delayed original executes.
  After custody epoch rotation, an existing applied receipt remains positive
  evidence, while absence is unknown and writes no new fence.
- Receipt lists keep at most 128 projected rows per result. The receipt log's
  500-to-400 eviction rule advances its watermark past the greatest evicted
  mint time, including future-skew and later backwards-clock cases. A still
  retained matching receipt can replay even below that watermark.

The reservation cap still counts 512 retained rows across the organization,
including terminal rows. Its native conflict/admission policy has not been
chosen or qualified. Similarly, the legacy receipt watermark is an existing
mechanism to model, not permission to add a shared write gate to the new system.
The packet's native per-owner custody and narrow conflicts remain required.

## P03-prototype surface (S3)

The narrow P03 prototype needs status, mail, receipt replay, charter read,
funding, atomic staffing, strict read and UI feed (v6 MIGRATION-AND-QUALIFICATION,
P03 row). At v3 `88c1390` the P01 gap census flagged 70 witnesses by keyword. The
reviewed surface is 51 witnesses: 42 of those 70 plus 9 the keyword scan missed
(`orgtree_send_notice` and its branch, the human-to-agent mail route, node detail,
the `/api/agent` hire and staffing branches). 28 flagged witnesses are outside it:
the charter TEMPLATE library and its folder settings, organization deletion,
outside-org and EXTERN mail, inbox clear, docket evidence receipts, and docket
attachments, deletion, acceptance, attention and reply. "Strict read" is read as
an authoritative read of item or agent state. The item is read through the two
work-item GET routes only (S3 ruling 2): the `orgtree_work` card must cover all 36
actions to be mapped, so it stays pending. The shared `/api/agent` door stays
pending until every `body.tool` branch has a contract.

Contracts are added family by family: F1 status and read, F2 mail, F3 funding,
staffing and receipt replay, F4 item read. A new contract adds nine dimension
slots, so pending changes by minus the witnesses mapped plus the new unresolved
occurrences, and it may rise (S3 ruling 1). Each candidate reports both numbers.

Candidate 1 (F1, first half) adds `status.report` (`orgtree_status`) and
`chart.read` (`orgtree_chart`, which is also the agent's charter read and credit
view). It maps both cards, both exact branches, the shared read-shaped block
(together with the two material contracts), and the shared mail-family result
ref and transcript chip selectors (whose message and notice contracts come with
F2). Specified from source and pinned by `tests/test_state_status_chart_boundary.py`
against `status-chart-boundary.json`: authority, predicates, writes, receipt and
effects for status; authority, predicates, receipt and effects for the chart.
Unresolved with an owner: reads and instrumentation (P02), conflicts (native
design), wire (native/Rust conversion) for both, and the chart's cold/migration
writes (P02). Recorded legacy behaviour, not approved: the status value is not
validated server-side, reporting is case-sensitive, the summary has no length
cap, an explicit null `include_standing_charter` omits the standing charters, and
the chart's own default for a missing visibility is unreachable because Org
construction backfills it as full.

## Deliberate failing controls

Tests remove entries, actions, connections, dimensions, source bindings and alias
cases; duplicate or substitute witnesses; map a route to an unrelated contract;
forge qualification; erase unresolved status; overlap conditional branches; and
label scope-checking list read-only. Each must be rejected. A helper write and
an unknown registration invalidate prior source evidence. Source scanning never
imports the backend. Public-boundary tests additionally substitute two unsafe
behaviors in the isolated test process: saving a helper mutation before its
refusal, and ignoring a committed replay. Each must fail the same assertion
that passes against the unchanged implementation; a marker proves that the
intended unsafe branch actually ran. These controls change no product files.

Continue P01 by resolving entries/facets and full wire/receipt fixtures under
review. The preserved http-cover census implementation is input to P02, not
silently imported or enabled by this package. Use the PostgreSQL qualification
record for the separate package-adoption gate.


## Isolated preview boundary

`preview-boundary.json` and `tests/test_state_preview_boundary.py` pin the
authenticated agent preview allowlist, selected operator-surface distinctions,
ordinary ledger authority on a detached document, fresh retries and selected
result/refusal behavior. Whole persisted-document comparisons and unsafe
clone/save controls distinguish a simulation from real state changes.

The actual clone materializes unrelated retained history. Account validation
does not imply account/session simulation parity, and provider preflights are
not proven effect-free. Only the bounded legacy authority and receipt facets
are specified; the seven other facets retain concrete open questions. See
`preview-boundary.md`. Neither a successful preview nor this P01 package
authorizes a native conversion.
