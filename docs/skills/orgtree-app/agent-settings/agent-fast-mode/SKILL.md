---
name: orgtree-agent-fast-mode
description: Explain faster inference, supported models and the per-agent fast-mode controls.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Fast mode

Fast mode asks a supported provider for faster inference at higher usage. It is
separate from thinking effort. Agents explain the setting; the user changes it.

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
- The agent hover tooltip includes **fast mode** when saved on for a supported model.
  Changing to an unsupported model ignores the stored choice and hides the controls.
  Switching back restores the saved preference.
- Provider entitlement, organization policy, credits or availability may still
  refuse faster inference. Such refusals remain visible as turn errors; a saved
  checkbox is a request, not proof that the provider accepted fast inference.
- Turning it off explicitly asks Codex for standard speed, overriding an inherited
  global fast tier. Usage accounting continues to use the provider's reported data;
  Orgtree does not invent a usage multiplier.

## See also

- [orgtree-agent-model-tab](../agent-model-tab/SKILL.md).
- [orgtree-agent-account-tab](../agent-account-tab/SKILL.md).
