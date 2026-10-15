---
name: orgtree-halts-and-restarts
description: Distinguish interrupted turns, persistent halts, freezes and engine restarts when deciding how work resumes.
---

Up: [orgtree-runtime](../SKILL.md)

# Halts and restarts

Read the persisted gate before choosing a recovery action. Similar-looking idle agents can be waiting for different things. A restart or an unhalt is not a rollback of external tool effects.

| Situation | Action reference |
|---|---|
| Only the current descendant turn must stop | [Interrupt](../tool-interrupt/SKILL.md). |
| The descendant must stay stopped until released | [Halt](../tool-halt/SKILL.md), then [unhalt](../tool-unhalt/SKILL.md). |
| The runtime records a provider/usage freeze | [Unstick](../tool-unstick/SKILL.md) and [usage-freeze guidance](../../accounts/usage-freezes/SKILL.md). |
| The org-wide stop latch is set | `orgtree-kill-switch` (orgtree-app › app-shell). |

These gates are separate. Clearing one need not clear another. Tool arguments, authority rules and result shapes live in those tool pages; a top-level agent is still bound by the downward authority rules.

For STOP ALL's scope, release effects and safety gestures, see `orgtree-kill-switch` (orgtree-app › app-shell).

## Engine restart

A deliberate or unexpected engine stop can end running provider processes and their dependent jobs. Startup repairs interrupted mail/turn bookkeeping and sends affected agents a waking restart message; idle live agents can receive a passive informational restart notice. Session continuity is attempted where the harness supports it, but in-flight tool execution is not reconciled into a guaranteed outcome.

On a restart notice, re-read breadcrumbs, docket and mail, inspect the actual repository/files/process evidence, and decide what remains. Do not rerun a potentially applied mutation solely because its original reply was lost. Report incomplete or uncertain work honestly. An idle informational notice does not itself require an acknowledgement.

No agent tool in this section restarts the whole app or changes its startup configuration. The desktop's restart/recovery surfaces are described in `orgtree-crash-and-restart` (orgtree-app › app-shell); the landed engine-start choice and its effect on agents are described by `orgtree-engine-start-mode` (orgtree-app › app-settings). Changing that choice leaves the current engine running until an explicit restart or the next automatic start.

## See also

- [orgtree-tool-halt](../tool-halt/SKILL.md)
- [orgtree-tool-interrupt](../tool-interrupt/SKILL.md)
- `orgtree-kill-switch` (orgtree-app › app-shell)
