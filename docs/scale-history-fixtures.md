# Matched history fixtures

`tools/scale/history_fixture.py` prepares a pair of offline bundles. Both arms
share **one frozen logical org document** and the exact same current transcript
files. History has separate deterministic identities, sessions and payloads.
This is preparation tooling, not permission to run N1000 or start providers.

## Input and execution order

1. After run authorization, seed one disposable active-only org with the existing
   scale seeder (`--archived-per-live 0 --archived-items-per-live 0`). Do not
   start its engine. Use the normal `store.export_json` path to export its
   consistent logical document. Keep its current transcript files stopped.
   Seeding each arm independently is wrong: the seed's random stream includes
   inactive rows, so changing their count changes later active inputs.
2. Freeze the run plan, viewport/navigation selections and source descriptor
   alongside that export. Build an explicit JSON map of every current source
   file, relative to the intended HOME, to its absolute stopped source path.
   Include any other active input file in this map too. The controller is
   responsible for this complete selection; the tool cannot discover missing
   files that it was never given. Never export or copy live Orgtree data here.
3. Use one intended workspace/HOME path for the eventual sequential arms. Do
   not rewrite active paths after freezing. `prepare_base` reserves the same
   `mail_seq=1_000_000_000` floor before both arms are frozen; input files and
   source documents are not mutated. Existing positive receive ordinals must
   be below 500,000,000. Generated read-mail ordinals occupy a disjoint reserved
   interval above that and below the shared floor. The absolute ordinal gap is
   artificial fixture data; both arms have the same next assigned ordinal.
   Generated rows are old by timestamp and physical archive order, and are
   inserted *before* the identical fixed recent tails.
4. Generate a new bundle, then verify it in a fresh process. The CLI accepts
   the **unprepared frozen export**, not the bundle's already-prepared base.

```powershell
python tools/scale/history_fixture.py estimate --base frozen-export.json --recipe recipe.json --current-bytes 268435456
python tools/scale/history_fixture.py build --base frozen-export.json --recipe recipe.json --current-files current-files.json --output C:/owned-temp/history-pair
python tools/scale/history_fixture.py verify --output C:/owned-temp/history-pair
```

The input and output must be disposable paths outside live app directories.
Reparse paths, traversal, existing nonempty output and insufficient disk reserve
are refused. Generation is streamed and guarded at 10 GiB free commit. The
manifest records exact counts, bytes and SHA-256 hashes, the active semantic
hash, the fixed-tail contribution and the recipe. `COMPLETE` is written last.
A stopped/interrupted preparation remains incomplete; it is never resumed by
overwriting it. Verification reconstructs the expected deterministic rows and
checks their inactive states, references, ratios and complete file inventory.

## History shape

Default recipe (JSON may override these values):

```json
{"retired_agents":1000,"archived_items":2000,"read_mail":100000,
 "old_transcripts":1000,"multiplier":10,"seed":1,
 "payload_profile":"live_quantiles","transcript_chars":262144}
```

The large arm has at least 10,000 retired nodes and 20,000 physically archived
done items. Every generated item has settled attention and an evidence body.
Read mail is settled. Each old transcript has its own retired Claude identity,
session and two valid source records. Current active transcript files are
unchanged. Row **counts and bytes** must both be at least ten times larger;
fixed existing read-mail tails count in both arms, so they increase the number
of rows needed in the large arm. Payload content is synthetic. The default
100-row deterministic quantile cycle reuses the scale seed's 2026-09-26 charter,
archived-item and mail profile; it is not a new fleet sample. Old transcripts
use the seed's 256 KiB size. `payload_profile: "fixed"` and 128-byte payloads
are available for tiny correctness controls.

Added sessions do not represent more concurrent active work. Added archived
nodes get separate lineage/mailbox identities, no turns/PID/grant and idle old
status. No provider is launched by either module.

## Restore and independent verification

`tools/scale/history_pg.py` is a library plus a command for an external disposable
fixture controller. It **does not** create a database, start PostgreSQL, scrub
the environment or launch an engine. Use the existing guarded custodian/controller
for those duties. The controller must first call
`authorize_empty_destination(root, slug, disposable_loopback_url)` on a new
empty root. Then configure ORGTREE_DATA to `root/data`, HOME/USERPROFILE to
`root/home`, ORGTREE_STORE to postgres and the matching ORGTREE_PG_URL. A marker
binds the resolved root, slug and database URL hash. Live roots, non-loopback or
unmarked databases, existing orgs and previous restore attempts are refused.

```powershell
python tools/scale/history_pg.py restore --bundle C:/owned-temp/history-pair --arm small --root C:/owned-temp/run --result C:/owned-temp/restore-result.json
python tools/scale/history_pg.py verify --bundle C:/owned-temp/history-pair --arm small --root C:/owned-temp/run --result C:/owned-temp/verify-result.json
```

The command proves its actual checkout imports and writes provenance. Both
arms use the same fixed path text and must be restored sequentially into newly
prepared destinations by the controller. Never clone a writing PG directory.
Normal compact store serialization, COPY triggers and the importer count-refresh
seam maintain derivative indexes. The generated database rows are one transaction:
an interrupted COPY rolls back. Base log storage positions are shifted by the
same fixed offset in both arms, without changing any record body. Streaming
source hashes cover all original rows before/after history insertion. A new
transaction independently reads every persisted history row and every fixed
source row; a fresh interpreter can repeat it. Source-file expectations are
derived from the bundle, not merely trusted from the restore writer's receipt.
The expected original SQL rows are computed directly from frozen `base.json`,
before creation and again in fresh verification. No writer-produced hash can
certify an altered initial restore. The declared storage normalization is compact
ASCII JSON, per-node rows with original ordinal, per-owner mutable queues,
per-item work rows/header, keyed-log entry pairs, and the cleared `killswitch`
and `deleted_cost_usd` singleton defaults when absent. Every value is compared;
top-level key order, dict-log owner order and each log's record order are retained.
Only internal log sequence positions and unrelated cross-section insertion order
are excluded. No charter, permission, queue, active item or settings field is dropped.

Verification enumerates all files under the owned HOME and requires exactly the
declared current files plus generated historical sources, with matching bytes.
Undeclared sources, missing files and directory links/junctions are refused.
There are no implicit internal-file allowances in HOME: any controller-owned
input belongs in its frozen inventory, and receipts/logs belong outside HOME.
Verification occurs before application startup can create additional files.

The source transcript files are ready for normal ingestion. The controller must
run normal ingestion/readiness outside its measured window and separately prove
the final capture counts. The small control ingests a real generated transcript;
this does not claim a fully populated historical journal has already been built
for a large arm. Application/turn/readiness and provider-launch guards remain
the qualification controller's responsibility.

`history-restore.json` records source hashes, exact file inventory, database size,
restore time and PG statistics. `RESTORE_COMPLETE` is written only after an
independent read succeeds. There is no retry-in-place after failure.

## Statistics and resource estimates

Every restore records table estimates, last explicit/automatic analysis times,
PG version and planner settings, then explicitly ANALYZEs every org table and
records the result. The pre-analysis state is `fresh_unanalyzed` only if no
analysis time is present; otherwise it is `seeded_before_explicit_analyze`.
The final state is `analyzed_after_seed`. Bootstrap analysis/autovacuum may have
already run; an arm must never be labelled untouched solely because this
generator has not yet issued ANALYZE. Retain the pre-analysis metadata for a
separately authorized cold-state diagnostic. No cold load is started here.

The estimate command samples a complete payload cycle and up to 1000 active
templates without generating the full history. It includes existing fixed read
tails when estimating ratios. Disk planning includes the pair bundle, restored
transcript files and one SQL arm, with 3x SQL allowance for heap/indexes and 3x
for WAL/temp, 20% margin and 2 GiB spare. These are conservative **planning
factors**, not measured amplification. Recompute from the actual frozen N1000
input and check free space on every destination volume. Database size in a small
test includes that test's shared database/cluster overhead, so linear extrapolation
must not treat it as a pure row-size measurement.

The full 10x fixture has not been built. Small serial preparation throughput is
an estimate input only; import triggers, ANALYZE, storage and historical ingestion
can change full-size timing. Large generation/load remains held until explicit
coordinator release and 24 GiB free-commit preflight. Small tests use the normal
p03 queue and its 12 GiB admission floor. No N1000, renderer, memory-flatness or
5% history-growth result is established by these controls.
