# State-system implementation: P01 source inventory

The approved design is revision 6, manifest SHA-256
`b830a69bd71b0cee052e78acfe1ceff6b399532765db7ed55d05a253f0f84dfd`.
Docket `rearchitect-data-access-so-reading-one-thing-doe`, decision 58 approves
that design and decision 59 authorizes its staged implementation. Its immutable
documents retain their original review-time headers; those headers do not undo
the later authorization. Installation, live data, deployment and release are
separate operations.

This first bounded P01 change provides executable **source coverage**, starting
at stable `529e2d805142eb5ca5647b286045526a6ae2c329`. It does not complete P01,
approve conversion, replace the operation census, or claim native database
qualification. No product entry point imports this tool.

## What is recorded

`operation-inventory.json` is language-neutral JSON with schema identity
`orgtree.state-operation-inventory/v1`. It records backend module fingerprints,
HTTP/WS/hook decorators, literal tool cards and action enums, worker/task and
callback registration sites, tool/action branch selectors, connection factories
and the legacy document-lock references. Every site names its file, enclosing
symbol, source lines and syntax fingerprint. Source is parsed without importing
the backend, opening its databases, launching workers or contacting providers.

Registration IDs identify **source sites**, not product operation IDs. Multiple
sites can be parts of one operation. A branch selector is evidence that a value
is tested, not proof that the value is accepted or reachable. GET does not imply
read-only, and a local source transaction does not make A-to-B mail self-only.
The runtime census must retain the logical end-to-end denominator.

The scanner retains dynamic selectors and targets as unresolved expressions.
Names such as `mount`, `submit` and `TOOLS` are deliberately conservative source
candidates: a disk mount or an unrelated set can appear and needs disposition,
not inclusion in an operation denominator. Exception-class hooks also appear as
expressions rather than being incorrectly treated as literal route strings.
Task hand-offs are matched by call name, so `asyncio.to_thread` is recorded as
a task site while `anyio.to_thread.run_sync` — a different call name — is not;
the second is visible only through the whole-module fingerprints.
Its import-name resolution does not prove receiver types or exclude local
shadowing. Arbitrary plugins, aliases and generated dispatch cannot be proven
complete by AST matching. All Python files in `engine/backend`, the engine's own
top-level modules (`engine/*.py`, including the desktop launcher `engine/launch.py`)
and `engine/winservice` are therefore
fingerprinted as a second check: even an unrecognized registration or a helper
write invalidates the old snapshot. This is a prompt for source review, not a
claim that its runtime effect was understood. Out-of-tree registrations require
explicit inventory and runtime coverage before conversion. Not scanned:
`engine/native/**/oracle` (offline test-vector generators the product never imports)
and `engine/runtime` (the gitignored packaged interpreter).
`tests/test_state_operation_inventory.py` fails if any other engine module with a route,
hook, task, worker or connection site is left out of the scan.

## Run and review

From the repository root, using the provisioned Python runtime:

```text
python tools/state_operation_inventory.py --check docs/state-system/operation-inventory.json
python tools/state_operation_inventory.py --write docs/state-system/operation-inventory.json
```

`--check` returns 1 on drift and 2 for invalid source/input. Refresh only after
reviewing the source delta. A matching snapshot always reports
`runtime_census: false` and `conversion_authorized: false`; regeneration cannot
turn either into a passing implementation gate. Comments/new lines can require
a refresh because line anchors and normalized source fingerprints are retained;
LF versus CRLF alone does not. Tests introduce a missing route, hidden dynamic
registration, new helper write, omitted site and fabricated qualification to
ensure the guard actually refuses each unsafe alternative.

## Remaining P01 and later gates

Before declaring P01 complete, resolve each concrete entry into reviewed
authority, read/write/predicate sets, isolation/conflict mechanism, canonical
wire/receipt contract, effects and instrumentation. Preserve conditional writes
and the full data/sidecar mapping. Pin the selected PostgreSQL release and
distribution evidence before dependency adoption; operational budgets start as
explicit hypotheses and need the P03 measurements, not invented capacity.

P02 must instrument actual attempted operations, storage contacts, timing,
privacy and loss with the separately docketed census permission split. Runtime
coverage must detect hidden storage access and unknown continuation linkage.
P03 must then qualify disposable native transactions and managed lifecycle,
disjoint/conflicting work, process faults, CPU interference, direct pgoutput,
TOAST/deletion/snapshot joins and reclamation before replacement Ready. Do not
convert broad state paths based on this source inventory or its unit tests.

The existing ninety OrgDoc and sixty-two NodeDoc field map, twenty-two invariant
families and P01-P10 order in the approved packet remain authoritative. Always
use full unique suffixes for new work names; preserve manual and required
migration/upgrade backups, the later full Rust migration, and every negative
control. This change introduces no new product behavior or design decision.
