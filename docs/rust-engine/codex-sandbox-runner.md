# Codex Windows runner investigation (2026-10-07)

The failure reproduces in Codex without Orgtree running it and outside every
Windows job: it belongs to the local Codex elevated sandbox path, not an
Orgtree-only launch or job-containment failure. Whether the underlying defect
is in Codex's implementation or its local Windows sandbox setup remains open.

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

The unelevated control alone did not reproduce the precise production error.
The subsequent elevated comparison below supplies that evidence instead.

## Completed elevated comparison

The coordinator authorized a scratch copy only. The copy contained the profile
configuration, sandbox capability SID, existing setup marker and sandbox-user
credentials; provider sign-in credentials, conversations and databases were not
needed or copied. Both cwd and the workspace writable root were the probe's own
scratch directory. The existing CLI executables were read from their installed
locations; `initialize` confirmed that Codex home was the scratch copy.

| CLI | Parent process in a Windows job | Unrestricted echo | Elevated workspace-write echo |
| --- | --- | --- | --- |
| 0.160.0 | Yes, inherited Orgtree jobs | Exit 0, probe-ok | Exact 15-second runner pipe-in timeout |
| 0.160.0 | No, measured with IsProcessInJob | Exit 0, probe-ok | Exact same timeout |
| 0.159.2 | No, measured with IsProcessInJob | Exit 0, probe-ok | Exact same timeout |

These were standalone app-server `command/exec` calls: no model request, thread
or turn, and no Orgtree code in the outside-job process. Setup refresh completed
with `errors=[]`; helper copies and generated metadata went into the copied
home. No UAC prompt or live-profile fallback was used. Every probe finished,
and the entire copied profile, including its secrets, was deleted afterwards.

Measured conclusion: the specific timeout is independently reproducible in the
local Codex elevated sandbox on two installed CLI versions. Rust's nested jobs
are unnecessary to reproduce it. This does not establish a new 0.160.0
regression, or distinguish a CLI implementation bug from broken local sandbox
state. No Orgtree engine correction is justified as the root-cause fix by this
evidence.

## Proposed Orgtree recovery

Keep the existing per-command approval route, rather than changing sandbox modes
or automatically replaying commands. The measured workaround is a retry with
`sandbox_permissions=require_escalated` for a seat with shell and write authority.

Prefer a narrowly triggered engine hint over a permanent startup instruction:

1. In `Actor::on_codex_item`, recognize a completed, failed commandExecution
   whose source is unifiedExecStartup, processId is null, duration is zero and
   output contains the exact runner pipe-in timeout. Do not match arbitrary
   command stderr or agent prose.
2. Once per turn, check current shell/write authority. For an eligible seat,
   use the existing `CodexProc::steer` path to explain that startup failed and
   suggest retrying the same command once through the normal escalation request.
   For plan/edit-disabled/shell-disabled seats, explain the runner failure without
   recommending an outside-sandbox retry. Existing approval decisions remain
   authoritative.
3. Record the diagnostic in the conversation. If steering loses a turn race,
   retain the diagnostic without restarting the turn or replaying the command.
   Bound the hint to prevent a retry loop.

This would improve recovery while leaving the agent's permission mode and the
Windows process leash intact. It appends a runtime message rather than changing
the startup instruction prefix. It is a proposal, not an implemented engine fix.
