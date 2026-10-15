---
name: orgtree-agent-visibility-access
description: Explain agent visibility and file/command permission choices and inherited ceilings.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Visibility and file/command access

These Scope-tab choices are stored in the selected agent's scope. Agents explain or suggest settings changes; they do not change settings themselves. Both wait for the shared Save.

## Visible agents

`node:org_visibility` chooses how much of the organization the agent can see:

| Label | Stored value |
|---|---|
| Only this agent | `self` |
| Its team | `team` |
| Its team and all reports | `subtree` |
| Everyone | `full` |

The saved/configured value initializes the field. New hires normally start from org hire defaults; the engine's missing-value normalization is `subtree`. The form's `full` fallback for missing data is not an engine default. See `orgtree-visibility` (orgtree-working > team) for the exact visible set and how visibility affects reads; visibility alone does not grant authority to write or contact everybody.

## File and command access

`node:permission_mode` sets the permission policy alongside folder and tool grants:

| Label | Stored value | Intended policy |
|---|---|---|
| Read only | `plan` | Read-only operation. |
| Ask before changes | `default` | Approval policy for changes. |
| Allow normal changes | `acceptEdits` | Normal editing policy within the seat's grants. |
| Unrestricted access | `bypassPermissions` | Removes approval prompts, including the sensitive shared-skill-file gate where supported. |

The initial value is saved configuration, with `acceptEdits` as the missing-value fallback and built-in hire default. The actual sandbox/approval mechanism depends on the harness and Windows session; the label does not guarantee an identical OS sandbox everywhere. See `orgtree-scope-and-permissions` (orgtree-working > team) and the corresponding provider leaf.

## Superior ceilings and save effects

Effective scope is bounded by every superior: neither visibility nor permission mode can be broader than the narrowest effective setting above it. The desktop is the user's grant surface, so a user save requesting broader scope raises intermediate configured scopes instead of treating the parent's current value as a permanent refusal. The form previews which ancestors gain access; review that warning before Save. A narrower parent makes descendants' effective scope narrower; distinguish a stored configured value from the effective value actually launched.

Unknown visibility or permission-mode values are refused. The save marks the affected subtree for reconfiguration; idle processes are replaced and busy ones wait for the turn boundary. Scope changes alter startup instructions and can cost cached input reuse. They do not supply missing folder or tool grants by themselves.

Suggest a visibility change for a concrete missing organization view, and a permission change for an intended approval policy. Explain any ancestor expansion. Do not suggest unrestricted access as a generic cure for an unrelated tool failure.

## See also

- `orgtree-visibility` (orgtree-working > team).
- `orgtree-scope-and-permissions` (orgtree-working > team).
- [orgtree-agent-folders-tab](../agent-folders-tab/SKILL.md).
- [orgtree-agent-tools-tab](../agent-tools-tab/SKILL.md).
