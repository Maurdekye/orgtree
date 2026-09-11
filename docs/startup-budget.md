# Startup work and readiness

The native inventory used to walk `imports/` for each imported node in the
transcript and hold loops. A large fleet multiplied the cost of the same walk.
The walker checks the import organization, native node folders and their direct
children; it does not recursively descend into native output subdirectories.

`NativeInventory` now belongs to one reconciliation or fleet-resume pass. It is
lazy, remembers a failed validation as well as a successful inventory, and
returns copies. Reconciliation passes it through transcript evidence, native
hold checks and replay admission. Workers still validate native context freshly
before execution. A requested session's path and ancestors are checked even
when its pass already has an inventory.

There is no timed or mtime cache for independent requests. A directory's mtime
does not identify changes below its descendants, including new SID collisions
and junctions. An ad-hoc lookup sees changes on its next call; a pass snapshot
ends with that pass. A new pass always reads a new inventory. Nothing is keyed
by an environment variable that can diverge from the store's bound data root.

The server performs deployment validation and any explicitly enabled account
migration before readiness. Its warm-process and recovery work then runs in a
worker, leaving the server able to announce ready, serve the desktop shell and
answer identity/shutdown requests. Read-only observations may reflect repair as
it lands (an organization read can still wait for the document lock). API writes
wait asynchronously for the repair to finish; automatic turn drivers, incoming
network delivery and restart wakes start after reconciliation. This preserves
interrupted-turn, model-switch and delivery-journal ordering. Pending recovery
does not count as idle for maintenance. A failed repair returns 503 to writes;
shutdown releases waiting requests without admitting them.

Desktop and boot-host readiness deadlines measure silence: 60 and 120 seconds
respectively. Only a structured checkpoint with the expected child PID/root
and an advancing sequence resets the timer. Checkpoints correspond to completed
steps or the next phase starting. There is no unconditional heartbeat thread;
ordinary logs and repeated checkpoints cannot disguise a hang. The separate
desktop attachment retry window remains bounded at 150 seconds.

On failed readiness, both hosts terminate their child tree and observe root-lock
release before calling cleanup complete. A structured `root-owned` refusal is
the boot race: its lock belongs to another engine, so it is neither terminated
nor awaited. Missing or held lock evidence is reported as unverified; the
desktop will not start another managed child over unverified cleanup.

## Regression budgets

`fleet_walk_budget` counts synchronous work on the current thread. Its decorators
sit on the walkers, below cache/reuse boundaries, and are unrestricted outside a
budget. Nested budgets both count; other threads have independent budgets.

| Label | Filesystem work |
| --- | --- |
| `imports-inventory` | Validated destination native inventory |
| `transcript-index` | Provider project and engine journal index |
| `transcript-search` | Uncached wildcard search across transcript projects |
| `workspace-tree` | Organization workspace/scratch storage measurement |

When adding a fleet walker, label its actual traversal and set a budget in the
calling pass's regression fixture. Assertions must exercise real eligible nodes
and check the expected count, not only an upper bound. Tests must also disable
reuse or deliberately exceed the budget to prove the counter can fail.

Run `python tools/test-startup.py` and `node --test tests/startup-engine.test.mjs`.
The Windows CI workflow runs those same commands. Each Python suite starts in a
separate process with explicit temporary storage before importing the store.
The large fixture has 500 Claude imported nodes and 20,000 direct import entries;
it verifies every session resolves, one inventory traversal, reconciliation
under 30 seconds, and real launcher readiness under 15 seconds while the sweep
is deliberately blocked. A synchronous-lifespan control misses readiness until
the same sweep is released. External providers and transports are disabled in
that launcher fixture: it measures engine startup, not provider login or process
warmup. Windows guardian tests explicitly declare themselves inert elsewhere.
