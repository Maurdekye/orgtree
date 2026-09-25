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
| entries | Exactly one disposition for each of the 333 inventoried registration sites. Pending, mapped or source-backed exclusion. HTTP/WS/tool entries cannot be excluded as false positives. |
| dispatch | Exactly one disposition for each of the 227 selector witnesses. A branch is evidence, not another operation. |
| storage | Exactly one disposition for each of the 18 connection candidates. Unknown sockets/factories remain visible. |
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

Current totals are 128 contracts, 87 mapped registrations and 158 mapped
dispatch witnesses. **673 obligations remain**: 237 registrations, 62 dispatch
witnesses, 14 storage candidates and 360 unresolved dimension occurrences.
From P01 F1 on, progress is reported as three numbers (coordinator ruling Q1, decision 1 on
p01-f1-contracts-for-the-org-lifecycle-and-catal): **entries contracted 54/194** (of the concrete http,
websocket and tool entries that were on the generic reason; F1b contracts none of them, since the
operator door had its own reason; F3 contracts thirteen; F2 twenty-two; the relaunch-cards item none of
them, since its three contracted entries are new witnesses outside the 194), **360 open dimension
occurrences** and **673 total pending**. Total pending RISES while the 194 are contracted, to about 790-1000 when all
twelve families have landed, and that rise is expected: each new contract closes its entry but opens
its own conflicts, wire and instrumentation dimensions until P03, the native conversion and P02 answer
them.
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
634 is three more than that 631 (S3 candidate 7b): the client's refused-lookup branch
is mapped (-1) to `receipt.lookup`, whose four unresolved `receipt-lookup` facets add
four occurrences (+4). The agent door entry stays pending by precedent.
632 is two fewer than that 634 (the native-design citation): `preview.reads` and
`preview.predicates` become specified (-2), because their "Closes with" clauses ask
only for the approved design, which r7 now is. See "Native conflict/predicate design" below.
612 is twenty fewer than that 632 (P01 S2e): P02's probe now observes what twenty
occurrences' Owner lines asked for on the S3 read and mail families, so those facets
are specified from its rows: `org-view.reads` and `org-view.writes` (two contracts
each), `org-feed.instrumentation`, `agent-mail.reads` and
`agent-mail.instrumentation` (two each), `human-mail.reads` and
`human-mail.instrumentation`, and `inbox.reads`, `inbox.writes` and
`inbox.instrumentation` (three each). The instrumentation facets close under S2d
decision 1: their "Closes with" clauses are legacy-only. Three facets gain observed
facts but stay open, each with an owner line narrowed to what remains:
`org-view.instrumentation` (the public gateway's token-map rebuild reads every org
before any census attempt exists, so it cannot be attributed; its question is
rewritten to that), `agent-mail.effects` (P07) and `human-mail.effects` (P08).
`tests/test_state_p02_contact_facets.py` re-runs the probe and asserts each new fact.
See "P03-prototype surface" below.
606 is six fewer than that 612 (P01 S2f): P02's funding rows (v3 b78c6ca, re-observed at
56a9c22) cover every outcome the funding Owner lines name, so `funding.reads` and
`funding.instrumentation` are specified on all three funding contracts. The
instrumentation facet closes under S2d decision 1. Its one out-of-set contact is not the
operation's: a warm raise or zero delta that follows a row which changed `f-kid` re-reads
that node row through the agent door's snapshot refresh (`api._agent_identity` ->
`store.cached_org` -> `_assemble_snapshot`), which a reordered run (S2f artifact r1) shows
is carried over from the previous row. S2f also corrects the `funding.reads` source fact
(under `DOC_LOCK`, `load_org` is the resident document) and names all three automatic
notices that withhold the reply grant (review finding f1).
600 is six fewer than that 606 (P01 S2g): P02's staffing rows (v3 56a9c22) cover every hire
and staff class the Owner lines name, so `staffing.reads` and `staffing.instrumentation` are
specified on all three staffing contracts. The instrumentation clause's locality set is widened
to the intended hire fan-out (the new seat's parent and peers, and for a superior insertion the
anchor and its reports), following the user ruling recorded at `ledger.hire`'s notices and the
coordinator's ruling that it is not a defect. Its warm third-agent reads are the same snapshot
carry-over S2f settled.
The citation of the approved design extension r3 (below) changes no status, so the 600 stands.
592 is eight fewer than that 600 (P01 S2h): P02's operator-ops and chooser rows (v3 845b2c7 and
b4a702b) cover `operator-ops.reads` and both families' instrumentation, so those are specified
(2 + 2 + 4). Both locality sets are widened to the intended hire fan-out, as S2g did for
staffing: for the operator door the target's whole ancestor chain (a raise writes each ancestor
its shortfall reaches), the new seat's parent and peers, and an above-hire's anchor and its reports; for the
chooser the new seat's parent and live peers. `quick-staff.reads` stays open, narrowed to the
staffing snapshot's own provider, account and effort reads, which P02's fixture patches out.
586 is six fewer than that 592 (P01 S2i): P02's docket-read and receipt-lookup rows (S3 F4,
v3 220e557) cover `work-read.reads`, `work-read.instrumentation`, `receipt-lookup.reads` and
`receipt-lookup.instrumentation`, so those are specified (2 + 2 + 1 + 1). The docket reads load
outside the document lock, so a warm read is a fresh load of all five tables, never the
resident. A lookup's warm reads depend on the resident's state, and the only row it writes is
the caller's own fence.
584 is two fewer than that 586 (P01 S2j): the coordinator ruled that P02's reviewed probe-level
record meets `diagnostic.instrumentation`'s clause, so it is specified. Three P02 facets are
narrowed to what the probe cannot reach: `org-view.instrumentation` to the gateway's token-map
rebuild, `material.reads` to a disk-backed sandboxed org, and `material.effects` to a successful
chown. The lookup's warm reload is now measured, not inferred (the reviewer's mutant on S2i).
580 is four fewer than that 584 (P01 S2k): of the 15 storage candidates, source reading excludes
the four that are not org state, each with a covering source reference: the kiosk share URL's
LAN-address socket, the liveness port probe, and the two read-only opens of the Antigravity CLI's
own conversation database. None is mapped. The org store and every sidecar the probe observes are
shared with uncontracted operations, so under the shared-selector rule they stay pending, and
every pending candidate now says why.
567 is thirteen fewer than that 580 (P01 W1, the first step of the coordinator-approved witness
triage W1-W8, whose rules are decision 1 on its item): of 21 plumbing registrations, source reading
excludes 13 that are not org-state operations: three router includes whose routes are inventoried
on their own, the static asset mount, two exception handlers, the shutdown hook and the git
scheduler stop, four disk mount calls the scanner took for route mounts, and the CLI tool-name
vocabulary. Eight stay pending with an owner: the startup hook, the three stdout pumps that feed a
turn's events, and the four stderr pumps, whose tails a failed turn reads into its failure record
(a usage-limit failure freezes the node).
560 is seven fewer than that 567 (P01 W8): of 33 machine, client and presentation dispatch rows,
source reading excludes seven: the two that swap a tool card in the agent-side MCP catalogue and
call nothing, and five branches in separate HTTP-client processes (externtool's four verbs,
mcptool's file delivery) whose called backend route is itself inventoried and carries the
obligation (the coordinator's ruling). The other 26 stay pending with an owner: per-node process
control, the V1 import's recovery resolution, git push, pull and cleanup on registered
repositories, two transcript rendering branches, and the agent door's tool naming. The
recovery resolution's only production caller is a launcher route in `engine/launch.py`, outside
the inventoried backend module set.
560 stands after P01 W2: none of the 30 provider and machine worker registrations is excluded. Even
the Antigravity status probe fills a process-wide cache that the hire gate and the turn launcher
read (the review fix). All 30 stay pending with an owner: the status probe, Codex and Antigravity event
callbacks and steer pumps, the cold MCP pump, warm-pool prewarm and keeper, the credential watcher and
usage loop, the freeze-reset refresh, the sandbox warm-up, the workspace-usage walk and the git
workspace reads and fetch (P08 or the git workspace feature), and the @net: mail hub loops (P07).
`tests/test_state_operation_contracts.py` now also checks that every excluded witness belongs to a
reviewed triage step.
559 is one fewer than that 560 (P01 W3 and W4, reviewed together). W3 triages the last 32
non-concrete registrations, the org-state background workers: it excludes only the startup
recovery's completion event, the same path W1 excluded through the shutdown hook, and gives the other
31 an owner (the runtime, channels and mail, watchdogs, the desktop import and maintenance, the
agent door, the staffing snapshot). W4 closes nothing: it names the tool and owner on each of the
40 agent-door branches for tools that have no contract.
558 is one fewer than that 559 (P01 W5 and W6, reviewed together). W5 names the owner of the 37 docket-family
branches (the `orgtree_work` card, P05, S3 ruling 2) and of `_attach_ref`'s present branch. W6 does
the same for 26 operator-operation, preview-simulation and receipt-helper branches. One of them,
`opreceipts.result_slice`'s reservation branch, is reached only by the 11 contracted reservation
variants (each files an applied receipt), so under rule 1 it is mapped to them.
W7 closes nothing: it names the owner of the last 30 generic dispatch branches (watchdog
actions and the watchdog tool, the audience tool and route, prime restart and relaunch, remote
control, and the desktop maintenance request, which the launcher installs as the self-restart and
prime restart hook). After W1-W8 no
dispatch witness and no non-concrete registration keeps the generic reason; the remaining generic
rows are concrete http, websocket and tool registrations.
571 is thirteen MORE than that 558, and that rise is correct: the inventory was undercounting
(p01-inventory-misses-the-production-routes-mount). The scan now covers the engine's own top-level
modules and `engine/winservice`, not only `engine/backend`. That adds 17 witnesses: the ten
production routes `engine/launch.py` mounts (the V1 import recovery read, which saves the org, and
its resolve write; desktop status, identity, notifications and shutdown; the maintenance ack and
failure; the mail hub read and configure), its router include and server task, one worker each in
`process_lifetime.py` and `service_host.py`, and three mail hub store connections. Four are
excluded (the router include, the server task and the two startup readers); thirteen stay pending
with an owner. The launcher also installs the self-restart hook (W7's review fix), another path the
backend-only scan could not see. `engine/native/**/oracle` (offline test-vector generators) and
`engine/runtime` (the gitignored interpreter) are not scanned, and a test fails if any other engine
file with a route, hook, task, worker or connection site is left out.
The owner-form step (p01-put-the-owner-of-the-35-older-pending-rows-i) closes nothing: 35 older
pending rows (the operation census, account marks, charter template folders, the `orgtree_work`
card, shared selectors, the S2k storage sites and two thread hand-offs) now state their owner as
`Owner: ...`. Every pending witness names its owner that way except the concrete http,
websocket and tool entries still on the generic reason (194 then, 175 after F1), and a test holds that.
590 is nineteen more than that 571, and the rise is expected (P01 F1,
p01-f1-contracts-for-the-org-lifecycle-and-catal). F1 contracts the org lifecycle and catalogue entry
points: nineteen contracts on nineteen entries, twelve agent tools (rename, retool, retire, dissolve,
cheap_compact, rehire, move, swap, self_subjugate, switch_model, list_orgs, list_tiers) and seven operator
routes (node account, reorder, compact, dissolve-all, lineage recover and drop-phantom, repair-rename), on
nine shared `lifecycle.*` facets. Authority, reads, writes, predicates, receipt and effects are specified
from source and pinned by `tests/test_state_lifecycle_boundary.py` against
`docs/state-system/lifecycle-boundary.json`; conflicts, wire and instrumentation stay open (P03 and P05, the
native conversion, and P02, which probes the family after it lands). Nineteen dispatch branches that only
these tools reach are mapped. The plan listed twenty entries: the external-chat server's `orgtree_list_orgs`
card calls `GET /api/orgs`, a different handler, so it moves to the external-chat family (F4). The fixture
records seven legacy defects, among them that retire and dissolve interrupt the target's turn before the
call can still be refused, and that a move to the node's current parent answers before any authority
check (tracked on backlogged retire-and-dissolve-interrupt-the-target-s-runni and
lifecycle-tool-receipts-and-admission-keyed-rena).
608 is eighteen more than that 590, and the rise is expected (P01 F1b). F1b contracts the operator ops
door's remaining operations (rename, retire, rescind, cheap_compact, rehire, dissolve, delete,
switch_model, promote, demote, move, reseed, revoke_dir) and its preview: fourteen contracts on the one
door, which is now mapped, with 23 of its branches. They reuse the operator-ops facets (coordinator
ruling Q5), except conflicts and instrumentation: the existing operator-ops.conflicts closes on design
schedules that cover hire and reallocate only, and operator-ops.instrumentation is specified from P02
rows that do not cover these operations, so the variants have their own unresolved
`operator-ops.variant-conflicts` and `operator-ops.variant-instrumentation`. `tests/test_state_operator_
variants_boundary.py` pins the facts against `docs/state-system/operator-variants-boundary.json`. The
preview simulation's `move_batch` branch is mapped although no door admits that operation name.
635 is twenty-seven more than that 608, and the rise is expected (P01 F3,
p01-f3-contracts-for-asks-reports-scope-requests). F3 contracts asks, reports, scope requests, watchdogs and audiences: 22 contracts on
thirteen entries, seven agent tools (orgtree_watchdog and orgtree_audience per action, S3 ruling 2) and six
routes (the ask answer, the inbox batch, the operator's watchdog and audience actions, the audience list,
and the operator scope route, which joins `lifecycle.*`), on three new facet families `asks.*`,
`watchdogs.*` and `audiences.*`. `tests/test_state_requests_boundary.py` pins them against
`docs/state-system/requests-boundary.json`. Contracting the inbox batch submit maps the two
`credit_request_action` branches S3 decision 5 held back. Recorded legacy defects: a forwarded report mails
the superior but wakes nobody; several receipts keep nothing; the watchdog list saves and broadcasts; the
operator's audience grant wakes the grantee with "new mail" but posts none (tracked on
a-report-forwarded-to-the-superior-is-mailed-but, the-watchdog-list-saves-and-broadcasts-and-the-o and
keyed-orgtree-request-credits-receipt-keeps-noth).
663 is twenty-eight more than that 635, and the rise is expected (P01 F2,
p01-f2-contracts-for-the-run-control-entry-point). F2 contracts the run-control entry points: 26 contracts on
22 entries (interrupt, unstick, continue_on, halt, unhalt, self_restart, prime_restart and restart_wake per
action, and fourteen operator routes) on the new `control.*` facets, pinned by
`tests/test_state_control_boundary.py` against `docs/state-system/control-boundary.json` with every process
effect replaced by a spy. Each contract states its behaviour per product profile where `desktop_policy` changes
it (decision 1 on the F2 item): under the desktop-managed profile the standard restart tools are refused and
the kiosk route is stripped (`desktop_policy.install_routes` also strips `/git/` and two account-key routes,
which F8 and F10 will state). The branches the desktop relaunch verbs reach stay pending until their tool
cards are inventoried (p01-inventory-misses-the-desktop-relaunch-tool-c), and three branches stay pending on
the card-less `orgtree_self_update` alias.

673 is ten more than that 663 (P01 relaunch-cards item, p01-inventory-misses-the-desktop-relaunch-tool-c). The
scanner missed two kinds of entry point. It read only the `TOOLS` catalogue, so mcptool's
`_DESKTOP_RELAUNCH_CARDS` (the `orgtree_self_relaunch` and `orgtree_prime_relaunch` cards the desktop-managed
profile swaps in) were not entries; and it knew nothing of the names the agent door dispatches without any card.
It now reads any module-level literal of tool cards as a catalogue, and records every `body.tool` operand, through
literals, sets, starred constants and other modules' constants, as a `tool_verb` entry when no card carries the
name (`unresolved_tool_refs` counts an operand it cannot resolve; it is 0). That adds nine entry witnesses: the two
cards and seven verbs (`orgtree_self_update`, `orgtree_send_file_once`, `orgtree_op_call`, `orgtree_op_epoch`,
`orgtree_op_lookup`, `orgtree_operation_census` and `orgtree_account_assign`). The validator treats a
`tool_verb` like a card: it cannot be excluded, and a contract bound to one must name it. Two guards in
`tests/test_state_operation_inventory.py` find card literals anywhere and `body.tool` names by a different walk
than the scanner, and fail on any that is not inventoried.

Five contracts on a new `relaunch.*` facet family (the closed `control.*` facets are not reused, decision 1 on
the F1b item) cover the two cards and `orgtree_self_update`, pinned by `tests/test_state_relaunch_boundary.py`
against `docs/state-system/relaunch-boundary.json` with the real desktop maintenance adapter writing its request
file. `orgtree_self_update` gets its own contract and is not recorded as an alias of `control.self-restart`,
because the source does not support that: under the non-desktop profile it behaves exactly as
`orgtree_self_restart`, but under the desktop-managed profile it is not refused as renamed and records a
maintenance request with action `update` and the caller's target (recorded legacy defect). Also recorded:
`orgtree_self_relaunch` accepts a `reason` and keeps none of it, and `orgtree_self_update`'s desktop receipt keeps
nothing. The eleven dispatch rows F2 left pending are mapped. The other six verbs stay pending with owner-named
reasons (the receipt verbs with the S3 receipt family, the census with P02, `orgtree_send_file_once` with F4,
`orgtree_account_assign` as an F1 follow-up). Pending moves by -11 dispatch, +6 entries and +15 open dimension
occurrences (conflicts, wire and instrumentation on each of the five contracts).

Of the 41 open dimension occurrences on the sixteen legacy-family contracts, 25 (9 facets) cannot be closed at P01
from the evidence that exists. (This sentence said 53 and 37 (17 facets) until the
native-design citation; those figures were already stale after S2d, which left 45
and 29 (12 facets). It said 43 and 27 (10 facets) until S2j closed
`diagnostic.instrumentation`.) Their questions need observed runtime contacts (P02) or the
qualification of the approved native design r7 at P03/P05. Each such facet keeps its original
question and adds one line naming its owner, the evidence that would close it,
and why the available evidence does not. The P02 real-data replay
(20260924T063643Z) does not replay these tools, so it closes none of them. The
per-operation probe closes `wrapper-reads`, `contacts` and (S2j) `diagnostic.instrumentation`.
Every other P02-owned facet still has a clause the probe cannot meet: a disk-backed sandbox
(`material.reads`), a successful sandbox chown (`material.effects`), or production-grade records
with a product-side drift refusal (`material.contacts`). `material.writes` waits on native
placement (P04). The remaining 16 are the
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

Candidate 7b (receipt lookup, S3 decision 9) adds `receipt.lookup`: the
`orgtree_op_lookup` receipt verb on POST `/api/agent`, selected with
equals(tool, orgtree_op_lookup) while the agent door itself stays pending. It maps
the agent-side client's reading of a refused lookup as an unsupported build
(`mcptool.call_api`): only a lookup reaches that branch, and the tool whose answer
was lost is data (`for_tool`), not a caller. The shared-selector guard now counts a
tool a contract selects with equals(tool, X) as covered. Specified from source and
pinned by `tests/test_state_receipt_lookup_boundary.py` against
`receipt-lookup-boundary.json`: authority (the agent token; refused while halted like
every agent tool; a caller asks only about its own keys), predicates (the
classification, coverage classes, the rotated epoch, the client's reading), writes
(only a missed lookup writes: the fence, which refuses a delayed original), receipt
and effects (none). Unresolved with an owner: reads and instrumentation (P02),
conflicts (native design) and wire (native/Rust).

## Native conflict/predicate design

The separately staffed native conflict, predicate and isolation design is approved:
docket `design-the-native-conflict-predicate-and-isolati`, artifact r7, sha256
`24e86a19f95b47ef2a2acabfbc8d8f4861268f555692167ea019c9c80f160792` (revision 3),
approved by review artifact r10, sha256
`8be9323173dd1ae785f66328a8481a12bf86c7f2c816797c1c9c496c01ea895b`. It was written
for the 18 pre-S3 dimensions. Every facet the design owned now carries one
"Native design r7" fact with that sha, and `tests/test_state_operation_contracts.py`
pins the classification (item `p01-cite-the-approved-native-conflict-predicate`):

- **closed** (the clause asks for the approved design only, so the facet is specified;
  its qualification still runs at P03/P05): `preview.reads` (r7 section 6.2, C6) and
  `preview.predicates` (sections 6.4 and 6.5, C2a, C6, D10; section 6.4 covers all ten
  transitions behind the thirteen agent preview spellings);
- **design half answered, pending on P03 qualification**: `legacy-lock` (11),
  `material.conflicts`, `diagnostic.conflicts` and `preview.conflicts`;
- **partial**: `staffing.conflicts` (the island, P2, P3, P5, P6 and the
  seat-plus-item crossing; no declared read set for hire), `operator-ops.conflicts`
  (reallocate and hire as ledger transitions; not the operator door),
  `agent-mail.conflicts` (only the reply-grant crossing, P1, which an explicit
  `orgtree_send_notice` makes as `orgtree_message` does),
  `receipt-lookup.conflicts` (C1's receipt-key uniqueness and replay order; not the
  fence) and `funding.conflicts` (section 6.4's reallocate row, C2a pairs P2 and P7;
  not credit-request approval's own conflict set, the filing's one-pending order, or
  schedules for deep bubbling and a concurrent decision);
- **not covered by r7**: `status`, `chart`, `org-view`, `org-feed`, `human-mail`,
  `inbox`, `quick-staff` and `work-read` conflicts.

The partial and uncovered facets name the design extension as their owner.

Every one of r7's 42 section 8 schedules stays named in an unresolved facet, so a
design-only closure never drops its qualification (S2e, on review note N1): the
schedules `preview.predicates` carried (Q-P3, Q-P6, Q-C2, Q-C9) and Q-C5, which r7
runs over every operation it designs, are carried on `preview.conflicts`, whose
"Closes with" now requires them. `tests/test_state_operation_contracts.py` pins it.
S2e also retracts a sentence the citation's review round added: an explicit
`orgtree_send_notice` keeps the reply grant (only three automatic notices do not:
the docket's assignment and participation notices and quick staffing's notice to
the previous assignee; S2f, on review finding f1), so r7's P1 covers `mail.notice` as it covers `mail.message`.

## Native design extension r3

The thirteen S3 conflicts facets whose owner lines named "the native conflict/predicate
design extension" now cite it: `NATIVE-CONFLICT-EXTENSION-S3-r3.md`, docket
`extend-the-native-conflict-and-predicate-design` artifact r8, sha256
`f5ee496781b4c2464a3ee723e9a740f5330bb61f516f9279e2e38a3c655af99c`, approved by
native-design-review in artifact r11, sha256
`4f94e78ccec0ba8a942e277e0c73f5d298f184c0dfb61d2e25cb73ce50c30b8d`. Each fact names the r3
section that answers the facet's design half (its section 9.1 row). Every one of the
thirteen clauses also asks to be "qualified by" concurrent schedules, so no facet is
specified. Each owner line moves to "P03 qualification of r3" with its schedules (all of r3
section 7 runs at P03, E-D18; P05 adds section 4.8's refusal fixtures), and keeps any r7
schedule it already carried. The approval's non-blocking notes A1 and A2 (r3's errata) are
recorded on `staffing.conflicts` as P04/P05 carries; the retracted section 4.8 sentence is
not cited. r3 also amends r7 (E-D17): the island gains every lineage split, which amends
section 6.4's `switch_model` and `retool` account rows (recorded on `preview.predicates`,
which stays specified, and on `preview.conflicts`, which carries the new schedule Q-E2), the
kiosk pool E8 joins every top-level holding write, and pair P8 orders a mail receive against
its mailbox's rehire, delete and fold (Q-E1, on `agent-mail.conflicts`).
`tests/test_state_operation_contracts.py` checks every citation and keeps all 50 r3 schedules
anchored in an open facet, each on its own facet (a per-facet map of section 9.1's Evidence
column), and requires r3's extensions of r7's Q-C3 (on `agent-mail.conflicts`) and Q-C5 (on
`preview.conflicts`) to stay named in an open owner line. One departure is recorded rather than
claimed: in a kiosk organization r3 keeps an organization-wide kiosk pool row (E8), which
`funding.conflicts`' clause ("no org-wide credit counter") excludes; the coordinator accepted it
as a departure from v6 scoped to kiosk organizations (E-D15; decision 2 of item
`p01-cite-the-approved-native-design-extension-r3`).

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
