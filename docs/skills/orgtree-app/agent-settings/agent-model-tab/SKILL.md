---
name: orgtree-agent-model-tab
description: Explain model tiers, version pins, effort and pending model changes.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Model, version and thinking effort

These are per-agent settings. Agents explain and recommend choices; they do not change settings themselves. The tab starts from the agent's current tier and configured scope, not a universal default model.

| Control | Storage | Choices and effect |
|---|---|---|
| Model | `node:tier` through a model-switch operation | Provider-grouped tiers; changing the tier changes the agent's model and seat cost. |
| Model version | `node:model_version` in scope | Shown when a tier has more than one listed version; empty means latest, with its version shown in the label. |
| Thinking effort | `node:effort` in scope | Organization default or a level offered for the chosen harness/model. Empty clears the agent override. |

## Model and version

Click a live agent desk's model letter to open the same provider-grouped hire
tokens without opening settings. Pick a tier, its eligible account and optional
version, then Apply. Escape or clicking away cancels without saving. Busy and
cross-provider tier changes ask for confirmation with the ordinary switch rules.
Refusals remain visible, and queued changes appear on the next-turn model card.
Pinned and popped-out desks share this control; retired identities stay passive.
The same actions are available to authorized agents through `orgtree_switch_model`
and `orgtree_retool` (account and model-version fields); the picker adds no new
engine operation or permission.

Model groups are Claude, Codex, Antigravity, Muse, OpenRouter and Language servers. Native tiers are ordered by seat cost; the last two groups retain registry order. Provider presence, enabled/sign-in state, legacy visibility and current offered models govern choices. An unavailable installed provider can leave a disabled choice with its reason; an absent provider's tiers can be hidden. The current tier remains visible as a truthful unchanged selection even when it is no longer offered for a new switch.

Saving an actual change goes through engine admission checks, including provider/account compatibility, model entitlement where required and capacity for a dearer seat. Muse model and version choices are checked against the seat's own login catalog; an unknown catalog cannot authorize a version pin. Antigravity Claude tiers have a fixed version and reject a nonempty version pin.

A selected version not in the chosen tier's version list is submitted as latest. Version availability is tier-specific; changing models does not make an old pin valid for the new tier.

A busy agent's model change is queued for the turn boundary; a later request can replace it. **Pending model change** shows the queued tier. **Cancel change** submits the current tier to cancel that queue, independently of the form's Save. Saving unrelated settings with the current tier does not cancel a queued switch. To apply a switch immediately, the UI advises interrupting the current turn first, then saving.

Cross-provider switches start a fresh session with a handoff summary; the earlier conversation remains available through saved history in the agent's folder. Scratch files and mail remain with the agent. A language-server switch between different harnesses also requires a fresh session. Same-provider changes do not use that cross-provider session reset. Model/provider changes create a new cache namespace; do not promise a provider cache hit or uninterrupted context reuse. See `orgtree-tool-switch-model` (orgtree-working › team) for admission, costs and the underlying operation.

## Thinking effort

The control uses the model's offered effort levels rather than offering every level for every model. Muse levels also depend on the selected or next-turn login and version. Resolution is the agent's own nonempty level, otherwise the organization's level, otherwise `high`. For a saved level the new model does not offer, launch maps to the highest offered level at or below it, otherwise the lowest offered level; the saved value itself is retained. New invalid choices are refused by validation.

Effort can affect reasoning time and usage. Suggest a lower offered level for routine work or a higher level when the task's difficulty warrants it, while respecting existing staffing choices. Do not infer a model switch is needed solely to change effort.

After a saved effective effort change, supported running Claude turns can receive the new level through the control channel. Other cases report next-turn delivery; Muse takes the new level on its next turn. A `sent` result means the request reached the CLI, not proof the model applied it. An unchanged effective level sends nothing.

The full form is a structural save and can replace processes, so it does not promise the narrower behavior of an effort-only action; see [the form's save behavior](../agent-config/SKILL.md). An effort-only control change by itself does not invalidate an unchanged prompt prefix.

## See also

- `orgtree-tool-switch-model` (orgtree-working › team).
- [orgtree-agent-account-tab](../agent-account-tab/SKILL.md).
- [orgtree-agent-fast-mode](../agent-fast-mode/SKILL.md).
- [orgtree-agent-fresh-start](../agent-fresh-start/SKILL.md).
- [orgtree-agent-config](../agent-config/SKILL.md).
