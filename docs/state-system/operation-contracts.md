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

The small condition language supports always, not, non_null_any, truthy_text,
equals (exact equality of one named argument with one text value) and all (a
conjunction of at least two conditions, every part evaluated). equals and all
were added for the operator ops door, which dispatches on `op` and treats
`preview` as a separate read (S3 decision 7).
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

Current totals are 41 contracts, 29 mapped registrations and 49 mapped
dispatch witnesses. **631 obligations remain**: 290 registrations, 178 dispatch
witnesses, 15 storage candidates and 148 unresolved dimension occurrences.
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
581 is five MORE than that 576, and that is expected (S3 ruling 1): the first
P03-prototype candidate maps four witnesses (two tool cards and their two exact
dispatch branches, -4) to two new contracts, `status.report` and `chart.read`,
whose nine facets P01 cannot close add nine unresolved dimension occurrences (+9).
592 is eleven more than that 581 (S3 candidate 2): three routes are mapped (-3)
to `org.tree`, `org.node-detail` and `org.feed`, whose unresolved facets add 13
occurrences (five shared `org-view` facets on two contracts, three `org-feed`
facets), and the shared diagnostic/preview branch `dd72cf1a` returns to pending
(+1, S3 decision 3).
596 is four more than that 592 (S3 candidate 3): six witnesses are mapped (-6) —
the two mail cards, their two exact branches, and the two shared mail-family
selectors that candidate 1 had to leave pending — to `mail.message` and
`mail.notice`, whose five unresolved shared `agent-mail` facets add ten
occurrences (+10).
612 is sixteen more than that 596 (S3 candidate 4): four operator routes are
mapped (-4) to `mail.human-send`, whose five unresolved `human-mail` facets add
five, and to `mail.user-inbox`, `mail.user-inbox-read` and `mail.node-inbox`, whose
five unresolved shared `inbox` facets add fifteen (+20).
599 is thirteen fewer than that 612 (P01 S2d): P02's probe (v3 0679103 and 3a2ec7b)
now observes what thirteen occurrences' Owner lines asked for, so those facets are
specified from its rows: `diagnostic.reads`, `diagnostic.writes` and
`diagnostic.effects` (two contracts each), `preview.writes`, `preview.effects`,
`status.reads`, `status.instrumentation`, `chart.reads`, `chart.writes` and
`chart.instrumentation`. `tests/test_state_p02_contact_facets.py` re-runs the probe
and asserts each new fact. S2d also corrects an S3 fact: at `self` visibility the
chart does NOT hide the superior, because the CLAUDE.md caveat names it (pinned as
legacy behaviour).
604 is five more than that 599 (S3 candidate 5): seven witnesses are mapped (-7) —
the request-credits and reallocate cards and branches, the credit-decision route
and its two ledger action branches — to `credits.request`, `credits.reallocate`
and `credits.decide`, whose four unresolved shared `funding` facets add twelve
occurrences (+12).
611 is seven more than that 604 (S3 candidate 6): seven witnesses are mapped (-7) —
the hire and staff cards and branches, the shared hire|staff harness selector, the
staff half of the rehire-rename selector and the staff receipt-coverage branch —
to `staffing.hire`, `staffing.staff-create` and
`staffing.staff-update`, whose four unresolved shared `staffing` facets add twelve
occurrences (+12); and candidate 5's two `credit_request_action` branches return to
pending (+2, S3 decision 5), because the uncontracted inbox batch submit
(`Org.resolve_batch`) reaches them too. The three `_staff_call` action branches
stay pending for the same reason: the uncontracted quick-staff route calls
`_staff_call` as the user.
616 is five more than that 611 (S3 candidate 6b): three witnesses are mapped (-3) —
`org_op`'s hire harness branch and `_org_op_locked`'s hire and reallocate branches —
to `operator.hire` and `operator.reallocate`, whose four unresolved shared
`operator-ops` facets add eight occurrences (+8). The ops route entry itself stays
pending: its other operations are uncontracted.
625 is nine more than that 616 (S3 candidate 7a): the four staffing-chooser routes
are mapped (-4) to `quick-staff.options`, `quick-staff.options-refresh`,
`quick-staff.preview` and `quick-staff.select`, whose four unresolved shared
`quick-staff` facets add sixteen occurrences (+16), and `_staff_call`'s three action
branches map back (-3) now that both of its callers are contracted.
631 is six more than that 625 (S3 F4): the two work-item GET routes are mapped (-2)
to `work.item-list` and `work.item-get`, whose four unresolved shared `work-read`
facets add eight occurrences (+8). The `orgtree_work` card and its four tool
selectors stay pending with the ruling-2 reason.
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
view). It maps both cards and both exact branches. Three SHARED selectors stay
pending with a reason naming what is and is not contracted: the read-shaped
block (`orgtree_send_file` and `orgtree_list_tiers` have no contract and are
outside the surface) and the mail-family result ref and transcript chip
(`orgtree_message` and `orgtree_send_notice` come with F2, which maps them). A
shared selector is mapped only once every tool it admits has a contract;
`tests/test_state_operation_contracts.py` enforces that for every mapped In/Eq
tool selector. The one older branch that broke the rule, `dd72cf1a` (the
diagnostic/preview block, which P02-A1 widened with `orgtree_operation_census`),
returned to pending in candidate 2 (S3 decision 3). Specified from source and pinned by `tests/test_state_status_chart_boundary.py`
against `status-chart-boundary.json`: authority, predicates, writes, receipt and
effects for status; authority, predicates, receipt and effects for the chart.
Unresolved with an owner: reads and instrumentation (P02), conflicts (native
design), wire (native/Rust conversion) for both, and the chart's cold/migration
writes (P02). Recorded legacy behaviour, not approved: the status value is not
validated server-side, reporting is case-sensitive, the summary has no length
cap, an explicit null `include_standing_charter` omits the standing charters, and
the chart's own default for a missing visibility is unreachable because Org
construction backfills it as full.

Candidate 2 (F1, second half) adds the operator UI's read surface: `org.tree`
(GET `/api/orgs/{slug}`) and `org.node-detail` (GET `.../nodes/{nid}/detail`),
which share one projection and so one set of `org-view` facets, and `org.feed`
(the org websocket). Specified from source and pinned by
`tests/test_state_org_view_boundary.py` against `org-view-boundary.json`:
authority (the desktop token gate, 404s, kiosk scoping and scrubbing),
predicates (ETag revalidation, archived summaries, detail selection), receipt and
effects for the view; authority, predicates, reads, writes, receipt and effects
for the feed. Unresolved with an owner: the view's reads, cold/migration writes
and instrumentation (P02), conflicts for both (native change-feed design) and
wire for both (native/Rust), and the feed's instrumentation (P02). Recorded legacy
behaviour: the first ETag a cold org serves is already stale, a valid agent
credential on these GETs is refused as "invalid or expired", the socket route
accepts an organization that does not exist, and in desktop-managed mode an org
document carrying `kiosk` makes the admin tree and node detail answer 500 (the
warm-process eligibility check catches only `RuntimeError`, but the desktop
policy raises `ValueError`) while the public view still serves. A kiosk config
without a ceiling also mints a fresh ceiling notice on every cold load. The kiosk
listener is started only by api.py's own `main()`, not by the desktop launcher.

Candidate 3 (F2, agent mail) adds `mail.message` (`orgtree_message`) and
`mail.notice` (`orgtree_send_notice`), which share one set of `agent-mail`
facets because both go through `Org.post_mail`. With both contracted, every tool
the shared mail-family result ref and transcript chip admit has a contract, so
those two selectors are mapped too. Specified from source and pinned by
`tests/test_state_agent_mail_boundary.py` against `agent-mail-boundary.json`:
authority (§7.2 addressing, the §7.3 reply grant, user and outside-party rules),
predicates (recipient resolution, kind, urgency, attachments, archived and
unknown recipients), writes by recipient class (agent, user, @org:, @mcp:, @net:)
and receipt. Unresolved with an owner: effects (P07: the destination-org write of
`interorg_send` and the @net: drain are spied, not exercised), reads and
instrumentation (P02), conflicts (native design) and wire (native/Rust). Recorded
legacy behaviour: empty bodies are delivered, any `kind` but `notice` is accepted,
and an agent may message itself, which drives its own turn.

Candidate 4 (F2, the human side) adds `mail.human-send` (POST
`.../nodes/{nid}/message`) and the three inbox routes, `mail.user-inbox`,
`mail.user-inbox-read` and `mail.node-inbox`, which share one set of `inbox`
facets. Specified from source and pinned by `tests/test_state_human_mail_boundary.py`
against `human-mail-boundary.json`: for the send, authority (the operator acts as
the user and reaches any node; §7.4 deep reach), predicates (refusals, the
session-command split, notices, attachments, archived recipients), writes and
receipt (client_op is not an idempotency key); for the inbox routes, authority,
predicates, receipt and effects. Unresolved with an owner: the send's effects
(P08: the session-command branch and /compact's background compaction), reads and
instrumentation (P02) for both, the inbox cold/migration writes (P02), conflicts
(native design) and wire (native/Rust). Recorded legacy behaviour: marking user
mail read broadcasts a tree change even when nothing was read.

Candidate 5 (F3, funding) adds `credits.request` (`orgtree_request_credits`),
`credits.reallocate` (`orgtree_reallocate`) and `credits.decide` (POST
`/api/orgs/{slug}/credit-requests`), sharing one set of `funding` facets. Specified
from source and pinned by `tests/test_state_funding_boundary.py` against
`funding-boundary.json`: authority (top-level-only requests, downward-only
reallocation, the operator decides as the user), predicates (whole-credit rounding,
amend and withdraw, the committed floor, pending-only decisions, moot and dry run),
writes, receipt and effects (a decision is user mail plus one ping). Unresolved with
an owner: reads and instrumentation (P02), conflicts (native balance-row design) and
wire (native/Rust). Recorded legacy behaviour: a keyed credit request's receipt
retains nothing of the request, a fractional delta moves a whole credit, and a zero
delta still logs an event. The operator `org_op` reallocate branch goes with the
staffing candidate, which contracts `org_op`.
Correction (S3 decision 5): candidate 5 mapped the two `credit_request_action`
branches (approve, and the approve|deny check) saying they were reached only from
the decision route. The inbox batch submit (`Org.resolve_batch`) reaches them too,
and it is uncontracted, so candidate 6 returns both to pending with that reason.

Candidate 6 (F3b, agent-door staffing) adds `staffing.hire` (`orgtree_hire`) and
`staffing.staff-create` / `staffing.staff-update` (`orgtree_staff`, one contract per
card action), sharing one set of `staffing` facets. Staff's rehire mode (a `node`)
is specified inside the staff contracts; `orgtree_rehire` itself is outside the
accepted surface and stays pending, and so does the account-binding receipt branch
it shares. Specified from source and pinned by `tests/test_state_staffing_boundary.py`
against `staffing-boundary.json`, with the provider gate patched off as machine
state: authority (destination inside the caller's subtree, strict scope clamp,
audience rules, rehire authority), predicates (no defaults, superior mode, credits on
the chain, staff action and mode), writes (seat and item in one save, a superior
insertion), receipt (TX_POST, or PRE for a named rehire-mode staff) and effects (one
drive per started seat). Unresolved with an owner: reads and instrumentation (P02),
conflicts (native design) and wire (native/Rust). The tool infers an omitted staff
action, which the selector DSL cannot express, so the selector cases name it.
`_staff_call`'s three action branches stay pending until quick-staff is contracted,
because that route reaches them too (S3 decision 5); `tests/test_state_operation_contracts.py`
now pins the known multi-caller helpers (`_staff_call`, `Org.credit_request_action`)
and refuses a mapped witness inside one while any of its callers is unmapped.
Recorded legacy behaviour: a hire started only by an audience grant is told its turn
starts on a kickoff it never sent; rehire-mode staffing of a live agent is not
refused; a named rehire-mode staffing renames the node before the transaction, so a
later refusal leaves it renamed; and an inserted superior's seat is paid out of the
anchor's own grant. The operator `org_op` hire and reallocate branches switch on
`op`, which the selector DSL cannot express either; they follow in their own
candidate.

Candidate 6b (F3b, operator ops) adds `operator.hire` and `operator.reallocate` on
POST `/api/orgs/{slug}/ops`, sharing one set of `operator-ops` facets, and the two
selector operators they need (S3 decision 7): `equals`, because the route
dispatches on `op`, and `all`, because `preview: true` turns a reallocate into a
separate read-only simulation that the write contract must not claim. Hire selects
on `op` alone, and its preview is a refusal the contract states. Specified from
source and pinned by `tests/test_state_operator_ops_boundary.py` against
`operator-ops-boundary.json`, with the provider gate patched off: authority (the
desktop token gate, the user as default actor, an agent named as actor gets that
agent's rules), predicates (required fields, user defaults and lenient clamps, the
anchor's scope for `above`, delta required and rounded up), writes, receipt (none:
a retried hire seats a second agent) and effects (one broadcast, no drive).
Unresolved with an owner: reads and instrumentation (P02), conflicts (native
design) and wire (native/Rust).

Candidate 7a (F3b, the operator staffing chooser) adds `quick-staff.options` and
`quick-staff.options-refresh` (GET and POST `/api/orgs/{slug}/staffing-options[/refresh]`),
`quick-staff.preview` and `quick-staff.select` (GET and POST
`/api/orgs/{slug}/work-items/{wid}/quick-staff`), sharing one set of `quick-staff`
facets. Specified from source and pinned by `tests/test_state_quick_staff_boundary.py`
against `quick-staff-boundary.json`, with provider discovery, the provider gate,
account reasons and efforts patched to a fixed offer as machine state: authority (the
desktop token gate; the commit acts as the user), predicates (backlogged tickets only,
the configured mode, the stale-context refusal, the snapshot a commit accepts),
writes (reads and the refresh write nothing durable; request and immediate commits),
receipt (the commit's own request-id receipt and replay) and effects (one
`quick_staff` ping per driven node, the compensating undo in request mode,
`kickoff_failed` in the immediate modes). Unresolved with an owner: reads and
instrumentation (P02), conflicts (native design) and wire (native/Rust). With both
of its callers contracted, `_staff_call`'s three action branches map back, each to
the contracts that take it: the create branch to `staffing.staff-create` alone,
because quick staff always sends action update. Recorded legacy defect: a
request-mode commit whose kickoff is refused on a ticket with empty progress lists
fails with an unhandled 500 and undoes nothing. The operator ops door's kiosk-visitor
path is now pinned too (the candidate 6b reviewer's note).

F4 (the strict item read, S3 ruling 2) adds `work.item-list` and `work.item-get`
(GET `/api/orgs/{slug}/work-items[/{wid}]`), sharing one set of `work-read` facets.
Specified from source and pinned by `tests/test_state_work_read_boundary.py` against
`work-read-boundary.json`: authority (the desktop token gate; the user as viewer),
predicates (the legacy-identity 409, the derived archive and backlog split, 404s),
writes (none: a read derives the archive and never sweeps it), receipt and effects
(none). Unresolved with an owner: reads and instrumentation (P02), conflicts (native
snapshot isolation) and wire (native/Rust). The `orgtree_work` tool card (36
actions) and its four tool selectors stay pending with the ruling-2 reason: the full
card is the P05 work family.

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
