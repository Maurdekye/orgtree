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

## The P01 "Closes with" clauses, clause by clause

These are the closing texts on P01 S2 (origin/v3/p01-s2-c2-opus55, 7ee2fcf).
"Met" means that rows in this output carry that evidence on synthetic data.
Whether that is enough to move a facet is P01's decision.

| Facet (occurrences) | Closing clause | Status here |
|---|---|---|
| `contacts` (11 reservation) | observed contact set per variant | met: tables R/W, kinds, checkouts, connects, tx, files, both aliases, cold/warm |
| | hidden-contact negative control | met: `control:hidden-contact` |
| | mail-locality negative control | evidence (reinterpreted as ORG-STORE locality): release-notify's mail write lands in its own org store (`org-db:own`), and `control:foreign-org-contact` proves `foreign` fires. Not a mail-routing locality test. |
| | receipt/log/effect contacts, loss accounting | met: keyed rows, `log_d`/`log_l` tables, wake spy counts, window counters |
| | wait evidence | partly: document-lock wait (`profile.lock_wait_ms`); no database lock wait is measurable |
| `wrapper-reads` (11) | observed dispatch/authentication/receipt/sidecar read set of one call, per variant | evidence (reinterpreted as ONE union per call): not split into dispatch/authentication/receipt phases. Refusal rows bound the pre-dispatch part: 401/403 = 0 statements; 409 halt = 5. |
| `diagnostic.instrumentation` (2) | contact/profile/loss record for both tools, cache hits, hidden eager loads | met on synthetic data (cold/warm, `profile`, window loss, `hidden_steps` = 0). "approved" and "drift" are for review/P01. |
| `diagnostic.reads` (2) | middleware, schema/pool cold-path contacts | met (whole attempt, cold rows) |
| | JSON-backend contacts | NOT met: SQLite backend only |
| | malformed-state contacts | NOT met |
| `diagnostic.effects` (2) | transitive cold effects and failure outcomes | partly: cold effects (the repeated `store._orgs_dir` mkdir) and the killswitch refusal; legacy and recovery effects NOT probed |
| `diagnostic.writes` (2) | migration, cold-schema, request-diagnostic and cache writes | met: no table written cold or warm; file writes listed per row (slow-trace emit when triggered) |
| `material.contacts` (2) | contact records with operation identity, surfaces, modes, tx membership, waits | met on synthetic data (a cold transcript read has 24 of 28 writes inside a transaction); "production-grade" NOT claimed; waits are document-lock only |
| `material.reads` (2) | provider/import/sandbox and cache hit/miss reads, including file reads | met for provider transcript file reads (`home:provider`), lazy imports (`file_read.code`) and cold/warm; sandbox NOT exercised (unsandboxed org) |
| `material.effects` (2) | directory creation, sandbox chown, lazy imports, cache updates, failure outcomes | met except sandbox chown (not exercised); failures: path escape, outsider, halt |
| `material.writes` (2) | physical writes to transcript-records, chat-window-index and reply-events per call | met (tables per sidecar, and a cold transcript read also writes the primary `doc`/`meta`/`nodes`) |
| | native placement decision | NOT met (P04) |
| `preview.instrumentation` (1) | contact/profile/loss coverage for every preview variant, including provider preflights | met: 13 operations cold (unstubbed) and warm |
| `preview.reads` (1) | provider/settings/registry/cold-storage read sets per variant | met: tables and file reads per variant (e.g. switch_model reads app settings and a provider identity file) |
| | approved bounded native simulation design | NOT met (design item) |
| `preview.effects` (1) | provider/cache/registry/normalization failure and external-contact outcomes, without stubbed preflights | partly: the cold rows are unstubbed and show no process/network; one failure outcome (switch_model 422). Other provider failure modes NOT probed. |
| `preview.writes` (1) | cold/migration/probe/cache writes and the full underlying mutator effects | met for writes (none to any table; file effects listed); "full mutator effects" means the simulation's clone, which the census does not see as a store |

## Limits

- **Statements only:** no rows examined, pages, physical IO or database lock
  wait. `profile.lock_*` is the in-process document lock.
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
