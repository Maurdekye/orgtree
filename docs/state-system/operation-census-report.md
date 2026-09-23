# Offline schema2 census report

`tools/operation_census_report.py` reads **one explicitly supplied local snapshot**
and writes a deterministic JSON or Markdown report to stdout. It uses only the
Python standard library. It does not import the backend, contact an endpoint,
enable capture, inspect live data, or read provider/native conversations.

This is the bounded P02 reporting foundation for the schema2 census landed at
`286396ebc6db13aed7bc0ebcfc873a703828296b`. It does not complete P02 or qualify
native/PostgreSQL behavior. No A2 fields or runtime changes are assumed.

⚠ Since P02-A3 the engine's census produces **schema 3** (it adds the per-attempt
`db` contact block). This tool reads schema 2 only, so it refuses every snapshot
from an engine at or after P02-A3 with exit code 2. That refusal is deliberate
and fail-closed; teaching the report schema 3 is separate, undocketed work.

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

## Focused verification

```powershell
& $censusPython tests/test_operation_census_report.py
```

The synthetic fixture follows the landed builder/snapshot shape and deliberately
contains a managed yield, a missing response start, diagnostics, unknown
dimensions, incomplete accounting, missing numerics, negative unattributed time,
and completion offsets out of append order. Tests separately exercise ring
eviction, response truncation including a zero limit, disabled/empty windows,
nearest-rank arithmetic and ties, mixed/all-missing observations, source hash and
determinism, Markdown escaping, corrupted order/window/identity/accounting,
numeric contamination, input bounds, and explicit unsafe CLI controls. No
backend, native database, capture service, or live endpoint participates.
