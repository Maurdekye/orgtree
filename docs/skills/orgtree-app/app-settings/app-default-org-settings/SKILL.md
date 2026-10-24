---
name: orgtree-app-default-org-settings
description: Explain the saved defaults used when creating organizations and distinguish UI fallbacks from engine defaults.
---

Up: [orgtree-app-settings](../SKILL.md)

# Default organization settings

The Default org settings tab and standalone defaults window use the same
form. Changes save automatically without closing it: discrete choices
immediately, numeric edits after about 750 ms. Close flushes pending edits.
Only changed fields are written. Inline errors offer Retry; a failed load
shows Retry without enabling a fallback editor. These app defaults seed
organization creation; they do not explicitly rewrite existing organizations'
stored settings. Agents explain and suggest; the user operates these controls.

| Field | Storage | Engine built-in default | Meaning |
| --- | --- | --- | --- |
| Top-level grant cap | `defaults:max_top_grant` | 1,000 | Ceiling for top-level grants; 0 is the engine's uncapped value, although the number input has a minimum of 1. |
| Default top-level grant | `defaults:default_top_grant` | 20 | Grant prefilled for new top-level hires. The form's missing-field fallback is 50, not the engine default. |
| Compaction threshold % | `defaults:compact_at` | 80% | Ordinary context-compaction threshold, UI 50–95%, saved as a percentage. |
| Default thinking effort | `defaults:default_effort` | Empty | Seeds the org default for agents without their own effort. Default (high fallback) means high only if neither the agent nor effective org setting supplies a level, before harness/model mapping. |
| Auto-resume usage-limit-frozen agents after the reset time | `defaults:auto_resume` | On | Sets the organization's automatic usage-limit resume policy. The form's absent-data fallback is Off. |

Use the values loaded from the engine, which can include saved app overrides.
A read failure leaves the form unavailable rather than treating missing data
as authoritative defaults. A save failure stays visible and also raises a toast.

The engine computes effective organization settings from built-ins, app defaults and stored org values in that order. Consequently existing explicit org values remain intact, while an old/partial org missing a key can still receive an effective fallback. For a particular existing org, inspect its actual settings rather than promising that a defaults edit can never affect a missing key.

Suggest these defaults for a recurring preference on future organizations. Change the existing organization's own controls for a specific current policy instead. Credits remain staffing capacity, not token allowances; a new default does not enlarge an existing agent's grant or authorize a deployment.

## See also

- [orgtree-org-basic](../../org-settings/org-basic/SKILL.md).
