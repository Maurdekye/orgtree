# P02: per-operation contacts for the four P01 tool families

`tools/p02_operation_contacts.py` runs every P01 contract variant of the
reservation, material-read, structural-diagnostic and isolated-preview
families through the real `/api/agent` door, once cold and once warm, with
the operation census on. It writes one row per operation:
`operation-contacts.json` (full) and `operation-contacts.md` (one table row
each).

    E:\...\engine\runtime\python.exe -I -B tools/p02_operation_contacts.py --out <dir>

It runs on SYNTHETIC data only. The fixtures are the P01 boundary tests'
fixtures, rebuilt under a fresh temporary root with HOME redirected. The
live and legacy roots are pinned before that redirect and protected by
`tests/isolation_guards.py`. The same guards refuse every process start and
network connect. The app lifespan is never started. Wakes and mail delivery
are spies: they are counted, never delivered. `tests/test_p02_operation_contacts.py`
runs the probe and checks its output.

## Where each number comes from

| Source | What it is |
|---|---|
| `census.*` | The product's own census record for the attempt (`census.py`, `census_contacts.py`, unchanged). It gives statement kinds, checkouts, connects, engine and hidden steps, the per-sidecar breakdown, and the record's `profile` numbers (handler/total ms, document-lock acquire/wait/hold, load/mutate/save ms). |
| `harness.*` | A wrapper around `census_contacts._run`, in the probe process only. From each observed statement's SQL it keeps only table names, mapped onto the stores' own `sqlite_master` names (anything else is `other`). It also records the store label and `in_transaction` after each write. Its statement count must equal the census's for the same attempt (`matches_census`). |
| `audit.*` | An audit hook that counts file opens, listings and mutations, every `sqlite3.connect` (including sites the census does not instrument), process starts and socket calls. Each count is attributed to the running operation, with a code location (`orgtree.<module>:<function>`) and a closed path category. Org stores are split into `own` and `foreign`. |
| `guard_refusals` | `isolation_guards` refusals, attributed the same way. |
| `wakes` | Spy counts for `supervisor.send_message` and `api.mail_notify`. |

## Row key

Each row is keyed by `contract` (one of the 16 ids in
`operation-contracts.json`) + `variant` + `condition` (`cold` or `warm`).
- Contract variants use the `wire_cases` name, e.g.
  `orgtree_reservation:reservation.acquire` or `preview.reallocate`.
- Refusals and controls use `refusal:<name>`, `keyed:<name>` or
  `control:<name>`.
- Each row also carries the exact `tool`, the exact `args`, the enveloped
  `request` when the call was keyed, and the reservation `alias`.

A cold row runs after `store._invalidate_snapshot` and `store._POOL.close_all`
for its organization. A warm row runs immediately after the cold one.

## What the rows cover

- **Reservation:** all 11 variants × both aliases × cold/warm.
- **Material:** `orgtree_read_scratch` (file, directory, missing) and
  `orgtree_read_transcript` against a real synthetic provider transcript file
  under the redirected HOME.
- **Diagnostic:** `orgtree_state_inspect` and `orgtree_capabilities`.
- **Preview:** all 13 admitted operations (`api._AGENT_PREVIEW_OPS`). The consumer's
  "12 simulation selectors" is the registry's count; the product admits 13, and all
  13 are covered.
  - Cold: the provider preflight UNSTUBBED. Any process start or connect it
    attempted would be refused by the guards and would appear in the row; in
    the runs so far it attempted none.
  - Warm: the preflight stubbed, so the simulation itself runs.
- **Named refusals:**
  - 401 unauthenticated, which is refused by the token gate before the census,
    so it has no census record;
  - 403 identity mismatch;
  - 409 halted and killswitch;
  - 422 unaddressable release successor (inside the lock);
  - 409 keyed conflict, a keyed replay, and a stale epoch;
  - the 512 retained-row cap;
  - a scratch path escape;
  - an outsider with no access route.
- **Negative controls:**
  - `control:hidden-contact`: one statement on a pooled connection through a
    plain `sqlite3.Cursor`, which only the census's trace callback can see.
    It must show `hidden_steps >= 1`, and every other row must show 0.
  - `control:foreign-org-contact`: the operation loads another organization's
    store. It must be classified `org-db:foreign`, and no other row may touch
    a foreign org.
- **Sandboxed organization** (`sandbox:*`, material family): a synthetic org
  with `d.sandbox.enabled`.
  - `sandbox:host-placed` (scratch and transcript, cold/warm): the transcript
    is read from the sandbox home under the data root (`data:sandbox`).
  - `sandbox:chown-new-dir`: a read that creates a node's scratch directory
    hands it to the container user (`sandbox.chown_agent`, `docker exec`).
    The guard refuses the process; the product swallows the failure by
    design and the read answers 200.
  - `sandbox:on-disk` (scratch and transcript): with `d.disk` the path goes
    through the org's virtual disk (`disk.windows_path`), which starts
    `wsl -l -q`. That is refused, and the read is a 500 before any file is
    read.
- **JSON store backend** (`json:*` rows, `backend: "json"`): the backend is
  fixed at import, so `main` runs ONE child copy of the probe with
  `--store json` before this process installs any guard. The child is fully
  guarded, runs the diagnostic family (normal, killswitch, malformed matrix),
  and its rows are merged into this output. Its provenance is in
  `json_backend.provenance` and must name the same commit.
- **Malformed stored state** (`malformed:<field>=<value>:node|org`, both
  backends): P01's legacy matrix (`CORRUPT_NODE` in
  `tests/test_state_diagnostic_boundary.py`). One field of one node is
  corrupted, inspected for that node and for the whole org, then restored.
  On the JSON backend a document with a malformed `scope` cannot be loaded at
  all, even to restore it, so there the probe restores the file's bytes.
- **Migration paths** (`migration:*`): synthetic orgs left in a legacy
  on-disk state, met by an operation.
  - `refused`: `.json` only, without `ORGTREE_MIGRATE`, gives
    `MigrationRefused` (500).
  - `legacy-json`: the same, with `ORGTREE_MIGRATE=1` for that one call. It
    migrates inside the operation, for both `diagnostic.inspect` and
    `preview.agent`. The migration's statements, the renames and the
    candidate cleanup are the row's contacts. It writes every node row, and
    its one write outside a transaction is the candidate's schema DDL.
  - `malformed-json`: gives `MigrationError` (500) with nothing written.
  - `interrupted`: a verified `.db.migrating` beside `.json.premigration`,
    finished by one rename.
- **Preview clone effects** (`clone` on every `preview.agent` row): the
  harness wraps `statepreview._apply`. It records how many paths the
  mutator changed in its isolated clone, per top-level section, and which
  nodes changed (with roles). No values are kept. The clone is not a store,
  so this is the only record of those effects.
- **Unstubbed provider failures** (`provider:*`, `preview.agent`
  `switch_model`, cold): one row per failure mode the provider gate names.
  - provider turned off;
  - Claude not installed, or not signed in;
  - an account not in the registry;
  - Codex not installed;
  - Codex not signed in: its `--version` probe is refused;
  - the legacy tier token (`gpt-reserve`);
  - Antigravity not installed;
  - OpenRouter with no key;
  - OpenRouter with a key, whose check's HTTP request is refused.

  Provider executables, sign-in files and keys are synthetic, under the
  redirected HOME and data root. `ORGTREE_CLAUDE`/`ORGTREE_CODEX`/
  `ORGTREE_ANTIGRAVITY` point inside the root, so no provider check reads
  this machine's PATH.
- **Audience-reached successor** (`audience-successor:reservation.release-notify`): the
  release successor is `cousin`, reachable only through an audience the
  user granted to `owner`. Its mail reaches only `cousin` (P01 contacts
  review f1).
- **Connection sites:** every one of the inventory's 15 sites is classified as
  instrumented (7: the primary store and the six sidecar sites) or
  uninstrumented, with a reason. The tests ASSERT the basis for leaving the
  uninstrumented readers alone: in every recorded row, the audited
  `sqlite3.connect` count equals the census's connects (primary plus
  sidecars), and no connect anywhere comes from `antigravity_provenance`,
  `desktop_import` or the mail hub.
- **The r5 residuals, reproduced:**
  - `db_unbound` is the census ENABLE request itself. It began while capture
    was off, so it has no tally, but it is recorded after capture turns on.
    That is one per enable, which is exactly one per arm-C round in r5.
  - `unclassified_action` counts tools that have no action: `orgtree_chart` and
    `orgtree_send_notice`. `orgtree_status` does not count, because its status
    value is read as the action.

## Loss accounting and unknown-contact refusal

Every row's own census counter deltas show no lost or misattributed
contact: `db_unbound`, `db_late`, `db_unattributed`, `db_hidden_unattributed`,
`db_observe_failed`, `db_self_recursion`, `rejected`, `dropped_*` and
`evicted` are all 0. `harness.statements_unbound` is also 0. The window's
own `db_unattributed` counts statements made BETWEEN operations (fixture
writes) and is not attributed to any row.

Every row lists its `contact_classes`: `<group>:<path category>` with the
code location dropped, plus `guard:<group>/<event>` for each guard refusal.
The KNOWN classes are:
- the file, listing, mutation and connect groups;
- on the operation's own org store, a sidecar, the scratch or sandbox
  trees, the rest of the synthetic data root, the provider home, the probe
  root, and code.

Anything else is unknown: a foreign org store, anything outside the
synthetic root, a process, a socket, or a guard refusal. A row must declare
each unknown class it provokes on purpose (`expected_unknown`).
- `unknown_contacts` lists undeclared ones.
- `expected_unknown_missing` lists declared ones that did not occur.

The test refuses both. The declaring rows are:
- `control:foreign-org-contact`;
- `sandbox:chown-new-dir` and `sandbox:on-disk`;
- `provider:codex-not-signed-in`, `provider:legacy-tier` and
  `provider:openrouter-network-refused`.

This is a probe-level drift check. It is not the product's runtime
drift/unknown-contact refusal.

## Agent-to-agent mail locality

Each row's `agents` block says which AGENTS the operation touched. There are
two layers, because of how the store keeps mail:

- **Physical (`agents.physical`, `agents.physical_nodes`):** node ids that appear
  in the parameters of the operation's own statements, by table, read/write and
  role. Per-agent rows exist only in `nodes` (one row per node) and `log_d`
  (per-owner log rows such as `mail_log`). The mail QUEUE (`mail`), `notices`,
  `delivering` and `audiences` are each ONE `doc` row for the whole
  organization, so a queue write is physically a rewrite of that org-wide row.
  No per-agent row separates one recipient's queue from another's.
- **Logical (`agents.logical`):** the org's `mail`, `notices`, `delivering`,
  `audiences` and `mail_log` are read before and after the operation, outside
  the operation window. Each changed entry is listed by the agent it belongs
  to: the recipient key of a queue, the grantee/grantor of a grant, or the
  owner of a `mail_log` row.

Each agent gets a role:
- `actor`: the caller;
- `target`: a counterparty named in the arguments (`successor`, `to`, `node`,
  `target`, `a`, `b`, `from`, `new_parent`, `grantee`, also inside preview's
  inner `args`);
- `user-or-org`;
- `third`: anyone else.

`third_agent_mail` counts logical mail changes that belong to a third agent.
`third_agent_rows_written` counts physical writes to a third agent's rows.
`mail_producing` is true when any mail section changed.

What the synthetic run shows:
- Among the four families, only `reservation.release-notify` produces mail.
- Its mail changes (the queue and `mail_log`) belong only to the named
  successor. The sender's own entries do not change, so the contacts are
  never self-only.
- No other row touches a third agent's mail or writes a third agent's rows.
- `control:third-agent-mail` (release to `peer` whose notify step also posts
  mail to `child`) is flagged, both logically and physically.

## Hand-off to P01: facet → clause → rows

The "Closes with" clauses are the Owner lines of the unresolved facets in
`docs/state-system/operation-contracts.json` (v3 88c1390; the nine P02-owned
facets are unchanged at 3f91cdd). "Covered" means
rows in this output carry that evidence on synthetic data. Whether that is
enough to move a facet is P01's decision. Rows are named by `variant`
(`json:` = the JSON-backend child).

### P02-owned clauses

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `contacts` | agent-level mail-locality control: release-notify's mail contacts are limited to the sender and the named successor, never self-only | covered (6721cad); specified by P01 at 88c1390 | all four `reservation.release-notify` rows (`agents.logical` = successor only); `control:third-agent-mail`. Added here (P01 review f1): `audience-successor:reservation.release-notify`, a successor reached through a held audience |
| `material.reads` | observed reads for a SANDBOXED organization (`sandbox.on_disk`, disk-backed placement) | partly | covered: `sandbox:host-placed` (scratch and transcript, cold/warm: the transcript is read from the sandbox home, `data:sandbox`); `sandbox:on-disk` (scratch and transcript: the disk-backed path is resolved through `wsl`, which is refused, so the read fails with a 500 before any file is read). NOT observable here: the read contacts of a disk-backed org. They need a running Docker Desktop WSL distro with the org's virtual disk mounted, which this synthetic, process-refusing harness cannot provide. Owner: P02, in a probe run on a sandbox-capable environment, which needs coordinator approval because it starts real processes. Outside the probe, from reading the source and not run here: on a machine where Docker Desktop's WSL distro is running, `disk.distro()` resolves and the read proceeds, so the 500 is the guard's refusal and not a product bug. Where WSL is down, or no docker-desktop distro exists, `distro()` raises `DiskError` ("fails loud" by design). The agent read path catches only `LedgerError`, so the caller gets a 500 carrying DiskError's actionable text rather than a 4xx/503 refusal. Whether that should be a clean refusal is a product question, not decided here. |
| `material.effects` | an observed sandbox `chown_agent` effect and its failure outcome | partly | covered: the chown ATTEMPT and its FAILURE outcome. `sandbox:chown-new-dir`: the `docker exec` chown is attempted and refused by the guard; the product swallows the failure and the read answers 200. NOT observed: a SUCCESSFUL chown, which needs a running sandbox container. Owner: P02, in the same sandbox-capable environment run as `material.reads`. |
| `material.contacts` | production-grade contact records with drift/unknown-contact refusal | partly: probe-level only | every row: `contact_classes`, `unknown_contacts` and `expected_unknown_missing`, refused by the test. NOT observable by a synthetic probe: production-grade runtime records and a product-side drift refusal. They need product instrumentation, owned by the P02 runtime-instrumentation stage; native concurrency and negative controls are P03 |
| `diagnostic.reads` | observed contacts on the JSON store backend and on malformed stored state | covered | `json:diagnostic.inspect`, `json:diagnostic.capabilities` (cold/warm), `json:refusal:killswitch`; `malformed:*:node` and `malformed:*:org` (18 corruptions × node/org) on BOTH backends |
| `diagnostic.writes` | observed writes on the migration paths (legacy JSON `migrate_org`, an interrupted migration finished by `_ensure_migrated`) | covered | `migration:legacy-json` (cold: the migration's writes, renames, candidate cleanup; warm: none), `migration:interrupted` (one rename, no statement writes) |
| `diagnostic.effects` | probes of the legacy-JSON and recovery (interrupted-migration) effects and their failure outcomes | covered | `migration:refused` (`MigrationRefused`, 500, nothing written), `migration:legacy-json`, `migration:malformed-json` (`MigrationError`, 500, nothing written), `migration:interrupted` |
| `diagnostic.instrumentation` | an approved (reviewed) drift-aware contact/profile/loss record for both tools, plus native negative controls | partly | drift-aware record: the unknown-contact refusal above, with profile and zero per-row loss on every row. This probe-level record is reviewed with this candidate. That review approves the probe, not a product drift policy; whether it closes the clause is P01's decision. NOT observable here: native negative controls (P03, needs a native build) |
| `preview.writes` | observed writes on the migration paths, and the full underlying mutator effects inside the simulation clone | covered | `migration:legacy-json` for `preview.agent` (cold/warm), `migration:refused`; `clone` on every `preview.<op>` warm row (paths per section, nodes and roles). The store is never written by a preview row |
| `preview.effects` | observed outcomes of the other provider failure modes (auth, registry, network refusals), without stubbed preflights | covered | `provider:disabled`, `provider:claude-not-installed`, `provider:claude-not-signed-in`, `provider:registry-unknown-account`, `provider:codex-not-installed`, `provider:codex-not-signed-in` (version probe refused), `provider:legacy-tier`, `provider:antigravity-not-installed`, `provider:openrouter-no-key`, `provider:openrouter-network-refused` (HTTP request refused). Native and general no-network behaviour is NOT claimed; provider qualification is P08 |

### Clauses on P02-mentioned facets that other stages own (no rows added)

| Facet | Closing clause | Owner |
|---|---|---|
| `material.writes` | a native placement decision for the transcript-records, chat-window-index and reply-events writes | P04 (schema/sidecar placement). The per-call physical writes are already in the material rows |
| `preview.reads` | an approved bounded native simulation design replacing whole-document cloning | the native conflict/predicate design, then P03/P05. The per-variant read sets are in the preview rows |
| `preview.instrumentation` | the P03 native concurrency and failure gates for every preview variant | P03 |

The other unresolved facets name no P02 clause:
- `legacy-lock`, `material.conflicts`, `diagnostic.conflicts`,
  `preview.predicates`, `preview.conflicts`: native conflict/predicate
  design;
- `wire-common`, `material.wire`, `diagnostic.wire`, `preview.wire`:
  native/Rust conversion.

At v3 3f91cdd the registry also has the S3 contracts `status.report` and
`chart.read`. Their unresolved facets (`status.*`, `chart.*`) are the second
phase of this work (the S3 families): see "Hand-off to P01 (S3 F1)" below.

## P01 S3 F1: `status.report` and `chart.read`

The first two S3 contracts (v3 3f91cdd) are probed with the same keys, the
same loss accounting and the same controls as the families above. The
fixture follows `tests/test_state_status_chart_boundary.py`:
- `st-chief` is top-level;
- `st-worker` and `st-sibling` sit under it;
- `st-deep` and a retired `st-retired` sit under `st-worker`.

The ids are distinctive so that a chart's `disclosed` set cannot match
ordinary words.

- **Status** (`orgtree_status`, actor `st-worker` unless noted), EVERY row
  cold and warm:
  - `status.report` (the wire case: done, to the parent);
  - `status.report:working`, `:idle`, `:unvalidated`, `:blocked-with-parent`;
  - `:done-top-level` and `:blocked-top-level` (actor `st-chief`, no parent);
  - `:keyed-fresh` and `:keyed-replay` (a fresh key per condition);
  - `refusal:status-bad-value` (422) and `refusal:status-halted` (409).

  A done or blocked report goes to the caller's parent. That parent is never
  named in the arguments, so each status row declares it as an IMPLIED target
  (`agents.targets`), read from the actor's STORED parent before the call. Such a report's mail changes belong only to the parent,
  with one wake. Every other outcome writes only the caller's own `nodes`
  row.
- **Status locality control** (`control:status-third-agent-mail`): a done
  report whose delivery step also posts mail to `st-sibling`. The control is
  flagged as a third-agent contact.
- **Chart** (`orgtree_chart`, actor `st-worker`):
  - `chart.read` (the wire case), cold/warm;
  - `chart.read:<level>` and `chart.read:<level>+archived` for self, team,
    subtree and full, each cold/warm.

  Each chart row records `disclosed`: the fixture's node ids that appear in
  the answer. This shows the level took effect. Observed:
  - `self` hides the sibling;
  - the caller's superior always appears;
  - archived rows appear only at subtree and full.

  A chart read writes nothing and signals nothing, cold or warm. A warm read
  runs no statement at all, because it is served from the cached snapshot.
- **Chart migration path** (`chart.read`, `migration:*`): a legacy `.json`
  org read through `cached_org`.
  - Refused without `ORGTREE_MIGRATE`.
  - Migrated inside the read with it. Its writes are the migration's.

## Hand-off to P01 (S3 F1): facet → clause → rows

Clauses from the Owner lines of the unresolved `status.*` and `chart.*`
facets at v3 3f91cdd (unchanged at f2d71a1).

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `status.reads` | observed per-operation contacts for orgtree_status (each outcome: working, done/blocked with and without a parent, keyed, replay, refusals), cold and warm | covered | each cold AND warm: `status.report` (done with a parent), `:blocked-with-parent`, `:done-top-level`, `:blocked-top-level` (without a parent), `:working`, `:idle`, `:unvalidated`, `:keyed-fresh`, `:keyed-replay`, `refusal:status-bad-value`, `refusal:status-halted` (22 rows) |
| `status.instrumentation` | an observed, loss-accounted contact record for orgtree_status (every outcome, cold and warm, both the caller's row and the parent's mail), including an agent-level locality control like the one `contacts` uses | partly | covered: the record above (every outcome, cold and warm), with the caller's row (`agents.physical_nodes` actor) and the parent's mail (`agents.logical`, implied target), plus `control:status-third-agent-mail`. NOT covered here: P03's native negative controls (a native build is needed) |
| `chart.reads` | observed per-operation contacts for orgtree_chart at each visibility level (self, team, subtree, full), with and without archived rows, cold and warm | covered | `chart.read:{self,team,subtree,full}` and each `+archived`, cold and warm (16 rows), plus the wire case `chart.read`; `disclosed` per row |
| `chart.writes` | observed writes on the cold and migration paths reached through cached_org (a snapshot miss falls through to load_org and _ensure_migrated) | covered | cold path: every cold `chart.read*` row (no table written). Migration path: `chart.read` `migration:refused`, and `migration:legacy-json` cold (the migration's writes) and warm (none). Whether this closes the P03 qualification half is P03's |
| `chart.instrumentation` | an observed, loss-accounted contact record for orgtree_chart at each visibility level, cold and warm | covered (P02 half) | the 16 level rows. P03 native negative controls are a separate stage |

Owned elsewhere, with no rows added:
- `status.conflicts` and `chart.conflicts`: the native conflict/predicate
  design, then P03, with P07 or P05;
- `status.wire` and `chart.wire`: the native/Rust conversion.

Pending, added next:
- F1b `org.tree`, `org.node-detail` and `org.feed` (fixed at v3 f2d71a1;
  facets `org-view.*` and `org-feed.*`);
- F2 `mail.message` and `mail.notice` (fixed at v3 325ec75; facets
  `agent-mail.*`).

Pending as P01 fixes their ids: the rest of F2 mail, F3 funding / staffing /
receipt replay, and F4 work-item GET routes.

## Limits

- **Agent identity** is read from statement parameters (node ids of the
  operation's own org) and from before/after snapshots of the mail sections.
  A node id carried only inside a JSON value, such as the org-wide mail blob,
  is seen through the logical snapshot, not the physical parameters.

- **Statements only:** no rows examined, pages, physical IO or database lock
  wait. `profile.lock_*` is the in-process document lock.
- **Known contact classes are broad:** `data:other` (the rest of the synthetic
  data root) and `run:other` (the probe root outside data and HOME) are
  known classes, so the unknown-contact refusal does not tell apart contacts
  within them. The code location in `audit.*` does.
- **Tables** come from the harness's SQL-text map. Only names in the stores'
  own `sqlite_master` appear; anything else is `other`.
- **SQLite's own file IO** is native and invisible to audit hooks. Its connects
  are not.
- **Process starts and network connects** are refused, not executed. A refused
  attempt would appear under `guard_refusals` and `audit.process`/`audit.network`.
- `audit.harness_event_loop` is the in-process test client's loopback
  socketpair, one per request. It is harness plumbing, not a product network
  contact.
- **Attribution is by time window.** Work a background thread does while an
  operation runs is credited to that operation. Late contacts after the
  census record is sealed appear in the window's `db_late`.
- **Synthetic fixtures,** one per family, in one process on one machine. This
  is not a complete coverage claim for any contract, and it is not observed
  live behaviour.
