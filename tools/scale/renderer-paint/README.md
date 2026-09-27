# Real renderer paint measurement

This is harness-only tooling. It runs the production Vite renderer and production
preload in a separate Electron process against an existing disposable scale fixture.
The installed app is never launched. Native window/preferences IPC is a fixture;
HTTP and WebSocket data come from the real engine and PostgreSQL. HTTP mutations
are refused. The runner refuses live roots, non-loopback endpoints, an unproven
server process, non-scale database names and missing active workload.

## Meaning of the numbers

Each click uses Electron `sendInputEvent`, checks a trusted browser click and a
previously false visible UI postcondition, then changes a tiny proof tile. The
timer stops only when Electron's offscreen paint callback contains that exact
opaque pixel ID. This measures input dispatch to compositor frame delivery,
including probe overhead. It is a conservative upper bound on the selected UI
change, **not physical display latency**. DOM readiness or `requestAnimationFrame`
alone never completes a measurement. The real renderer is instrumented externally;
no product source changes or React-state shortcuts are used.

The five groups are select-agent, open-docket-item, switch-tab (inbox),
open-attention, and open-chat. Setup clicks are retained but excluded from these
groups. Raw samples plus p50/p95/p99/max are kept. Every measured click must be
<100ms to meet the target; small N10 runs validate tooling, not N1000.

For the selected visible agent, each emitted `[[mN]]` marker is joined to its
actual HTTP submission, renderer WebSocket receipt, visible text range, and
compositor proof. Interior missing IDs cannot be hidden by a later maximum ID.
Failed submissions, missing receipts, received-but-unpainted updates and late
updates are reported separately. Feed has a five-second final observation horizon;
anything after the one-second deadline stays late. Arrival-to-paint and
emission-to-paint are both reported, with clock uncertainty included in the latter
threshold. Every expected marker must qualify; zero markers never passes.

Only the selected agent's visible feed is tested. Coalesced markers that never
become visible are unpainted even if the latest state arrived. This is a strict
per-update interpretation. Other HTTP harness windows are synthetic; this tool
does not claim full multiwindow, all-agent or physical-monitor coverage.

## Run discipline and controls

Obtain the exclusive machine slot first. Build before starting engine load. Do not
attach to another agent's measurement. Until coordinator approval, use at most N10.
Use the existing scale seeder/prepare/server/load orchestrator with its disposable
PG instance and approved launch audit. Start the load with streams, tool calls and
steer polling enabled; allow enough duration for renderer startup, setup clicks,
all repeats and the feed window. This harness attaches to that fresh descriptor;
the orchestrator still owns engine/PG/load cleanup. It never attaches to the live
application and never terminates a process it did not spawn.

```powershell
node tools/scale/renderer-paint.mjs build --output E:/scratch/paint-build
node tools/scale/renderer-paint.mjs selfcheck --build E:/scratch/paint-build --output E:/scratch/paint-control
# While an independently owned disposable load is actively running:
node tools/scale/renderer-paint.mjs run --build E:/scratch/paint-build --descriptor E:/scratch/fixture/scale-descriptor.json --label measured --output E:/scratch/paint-run --seconds 15 --repeats 3
# After that load has completely drained and written summary.json:
node tools/scale/renderer-paint.mjs report --output E:/scratch/paint-run
```

Use new output directories; existing directories are refused. The runner records
clean committed source provenance. It guards free virtual memory independently
of a responsive renderer and has an outer wall deadline. Owned Electron processes
are terminated on guard/deadline failure; use the machine run wrapper so a killed
driver also has its owned children collected. No raw descriptor token or PG URL
is copied into measurement artifacts.

Every Electron run calibrates frame cadence and cross-process clocks. Controls
include an actual measured 250ms renderer stall and a proof tile deliberately
withheld after DOM readiness. The delayed paint must increase latency, and the
withheld paint must remain incomplete. Pure accounting/refusal checks are in
`model.test.mjs`; run only those with `node --test`, under agreed test discipline.

`renderer.json` and `events.jsonl` are raw evidence, not a pass. `report` also
requires the entire measured interval to fit inside the final load config's
active demand window, actual completed calls and steer polling in that interval,
the load's clean completion, no WebSocket close or launch invalidation, all five
click groups, and a nonempty feed. It preserves the load's actual simulation mode
and activity counts: queued-mail load must not be described as completed provider
turns. Valid but slow runs still produce a report; `clickTargetMet` and
`feedTargetMet` are separate from `validMeasurement`.

No N1000 performance or memory-stability result is implied by building this tool.
