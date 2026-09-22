# v3 synthetic qualification harness

`python -B tools/qualify-v3.py --components --output artifacts/v3-qualification.json`

Add `--wire --migration` to include the separately reviewed wire compatibility
suites and six synthetic migration preparation scenarios from the same checkout.

Add `--ui` on Windows to run the reviewed whole-App Electron probe's baseline
and all four deliberate failure controls. This requires the checkout's existing
Node/Electron/esbuild dependencies. A missing dependency or unsupported platform
fails a requested slice; it never silently reduces the requested coverage.
Requested adapters must produce complete passing evidence; missing tools,
unstructured/empty receipts, timeouts and unexpected refusals fail the slice.

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
The receipt must contain each requested suite exactly once; missing, duplicate
or unexpected modules fail even if its overall process returned success.

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
Every refusal has an immediate before/after revision and SHA-256 comparison of
the complete public item response. The permitted final revision delta is counted
from item creation, before any control request, so later valid updates cannot
hide a refusal's side effect. Adapter tests reproduce that risk by injecting a
real public update after a refused request returns.

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

## Optional reviewed adapters

`adapters.py` invokes sibling tools without reimplementing their product behavior.
All outputs remain bound to the runner's before/after source identity. The same
temporary environment removes inherited Orgtree/provider selectors. Adapter
processes receive fixed commands; there is no live endpoint or source-root input.
Child TEMP/TMP/TMPDIR paths are contained inside the parent's owned temporary
root, so timing out a migration CLI also removes the fixture whose own cleanup
context could not run. A real-CLI regression pauses after each of the six real
fixtures is created, times out the process and checks containment and removal.

`--wire` reuses `test_wire_contract.py` and `test_wire_contract_controls.py` through
the existing isolated verification runner. Both exact module identities must
appear once, with successful structured results and the reviewed counts of 11
and 1 tests. The latter test owns six fault subtests; the outer receipt counts
the test, not six independently enumerated outcomes. Changes to these counts
require deliberate adapter review. This is composed current-Python TCP HTTP/WS
and real MCP stdio compatibility evidence. It does not execute application
lifespan, providers or the native v3 durable-feed protocol. See
[wire conformance](wire-conformance.md) for the complete fixture and control limits.

`--migration` invokes the reviewed migration CLI for ordinary, SQLite, partial,
large, interrupted and malformed synthetic fixtures. Five positive scenarios
must provide all six named conservation checks, complete import and restored
receipts, matching source/restore manifests and consistent SHA-256 fields. Their
mapping remains `preserved_unmapped`, authority `none`, and activation false.
The malformed control counts only when the five baselines pass and the CLI
returns its exact invalid-JSON refusal with exit 1. A crash, unrelated refusal
or missing result fails. Interrupted identifies its Python exception after
local publication. CLI durations include fixture generation and rehearsal, and
are not native migration latency measurements.

This migration evidence is component-level synthetic preparation. It preserves
all reported native gaps and never qualifies native schema import, live capture,
writer fences, activation, current-state post-acknowledgment rollback, power-loss
durability, streaming bounds or external-effect reconciliation. The CLI's six
scenarios do not run its separately reviewed abrupt-child-exit test suite. See
[synthetic migration](state-system/synthetic-migration-harness.md) for that scope.
Omitting either flag records its optional adapter as `not_exercised`. Passing
both still leaves `full_product_qualified` false and `--require-full-product`
returns 3 after an otherwise passing slice.

## Optional whole-App composition

`--ui` runs `node tools/run-app-composition-probe.mjs <owned-root> <mode>`
for `baseline`, `no-bus`, `no-readiness`, `no-lifecycle`, and
`no-compact-header`. The baseline must report exactly 57 named passing checks.
Each control must have its exact assertion roster and only its intended failures:
`cold-visible-exact` for the first two controls, `reload-visible-exact` for the
third, and the three narrow-header geometry checks for the fourth. All other
checks must pass. An arbitrary exit 1, crash, missing assertion, duplicate,
unrelated failure, inconsistent summary, unexpected HTTP request or different
source identity fails. Controls count only beside a passing baseline.

These are **composed UI** results. The shipping production-React App, preload,
Preferences and window/held-event/lifecycle helpers execute. Fixture code owns
the main process bindings and window construction; canned loopback HTTP/WS
supplies state. The probe does not execute production `main/index.ts`, a real
engine, OS notification service, native confirmation dialog, installed app or
startup/crash restoration. Attention/Desk and three-org window observations
retain those boundaries. See [the probe contract](../tests/app-composition.md).

The parent assigns a waiting launcher to the production Windows Job helper
before allowing Node or Electron to start. On success, failure or timeout it
terminates the entire owned process tree and waits for zero active processes
before removing the temporary root. Tests exercise real child/grandchild timeout
and normal-exit orphan cleanup, plus refusal before ownership is established.
`cleanup.completed` cannot be true when UI process cleanup is unproven. No
process-name search or unrelated PID termination is used.

Reports embed complete assertion details, source and HTTP receipts, bounded log
tails, and SHA-256/size records for generated screenshots and probe evidence.
Temporary images/builds are removed; the hashes are attribution records, not
downloadable screenshots. To retain images, run the standalone probe with your
own output directory. Receipt reads are capped at 2 MB and individual evidence
files at 16 MB/100 files per mode. Probe durations include build, fixtures and
deliberate waits; they are not commit-to-paint latency measurements.

Omitting `--ui` records missing optional coverage. Passing it does not clear the
remaining native/full-product gates or change `--require-full-product` exit 3.

For a short development run:

```powershell
python -B tools/qualify-v3.py --concurrency 1 4 --operations 4 --demand-multipliers 1 --output artifacts/smoke.json
python -B tools/run-python-verification.py --repo-root . tests/test_v3_qualification.py
python -B tools/run-python-verification.py --repo-root . tests/test_v3_qualification_adapter.py
```

Operations are limited to 1..40 (below the 50-row work evidence cap), concurrency
to the recorded matrix, offered rate to 1..1000 before the demand multiplier,
and each worker timeout to 1..600 seconds. Timeout/crash fails the slice and
still attempts to clean the owned temporary root. The output preserves bounded
failure context. Reports are evidence for this slice, not a completed P10 gate.
