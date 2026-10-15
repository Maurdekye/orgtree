---
name: orgtree-tool-retool
description: Change a descendant's supplied scope or instruction fields while handling additive folders and inherited restrictions.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_retool

Requires `team`. Use for an authorized descendant's configuration; only supplied fields change. The exception on yourself permits exactly `node` plus `team_charter`: your superior controls your own charter and scope. A top-level agent cannot self-grant other capabilities either.

## Parameters

| Parameter | Effect |
| --- | --- |
| `node` | Required target name. |
| `charter` | Replace the descendant's role instructions with a nonblank string; omitted/blank retains them. |
| `team_charter` | Replace nonblank standing instructions for the target and its team. This is the only self-editable field. |
| `add_dirs` | Add `{path,mode}` folders or change the mode of a named held folder; other folders remain. `mode`: `ro`/`rw`, omitted normalizes to `rw`. `[]` adds nothing, not remove everything. |
| `remove_dirs` | Explicit list of held folder paths to remove. Use strings as offered by the schema. Unknown paths or a path also in add_dirs are refused. |
| `tools` | Merge supplied `bash`, `web`, `edit`, `subagents`, `mcp`, and `orgtree` group switches. Omitted keys stay; mcp is the supplied list, not a separate add/remove operation. |
| `org_visibility` | `self`, `team`, `subtree`, `full`; must fit your effective scope. |
| `permission_mode` | `default`, `acceptEdits`, `bypassPermissions`; must fit your effective mode. |
| `effort` | A level the current tier/model/login supports (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` are the shared vocabulary); `""` removes the override to inherit. Unsupported levels are refused. |
| `account` | Exact compatible org-allowed account id or `primary` for the provider's own login; omission keeps binding. Busy account changes queue for a turn boundary. |
| `account_fallback` | Set opt-in/out for fallback within the same provider. |
| `clear_account_fallback` | True removes the override and uses org default; takes precedence over account_fallback. |

Orgtree group keys are `docket`, `team`, `messaging`, `inspection`, `watchdogs`, `runtime`, `user`; omitted keys remain, an ancestor denial is inherited, and unknown/non-boolean keys are refused. `orgtree_status` remains available. A granted tool switch does not override your assignment or authorize an unrelated action.

## Folder changes and propagation

Retool adds folders; [hire](../tool-hire/SKILL.md) starts a whole list and [rehire](../tool-rehire/SKILL.md) replaces a supplied list. Removing a folder or making it read-only stores the corresponding restrictions on descendants, preventing a later move from reviving a revoked grant. Folder comparisons normalize separators/dot segments and case on Windows.

You cannot grant above your own effective capability. An allowed deep grant can raise the affected folder/tool/visibility/permission axes of intermediate managers below you, retaining unrelated grants. Inspect `cascaded`, `raised`, `clamped`, `folders` and warnings; the call can affect more than its named target. These are scope effects, not credit allocation.

Effective permission and visibility remain bounded by the ancestor chain. A folder grant does not clear the harness's protected-path gate. Do not use retool to change a tier; use [switch model](../tool-switch-model/SKILL.md).

## Application and examples

An effort-only call does not restart the whole subtree: the runtime reports effort delivery to the target (Claude can accept a live change, other harnesses use the next turn). In-flight calls can retain old effort. Muse effort is checked on the login the next turn will use, including an account queued earlier or supplied now. Other scope/instruction changes reconfigure affected launches; no mid-turn prefix rewrite is promised.

```json
{"node":"draft-checker","tools":{"web":false}}
```

For your own standing team rule, using your actual current name:

```json
{"node":"team-lead","team_charter":"Read the full assigned docket scope and record source evidence before reporting completion."}
```

The first example requires a descendant; the second requires the caller to be team-lead or an authorized superior. Refusals include "on yourself only team_charter can change", unknown folder removals, add/remove collisions, unknown visibility/mode, unsupported effort, invalid account and a grant exceeding the caller. Re-read after an unknown timeout outcome before retrying.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
