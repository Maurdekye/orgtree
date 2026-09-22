# Synthetic 2.x migration and rollback rehearsal

2.x migration changes need repeatable preservation tests without using user data.
This first slice provides generated legacy fixtures, read-only fixture readers,
a replaceable target adapter, verified backup/receipt state, interruption/retry,
and reconstruction of the original readable source. It is preparatory work for
the private v3 programme. It does **not** implement the native v3 import schema,
activate a database, or qualify a real installation for migration.

## Run

From the repository root, with Python's standard library only:

```powershell
python -m tools.migration_harness --scenario ordinary
python -m tools.migration_harness --scenario sqlite
python -m tools.migration_harness --scenario partial
python -m tools.migration_harness --scenario large
python -m tools.migration_harness --scenario interrupted
python -m tools.migration_harness --scenario malformed
python -m unittest discover -s tests -p test_v3_migration_harness.py -v
```

The CLI accepts a scenario, never a source path. It creates an isolated temporary
root, generates invented data, checks import/retry/restore, prints one JSON
report and removes its temporary files. `ORGTREE_DATA`, provider homes and app
settings are not consulted. No backend module is imported. There is no install,
service start, network, dispatch, restart, runtime integration or migration hook.
The Python API's root argument is for tests resuming those generated fixtures;
it requires the exact synthetic marker and refuses unmarked roots. The marker
is an accident-prevention guard, not authentication against a malicious local
writer. Callers must retain exclusive custody of their disposable directories.

Exit 0 means the synthetic checks in `checks` passed. Exit 1 means refusal;
`malformed` is an intentional negative control, with `known_negative` classification.
Argument errors use argparse's exit 2. Other refusal reports do not become a
passing native gate. The report format is `orgtree-synthetic-migration-report`,
version 1. It contains the scenario, result, classification, inventory, named
checks, full import and rollback receipts, source/receipt SHA-256 hashes,
`mapping_status: preserved_unmapped`, `activation_allowed: false`, and an explicit
`not_exercised` list. Redirect stdout to retain the structured evidence; reports
contain generated names and hashes, not fixture bodies. An interrupted scenario
injects a Python exception after candidate publication and retries through a new
harness object. The unittest suite separately kills child processes using
`os._exit(73)` and verifies recovery.

## Source inventory and coverage

The source anchor for the first reader/fixture contract is main `286396e`.
`formats.py` freezes the actual DDL from the listed source modules. An AST-only
test compares those definitions against the checkout without importing runtime
code; schema drift therefore requires explicit reader/fixture review.

| Source family and source evidence | This slice | Remaining native requirement |
|---|---|---|
| `store.py` JSON org documents, document version 1 | All input bytes and fields; ordered document/node view; org/node identity, parent cycles, mail-owner and docket-owner checks | Approved typed mapping of every field, aliases and incarnation rules |
| `store.py` SQLite ledger schema 1: doc, nodes, log_d, log_l, meta | Read-only closed DBs; key/node/owner order, empty logs, keyed steer attempts; eager and rowed legacy sections; full DB bytes retained | Coherent fenced real-source snapshot; streaming native import |
| Existing `.json.premigration` files | Decoded and preserved as independent originals | Proven historical identity and retention obligations |
| `transcript_records.py`: all 15 noninternal tables | Every table populated, schema checked, every column/cell and original DB bytes retained; source epochs/checkpoints, records, tools, auxiliaries, assistant messages and receipts | Native ownership, source/epoch/byte-range/order and cross-table semantic mapping |
| `toolwait.py`: operations, dead_letters | Running and completed-unpublished invented rows, retained result identities; full DB bytes | Settlement, publication custody and no repeated effects |
| `filedelivery.py`: deliveries | Original opaque receipt key/fingerprint and pending `NULL` result retained | Exact legacy hash compatibility and real pending-file reconciliation |
| `reply_events.py`: events | Immutable original reply id/scope/quote retained | Native citation and generation mapping |
| `appsettings.py`, `registry.py`, desktop preferences | Invented JSON settings and credential references only; exact bytes and decoded values | Platform custody and real independent settings roots |
| Transcript JSONL and immutable attachments | Synthetic normalized fixture paths `transcripts/<org>/<node>/*.jsonl` and `content/<org>/<node>/*`; full bytes, row order, source-owner links | Real scratch/uploads/outbox/native journals and source manifests |
| Mail, original operation keys, work scope/history, one-shot watchdog state, transport spool entries inside org docs | Retained values and raw bytes, list order preserved | Complete mail/authority/timer/effect semantics and legacy ordering provenance |
| Other root files, sidecars, tables or SQL schema versions | Explicit refusal before backup/import | Source inventory/classification and a reviewed reader |

The normalized transcript/content paths are **fixture layout**, not an assertion
about the installed data root. Settings from independently owned roots are
co-located only in this synthetic transfer specimen. The sidecar reader proves
schema/cell/byte conservation, not that its generated rows are sufficient to
exercise a real runtime. In particular, native cross-table identities and effect
fences are still unexercised. An org-only backup is never presented as complete:
the manifest includes all represented sidecars and attachments.

Unknown JSON fields are retained losslessly with the entire bundle explicitly
marked `preserved_unmapped`. No field is thereby classified for native use; any
future activation gate must refuse that status. Unknown physical files/tables,
duplicate JSON keys, non-finite numbers, invalid JSON, missing records, orphan
fixture files, conflicting JSON+DB org sources, ambiguous eager+rowed sections,
unaccounted row owners, malformed order metadata, unfinished JSONL tails and
WAL/journal files refuse. Sources must already be closed and coherent. This
reader is deliberately stricter than the runtime's legacy repair heuristics.
It does not claim to accept every historical 2.x root.

Fixtures include ordinary JSON, SQLite with premigration copies, two-org mixed
JSON/SQLite with old opaque work IDs and absent historical seat IDs, and a large
specimen with 1,000 agents and 1,000 JSONL records. The interrupted fixture uses
the mixed specimen. Sizes measure fixture coverage only; they are not capacity,
streaming-memory or latency qualification. All names, bodies, credentials and
records are invented. No production export was used.

## State and recovery contract

One operating-system file lock serializes a rehearsal. A competing invocation
refuses; a dead process releases its lock. Scans reject symlinks, junction/reparse
attributes, hardlinked payloads and nonordinary files. No recursive deletion is
used by the harness; the CLI owns and cleans its newly generated temp root.

1. Preflight reads every represented source, produces exact byte manifests and
   a complete transfer bundle, and checks the bytes did not change while read.
2. `plan.json` pins harness/adapter versions, operation key, source hashes,
   inventory, logical digest and nonauthority/mapping status before backup begins.
3. Backup files are written and fsynced through `.part` files and atomic replace.
   An interrupted initial copy can resume only from the same source. Unknown or
   conflicting backup bytes refuse. Once a receipt exists, a missing or changed
   verified backup refuses rather than being silently recreated.
4. `receipt.json` records `prepared` after the complete backup is verified.
   The adapter builds in `stage/`; its read-back must match every source field,
   identity, order, sidecar cell and original byte, independently of record counts.
5. The staged directory is renamed to `target/`, still **nonauthoritative**.
   The harness rechecks source, backup and target, then records `complete` with
   the target manifest. Retry after publication but before receipt recognizes
   that target; an unchanged complete retry returns exactly the same receipt.
   Changed source, operation key, adapter version, candidate or receipt refuses.
   Control documents are compared with JSON types preserved at every depth;
   boolean/integer/float aliases such as `true`, `1` and `1.0` are not interchangeable.
   Adapter identities are nonempty strings and versions are positive integers.
6. `rollback()` verifies the backup and rebuilds `restored/`, never overwriting
   the source. It proves file-byte equality and readable legacy equivalence,
   then persists `rollback.json`. It resumes interrupted copy/receipt boundaries.
   After a verified backup exists, even deletion of the original source does not
   prevent reconstruction. Candidates and backup stay available as evidence.

Checkpoints are `planned`, `backup-file` (after each completed file), `backed-up`,
`prepared`, `staged`, `published`, `complete`, `restore-file`, and `restored`.
`published` refers only to a local nonauthoritative candidate directory, not a
release or activation. Both exceptions and actual child-process exits are tested.
Writes fsync files; POSIX also fsyncs parent directories. Python does not provide
this Windows directory-fsync operation. Process-exit recovery is **not** a claim
of power-loss durability, disk-full behavior or platform cutover durability.
Restored equivalence covers file contents and decoded data, not ACLs, timestamps
or empty directories. All-at-once memory usage is explicit in this first slice.

## Adapter and qualification boundary

The `Adapter` protocol has a stable `identity`, `version`, `build(bundle, staging)`
and `read(target)` conservation view. `EnvelopeAdapter` is a lossless JSON test
representation containing decoded records **and** base64 original file bytes.
It is not a v3 storage model and is never on a hot runtime path. Adapter changes
must change their version; retries cannot silently switch implementations.
Future native adapters need separately reviewed field/key maps and must retain a
complete export view for these checks. Preserving opaque bytes does not establish
native identity conversion or typed-schema correctness.

There is no activation API. An acknowledged-write marker, explicit
`acknowledged_writes=True`, or changed target refuses old-backup rollback.
Pre-activation source reconstruction is the only rollback demonstrated here.
After real cutover, architecture v6 requires current acknowledged records and
effects via compatible binary or a complete fenced reverse conversion. That work,
native schema/import, writer fences, external effect reconciliation, full source
classification, backup policy/disk budgets, streaming bounds and power-loss
qualification remain separate gates. No existing P01–P10 gate is waived.

The lossy controls remove scope history/transcript receipts, change node/mail or
opaque delivery identities without changing counts, and alter attachment bytes;
all must fail before a complete receipt. Other negatives cover source races,
corrupted backups/receipts/candidates, unknown tables, missing order metadata,
concurrent invocations and changed retry identity. Native symlink creation is
reported skipped when Windows privilege is unavailable; reparse-attribute
refusal and real hardlink refusal are still exercised.
