---
name: orgtree-agent-card
description: Read agent-card identity, capacity and state indicators without mistaking a pending change or locator for an action.
---
Up: [orgtree-canvas](../SKILL.md)

# Read an agent card

At ordinary overview zoom, a card has identity, state and shortcut rows. Its tier token names the model tier; the name tooltip can identify a bound account. The context wheel shows measured or estimated occupancy against capacity, not provider usage or a token spending budget. Its tooltip explains unavailable/empty values and the compaction threshold; an estimate carries an approximation mark. On the overview card the wheel is a passive indicator.

| Visible indicator | Read it as |
| --- | --- |
| Working spinner/state and elapsed time | A turn is active; the age is not a completion estimate. |
| Queued/waiting state | Waiting for a free turn slot, rather than currently generating. |
| Compacting | Session compaction is in progress. |
| Halting/halted | A deliberate stop/wake barrier; separate from a usage freeze. |
| Usage freeze and countdown | Provider/limit interruption; an inferred marker qualifies the account/tier observation. Read the tooltip's reason. |
| Done/blocked/idle summary and age | The recorded agent status and time since the last completed turn ended, not an independent verification of its task. See the [desk clock rules](../../desk/agent-desk/SKILL.md#header-controls) for legacy and active references. |
| Error dot | Last recorded error; hover for the text. |
| Archived/unrecoverable label | The seat is not an ordinary live worker; do not infer its history was deleted. |
| Pinned | Its desk is hosted in a canvas window; focusing can raise that window. |
| Secondary serving-account badge | The account actually serving the turn when supplied; ambient/default serving accounts do not get this badge. |
| Next turn → account/model/effort | A queued requested value, distinct from the current serving configuration. |
| Effort badge | An agent-specific effort override; it can appear even when equal to the org default. |
| Watchdog count/one-shot mark | Attached watchers; the satellite/detail controls are separate from agents. |
| Stack/layers count | More agents share this visible stack; use [piles](../piles/SKILL.md) to choose its front. |

Process readiness and provider-cache indicators on the opened desk are separate from the card's occupancy wheel; see [agent desk](../../desk/agent-desk/SKILL.md). A parked process is not proof of a provider cache hit. Session behavior belongs to `orgtree-turns-and-wakes` (orgtree-working › runtime), and usage interruption to `orgtree-usage-freezes` (orgtree-working › accounts).

The credit bar beside the card distinguishes seat, allocated grant, held segments and free room. Its tooltip/readout gives the values. On desktop an editable bar can stage and commit a grant change on release, with a lower bound covering held reports; cancellation abandons it. Touch uses a read-only gauge rather than precision reallocation dragging. For staffing arithmetic see `orgtree-credits` (orgtree-working › team).

Hover shortcuts can open docket, inbox, pinned desk, settings and presented documents. The retirement shortcut becomes a whole-team dissolution confirmation for a manager. Use [context menus](../context-menus/SKILL.md) for the complete state-gated action list. Unread mail count is mail state, not a request to acknowledge every notice.

At far zoom the card becomes a tier/state locator; shortcut hit targets are removed. Selecting it navigates to the agent. At desk zoom the desk's own header replaces the overview chrome, and a desk already hosted elsewhere can show a placeholder. See [pinned windows](../pinned-windows/SKILL.md) and [agent desk](../../desk/agent-desk/SKILL.md) for those surfaces.

## See also

- [orgtree-context-menus](../context-menus/SKILL.md)
- [orgtree-agent-desk](../../desk/agent-desk/SKILL.md)
