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
network connect. The probe (and its JSON-backend child) refuses to run on
code that is not its own tree. Before the app loads, it imports `engine` and
`orgtree` and checks each module's own `__file__` against the tool's tree. On
a mismatch it exits 3 with `P02 PROBE PROVENANCE REFUSED`, naming the path it
actually loaded, and writes no result files. That is what a tree in a guarded
folder, or a copy without an engine, produces: the runtime's `._pth` fallback
silently supplies another checkout (`tests/test_p02_probe_provenance.py`).
The app lifespan is never started. Wakes and mail delivery
are spies: they are counted, never delivered. The boot build identity that
the app computes and freezes at startup (`restart_wake.on_backend_startup`)
is injected instead, naming the probe's commit. Left unset, the first docket
read would compute it and start `git`, which a running app never does on a
read path. `tests/test_p02_operation_contacts.py`
runs the probe and checks its output.

## Cross-org reads found (recorded, not fixed)

Operations that read OTHER orgs' stores. Each is observed by the probe on
synthetic data; none is fixed here. P01 and P05 should cite these rows.

- **Every admin org tree build reads one `doc` row of EVERY other org**
  (`orgtree.store:local_net_slugs`, which marks hub peers that are local
  orgs), cold and warm. Rows: `org.tree` and its `migration:*` rows, as
  declared `statement:data:org-db:foreign` statements. See the
  `org-view.reads` row of the S3 F1b hand-off table.
- The public kiosk gateway rebuilds its token map by reading every org
  before any census attempt: `kiosk_token_scan`. A public request whose
  token cache has expired carries this read, outside its census record.
- `mail.message:bare-unknown-name` looks the name up in every org.
- A human send to a name that is no node here does the same before its 422
  (`mail.human-send` `refusal:human-unknown-node`).
- **An agent's `orgtree_list_orgs` loads EVERY org's whole document**
  (`store.list_orgs` → `_scan_orgs`), cold and warm, to keep one summary row
  of each. Rows: `catalogue.list-orgs`, as declared
  `statement:data:org-db:foreign` statements at `orgtree.store:_load_lazy`
  and `_meta_get` (P01 F1, below).

## Where each number comes from

| Source | What it is |
|---|---|
| `census.*` | The product's own census record for the attempt (`census.py`, `census_contacts.py`, unchanged). It gives statement kinds, checkouts, connects, engine and hidden steps, the per-sidecar breakdown, and the record's `profile` numbers (handler/total ms, document-lock acquire/wait/hold, load/mutate/save ms). |
| `harness.*` | A wrapper around `census_contacts._run`, in the probe process only. From each observed statement's SQL it keeps only table names, mapped onto the stores' own `sqlite_master` names (anything else is `other`). It also records the store label and `in_transaction` after each write. Its statement count must equal the census's for the same attempt (`matches_census`). |
| `audit.*` | An audit hook that counts file opens, listings and mutations, every `sqlite3.connect` (including sites the census does not instrument), process starts and socket calls. Each count is attributed to the running operation, with a code location (`orgtree.<module>:<function>`) and a closed path category. Org stores are split into `own` and `foreign`. |
| `audit.stat` | On the `mail.human-send:attachment` rows only: `os.path.isfile` / `os.path.getsize` calls, wrapped for that row because a stat raises no audit event. Same category and code location as the audit hook. |
| `guard_refusals` | `isolation_guards` refusals, attributed the same way. |
| `wakes` | Spy counts for `supervisor.send_message` and `api.mail_notify`. |
| `immediate_command` | Spy count for `supervisor.immediate_command` (a human session command's immediate path; declined, so the command takes its `send_message` delivery). |

## Row key

Each row is keyed by `contract` (a contract id in
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
- **Connection sites:** every one of the inventory's 18 sites is classified as
  instrumented (7: the primary store and the six sidecar sites) or
  uninstrumented, with a reason. Three of them are the hub store migration in
  `engine/mailhub_runtime.py` (`MailhubRuntime._migrate_store`), which the
  inventory scans since it covers the engine's top-level modules. The tests ASSERT the basis for leaving the
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

**Statements by store.** When an observed connection is created
(`ObservedConnection.__init__`, which the sidecar classes inherit), the
harness records its database file. It classifies every statement by that
file: the operation's own org store, ANOTHER org's store, or a sidecar
(`harness.statement_stores`). For each statement on another org's store it
also records the product frame that ran it
(`harness.foreign_statement_sites`, e.g. `orgtree.store:local_net_slugs`).
Nothing extra runs on the connection. A read on an already-pooled foreign
store is therefore visible even when no connect happens, and it is a
contact class of its own (`statement:data:org-db:foreign`) that a row must
declare. Rows that do so:
- the admin `org.tree`, cold and warm, and its migration rows: every tree
  build reads one `doc` row of EVERY other org (`store.local_net_slugs`);
- `mail.message:org` and `:bare-unknown-name`;
- `control:foreign-org-contact`.

No statement anywhere runs on an unmapped connection.

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
`physical_written` lists every agent whose row a statement WROTE, whatever
its role (a subset of `physical_nodes`).
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
  (`agents.targets`), read from the actor's STORED parent before the call.
  Such a report's mail changes belong only to the parent, with one wake. Every other outcome writes only the caller's own `nodes`
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

F1b, F2 (agent and human mail, inbox routes), F3 (funding), F3b (staffing),
F3c (operator ops), F3d (quick-staff) and F4 (work-read, receipt-lookup)
follow below. With F4, every P02-owned `reads` and `instrumentation` facet in
the registry at v3 b4a702b has probe rows, several of them only partly
covered (for example `material.reads`, disk-backed placement, and
`org-view.instrumentation`, the kiosk token scan). That is NOT complete
coverage: see each hand-off table's status, "NOT covered" and "Owned
elsewhere" entries, and Limits.

## P01 S3 F1b: `org.tree`, `org.node-detail`, `org.feed`

These are not `/api/agent` tools. The runner's `call` option drives the real
route through the same window, census baseline and collector: an HTTP GET
with the desktop token (admin), the public kiosk gateway (`/k/<token>/…`),
or a websocket. The fixture follows `tests/test_state_org_view_boundary.py`:
`ov-boss`, `ov-worker`, and a retired `ov-gone`.

- **Admin** (kiosk off): `org.tree`, `org.node-detail` (`ov-worker`) and
  `org.node-detail:archived` (`ov-gone`), each cold and warm, with
  `disclosed`. Refusals: `refusal:tree-no-token` (401) and
  `refusal:detail-unknown-node` (404).
- **Public** (kiosk on): `org.tree:public` and `org.node-detail:public`,
  cold and warm. Refusal: `refusal:tree-bad-kiosk-token` (404, answered by
  the gateway, with no census record).
- **The desktop-mode kiosk 500** (`refusal:tree-admin-on-kiosk-org`): the
  admin tree of a kiosk-enabled org answers 500 "Not available in desktop MVP:
  kiosk". This is the legacy defect P01 pinned at f2d71a1; it is recorded, not
  fixed. That is why the admin rows run before the kiosk is enabled.
- **The kiosk token scan** (`kiosk_token_scan`, top level, NOT a row): the
  public gateway resolves `/k/<token>` through `api._kiosk_token_map`. That
  map is rebuilt, on a 5-second cache, by reading every org's document, and
  the rebuild runs in the ASGI wrapper before the app, so before any census
  attempt exists.
  - Measured on its own with the cache forced stale: every statement is
    unattributable (`statements_unbound` equals `statements`, census
    `db_unattributed` grows), no census record, and every org store is read
    to map one kiosk org.
  - The public rows (tree, detail and feed) run with the map PINNED fresh:
    its cache timestamp is set far ahead, so the real lookup answers from
    the built map however long a row takes. They therefore carry only their
    own request's contacts, independent of the 5-second cache, and per-row
    loss stays zero.
  - In the product, any public request that arrives after the cache has
    expired carries this every-org read as well, outside its census record.
  - This is a census coverage gap for P02 runtime instrumentation and a
    cross-org read for the native design; it is not fixed here.
- **Feed** (`org.feed`, a websocket): `org.feed` (admin) and `org.feed:public`,
  each cold and warm; `org.feed:fanout` (admin and public together, two
  broadcasts); `refusal:feed-no-token` (close 4401). Each row's `feed`
  records:
  - subscribers in the slug's room;
  - frames received per subscriber after `hub.changed`;
  - how many subscribers the hub holds as public.

  The census records no websocket attempt, and a subscription runs no
  statement.
- **Migration path** (`org.tree` `migration:*`): a legacy `.json` org read
  through `cached_org`: refused, then migrated inside the GET.

## Hand-off to P01 (S3 F1b): facet → clause → rows

Clauses from the Owner lines at v3 f2d71a1.

> **Cross-org read on every admin tree build.** GET /api/orgs/{slug}
> (admin) reads one `doc` row of EVERY other org on each build, cold and
> warm (`orgtree.store:local_net_slugs`). Recorded, not fixed; see
> `org-view.reads` below.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `org-view.reads` | observed per-operation contacts for GET /api/orgs/{slug} and the node detail route, admin and public, cold and warm, with archived nodes present | covered | `org.tree`, `org.tree:public`, `org.node-detail`, `org.node-detail:archived`, `org.node-detail:public`, each cold and warm (the archived node is in every tree's `disclosed`); refusals. The admin tree also reads one `doc` row of EVERY other org on each build (`store.local_net_slugs`), visible cold and warm as declared foreign statements. The gateway's token-map rebuild is in `kiosk_token_scan` (not attributable to a row), and a real public request whose token cache has expired carries it as well |
| `org-view.writes` | observed writes on the cold and migration paths reached through cached_org | covered | cold path: every cold tree/detail row (no table written); migration: `org.tree` `migration:refused`, `migration:legacy-json` cold (the migration's writes) and warm |
| `org-view.instrumentation` | an observed, loss-accounted contact record for the tree and detail routes, admin and public, cold and warm | partly | covered: the rows above, per-row loss zero. NOT covered: the public gateway's token-map rebuild, which the census cannot attribute to any attempt (`kiosk_token_scan`). Closing it needs product instrumentation (P02 runtime stage); P03 native controls are separate |
| `org-feed.instrumentation` | an observed record of feed subscriptions and frame fan-out (per slug, admin and public) | covered by the harness, not by the census | `org.feed`, `org.feed:public` (cold/warm), `org.feed:fanout`, `refusal:feed-no-token`, each with `feed` (subscribers, frames per subscriber, public count). The product's census records no websocket attempt; a census record of subscriptions needs product instrumentation (P02 runtime stage) |

Owned elsewhere, with no rows added:
- `org-view.conflicts` and `org-feed.conflicts`: the native design, then P03;
- `org-view.wire` and `org-feed.wire`: the native/Rust conversion. The
  desktop-mode kiosk 500 is recorded above, for them to decide.

## P01 S3 F2: `mail.message`, `mail.notice`

The fixture follows `tests/test_state_agent_mail_boundary.py` with
distinctive `m-*` ids:
- `m-top` is top-level;
- `m-mid` and `m-sib` sit under it;
- `m-kid` is under `m-mid`, `m-deep` under `m-kid`, `m-cousin` under
  `m-sib`;
- `m-gone` is retired;
- a second org receives `@org:` mail.

Delivery wakes are spies, as everywhere; `supervisor.interorg_send` is NOT
stubbed.

- **`orgtree_message` by recipient class**, each cold and warm:
  - `mail.message` (the wire case: `m-mid` to its superior `m-top`);
  - `:deep` (`m-mid` to `m-deep`, below its direct report; the cold row is
    the first send and grants `m-deep` a reply audience, the warm row does
    not);
  - `:archived` (`m-gone`, deferred);
  - `:user` (from the top);
  - `:org` (`@org:<dest>`; the cold row is the org's first outside send and
    auto-grants `m-top` the org-inbox audience);
  - `:mcp` (`@mcp:peer1`, filed);
  - `:bare-unknown-name` (`nobody-here`, 422 NOT DELIVERED).
- **`orgtree_send_notice`**, each cold and warm: `mail.notice` (`m-mid` to
  its peer `m-sib`), `:deep` (`m-top` to `m-kid`, with its grant cold) and
  `:archived`. Refusals: `refusal:notice-to-org` and
  `refusal:notice-to-user` (422).
- **Keyed:** `:keyed-fresh` and `:keyed-replay` for both tools, cold and
  warm. **Halted:** `refusal:mail-halted` (409).
- **Agent-level locality:** every in-org send changes only the named
  recipient's mail and `mail_log` (`agents.logical`), plus, on a first deep
  send, the audience grant between the sender and that recipient. The
  control `control:mail-third-agent` (a send whose delivery also posts to
  `m-sib`) is flagged.
- **Cross-org contacts** (declared on the cold rows):
  - `:org` writes into the DESTINATION org's store;
  - `:bare-unknown-name` looks the name up across every org (hundreds of
    statements, warm or cold).

  Both conditions show the foreign statements
  (`harness.statement_stores` / `statement:data:org-db:foreign`). Cold, the
  foreign store is also closed first, so its connect shows too
  (`sqlite_connect:data:org-db:foreign`). Warm, it is pooled and no connect
  happens.

## Hand-off to P01 (S3 F2): facet → clause → rows

Clauses from the Owner lines at v3 325ec75.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `agent-mail.reads` | observed per-operation contacts for orgtree_message and orgtree_send_notice by recipient class (agent, deep agent, archived, user, @org:, @mcp:, a bare unknown name that scans other orgs), cold and warm | covered | `mail.message`, `:deep`, `:archived`, `:user`, `:org`, `:mcp`, `:bare-unknown-name`; `mail.notice`, `:deep`, `:archived`; each cold and warm; plus the notice refusals, keyed and halted rows |
| `agent-mail.instrumentation` | an observed, loss-accounted contact record for both mail tools by recipient class, with agent-level locality (only the sender and the named recipient touched) | partly | covered: the record above, per-row loss zero, `agents.logical` = the named recipient only (plus the first-deep-send grant between sender and recipient), `control:mail-third-agent` flagged. NOT covered: P03 native negative controls |
| `agent-mail.effects` | observed cross-org effects of interorg_send on the destination org's document and of the @net: spool drain and hub delivery, with their failure outcomes | partly (P07 owns it; P02 observes) | covered: `mail.message:org`. interorg_send runs unstubbed and its write into the destination org's store is observed cold (foreign connect). NOT observed: the destination document's changed sections (the harness snapshots the sender's org only), the @net: spool drain and hub delivery (network, refused here; P07), and interorg_send's failure outcomes |

Owned elsewhere, with no rows added:
- `agent-mail.conflicts`: the native design, then P03 and P07;
- `agent-mail.wire`: the native/Rust conversion.

## P01 S3 F2, the human side: `mail.human-send` and the three inbox routes

The fixture follows `tests/test_state_human_mail_boundary.py` with
distinctive `h-*` ids:
- `h-top` is top-level; `h-mid` and `h-sib` sit under it; `h-deep` is under
  `h-mid`; `h-gone` is retired;
- `h-top` has four mails waiting in the user inbox and has sent one mail to
  `h-mid`; a file `brief.txt` is staged in its working folder.

The operator is the actor (`@user`, the desktop token). Each row's
`agents.targets` is the addressed node plus its superior chain, which the
route notifies (`implied`).

- **`mail.human-send`** (POST `.../nodes/{nid}/message`) by class, each cold
  and warm:
  - `mail.human-send` (to top-level `h-top`);
  - `:deep` (`h-deep`: mail to it, deep-reach notices to `h-mid` and
    `h-top`, and on the cold row the first user-audience grant);
  - `:archived` (`h-gone`: deferred, sparked but not pinged);
  - `:notice` (`h-mid`, `notice: true`);
  - `:session-command` (`h-mid`, `/model sonnet`: no mail; the deep-reach
    notice; `immediate_command` counted, then the command delivery);
  - `:attachment` (`h-top`, one staged file and one missing);
  - `:reply-to-chat-event` (a `reply_to` naming a mailbox event of `h-top`,
    resolved through `supervisor.resolve_chat_event`);
  - `:reply-target` (a typed `target`: a user-inbox mail from `h-top`).
- **Refusals** (warm): `refusal:human-empty`,
  `refusal:human-target-and-reply`, `refusal:human-unknown-node` (422) and
  `refusal:human-command-archived` (409) write nothing.
  `refusal:compact-no-conversation` (`/compact` on a node with no
  conversation) is refused 422 before any compaction starts.
- **Agent-level locality:** each send changes only the node's mail and
  `mail_log`, the chain's notices and, on a first contact, the node's user
  audience. The control `control:human-send-third-agent` (a send whose
  delivery also posts to `h-sib`) is flagged.
- **Inbox routes**, each cold and warm, on BOTH store backends (the JSON
  rows come from the JSON-backend child and carry the `json:` prefix):
  `mail.user-inbox` (GET `/inbox`), `mail.user-inbox-read` (POST
  `/inbox/read` with one pending id) and `:nothing-read` (an unknown id),
  `mail.node-inbox` (GET `nodes/h-top/inbox`). Refusals:
  `refusal:inbox-no-token` (401, no census record) and
  `refusal:node-inbox-unknown-node` (404).
- **Inbox migration paths** (SQLite): for each route, a legacy `.json` org
  met by the route: `migration:refused` (cold, 500 MigrationRefused, no
  write), `migration:legacy-json` cold (migrated inside the route, with
  `os.rename` in `store.migrate_org`) and warm (no write).

Observed and recorded; legacy behaviour, NOT endorsed by this probe and not
fixed here. Each is also present on released main 0008ccb (source
inspection):
- `refusal:human-unknown-node` looks the name up in every other org before
  its 422 (hundreds of statements on other orgs' stores, declared). The
  lookup is `api._external_candidates` over `store.list_orgs()`. It is not
  visible to the user.
- `refusal:compact-no-conversation`: a REFUSED `/compact` has already saved
  the deep-reach notice to the chain (`h-top`), and on a first contact the
  user audience. The chain is told of a command that ran nothing. This is
  visible to the user; backlogged as
  `a-refused-compact-still-notifies-the-superior-ch`.
- `:reply-to-chat-event` opens four sidecar connections on every call, cold
  and warm, and the `reply_events` sidecar runs its DDL outside a
  transaction each time (the row's one write outside a transaction). It is
  not visible to the user.
- On the JSON backend a read mark saves through an unnamed temp file in
  `orgs/` that is renamed onto the org's own document. The harness classes
  the temp file `data:org-db:temp` and the rename by the store it lands on
  (`os.rename:data:org-db:own`).

## Hand-off to P01 (S3 F2, human side): facet → clause → rows

Clauses from the Owner lines at v3 881c14c.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `human-mail.reads` | observed per-operation contacts for the human send by class (top-level, deep, archived, notice, session command, reply target), cold and warm | covered | `mail.human-send`, `:deep`, `:archived`, `:notice`, `:session-command`, `:reply-to-chat-event`, `:reply-target`, and `:attachment` (the working-folder stats, `audit.stat`); each cold and warm; plus the refusals. `:session-command` observes the DECLINED immediate path (the spy returns False); a real immediate command's reads are not observed (see `human-mail.effects`) |
| `human-mail.instrumentation` | an observed, loss-accounted contact record for the human send with agent-level locality (the node and its notified chain only) | partly | covered: the rows above, per-row loss zero, `agents.logical` = the node plus its chain's deep-reach notices (and the first audience grant), `control:human-send-third-agent` flagged. NOT covered: P03 native negative controls |
| `human-mail.effects` | the observed effects of the session-command branch (immediate_command, the command delivery and the /compact background compaction), with their failure outcomes | partly (P08 owns it; P02 observes) | covered: `:session-command` counts `immediate_command` (declined) and the command delivery (`send_message`), both spies; `refusal:compact-no-conversation` records a refused `/compact` that has already saved the chain notice (legacy behaviour, not endorsed; backlogged as `a-refused-compact-still-notifies-the-superior-ch`). NOT observed: a real immediate command, a real delivery, and the `/compact` compaction thread and its failures (not started here; P08) |
| `inbox.reads` | observed per-operation contacts for the three routes on both store backends, cold and warm | covered | `mail.user-inbox`, `mail.user-inbox-read`, `:nothing-read`, `mail.node-inbox`, each cold and warm, on SQLite and on JSON (`json:` rows); refusals on both |
| `inbox.writes` | observed writes on the cold and migration paths of the three routes (read_user_inbox, read_mail_tails, load_org_snapshot and the resident load) | covered | cold rows of the three routes (only a matching read mark writes); `migration:refused`, `migration:legacy-json` cold (the migration's writes, inside the route) and warm, for each route |
| `inbox.instrumentation` | an observed, loss-accounted contact record for the three inbox routes | partly | covered: the rows above, per-row loss zero. NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `human-mail.conflicts` and `inbox.conflicts`: the native design, then P03
  and P07;
- `human-mail.wire` and `inbox.wire`: the native/Rust conversion.

## P01 S3 F3: `credits.request`, `credits.reallocate`, `credits.decide`

The fixture follows `tests/test_state_funding_boundary.py` with distinctive
`f-*` ids:
- `f-top` (grant 20) and `f-top2` (grant 5) are top-level;
- `f-mid` (6) and `f-sib` (1) sit under `f-top`; `f-kid` (2) is under `f-mid`.

Delivery wakes are spies, as everywhere.

- **`orgtree_request_credits`** (caller `f-top`), each cold and warm: a new
  request (`credits.request`, limit 30), `:amend` (35.2, rounded up to 36,
  the same row) and `:withdraw` (a limit at the current grant). Also
  `:nothing-to-request` (`f-top2` at its grant, no write) and the refusals
  `refusal:request-no-reason`, `refusal:request-not-a-number` and
  `refusal:request-not-top-level` (422).
- **`orgtree_reallocate`** (caller `f-top`), each cold and warm:
  `credits.reallocate` (`f-mid` +2), `:down` (`f-mid` -1) and `:deep`
  (`f-kid` +1; its grant notice also reaches its parent `f-mid`, declared as
  an implied target). Also `:zero` (only the event is written) and
  `:fractional` (+0.3 moves a whole credit). Refusals (422): the committed
  floor, upward, self, and a non-number delta.
- **Keyed:** `:keyed-fresh` and `:keyed-replay` for both agent tools, cold
  and warm.
- **`credits.decide`** (the operator's POST `/api/orgs/{slug}/credit-requests`,
  actor `@user`), each cold and warm. Each row decides a request its
  requester made just before, outside the row: approve (`credits.decide`),
  `:counter` (a different granted amount), `:deny` (`f-top2`), `:moot` (the
  requester archived for the call) and `:dry` (a dry run). Refusals: a dry
  run without `granted`, a bad action, the agent credential (401, no census
  record) and an id that is not pending.
- **Agent-level locality:**
  - a request touches no agent but the caller;
  - a reallocation writes only the target's notices (and its parent's, for
    a grandchild);
  - a decision writes only the requester's mail and `mail_log`, plus its
    grant notice when the grant changes;
  - moot and dry send nothing, and dry writes nothing.

  The control `control:funding-third-agent` (a reallocation whose closing
  tree broadcast also posts mail to `f-sib`) is flagged.

Observed and recorded, not a defect claim: a warm raise to `f-mid` (and the
warm zero delta) also READS the row of `f-mid`'s child `f-kid`. The row shows
it as a physical `third` read with no write. It is a CARRY-OVER read, not a
contact of the reallocation. The frames were recorded at three layers:
- product step: `nodes:read@orgtree.api:_agent_identity` (this probe's
  `agents.third_sites`), the agent door's identity check, before any ledger
  work;
- loader: `store.cached_org` -> `_assemble_snapshot`, the delta refresh that
  re-reads every node id changed since the last snapshot (`nids` is
  `_changed_nodes.pop(slug)`);
- cause: the PREVIOUS row changed `f-kid` (the preceding `:deep` row).

The loader frame and the cause come from a reordered run by P01
(p01-current-gap-opus55) on 33c6cf2, whose engine is identical to 464d0c1.
The read appeared only in the rows right after a row that changed `f-kid`,
each time with the same frame chain `census_contacts` <- `store:4468
_assemble_snapshot` <- `store:4608 cached_org` <- `api:11239 _agent_identity`.
In general, the physical read set of ANY warm operation includes the rows
that earlier operations in the same org changed since the last snapshot. It
is bounded by those changes, not by the operation's own agents. Cold, the
whole node table is read in one statement, so no per-node read shows (see
Limits: agent identity comes from statement parameters).

## Hand-off to P01 (S3 F3, funding): facet → clause → rows

Clauses from the Owner lines at v3 27c8667 (unchanged since 742492d).

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `funding.reads` | observed per-operation contacts for the three funding operations (request new/amend/withdraw, reallocate up/down/deep, decide approve/counter/deny/moot/dry), cold and warm | covered | `credits.request`, `:amend`, `:withdraw`; `credits.reallocate`, `:down`, `:deep`; `credits.decide`, `:counter`, `:deny`, `:moot`, `:dry`; each cold and warm; plus the no-op, zero, fractional, keyed and refusal rows |
| `funding.instrumentation` | an observed, loss-accounted contact record for the three funding operations with agent-level locality (the caller, the target and its chain only) | partly | covered: the rows above, per-row loss zero; `agents` writes only the caller (request), the target and, for a grandchild, its parent (reallocate), or the requester (decide); `control:funding-third-agent` flagged. Beyond the clause's set, a warm raise READS the target's child row (no write): a carry-over read by the agent door's snapshot refresh of a row the previous operation changed, not a contact of the reallocation (see above). NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `funding.conflicts`: the native balance-row design, then P03;
- `funding.wire`: the native/Rust conversion.

## P01 S3 F3b: `staffing.hire`, `staffing.staff-create`, `staffing.staff-update`

The fixture follows `tests/test_state_staffing_boundary.py` with distinctive
`s-*` ids:
- `s-top` (grant 200) and `s-top2` are top-level;
- `s-mid` (60) and `s-sib` (the third agent) sit under `s-top`;
- `s-gone-cold` and `s-gone-warm` are archived, one for each rehire row.

The provider hire gate is stubbed (`api.provider_hire_gate`), as in the P01
test; the first-turn drive is the `send_message` spy. Every new seat's name
is known in advance and registered as a fixture node, so its rows are
recognised.

- **`orgtree_hire`** by class, each cold and warm:
  - `staffing.hire` (plain: `s-mid` hires under itself, idle);
  - `:kickoff` (started, one request mail);
  - `:target` (`s-top` hires under `s-mid`);
  - `:superior` (inserted above `s-mid`);
  - `:audiences` (`audiences: ["s-mid"]`, started);
  - `:work-item` (assigns a backlogged item, started).
- **`orgtree_staff`**, each cold and warm: `staffing.staff-create`,
  `staffing.staff-update` (hands `s-mid`'s item to a new seat) and
  `staffing.staff-create:rehire` (restores an archived seat).
- **Refusals** (422, no primary write): outside the subtree, not enough
  credits, unknown tier, a bad staff action, and a missing title (the seat
  goes with the unsaved document).
- **Keyed:** `:keyed-fresh` and `:keyed-replay` for hire and staff, cold
  and warm.
- **Agent-level locality:** each row's `agents.targets` is the new (or
  rehired) seat, the destination, a moved item's previous owner, AND the new
  seat's parent and live peers. Nothing outside that set is written. The
  control `control:staffing-third-agent` (a kickoff hire whose first-turn
  drive also mails `s-sib`) is flagged.

Deliberate product behaviour, recorded:
- **A hire tells every peer.** `ledger.hire` sends `lifecycle.hired`
  notices to the new seat's parent (relation `report`) and to EVERY live
  child of that parent (relation `peer`). A superior insertion also tells the
  anchor's own reports (relation `child`; ledger.py around line 7098). This
  is intended: the hire code reads "every affected agent is told, WHOEVER
  acted (user ruling)" (ledger.py:4727, in the code since 185c632,
  2026-09-07; the same on released main 0008ccb). P01's staffing locality set
  ("the caller, the destination chain, the new seat and a moved item's
  previous owner only") is therefore narrower than the intended behaviour
  and does not name the peers or the anchor's reports. The rows declare
  them. The fan-out grows with the number of peers.
  - The per-agent view cannot show HOW an agent is told twice. A superior
    hire first seats the new agent under the anchor, so the anchor's
    reports get BOTH a `lifecycle.hired` peer notice and a
    `lifecycle.inserted` child notice. `agents.logical` lists each agent
    once per section. P01 pins the two notices by relation in
    `tests/test_state_staffing_boundary.py`.

Observed and recorded; legacy behaviour, NOT endorsed, not fixed:
- **Every hire and staff call journals in the `tool_waits` sidecar.** Hire
  and staff are managed-wait tools (`mcptool.MANAGED_WAIT_TOOLS`,
  `toolwait.invoke`). Each call, refused or replayed too, runs the sidecar's
  eight DDL statements outside a transaction and writes `operations` and
  `dead_letters` (both asserted). It also opened four `tool_waits`
  connections per call in these runs (observed, not asserted). No other row
  touches that sidecar.
- Some cold hire and staff rows also wrote a slow-trace file
  (`orgtree.slowtrace:emit`, `data:other`). It depends on timing: it
  appears when a call is slow.

## Hand-off to P01 (S3 F3b, staffing): facet → clause → rows

Clauses from the Owner lines at v3 b84131f (unchanged from b78c6ca).

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `staffing.reads` | observed per-operation contacts for hire (plain, kickoff, target, superior, audiences, work_item) and staff (create, update, rehire mode), cold and warm | covered | `staffing.hire`, `:kickoff`, `:target`, `:superior`, `:audiences`, `:work-item`; `staffing.staff-create`, `staffing.staff-update`, `staffing.staff-create:rehire`; each cold and warm; plus the refusal and keyed rows. The OpenRouter harness choice (`new_hire_harness`, a provider read) is not exercised: the fixture uses `haiku`, and the provider gate is stubbed |
| `staffing.instrumentation` | an observed, loss-accounted contact record for hire and staff with agent-level locality (the caller, the destination chain, the new seat and a moved item's previous owner only) | partly | covered: the rows above, per-row loss zero; `control:staffing-third-agent` flagged. The observed locality is WIDER than the clause: a hire also writes notices to the new seat's parent and every peer, and a superior insertion to the anchor's reports (declared, see above). That fan-out is deliberate (a 2026-09-07 user ruling cited in the code), so P01 should WIDEN the set to name the new seat's parent and live peers and, for a superior insertion, the anchor's reports. NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `staffing.conflicts`: the native design, then P03;
- `staffing.wire`: the native/Rust conversion.

## P01 S3 F3c: `operator.hire` and `operator.reallocate` (the operator ops door)

The fixture follows `tests/test_state_operator_ops_boundary.py` with
distinctive `op-*` ids:
- `op-top` (grant 40) and `op-top2` are top-level;
- `op-mid` (6) and `op-sib` (the third agent) sit under `op-top`;
- `op-kid` sits under `op-mid`.

Every row is a `POST /api/orgs/{slug}/ops` on the desktop token, as the
operator (`@user`), through `run(call=...)`. The provider hire gate is
stubbed on the hire rows, as in the P01 test. The door keeps no operation
receipts (P01 pins that a repeated hire seats a second agent), so there are
no keyed rows.

- **`operator.hire`**, each cold and warm:
  - `operator.hire` (top level);
  - `:under` (under `op-mid`);
  - `:above` (inserted above `op-mid`, under `op-mid`'s current parent:
    `op-top` cold, the cold insertion warm).
- **`operator.reallocate`**, each cold and warm: `operator.reallocate` (up,
  +2 to `op-mid`), `:down` (-1) and `:top-level` (+1 to `op-top`); plus
  `:fractional` (+0.5, warm).
- **Refusals** (warm; no primary write, nothing logical): a hire with no
  name, an unknown tier, an above-hire whose anchor does not report to the
  named parent, an agent credential (401, refused before any attempt is
  recorded), a reallocation with no delta, one below the committed floor,
  and a named agent actor with no authority over its superior.
- **Agent-level locality:** each row's `agents.targets` is the new seat, its
  parent and the parent's live children (every live top-level seat, for a
  top-level hire), an above-hire's anchor and its reports, or a
  reallocation target and its whole chain. Logically, the only changes are
  the `notices` to those targets. Nothing outside the set is read or
  written, and the door drives nobody and sparks nothing (`wakes` zero). The
  control `control:operator-third-agent` (a reallocation whose closing tree
  broadcast also posts mail to `op-sib`) is flagged.

Observed and recorded:
- **A raise writes the target's whole chain.** The up rows WRITE the rows
  of `op-mid`'s parent AND grandparent (the two above-hires), cold and warm.
  This is `ledger._chain_acquire`: for an operator action, a raise's
  shortfall bubbles up every ancestor to the top level, inflating grants on
  the way. The down rows do not touch the grandparent. P01's clause ("the
  target, its chain") names this. The rows declare the whole ancestor chain.
  The test asserts, per node, that the target, its parent AND its
  grandparent are each WRITTEN (`agents.physical_written`, the agents whose
  rows a statement wrote), and that the down rows neither read nor write
  the grandparent.
- **A top-level hire tells every live top-level seat** (its peers under
  `@user`). That is the same deliberate fan-out as the agent door's hire,
  above.
- The OpenRouter harness choice (`new_hire_harness`, a provider read before
  DOC_LOCK) is not exercised: the fixture uses `haiku`, and the gate is
  stubbed.
- The kiosk visitor path to the same door (pinned by P01) has no rows here.

## Hand-off to P01 (S3 F3c, operator ops): facet → clause → rows

Clauses from the Owner lines at v3 56a9c22 (unchanged from b84131f).

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `operator-ops.reads` | observed per-operation contacts for operator hire (top level, under a parent, above) and reallocate (up, down, top level), cold and warm | covered | `operator.hire`, `:under`, `:above`; `operator.reallocate`, `:down`, `:top-level`; each cold and warm; plus `:fractional` and the refusal rows. The OpenRouter harness choice (a provider read) is not exercised, and the kiosk visitor path has no rows |
| `operator-ops.instrumentation` | an observed, loss-accounted contact record for operator hire and reallocate with agent-level locality (the target, its chain and the new seat's parent and peers only) | partly | covered: the rows above, per-row loss zero; locality within the clause's set, where "chain" is every ancestor (a raise writes them all) and an above-hire's set includes the anchor's reports, which the clause does not name; `control:operator-third-agent` flagged. NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `operator-ops.conflicts`: the native design, then P03;
- `operator-ops.wire`: the native/Rust conversion.

## P01 S3 F3d: quick-staff (the staffing chooser)

The fixture follows `tests/test_state_quick_staff_boundary.py` with
distinctive `qs-*` ids:
- org tiers `haiku` and `luna`;
- `qs-mgr` is top-level (the tickets' assignee, visibility `self`), with
  `qs-kid` under it (the third agent of the request-mode control);
- `qs-other` is top-level.

Every row is an HTTP call on the desktop token as the operator (`@user`),
through `run(call=...)`. Machine state is patched for the WHOLE family, as
in the P01 fixture:
- provider discovery gives a fixed offer (`api._providers_payload`);
- the provider gate, account reasons and advertised efforts are stubbed;
- `staffcache.read` recomputes the snapshot on EVERY read, and
  `staffcache.warm` is a no-op.

So there is no warm staffing snapshot. Cold and warm are the org store's
conditions only, and the snapshot's own reads (provider state, account
boards) are outside what these rows observe. The mode is set with
`appsettings.set_quick_staff_behavior` outside each row. The kickoff spy
answers `accepted`, because the route undoes a request whose kickoff is not
accepted. An immediate commit names its seat from the ticket title, so each
ticket is titled with the seat's registered id.

- **`quick-staff.options`** and **`quick-staff.options-refresh`**, each cold
  and warm. The refresh runs no statement at all.
- **`quick-staff.preview`** in each mode (`request`, `:under-assignee`,
  `:top-level`), each cold and warm, on a backlogged ticket owned by
  `qs-mgr`.
- **`quick-staff.select`** in each mode, each cold and warm, each followed by
  its `:replay` (the same request id and selection). The replay answers 200
  from the ticket's receipt with no write, no mail and no wake.
- **Refusals** (warm; nothing written, no wake): an agent credential on the
  options read and on the commit (401, refused before any attempt is
  recorded), a stale selection, an effort without a model, an account in
  request mode, an immediate mode without a model, and a preview of a ticket
  that is no longer backlogged.
- **Agent-level locality:** reads write nothing and tell nobody. A commit
  writes only the assignee's row and, in an immediate mode, the new seat's
  (`agents.physical_written`). Its mail reaches the assignee (the request,
  or the "staffed beneath you" notice and the item-moved notice) and the new
  seat. Notices also reach the new seat's parent and live peers: `qs-kid`
  under the assignee, and every live top-level seat at the top level. That is
  the hire's deliberate fan-out (see S3 F3b), and the rows declare it. The
  control `control:quick-staff-third-agent` (a request-mode commit whose
  closing tree broadcast also mails `qs-kid`) is flagged.

Observed and recorded:
- A WARM options read, preview or replay runs no SQL statement at all
  (asserted: census statements 0 and no store touched). The org comes from
  the resident document, even though these routes call `store.load_org`
  under DOC_LOCK. Cold, the options read and the previews do read the store.
- Wakes: a request commit drives the assignee once and sparks once; an
  immediate commit drives the new seat once and sparks twice (the
  assignment and the kickoff).
- The kickoff-refused undo path (P01 pins it, including the recorded
  empty-progress 500) has no rows here.

## Hand-off to P01 (S3 F3d, quick-staff): facet → clause → rows

Clauses from the Owner lines at v3 845b2c7.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `quick-staff.reads` | observed per-operation contacts for staffing-options (cold and warm), the preview in each mode and the commit in each mode, including the replay | covered | `quick-staff.options`, `quick-staff.options-refresh`; `quick-staff.preview`, `:under-assignee`, `:top-level`; `quick-staff.select`, `:under-assignee`, `:top-level`, each with `:replay`; every row cold and warm; plus the refusal rows. The staffing snapshot's own reads are patched out (P01's fixture), so they are not observed here |
| `quick-staff.instrumentation` | an observed, loss-accounted contact record for the chooser with agent-level locality (the assignee, the new seat and the ticket only) | partly | covered: the rows above, per-row loss zero; writes only the assignee's and the new seat's rows; `control:quick-staff-third-agent` flagged. The observed locality is WIDER than the clause: an immediate commit's notices also reach the new seat's parent and live peers (the hire's deliberate fan-out, declared). P01 should widen the set as for staffing. NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `quick-staff.conflicts`: the native design, then P03;
- `quick-staff.wire`: the native/Rust conversion.

## P01 S3 F4: `work.item-list` and `work.item-get` (the operator's docket reads)

The fixture follows `tests/test_state_work_read_boundary.py` with distinctive
`wr-*` ids: `wr-mgr` owns an open, a backlogged and a done item. The done
item's docket update is two hours old, so the list derives it archived.

- **`work.item-list`** plain, `:archived`, `:backlogged` and `:compact`, and
  **`work.item-get`** plain and `:compact`, each cold and warm, as `@user`
  on the desktop token.
- **Refusals** (warm; nothing written): an unknown item (404), an agent
  credential on the list and on the item (401, refused before any attempt is
  recorded), and legacy work identity (409: an item without a slug, restored
  outside the row).
- **Org-level locality:** every statement of every read runs on THIS org's
  store (`statement_stores` is `data:org-db:own` only), nothing is written,
  and nobody is told or woken. The control `control:work-read-foreign-org`
  (the identity guard also loads another org's store cold) shows foreign
  statements and a foreign connect, so the classification can fire here.

Observed and recorded: in a process whose startup never ran, the FIRST
docket read computes the boot build identity and starts `git rev-parse`
(`orgtree.build_identity:_verified_checkout`, via the delivery view's
`workitems.build_identity`). The isolation guard refused it in a trial
run, and the read still answered 200. The product computes this identity at
startup, so this is a harness condition, not a read-path contact. The probe
now injects the identity (see the top of this page).

## P01 S3 F4: `receipt.lookup` (`orgtree_op_lookup`)

The fixture follows `tests/test_state_receipt_lookup_boundary.py` with
distinctive `rl-*` ids: `rl-top`; `rl-mid` under it (the reallocation target
that the looked-up call names); `rl-sib` (the third agent of the control).
The looked-up call is `orgtree_reallocate {node: rl-mid, delta: 1}`.

- **Each answer**, cold and warm, with the answer's `state`, `reason` and
  `fenced` kept on the row (`answer`):
  - `receipt.lookup:not-applied` (a fresh key: `not_applied`, and the key is
    fenced);
  - `:fenced-again` (the same key again: answered from the fence);
  - `:applied` (a key a keyed call applied just before, outside the row);
  - `:conflict` (that key, different arguments);
  - `:epoch-rotated` (a fresh key under a rotated epoch: `unknown`,
    `epoch_rotated`, not fenced).
- `receipt.lookup:other-agents-key` (warm): `rl-mid` asks about `rl-top`'s
  applied key, finds nothing in its own namespace, and fences it there.
- **Refusals** (warm; nothing written): halted (409), no `op_key` (422), no
  `for_tool` (422), a bad token (401, before any attempt is recorded).
- **Agent-level locality:** `receipt_namespace` is each row's change in
  receipt rows per owning agent, read outside the window from `log_l`
  section `op_receipts`. The only receipt row any lookup adds is the
  caller's own fence. No other agent's row is read or written: the rows
  name no third agent, and not even `rl-mid`, although the looked-up call
  names it. The control `control:receipt-lookup-third-agent` (a lookup
  followed by mail to `rl-sib`) is flagged.
- The keyed call that applies a key runs outside the row, followed by a
  snapshot refresh (`store.cached_org`), so a warm lookup does not carry the
  setup's changed-row re-read (the carry-over read, S3 F3).

## Hand-off to P01 (S3 F4): facet → clause → rows

Clauses from the Owner lines at v3 b4a702b.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `work-read.reads` | observed per-operation contacts for the list (plain, archived, backlogged, compact) and the item read, cold and warm | covered | `work.item-list`, `:archived`, `:backlogged`, `:compact`; `work.item-get`, `:compact`; each cold and warm; plus the refusal rows |
| `work-read.instrumentation` | an observed, loss-accounted contact record for the item reads with org-level locality (this org's work records only) | partly | covered: the rows above, per-row loss zero; every statement on this org's store only; `control:work-read-foreign-org` flagged. NOT covered: P03 native negative controls |
| `receipt-lookup.reads` | observed per-operation contacts for the lookup answers (not_applied with a fence, applied, conflict, epoch-rotated), cold and warm | covered | `receipt.lookup:not-applied`, `:applied`, `:conflict`, `:epoch-rotated`, plus `:fenced-again`; each cold and warm, with the answer kept on the row; plus `:other-agents-key` and the refusal rows |
| `receipt-lookup.instrumentation` | an observed, loss-accounted contact record for the lookup with agent-level locality (the caller's own receipt namespace only) | partly | covered: the rows above, per-row loss zero; `receipt_namespace` changes only for the caller (its fence); no other agent's row read or written; `control:receipt-lookup-third-agent` flagged. NOT covered: P03 native negative controls |

Owned elsewhere, with no rows added:
- `work-read.conflicts`, `receipt-lookup.conflicts`: the native design,
  then P03;
- `work-read.wire`, `receipt-lookup.wire`: the native/Rust conversion.

## P01 F1: the org lifecycle and catalogue entry points

The fixture follows `tests/test_state_lifecycle_boundary.py`, one small team
(a cell) per row so every row acts on a fresh target whose peers are known.
A cell is `lc-<cell>-<cond>-<role>`: `p` the cell's head under `lc-top`
(grant 6), `m` its report, `k` `m`'s report, `s` `m`'s peer. `lc-top2` is
top-level, and `lc-third` sits under `lc-top`, never named: the third agent.
Pre-states set in the fixture:
- the rehire cells' reports are archived (one with waiting mail);
- the compact cells' managers have a conversation (`occupancy`);
- each repair cell has a rename that stranded a presented document under
  the old id;
- the switch cells' managers hold a grant of 2, because a model switch draws
  its seat cost from the chain only up to the ACTOR (`ledger._chain_acquire`).

`lifecycle.dissolve-all` runs on two orgs of its own (`da-*`), because it
archives every seat. As in the P01 fixture, these are counting spies, and
each row records its calls in `spies`:
- the provider gate;
- the pre-archive interrupt;
- the remote reap;
- the transcript copy;
- manual compaction;
- `supervisor.notify`;
- tier discovery;
- the mail hub roster.

`hub_changed` is real and counted.

"Each contract" means the 19 F1 contracts from P01 F1 (v3 aaad0df). The
lifecycle family has a 20th contract since P01 F3 (v3 0f7c925):
`lifecycle.operator-scope` (`POST /api/orgs/{slug}/nodes/{nid}/scope`, the
operator retool). It has no rows in this section: its rows are in the F3
section below.

- **Each contract, cold and warm:**
  - on the agent door: `lifecycle.rename`, `.retool`, `.retire`,
    `.dissolve`, `.cheap-compact`, `.rehire`, `.move`, `.swap`,
    `.self-subjugate`, `.switch-model`, `catalogue.list-orgs` and
    `.list-tiers`;
  - on the operator routes (`@user`): `lifecycle.reorder`, `.compact` (the
    call waits for the compaction thread's spy, so the effect falls inside
    the window), `.repair-rename` and `.dissolve-all`.
- **Refusal rows only, cold and warm:**
  - `lifecycle.account-assign` (`refusal:account-unknown`): success needs a
    registered account, which is machine state;
  - `lifecycle.lineage-recover` and `.lineage-drop-phantom`
    (`refusal:lineage-not-lost`, `refusal:lineage-not-phantom`): success
    needs a lost or phantom generation backed by a real session file.
- **Variants** (warm):
  - `retool:self-team`;
  - `retire:self` (a leaf retires itself);
  - `retire:with-reports` (a superior retires a manager: a dissolve);
  - `rehire:name`, `rehire:mail` (driven exactly once) and `rehire:live` (a
    no-op);
  - `move:batch`;
  - `move:noop-unrelated-caller`;
  - `move:keyed-fresh` and `:keyed-replay`;
  - `rename:keyed-malformed-key`;
  - `switch-model:no-op`.
- **Refusals** (warm; no primary write, nothing logical):
  - 14 tool refusals, covering authority, a taken name, one's own charter,
    a self-retire with reports, dissolve and cheap-compact of oneself, a
    batch entry that is not an object, a swap of one agent, a top-level swap,
    a non-descendant subjugation, one's own model and an unknown tier;
  - the malformed-key retire;
  - four route refusals, including an agent credential on a route (401,
    before any attempt is recorded).
- **Agent-level locality:** each row declares what it reaches without naming
  it in its arguments:
  - a new name, or a bearer (`m@0`);
  - the subtree it archives;
  - the agents it tells: P01's pinned `told`, per cell role (a dissolved
    seat's peer, a move's old parent, a swap's reports, a subjugation's new
    parent and peer).

  The test checks every F1 row against that set. Nothing outside the actor
  and its targets is written. Every notice goes to a target, and the test
  asserts the pinned set exactly. `lc-third` is never touched. The only
  third-agent contacts are READS, at the carry-over re-read of the rows the
  previous operation changed (`api._agent_identity`; for compact also
  `halt.org_killswitch`). The control `control:lifecycle-third-agent` (a
  retool whose closing broadcast also posts mail to `lc-third`) is flagged.

Observed and recorded:
- **`orgtree_list_orgs` loads every org's whole document** (see "Cross-org
  reads found"). P01's `lifecycle.reads` fact said "every org's catalogue
  row". The statements show the whole document, of which only the summary
  row is kept. P01 corrected the fact from this probe (v3 52a2d3c).
- **rehire, retire, dissolve and cheap-compact are managed-wait tools**
  (`mcptool.MANAGED_WAIT_TOOLS`), as are hire and staff. EVERY call, a
  refusal or a no-op too, journals in the `tool_waits` sidecar.
- These pinned legacy behaviours are measured, not fixed, and each is
  confirmed by the rows:
  - the pre-archive interrupt runs BEFORE the refusal of a self-retire with
    live reports and of a malformed key (spy count 1, no primary write), but
    not before the authority pre-guard;
  - a same-parent move by an unrelated caller answers 200, writes nothing,
    and still broadcasts (`lifecycle-tool-receipts-and-admission-keyed-rena`
    #6);
  - rename goes through `supervisor.notify` only (no `hub_changed`, no remote
    reap);
  - a keyed rename with a malformed key is executed, and writes no `meta`
    row, where the keyed move's receipt goes (observed);
  - `list_orgs` takes the write lock and broadcasts, but writes nothing;
  - dissolve-all tells the later top-level seat, then dissolves it in the
    same save.

## Hand-off to P01 (F1, lifecycle): facet → clause → rows

Clause from the Owner line at v3 15c22d8 (unchanged since c86a5e7). The
parenthetical is the facet's first open question, not the Owner line.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `lifecycle.instrumentation` | a loss-accounted P02 record per lifecycle row (open question: actual contacts per outcome, cold and warm, refusals and keyed replays included, and the org-level locality of each) | partly | covered: every F1 contract cold and warm, per-row loss zero, with the variants, keyed calls (fresh, replay, malformed) and refusals above; org-level locality (only `list_orgs` reads other orgs, declared); agent-level locality within the declared set; `control:lifecycle-third-agent` flagged. `lifecycle.operator-scope` (P01 F3) has its rows in the F3 section (cold, warm and a refusal). NOT covered: the success paths of account-assign, lineage-recover and lineage-drop-phantom (refusal rows only); P03 native negative controls |

Owned elsewhere, with no rows added:
- `lifecycle.conflicts`: P03/P05;
- `lifecycle.wire`: the native conversion.

## P01 F1b: the operator ops door's remaining operations and its preview

The fixture follows `tests/test_state_operator_variants_boundary.py`, one
cell per row (`vx-<cell>-<cond>-<role>`, the same shape as F1): `p` is the
P01 fixture's top, `m` its mid, `k` its leaf, `s` its sib. `vx-top2` is
top-level and `vx-third` sits under `vx-top`, never named. Pre-states:
- the rehire cells' leaves are archived (one with waiting mail);
- the reseed cells' managers are unrecoverable;
- the revoke cells' manager and leaf hold the fixture directory;
- one archived leaf exists for the cheap-compact refusal.

Every row is a `POST /api/orgs/{slug}/ops` on the desktop token. As in the
P01 fixture, these are counting spies (`spies`):
- the provider gate;
- the pre-archive interrupt;
- the remote reap;
- the transcript copy;
- `supervisor.forget`;
- `supervisor.notify`.

`hub_changed` is real and counted.

- **Each operation, cold and warm, as `@user`:** `operator.rename`,
  `.retire`, `.rescind`, `.cheap-compact`, `.rehire`, `.dissolve`,
  `.delete`, `.switch-model`, `.promote` (to the top level), `.demote`,
  `.move`, `.reseed`, `.revoke-dir` and `.preview` (a retire preview).
- **Variants** (warm):
  - the preview of a delete, a reallocation and a model switch, and a
    retire preview with an agent actor named in the body;
  - `operator.rehire:mail` (driven exactly once);
  - `operator.reseed:no-op` (a live seat: no write, still a broadcast).
- **Refusals** (warm; no write, nothing logical): 16 of them:
  - missing arguments (rename, switch, demote, revoke);
  - a taken name;
  - agent actors named in the body, covering authority, delete, promote to
    the top level, rescind, a self-retire with reports, and a retire without
    authority;
  - an unknown op;
  - a preview of rename and of rehire;
  - cheap-compact of an archived seat;
  - an agent credential (401, before any attempt is recorded).
- **Agent-level locality:** each row declares P01's pinned `told` per cell
  role, plus a new name, a bearer and the subtree an operation archives or
  rescopes. For a promotion it also declares every live top-level seat (the
  new peers) and the promoted seat's whole old chain. Nothing outside the
  actor and its targets is written. Every notice goes to a target, and the
  test asserts the pinned set exactly. `vx-third` is never touched, and a
  third agent's row is only ever read. The control
  `control:op-variants-third-agent` (a move whose closing broadcast also
  posts mail to `vx-third`) is flagged.

Observed and recorded:
- **A promotion to the top level writes the promoted seat's whole old
  chain.** Cold and warm, the promote rows WRITE the old parent, the old
  grandparent and `vx-top`, besides the seat and its new top-level peers.
  This is `ledger._move`'s credit path: the seat's credits are released from
  the old parent up to the lowest common ancestor, which for a promotion to
  the top level is `@user`, so every ancestor's grant changes. P01's pinned
  `told` does not name the old grandparent. It is the same shape as an
  operator raise (S3 F3c).
- The operator preview runs the same simulation as the agent door's preview
  (`clone` is recorded), and the store is not written.
- These pinned legacy behaviours are measured, not fixed, and each is
  confirmed by the rows:
  - retire, dissolve and rescind interrupt the target first; an agent-actor
    rescind and an agent-actor self-retire with live reports are refused
    AFTER that interrupt, while the authority pre-guard refuses before it;
  - delete takes no pre-archive interrupt (`forget` and the reap run);
  - the operator door's rename reaps and broadcasts, and the agent door's
    does neither.

## Hand-off to P01 (F1b, operator variants): facet → clause → rows

Clause from the Owner line at v3 15c22d8 (unchanged since c86a5e7). The
parenthetical is the facet's first open question, not the Owner line.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `operator-ops.variant-instrumentation` | a loss-accounted P02 record per variant row (open question: actual contacts per outcome, cold and warm, refusals included, and the org-level locality of each) | partly | covered: all 13 operations and the preview, cold and warm, per-row loss zero, with the preview variants, the waiting-mail rehire, the no-op reseed and 16 refusals; org-level locality (every statement on this org's store); agent-level locality within the declared set, which for promote includes the old chain that the pinned `told` does not name; `control:op-variants-third-agent` flagged. NOT covered: P03 native negative controls; the kiosk visitor path |

Owned elsewhere, with no rows added:
- `operator-ops.variant-conflicts`: the native design, then P03;
- `operator-ops.wire`: the native/Rust conversion.

## P01 F3: asks, reports, scope requests, watchdogs and audiences

The fixture follows `tests/test_state_requests_boundary.py`, one cell per row
(`rq-<cell>-<cond>-<role>`). Here the cell's head `p` is TOP-LEVEL, like the
P01 fixture's top, so its asks and presentations go to the user. `m` is its
report, `k` is `m`'s report and `s` is `m`'s peer. `rq-third` sits under the
refusal cell's head and is never named. Setups run through the door just
before a row, outside its window:
- an open ask;
- a watchdog (optionally one-shot or paused);
- an audience request or grant.

As in the P01 fixture, the watchdog smoke run and live effort delivery are
counting spies (`spies`), turn delivery is the probe's global spy (`wakes`),
and `hub_changed` is real and counted.

- **Each contract, cold and warm** (22 in all):
  - on the agent door: `asks.ask`, `.withdraw`, `.present`, `.submit-report`,
    `.request-scope`; `watchdogs.create`, `.list`, `.pause`, `.resume`,
    `.remove`, `.supersede`; `audiences.request`, `.forward`, `.grant`,
    `.deny`, `.revoke`;
  - on the operator routes (`@user`): `asks.answer`, `asks.batch-resolve`,
    `lifecycle.operator-scope`, `watchdogs.operator-action`,
    `audiences.operator-action` and `audiences.list`.
- **Variants** (warm):
  - an ask and a scope request from a non-top-level agent (routed to the
    superior);
  - a top-level report (presented to the user);
  - withdraw with no open ask;
  - an answer that dismisses;
  - a watchdog list by the owner's ancestor;
  - an audience request to an agent already reachable;
  - a keyed watchdog list, fresh and replayed.
- **Refusals** (warm; no primary write, nothing logical): 17 of them,
  covering:
  - an empty question, empty scope items, a presentation by a non-top-level
    agent;
  - a command watchdog without bash, a watch target outside the folder, an
    unknown kind, a pause without authority, a supersede of a persistent dog;
  - an audience request off the chain, a bad audience action;
  - no open batch, a stale answer and a stale batch;
  - an unknown watchdog id and a bad action on the operator routes, and a bad
    visibility on the operator scope route;
  - an agent credential on a route (401, before any attempt is recorded).
- **Agent-level locality:** each row declares P01's pinned mail and notices
  per cell role. The test asserts them exactly: a report mails the
  superior; an audience request mails the requester's superior, a forward
  the target, a grant or deny the requester; a revoke tells the grantee; an
  answer or batch mails the asker; the operator scope route tells the
  target; the operator audience grant tells both parties. Nothing outside
  the actor and its targets is written, `rq-third` is never touched, and a
  third agent's row is only ever read. The control
  `control:requests-third-agent` (a watchdog pause whose closing broadcast
  also posts mail to `rq-third`) is flagged.

Observed and recorded:
- **`orgtree_watchdog` is a managed-wait tool** (`mcptool.MANAGED_WAIT_TOOLS`):
  every call, refusals included, journals in the `tool_waits` sidecar.
- These pinned legacy behaviours are measured, not fixed, and each is
  confirmed by the rows:
  - a forwarded report mails the superior and drives nobody;
  - the operator audience grant tells both parties by notice, posts no mail,
    and still drives the grantee;
  - a watchdog list goes through the write cycle and broadcasts but writes
    nothing to the org, and keyed it files a receipt;
  - the operator scope route broadcasts nothing itself.

## P01 F2: run control, per product profile

The fixture follows `tests/test_state_control_boundary.py`, one cell per row
(`ct-<cell>-<cond>-<role>`, the same shape as F3). The unstick cells'
managers are frozen and the unhalt cells' managers are halted before the
row. The killswitch latches a whole org, so it runs on two orgs of its own
(`ks-*`): latch, release, then resume. **EVERY process effect is a counting
spy** (`spies`), as the ticket requires and as in the P01 fixture:
- halt's process cut;
- turn interrupts and the killswitch sweep;
- the warm-pool process control;
- remote control;
- the restart launch and the prime arm and cancel;
- continue-on's live provider read;
- the storage check.

The probe never halts, restarts or kills a real process, and the guards
refuse any process start in any case.

**Profiles.** The app is desktop-managed (`engine.launch` sets
`ORGTREE_DESKTOP_MANAGED=1`). Where `desktop_policy` changes behaviour, the
non-desktop profile is probed by clearing that flag for the one call (row
`env`):
- `orgtree_self_restart` and all three `orgtree_prime_restart` actions have
  a `:desktop` row (refused as renamed, no effect) and a `:non-desktop` row
  (the launch, arm or cancel spy fires), each cold and warm;
- the kiosk route is stripped from the desktop-built app
  (`desktop_policy.install_routes` drops every route with `/kiosk` in its
  path): `control.kiosk:desktop-stripped`, cold and warm, answers 404
  (P01 pins 405; reported). For the non-desktop profile the real handler
  (`api.org_kiosk`) is mounted at its own path for these rows only, as a
  non-desktop build mounts it, and the flag is cleared for the call:
  `control.kiosk:non-desktop` configures a kiosk org of its own (`kx-*`)
  cold and warm, and `refusal:kiosk-not-a-kiosk-org` is the handler's 422
  on an ordinary org. Mounting the route rather than calling the function
  keeps each call a census-recorded, loss-accounted attempt; the route is
  removed afterwards.

- **Each contract, cold and warm** (26 in all):
  - on the agent door: `control.interrupt`, `.unstick`, `.continue-on`,
    `.halt`, `.unhalt`, `.restart-wake-arm`, `-status` and `-cancel`,
    `.self-restart`, `.prime-restart-arm`, `-status` and `-cancel`;
  - on the operator routes: `control.op-interrupt`, `.op-unstick`,
    `.op-continue-on`, `.op-halt`, `.op-unhalt`, `.op-process`,
    `.remote-control`, `.steer-claim`, `.steer-ack`, `.steer-state`,
    `.kiosk`, `.killswitch`, `.killswitch-release` and `.resume`.
- **Variants** (warm): an unstick of a node that is not frozen; a batch
  halt; an operator interrupt of a halted node; an operator unhalt of a node
  that is not halted; a restart wake armed for a subordinate; a release of a
  killswitch that is not latched.
- **Refusals** (warm; no primary write, nothing logical): 18 of them:
  - authority (interrupt self or up, unstick up, continue-on up, halt up);
  - a batch halt with one target out of reach (nothing is cut);
  - choosing one's own account (403);
  - non-desktop self-restart and prime arm below the top level, and a bad
    prime action;
  - a restart wake for a superior (403), a recurring wake, a bad wake
    action;
  - an unknown node for the process route (404), a bad remote-control
    action;
  - resume while the killswitch is latched (409);
  - the non-desktop kiosk handler on an org that is not a kiosk (422);
  - an agent credential on a route (401).
- **Agent-level locality:** the pinned notices are asserted exactly (an
  unstick tells the unfrozen node), and `ct-third` is never touched. The
  control `control:control-third-agent` (an interrupt whose closing
  broadcast also posts mail to `ct-third`) is flagged.

Observed and recorded:
- **The unhalt carry-over (a finding).** After an AGENT-DOOR unhalt, in the
  warm condition, the save of every later operation on the org re-writes a
  `log_d` row naming the unhalted node:
  - in this run, the next 7 agent-door rows and the operator unstick, halt
    and unhalt routes;
  - it stops after the operator unhalt;
  - cold rows, which drop the shared snapshot first, never show it.

  Reproduced independently by p01-current-gap-opus55 with the exact
  sequence: the durable document ends with an empty `steer_attempts`
  entry for the node, and P01 reported it as a product defect. The
  source:
  - `halt.unhalt` calls `supervisor.scan_steer_records`;
  - that reaches `_steer_attempts`, which does
    `org.d.setdefault("steer_attempts", {}).setdefault(nid, {})` on the
    loaded document under `DOC_LOCK` without saving;
  - that leaves an empty dict-log owner on the resident document for later
    saves to reconcile.

  The operator unhalt route, which runs the same `halt.unhalt`, did not
  leave a lasting carry-over in this run. The test pins the exact rows and
  that every such write is a `log_d` write naming that node.
- **`orgtree_continue_on` is a managed-wait tool**: every call, refusals
  included, journals in the `tool_waits` sidecar.
- A batch halt cuts every target before halting each (`halt_cut` 4 for two
  targets). A batch with one target out of reach refuses before anything is
  cut, as P01 pins.
- `hub_changed` fires for the agent-door interrupt and not for the operator
  route. Halt and unhalt broadcast nothing and notify instead (`halting`,
  `halted`; `unhalted`).

## Hand-off to P01 (F3 and F2): facet → clause → rows

Clauses from the Owner lines at v3 7c79f28. The parenthetical is each
facet's first open question, not the Owner line.

| Facet | Closing clause | Status | Rows |
|---|---|---|---|
| `asks.instrumentation` | a loss-accounted P02 record per row (open question: actual contacts per outcome, cold and warm, refusals included) | partly | covered: the seven asks contracts cold and warm, the routed, top-level, no-open-ask and dismiss variants, and their refusals, per-row loss zero; locality within the pinned mail and notices; `control:requests-third-agent` flagged. NOT covered: P03 native negative controls |
| `watchdogs.instrumentation` | a loss-accounted P02 record per row (open question: actual contacts per outcome, cold and warm, refusals included) | partly | covered: the seven watchdog contracts cold and warm, the ancestor list, the keyed list fresh and replayed, and their refusals; the smoke run is a spy. NOT covered: a real smoke run; P03 native negative controls |
| `audiences.instrumentation` | a loss-accounted P02 record per row (open question: actual contacts per outcome, cold and warm, refusals included) | partly | covered: the seven audience contracts cold and warm, the already-reachable request and the refusals; locality within the pinned mail and notices. NOT covered: P03 native negative controls |
| `control.instrumentation` | a loss-accounted P02 record per row (open question: every run-control operation, including the process effects the P01 test replaces with spies) | partly | covered: all 26 contracts cold and warm, both profiles for self-restart, prime-restart and the kiosk route (the non-desktop handler through its mounted route), the variants and 18 refusals, per-row loss zero; the unhalt carry-over recorded. NOT covered, by design: the PROCESS EFFECTS themselves, which stay spies here as the ticket requires (never a real halt, restart or kill); P03 native negative controls |
| `lifecycle.instrumentation` (operator-scope only) | as in the F1 row | covered for `lifecycle.operator-scope` | `lifecycle.operator-scope` cold and warm, and `refusal:op-scope-bad-visibility` |

Owned elsewhere, with no rows added: `asks.*`, `watchdogs.*`, `audiences.*`
and `control.*` conflicts and wire.

## Limits

- **Agent identity** is read from statement parameters (node ids of the
  operation's own org) and from before/after snapshots of the mail sections.
  Each statement that names a node id also records the first product frame
  outside the store layer (`agents.third_sites` for the third-agent ones).
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
- **Stats** (`os.stat`, `os.path.isfile`, `exists`, `getsize`, `realpath`)
  raise no audit event. Only the attachment rows wrap `isfile` and `getsize`
  (`audit.stat`); every other row's stats are unobserved.
- **Unnamed temp files in `orgs/`** (`tmp*.tmp`) are the known class
  `data:org-db:temp`; they name no org. The rename that lands one is
  classified by its destination, so a temp file renamed onto another org's
  store would still show as `data:org-db:foreign`.
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
