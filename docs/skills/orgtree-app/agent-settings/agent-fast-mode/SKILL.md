---
name: orgtree-agent-fast-mode
description: Explain faster inference, supported models and the per-agent fast-mode controls.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Fast mode

Fast mode asks a supported provider for faster inference at higher usage. It is
separate from thinking effort. The user or an authorized superior can change it.

- The lightning button above Send changes this agent's saved setting immediately.
  Its pressed state shows the saved choice. Agent settings > Model has the same
  **Fast mode** checkbox, applied with Save.
- Both controls are hidden when the current harness and model lack support.
  Codex requires an advertised fast or priority service tier for that exact model
  version. First-party Claude Code supports the verified Opus 4.8 and 5 family.
  Antigravity, OpenCode/OpenRouter, Muse and language-server routes have no verified
  equivalent and show neither control.
- The choice applies to the next turn in the same conversation. A speed-only save
  does not switch model, account or session and does not restart the CLI. A running
  turn keeps its existing speed. There is no promise of a prompt-cache hit.
- While a turn is running, a badge in the desk header says **next turn →
  fast on** or **next turn → fast off** when the saved choice differs from the
  speed request sent to that turn. Its tooltip gives both values. It clears on
  next admission, turn completion or reverting the choice. Unknown serving state
  shows no badge; saving alone does not prove a change is pending.
  The same queued-state card and tooltip appear at near canvas zoom with the
  pending account, model and effort cards. None appears in the composer.
  Its speed toggle keeps the top row: either queued direction uses a slightly
  darker highlight until admission. Steady on has the ordinary active highlight;
  steady off has none.
  Hovering a pending speed toggle says **Fast mode turns on next turn** or
  **Fast mode turns off next turn**. After admission or reverting, the ordinary
  speed help returns.
  Effort and Send/Stop remain on a separate lower row, right
  aligned beneath them. The text field retains a 10ch minimum on narrow desks.
- The agent hover tooltip includes **fast** when saved on for a supported model.
  Changing to an unsupported model ignores the stored choice and hides the controls.
  Switching back restores the saved preference.
- At near canvas zoom, a passive lightning icon card has the tooltip **fast**.
  It shows known active speed during a running turn, and the saved setting while
  idle. Queued-on does not mark a standard-speed running turn; queued-off keeps
  the still-active fast bolt. Busy with unknown/null speed, off or unsupported
  routes, and far/map views show no bolt.
- Provider entitlement, organization policy, credits or availability may still
  refuse faster inference. Such refusals remain visible as turn errors; a saved
  checkbox is a request, not proof that the provider accepted fast inference.
- Turning it off explicitly asks Codex for standard speed, overriding an inherited
  global fast tier. Usage accounting continues to use the provider's reported data;
  Orgtree does not invent a usage multiplier.

## See also

- [orgtree-agent-model-tab](../agent-model-tab/SKILL.md).
- [orgtree-agent-account-tab](../agent-account-tab/SKILL.md).

## Hiring defaults and agent tools

Org settings > Hire defaults > Fast mode offers a separate toggle for each
supported tier. All start OFF. They affect new hires and Quick chat, not existing
agents or rehires. Explicit `fast_mode` on hire overrides the default, including
false. Managers can set `fast_mode` on hire, rehire, staff and retool for agents
in their ordinary scope; state_inspect shows the saved boolean.
`orgtree_fast_defaults` reads defaults and lets only top-level agents whose
superior is the user patch them. Speed-only changes apply next turn without
changing model/account/session or restarting the warm CLI.
