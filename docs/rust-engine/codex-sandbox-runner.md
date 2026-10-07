# Codex Windows runner investigation (2026-10-07)

The reported failure is not specific to a newly hired agent. Both parity-astra
and an existing feed-astra session fail ordinary shell commands with
`timed out after 15000ms connecting runner pipe-in`. The shell has not started:
the native command item has no process id, exit code -1 and duration 0.

## Measured comparison

The engine log and the two sessions' execution metadata show:

| Observation | parity-astra | feed-astra |
| --- | --- | --- |
| Thread sandbox | workspace-write | workspace-write |
| Approval policy | on-request | on-request |
| Model | gpt-6-astra | gpt-6-astra |
| Primary account home | Default Codex home | Default Codex home |
| Ordinary command | Three startup failures at 00:13-00:14 UTC | Same startup failure at 00:12:37 UTC |
| Successful comparison | No escalated command in the failed turn | Retry at 00:12:42 UTC requests `sandbox_permissions=require_escalated` and completes |

The working agent's configuration alone was misleading: most of its successful
commands explicitly requested escalation. The matching failed/retried command
reads `docs/machine-traps.md`. This explains the observed difference without
claiming that all workspace-write commands work for established agents.

Parity's logged launch uses Codex 0.160.0, its own scratch cwd, no explicit
`CODEX_HOME`, no API key override and only the compaction-threshold config
override. The default profile selects `windows.sandbox = "elevated"`. Codex's
sandbox log records successful setup refresh (`errors=[]`) and resolves the
copied 0.160.0 command runner before the timeout. A missing runner or failed
setup was not observed. A later parity launch uses danger-full-access; a
successful shell command after that launch was not present in the inspected log.

## What 3.x did

The preserved Python launch in `engine/backend/orgtree/codexrun.py` starts the
same stdio app-server with the agent scratch cwd, account-specific home only
when applicable, and CREATE_NO_WINDOW. Its supervisor maps edit-enabled
acceptEdits to workspace-write and bypassPermissions to danger-full-access.
It sends sandbox and approval policy on both thread start and resume.

`_codex_approval_decider` accepts an outside-sandbox command retry only when the
seat has shell and write authority; plan and edit-disabled seats cannot use that
escape. Its source documents this route as the authorized Git landing path.
Rust's `runtime/codex.rs::answer` retains the same shell-and-write gate. No
special 3.x runner installation or unconditional permission widening was found
in that launch path. This is source inspection, not a new execution of 3.x.

One process-lifetime difference remains relevant to a deeper investigation:
Python leashes the CLI to a kill-on-close job, while Rust also places the engine
itself in a root job and each CLI in a nested child job. This is a measured source
difference, not evidence that the jobs cause the pipe failure.

## Isolated controls and limits

No-model app-server probes in disposable Codex homes run `cmd /d /c echo probe-ok`.
Danger-full-access completes with exit 0 on both local Codex 0.160.0 and 0.159.2.
Workspace-write with **unelevated** sandbox configuration does not return a
response within the probe's 30-second bound, on either version. The same
unelevated probe times out in a separate hidden process for which
`IsProcessInJob` returns false. All probe processes have ended.

That control does not reproduce the production elevated runner's precise pipe
error. It cannot rule out an interaction between elevated Codex and Rust's jobs,
nor establish an upstream regression. The measured failing component is the
Codex Windows sandbox startup path; attribution between Codex and Orgtree remains
unresolved. No engine fix should be presented as verified yet.

## Proposed next step

Compare the same no-model **elevated** command under the existing sandbox setup
inside the engine job tree and outside every job. This may refresh Codex sandbox
metadata and Windows ACLs, so it needs explicit authorization beyond this task's
read-only/live-data constraint. Do not change an agent's permission mode merely
to run the comparison.

Meanwhile the existing authorized per-command retry is the measured workaround
for a write-enabled shell seat. A targeted agent instruction could explain that
retry after this exact startup error, preserving the normal approval gate and
the plan/edit-disabled restrictions. That would change the instruction prefix;
it should be coordinated rather than added as an unannounced blanket bypass.
