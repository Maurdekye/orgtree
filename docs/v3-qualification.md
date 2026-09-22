# v3 synthetic qualification harness

`python -B tools/qualify-v3.py --components --output artifacts/v3-qualification.json`

This first slice runs against the source checkout. It creates an empty temporary
SQLite data directory, drives production `TokenGate` and `/api/agent` through
HTTP/ASGI, closes that worker, and checks the same synthetic database in a new
process. It never attaches to an engine, accepts a live endpoint, copies live
organizations, starts application lifespan, installs, packages, or restarts the
desktop. Provider/desktop process launches are forbidden inside probe workers;
only read-only Git identity/status queries are allowed.
Fixture seats are inert ledger records. No provider account is used by the probe.

The source identity includes commit, Git tree, dirty state and a SHA-256 over
tracked and untracked nonignored files before and after execution. Changed
source fails the slice. The interpreter comes from the existing
`tools/run-python-verification.py` selection logic; the worker uses the existing
import-provenance assertion. Review/delivery evidence must use a clean committed
candidate. Put reports under ignored `artifacts/` to avoid source churn.

## Evidence levels and exit status

- **Component:** an existing isolated test suite or a report checker. Mocks and
  narrower entry points in those suites remain their limitations.
- **Composed:** the backend middleware, dispatch, authentication, receipts and
  SQLite path together, using in-process HTTP. No real socket, startup lifecycle,
  PostgreSQL service or rendered desktop is exercised.
- **Full product:** reserved for a shipping candidate with native services and
  desktop behavior exercised together. This runner never grants that level.

Exit 0 means every exercised slice passed. Missing coverage remains
`not_exercised`, and `full_product_qualified` is always false in this first slice.
Exit 1 means an exercised check, worker, provenance or cleanup failed.
`--require-full-product` exits 3 after a passing slice while full-product evidence
is missing. A zero-test or unstructured component receipt cannot pass.

## Work and measurements

The default matrix is concurrency **1/4/8/11/16**, with **24** evidence appends per
run. Fixed-work submits the same bounded batch at each concurrency. Fixed-demand
offers requests independently of completions at **24/48/96 per second** (1x/2x/4x).
It retains arrival lag and the queue rather than slowing offered demand when
workers are busy. The total finite batch and maximum worker count bound memory.
There is no dropped-request policy. This is a short synthetic stress curve,
not an observed-load replay or a steady-state capacity estimate.

Each run records offered/submitted/completed/failed/refused/nonterminal/dropped
counts, final backlog, peak executor queue and in-flight requests. Every sample
keeps arrival lag, executor queue wait, in-process HTTP time and elapsed time from
the scheduled offer. p50/p95/p99/max use the nearest-rank method and report their
sample denominator. All outcomes remain in latency distributions; failures are
also counted, not silently excluded. At small sample sizes p99 is usually the
maximum. Fixed-work elapsed time includes draining the entire offered batch.

Existing `stateprobe` aggregates attribute lock wait/hold, parsing, serialization
and lazy-section work to production operation labels. They are reset after
fixture setup and read before verification requests. They are aggregate
diagnostics, not per-request causal joins or complete native contact traces.

The workload is **only work.evidence appends**, warmed by fixture creation/get.
Controls prove exact final refs and revisions; four concurrent same-key retries
produce one effect; changed payload is refused; an old generation token is
refused after fixture revocation and a fresh token succeeds; sequential updates
are visible in order and stale revision replacement is refused. Reopen checks
acknowledged state and the original receipt and refuses a new intent under the
old process epoch. This is clean process persistence, not crash/power-loss proof.
The current legacy API uses 422 for stale revision/epoch refusals and 409 for
changed-payload key conflict; these are checked against actual response details.

Nine **observation-mutation** controls deliberately damage copies of the measured
results and require the checkers to detect loss, duplicates, missing completion,
stale authorization, ordering and recovery faults. A failing positive baseline
does not count as a killed control. These controls test checker sensitivity;
they are explicitly not unsafe mutations of product code or proof that an
arbitrary implementation fault will be caught. Existing component tests are
reused with `--components`: tool-call atomicity/freshness, mail drain, restart
marker identity and startup recovery. Their mocks remain visible limitations.

## Deliberately incomplete coverage and adapter boundary

The report enumerates native PostgreSQL/Rust, migration and post-acknowledgment
rollback, window identity/routing/restoration, Attention/Desk retention,
commit-to-paint, mixed UI demand, cold runs, 10x history, churn/settle, finite
funding/topology/torn-state races, unsafe production controls, native termination,
and all-entry logical census as missing. It does not adopt the v6 latency gates
from in-process append timings. No small-command, tree or paint SLA is claimed.

`tools/v3_qualification/backend.py` owns only the backend adapter.
`evidence.py` checks observations without reconstructing product state.
`runner.py` owns isolated process execution and coverage classification.
Migration and renderer/native owners can add adapters with the same row fields:
`id`, `level`, `classification`, `errors`, `observed`, and explicit `limits`.
Classification must reflect the actual boundary and the exact candidate; a
missing runner must remain `not_exercised`. Future adapters must use their
production interfaces and reusable synthetic fixtures. Do not promote a
schema-neutral migration envelope or a renderer mock to native/full-product
evidence. No externally supplied report is trusted as a qualification today.

For a short development run:

```powershell
python -B tools/qualify-v3.py --concurrency 1 4 --operations 4 --demand-multipliers 1 --output artifacts/smoke.json
python -B tools/run-python-verification.py --repo-root . tests/test_v3_qualification.py
```

Operations are limited to 1..40 (below the 50-row work evidence cap), concurrency
to the recorded matrix, offered rate to 1..1000 before the demand multiplier,
and each worker timeout to 1..600 seconds. Timeout/crash fails the slice and
still attempts to clean the owned temporary root. The output preserves bounded
failure context. Reports are evidence for this slice, not a completed P10 gate.
