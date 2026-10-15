---
name: orgtree-app-turn-limits
description: Explain total and silence time limits, their units, disabling them and their application timing.
---

Up: [orgtree-app-settings](../SKILL.md)

# Turn time limits

Runtime > Turn time limits applies across organizations. Agents explain and suggest these controls; the user operates them. Each row stores an integer number of seconds through `/api/app-settings/runtime`; `0` disables that limit.

| Control | Storage | Built-in default | What expires |
| --- | --- | --- | --- |
| Total limit | `rt:turn_timeout_s` | 86,400 seconds, 24 hours | A turn that has run longer than the ceiling, even while producing activity. |
| Silence limit | `rt:turn_idle_s` | 600 seconds, 10 minutes | A turn whose activity clock has produced no stream event for that period. |

The switch enables/disables the row. The amount accepts a positive finite value in minutes or hours, rounds the conversion to seconds, and permits 1 through 31,536,000 seconds in this UI. Disabling sends 0. Re-enabling an empty amount restores that row's default. Invalid, blank or out-of-range amounts are marked invalid and not saved. Changing the unit, leaving the amount field, or pressing Enter commits a valid changed value; typing alone is a draft. The row is disabled during its save, and an error appears if the request fails.

## Timing and expiration

The UI says limits apply from the next turn and a running turn keeps its limit. The current actor's watchdog instead reads the current app settings when calculating its deadline and checking an active turn. A changed limit can therefore affect an already running turn at its next timer check; do not promise the UI hint's snapshot semantics. A harness can also have a launch-time timeout: Antigravity receives the total timeout when its process starts. This source discrepancy is not a measured timing guarantee for every harness.

Expiration normally stops the agent process and ends the turn with the recorded silence/total-limit reason. The Muse foreground-tool exception stops eligible silent tool calls and lets the model continue; it does not cancel the total ceiling. Background work or an unresponsive already-stopped call can still result in ending the turn. See `orgtree-turns-and-wakes` (orgtree-working › runtime) for the runtime lifecycle.

Suggest a higher silence allowance when legitimate work produces long gaps, using actual task evidence. Suggest a total ceiling for work that should stop even if it keeps emitting activity. Turning a limit Off removes that protection; explain that choice in relation to the user's intended work, not as a generic fix for every stall. These controls do not increase provider context or account capacity.

Changing the limits does not itself rewrite the agent's startup prompt or switch its account/model. A turn killed by expiration may require recovery according to its actual state; do not claim that increasing a number revives a turn that already ended.

## See also

- `orgtree-turns-and-wakes` (orgtree-working › runtime).
