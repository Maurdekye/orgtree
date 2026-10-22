---
name: orgtree-agent-card
description: Read agent-card identity, capacity and state indicators without mistaking a pending change or locator for an action.
---
Up: [orgtree-canvas](../SKILL.md)

# Read an agent card

The small shared state markers are [state badges](../../desk/agent-desk/SKILL.md#badges);
the containing agent/zoom card remains a card.

At ordinary overview zoom, a card has identity, state and shortcut rows. Its tier token names the model tier; the name tooltip can identify a bound account. The context wheel shows measured or estimated occupancy against capacity, not provider usage or a token spending budget. Its tooltip explains unavailable/empty values and the compaction threshold; an estimate carries an approximation mark. On the overview card the wheel is a passive indicator.

| Visible indicator | Read it as |
| --- | --- |
| Working spinner/state and elapsed time | A turn is active; the age is not a completion estimate. |
| Queued/waiting state | Waiting for a free turn slot, rather than currently generating. |
| Compacting | Session compaction is in progress. |
| Halting/halted badge | A deliberate stop/wake barrier; separate from a usage freeze. |
| Frozen badge and countdown | Provider/limit interruption; an inferred marker qualifies the account/tier observation. Read the tooltip's reason. |
| Done/blocked/idle summary and age | The recorded agent status and time since the last completed turn ended, not an independent verification of its task. See the [desk clock rules](../../desk/agent-desk/SKILL.md#header-controls) for legacy and active references. |
| Error dot | Last recorded error; hover for the text. |
| Archived/unrecoverable label | The seat is not an ordinary live worker; do not infer its history was deleted. |
| Pinned | Its desk is hosted in a canvas window; focusing can raise that window. |
| Secondary serving-account badge | The account actually serving the turn when supplied; ambient/default serving accounts do not get this badge. |
| Session 0 state badge | Engine-reported Windows Session 0 placement, also shown on the desk header. The native tooltip and keyboard accessible label give the placement reason and known since time; null or signed-in placement hides it. See the [desk state badges](../../desk/agent-desk/SKILL.md#badges). |
| Next-turn account/model/effort/fast mode badge | A queued requested value, distinct from the current serving configuration. |
| Fast mode badge (lightning bolt; tooltip: fast) | Near-zoom supported active fast speed: a busy turn uses known serving speed; idle uses the saved setting. Queued-on/current-off and unknown busy speed do not show it. Queued-off keeps it until the fast turn ends. |
| Next-turn fast mode badge (fast on/off) | Near-zoom queued saved speed, with a tooltip naming current and next values. Only supported live running seats with known opposite serving speed show it; idle, unknown and matching values do not. It is independent of the active bolt. |
| Effort badge | An agent-specific effort override; it can appear even when equal to the org default. |
| Watchdog count/one-shot mark | Attached watchers; the satellite/detail controls are separate from agents. |
| Stack/layers count | More agents share this visible stack; use [piles](../piles/SKILL.md) to choose its front. |

Process readiness and provider-cache indicators on the opened desk are separate from the card's occupancy wheel; see [agent desk](../../desk/agent-desk/SKILL.md). A parked process is not proof of a provider cache hit. Session behavior belongs to `orgtree-turns-and-wakes` (orgtree-working › runtime), and usage interruption to `orgtree-usage-freezes` (orgtree-working › accounts).

The credit bar beside the card distinguishes seat, allocated grant, held segments and free room. Its tooltip/readout gives the values. An editable bar can stage and commit a grant change on release, with a lower bound covering held reports; cancellation abandons it. Project containers contribute no seat of their own: held-report segments pass through them to their live agent descendants. The current app does not switch to a separate mobile gauge merely because the window is narrow. For staffing arithmetic see `orgtree-credits` (orgtree-working › team).

Hover shortcuts can open docket, mail, pinned desk, settings, presented documents and, while the agent has a live report, its Team. The retirement shortcut becomes a whole-team dissolution confirmation for a manager. Use [context menus](../context-menus/SKILL.md) for the complete state-gated action list. Unread mail count is mail state, not a request to acknowledge every notice.

At far zoom the card becomes a tier/state locator; shortcut hit targets are removed. Selecting it navigates to the agent. At desk zoom the desk's own header replaces the overview chrome, and a desk already hosted elsewhere can show a placeholder. See [pinned windows](../pinned-windows/SKILL.md) and [agent desk](../../desk/agent-desk/SKILL.md) for those surfaces.

## Identity tooltips

Agent identity hovers use the native tooltip: catalog model/version, effort and, when that provider has multiple configured accounts, the bound account or default. Missing values and queued model changes are omitted. Draft effort reads (not started); retired identities retain the last model with a retired marker. A visible name is not repeated in the tooltip; an icon-only link or identity-less Owner/Presenter menu label puts the name first. Far-zoom cards instead reveal the name in a floating label and omit it from the native tooltip, for projects as well as agents.

Project identities use the same hover everywhere, including the whole closed card: Project/retired state, configured slots held/total and waiting line, event listeners and watch thresholds/counts, mail queue listeners/waiting/in-flight counts, then a short Summary gist when present. These are the live facts used by its header badges, not a separate snapshot. Projects use a folder mark and have no model/account tooltip. The same three name rules apply.

## Card fit and retired entries

At overview zoom, the complete face of an agent or project card shrinks uniformly when needed to fit its fixed bounds. Text, badges and icons shrink together; the card does not expand or cut off its lower controls. This does not change an opened desk or far-zoom locator.

A retired-count badge on an agent or project card opens the shared retired list. Its own right-click menu offers Open retired list rather than the containing agent/project menu. The same badge is available among a desk's report jump controls when retired reports are hidden. Selecting an entry reveals/navigates to that retained identity; it does not restore or rehire it. See [piles](../piles/SKILL.md).

## See also

- [orgtree-context-menus](../context-menus/SKILL.md)
- [orgtree-agent-desk](../../desk/agent-desk/SKILL.md)
