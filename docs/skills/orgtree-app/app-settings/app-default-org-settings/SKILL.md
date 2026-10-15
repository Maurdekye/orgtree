---
name: orgtree-app-default-org-settings
description: Explain the saved defaults used when creating organizations and distinguish UI fallbacks from engine defaults.
---

Up: [orgtree-app-settings](../SKILL.md)

# Default organization settings

The Default org settings tab and standalone defaults window use the same form. Changes remain draft until **save**; **cancel** closes without submitting them. Save writes app defaults through the defaults endpoint, to seed organization creation. It does not explicitly rewrite existing organizations' stored settings. Agents explain and suggest these controls; the user operates them.

| Field | Storage | Engine built-in default | Meaning |
| --- | --- | --- | --- |
| top-level grant cap | `defaults:max_top_grant` | 1,000 | Ceiling for top-level grants; 0 is the engine's uncapped value, although the number input has a minimum of 1. |
| default top-level grant | `defaults:default_top_grant` | 20 | Grant prefilled for new top-level hires. The form's missing-data/error fallback is 50, not the engine default. |
| compaction threshold % | `defaults:compact_at` | 80% | Ordinary context-compaction threshold, UI 50–95%, saved as a percentage. |
| default thinking effort | `defaults:default_effort` | Empty | Inherit into agents without their own effort. The label says CLI default/no flag, but current effort resolution falls back to high for an empty value before harness mapping. |
| hires bubble their cost up the chain | `defaults:cascade_hire` | On | Enables funding cascade for later hire operations within their authority boundary. |
| allocations & model upgrades bubble their cost up the chain | `defaults:cascade_alloc` | On | Enables funding cascade for allocations and dearer model changes within their authority boundary. |
| auto-resume usage-limit-frozen agents after the reset time | `defaults:auto_resume` | On | Sets the organization's automatic usage-limit resume policy. The form's absent-data fallback is Off. |

Use the values loaded from the engine, which can include saved app overrides. The form falls back to an empty object on a failed load and displays individual UI fallbacks; do not mistake that failure display for authoritative current defaults. A save error appears in a toast; success reports saved and closes the form.

The engine computes effective organization settings from built-ins, app defaults and stored org values in that order. Consequently existing explicit org values remain intact, while an old/partial org missing a key can still receive an effective fallback. For a particular existing org, inspect its actual settings rather than promising that a defaults edit can never affect a missing key.

Suggest these defaults for a recurring preference on future organizations. Change the existing organization's own controls for a specific current policy instead. Credits remain staffing capacity, not token allowances; a new default does not enlarge an existing agent's grant or authorize a deployment.

## See also

- [orgtree-org-basic](../../org-settings/org-basic/SKILL.md).
