# Offline schema2/schema3 census report

`tools/operation_census_report.py` reads **one explicitly supplied local snapshot**
and writes a deterministic JSON or Markdown report to stdout. It uses only the
Python standard library. It does not import the backend, contact an endpoint,
enable capture, inspect live data, or read provider/native conversations.

This is the bounded P02 reporting foundation for the schema2 census landed at
`286396ebc6db13aed7bc0ebcfc873a703828296b`, extended in P02-A4a to read the
**schema 3** census that P02-A3 produces (it adds the per-attempt `db` contact
block for the primary SQLite store). It does not complete P02 or qualify
native/PostgreSQL behavior.

The tool reads exactly schema versions **2 and 3** (the JSON integers, never a
bool, float or string) and refuses every other version with exit code 2,
including the schema 4 planned for P02-A4b. A schema-2 snapshot is reported
byte-for-byte as before (report schema v1); a schema-3 snapshot is reported as
report schema v2, described under [Schema 3](#schema-3-observed-primary-store-contacts).
Note that the comment above `SCHEMA_VERSION` in `engine/backend/orgtree/census.py`
still says this tool refuses schema 3; it is left unedited so the P01
source-binding artifacts stay unchanged, and this document supersedes it.

## Run against a supplied file

From a checkout, with the provisioned interpreter selected explicitly (substitute
the actual provisioned Python path on your machine):

```powershell
$censusPython = 'E:\Libraries\Desktop\orgtree\engine\runtime\python.exe'
& $censusPython tools/operation_census_report.py tests/fixtures/operation-census-report/mixed-schema2.json --format json
& $censusPython tools/operation_census_report.py tests/fixtures/operation-census-report/mixed-schema2.json --format markdown
& $censusPython tools/operation_census_report.py --help
```

The example input is entirely synthetic. An existing offline snapshot can replace
that filename. Redirect stdout using your shell if you need saved reports; the
tool itself writes no files. Run once for each output format. Exit code 0 means
the supplied snapshot was reportable; exit code 2 means refusal, with no report
on stdout. Successful analysis does not imply a complete capture.

## Input boundary

The tool accepts the schema2 `census.snapshot()` object, optionally with the agent
door's `ignored_arguments` list. A JSON array of snapshots, JSONL, a logical-span
schema, unknown fields (including future A2 fields), and other schema versions
are refused. Required snapshot/record identity fields must be present; optional
numeric observations can be absent or null and remain missing. The snapshot's
vocabulary must match the landed schema2 vocabulary.

The fixed bounds are 16 MiB of UTF-8 input, 16,384 served records, 4,096 characters
per string, nesting depth 12 and 1,000,000 value nodes. Source capacity must remain
within the schema2 range 64–262,144; the analyzer's served-record bound is smaller
than the largest possible source ring. Numbers must be finite, non-boolean and
at most `2**53-1` in magnitude. Counters and sequence identities must be integers.
Durations/counts must be nonnegative except the source's deliberately unclamped
`unattributed_ms`. These limits are fixed and cannot be disabled by a CLI flag.

URLs, stdin, UNC/network paths, device/alternate-stream paths, symlinks/reparse
points, directories, and nonregular files are refused. On Windows the input must
be on a local fixed drive. Move a supplied offline export to an ordinary local
file before invoking this tool. Duplicate JSON keys, nonfinite literals,
overflowing exponent numbers and inconsistent accounting are errors, not rows
silently dropped from the report. The tool is not an authenticity verifier or a
filesystem sandbox against concurrent hostile path replacement.

## What the report contains

The JSON report schema is `orgtree.operation-census-report/v1`. `source` identifies
the input basename, byte length, and SHA-256 of the exact input bytes (including
any UTF-8 BOM). `snapshot` preserves the supplied schema, process `instance`,
window generation/origin/duration, enable state, capacity, sequence boundaries,
all counters, source vocabulary, provenance, limits and optional ignored arguments.
No report-generation timestamp or machine path is added. Identical input bytes
under the same basename produce identical JSON and Markdown on repeated runs.

`timeline` preserves every served attempt in contiguous **sequence order**. A
row's `t_ms` is an offset near HTTP-attempt completion, measured against the
snapshot window origin. It is not a start time. Sequence is assigned later, on
ring append, so completion offsets can decrease under concurrency. The analyzer
does not sort by time or subtract durations to invent start timestamps. Each
offset must lie in the supplied window. The original fields and optional
measurements remain available in the JSON timeline.

`ranks.handler_ms` and `ranks.total_ms` independently group by the available
`op`, method, route, tool, action, action discriminator and subdimensions. Missing
tool/action dimensions remain null. The diagnostic flag is part of the grouping
key, making diagnostic groups separate. Each group has attempt `count`, numeric
`known`/`missing` counts, p50/p90/p99, max, and cumulative milliseconds. Ranks sort
by descending cumulative known duration, with entirely unknown totals last;
canonical operation identity breaks ties. Each list has ordinal ranks starting
at 1. JSON preserves the complete identity; Markdown prints it beside the values.

Percentiles use **nearest rank**: sort the `n` known observations ascending and
select `x[ceil(p*n)-1]` for `p=0.50`, `0.90`, `0.99`. There is no interpolation.
For `[1,2,3,4,5,6,7,8,9,100]`, p50=5, p90=9, p99=max=100, and cumulative=145.
An additional missing observation changes count and missing, not those values.
If `n=0`, all percentile/max/cumulative values are null, not zero. A measured
zero is known. Cumulative uses `math.fsum`; it sums potentially overlapping
attempts and is not elapsed wall time. CPU, stages, and lock measurements are not
added to handler/total duration or relabeled as exclusive duration.

`special_records` lists sequence references for diagnostic, nonterminal and
no-response-start records; the categories can overlap. The same records remain
in the timeline and ranks whenever the ranked duration is known. Markdown gives
these categories their own table and flags each affected timeline row. A managed
yield keeps HTTP200, `terminal=false`, `nonterminal_reason=managed_yield` and
`outcome=unknown`. Its later result is absent. Even `terminal=true`/`outcome=ok`
is HTTP-attempt evidence, not proof of successful logical-operation completion.

## Coverage and counter meanings

The report always says **incomplete; complete capture is not established**.
Its population statistics describe the served attempts only. The coverage block
keeps these quantities separate:

| Quantity | Meaning |
| --- | --- |
| observed_attempts | Source `observed`: attempts seen by access middleware, even with capture disabled |
| recorded_attempts | Attempts appended in this window |
| retained_in_ring | Served rows plus `truncated_by_limit` |
| served_attempts | Rows actually supplied to the analyzer |
| evicted_attempts | Recorded rows removed by ring capacity; equals source `evicted_derived` |
| retained_not_served | Rows still retained but omitted by the snapshot's serving limit |
| observed_without_served_record | `observed - served`; includes omissions, not just eviction |
| observed_minus_accounted | Signed residual described below; never an exact pending count |

The source counters are reproduced individually in both formats:

- `skipped_disabled`: observation began while capture was off.
- `skipped_self`: census reads excluded from the ring.
- `rejected`: observer exceptions; not a logical refusal count.
- `dropped_capture_off`: capture stopped between observation and append.
- `dropped_stale_window`: a record built against an earlier window was dropped.
- `nonterminal`, `no_response_start`, and the four `unclassified_*` counters:
  labels on recorded attempts, **not disjoint omission counts**.

The residual is `observed - recorded - skipped_disabled - skipped_self - rejected
- dropped_capture_off`. `dropped_stale_window` is deliberately excluded: the
source increments it in the new window after resetting the old observation
count. A positive residual may include builds in progress at snapshot time.
The landed source can also increment `skipped_self`/`rejected` across a reset
without carrying their old observations, so a negative residual is exposed as
ambiguous accounting, not relabeled as loss or silently zeroed. Hard checks still
require `recorded + skipped_disabled + dropped_capture_off <= observed`.

Ring accounting must reconcile exactly: `recorded = served + truncated_by_limit
+ evicted`, retained population equals `min(recorded, capacity)`, and the served
rows must be the contiguous tail ending at `recorded`. Snapshot sequence
boundaries, row schema/unit, operation identities, enum values, outcome/terminal
consistency, diagnostic flags and served provenance must agree. Observable row
flags must fit the corresponding full-window counters, allowing for unserved
rows. Unknown tool classification cannot be reconstructed from a fallback route
row, so its counter is preserved without inventing per-row labels.

`measurement_coverage` counts known/missing for every supported numeric
observation, including unwired optional lock measurements. An absent field is
not evidence that contention was zero. `dimensions` counts observed enum labels,
including `unknown` and method `other`. Source `declared_coverage` is preserved
and checked only as the fraction of served rows carrying a declaration. It is
not a locality percentage. No actual database contacts, conflicts, transactions,
logical-operation denominators, non-HTTP work, or complete continuation history
can be derived from this schema. The source's overhead and default-off caveats
remain visible in both report formats.

## Schema 3: observed primary-store contacts

A schema-3 snapshot is checked against the producer's closed sets, which are
restated in the tool (it never imports the backend):

- top level: the schema-2 fields plus `contact_coverage`;
- counters: the schema-2 counters plus `db_unbound`, `db_unattributed`,
  `db_late`, `db_hidden_unattributed`, `db_self_recursion`, `db_observe_failed`;
- vocabulary: the schema-2 vocabulary plus `db_store` and `db_kind`, exactly;
- records: `v` must equal 3, and the only new optional field is `db`, which is
  exactly `store`, the nine integer counts (`connects`, `connect_failed`,
  `checkouts`, `statements`, `statement_failed`, `statement_busy`,
  `engine_steps`, `hidden_steps`, `linked_threads`), `kinds` and `kind_failed`
  (keys from `db_kind`, values integers of at least 1);
- provenance: `measures_storage_contacts` must be `primary_sqlite_store_only`,
  and `rows_with_contact_evidence` / `rows_without_contact_evidence` must equal
  a recount of the served rows;
- `contact_coverage`: exactly `primary_store`, `instrumented`, `uninstrumented`,
  `other_processes`, `complete`, `kinds`, `fields`; `complete` must be `false`,
  and every entry must name a repository-relative `.py` path and a dotted
  symbol, never a machine path or free text.

Any other key anywhere — a SQL string, a path, parameters, a slug, a duration,
rows examined, a schema-4 `secondary` block — is refused. So is a schema-3
field on a schema-2 snapshot and a record whose `v` differs from its snapshot.

Only invariants the producer guarantees are enforced. A statement's kind and
failure are credited in one atomic tally update, so `sum(kinds) == statements`
and `kind_failed[k] <= kinds[k]` hold exactly. `statement_failed`,
`statement_busy` and `connect_failed` are separate later updates that the
attempt's seal can fall between, so they are only bounded:
`statement_failed <= sum(kind_failed)`, `statement_busy <= statement_failed`,
`connect_failed <= connects`. Engine steps, hidden steps, checkouts and linked
threads come from independent sources and are not related to statements.
`db_unbound` is bumped once per recorded attempt without a `db` block, so the
served rows bound it like the classification counters. The other `db_*`
counters are tied to no record and are only checked as integers.

The report (schema `orgtree.operation-census-report/v2`) keeps every v1 section
unchanged and adds `contacts`:

- `totals` and `by_operation`: sums of every count and kind over served rows
  that carry a `db` block, grouped by the same operation identity as the
  duration ranks and ordered by statements;
- `with_contact_evidence`, `without_contact_evidence` and the sequence numbers
  of rows without a block. A row without a block was not observed (its attempt
  began before capture was on). It is listed, never summed as zero;
- `process_counters`: the six `db_*` counters, attributed to no operation;
- the snapshot's `contact_coverage` and limits, preserved under `snapshot`.

Nothing is divided: there is no locality, share, rate, rows, IO or duration
figure, and `complete` is always `false`. The v2 limits say that contact sums
cover only the primary store's own connections.

The schema-3 fixture `mixed-schema3.json` is synthetic. Its vocabulary,
provenance note, limits and `contact_coverage` were copied from a real
`census.snapshot()` produced by this checkout's census against a temporary data
root (the same child-process producer the round-trip test runs). Its records are
the six schema-2 fixture rows with `v: 3` and hand-set `db` blocks covering an
unobserved row, zero-contact rows, a failed and busy statement, a failed
connect, a hidden step and a managed tool's linked thread.

## Contact-observer overhead benchmark

`tools/census_contact_overhead.py` is an offline single-machine microbenchmark.
It creates a temporary data root, points `ORGTREE_DATA` at it before importing
any backend code, refuses to run if the store bound any other root, and takes no
path, URL or endpoint argument. Three arms run interleaved, with their order
rotated each repetition, after discarded warmup repetitions:

- `plain`: the store's connect arguments and pragmas without `factory=` and
  without the pool's checkout note (the store before P02-A3);
- `observed_off`: the real `store._open_conn` / `_Pool` with capture off (the
  shipped default);
- `observed_on`: the same with capture on and a bound per-thread tally.

The workloads are `pooled_read` (checkout plus one keyed SELECT),
`write_transaction` (BEGIN IMMEDIATE, one upsert, COMMIT) and
`executemany_batch` (a 16-row upsert in a transaction). Each runs with 1 and 8
threads. The JSON output gives the median and nearest-rank p90 of wall
nanoseconds per statement call, and the deltas against `plain`, together with
the Python and SQLite versions, CPU count and run sizes. Its `claim` field says
what the numbers are not: end-to-end, request-level or product overhead.

```powershell
& $censusPython tools/census_contact_overhead.py --repetitions 30 --statements 200 --warmup 3
```

## Focused verification

```powershell
& $censusPython tools/run-python-verification.py --repo-root . tests/test_operation_census_report.py tests/test_census_contact_overhead.py
```

`test_operation_census_report.py` pins the schema-2 JSON and Markdown bytes to
SHA-256 values measured before schema 3 existed. It exercises exact version
dispatch, the cross-schema, privacy, closed-set and invariant refusals (with
positive controls for what the producer can legitimately emit), and a
producer-to-report round trip. The round trip runs the in-tree census in a
child process against a temporary data root with capture on, writes its
schema-3 snapshot, reports it through the CLI, and compares the contact sums
with an independent recount; a field the report does not know fails it.
`test_census_contact_overhead.py` checks only the benchmark's output shape and
its argument refusals, never a timing.

The synthetic fixture follows the landed builder/snapshot shape and deliberately
contains a managed yield, a missing response start, diagnostics, unknown
dimensions, incomplete accounting, missing numerics, negative unattributed time,
and completion offsets out of append order. Tests separately exercise ring
eviction, response truncation including a zero limit, disabled/empty windows,
nearest-rank arithmetic and ties, mixed/all-missing observations, source hash and
determinism, Markdown escaping, corrupted order/window/identity/accounting,
numeric contamination, input bounds, and explicit unsafe CLI controls. No
backend, native database, capture service, or live endpoint participates.
