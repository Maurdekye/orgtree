---
name: orgtree-tool-hire
description: Hire a new subordinate or superior with explicit placement, credits, scope and an optional first task.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_hire

Requires the `team` tool group. Use for a new role; first inspect archived expertise with [chart](../../inspection/tool-chart/SKILL.md) and consider [rehire](../tool-rehire/SKILL.md). A hire reserves concurrent capacity, not tokens. For a live assignee, assign work through [work](../../docket/tool-work/SKILL.md) instead of creating another seat.

## Parameters

The schema requires the complete ordinary-hire scope: `add_dirs`, `org_visibility` and `tools` with **all five** keys `bash`, `web`, `edit`, `subagents`, `mcp`. False flags and empty lists are valid explicit choices. New-hire `name`, `tier`, `grant`, `charter` and `index` are also required. Superior insertion inherits the target's scope and must omit scope fields. A refused incomplete request lists all missing fields together; supply the whole list before retrying.

| Parameter | Meaning and default |
| --- | --- |
| `name` | Required, unique within the org among non-deleted agents: 1–64 ASCII letters/digits, `-`, `_`, `.`; first character alphanumeric. Reserved names user/system/engine/org/net are refused. |
| `tier` | Required catalog tier; inspect [list tiers](../tool-list-tiers/SKILL.md). The model/provider must be enabled and eligible. |
| `grant` | Required nonnegative integer allocation for the new agent's team. Its seat plus grant must fit the funding boundary. |
| `charter` | Required nonblank full role and standing instructions. A charter alone starts no task. |
| `index` | Required integer, zero-based live sibling insertion position, `0..existing_count`; last appends. For superior insertion, exclude its target from the old sibling set. |
| `hire_type` | `subordinate` by default; `superior` inserts above the target. |
| `target`, `parent` | Subordinate's parent, default yourself; superior's target, default yourself. `target` takes precedence over the hire alias `parent`. Ordinary subordinate placement must be within your subtree. |
| `add_dirs` | Ordinary hire requires a whole starting list of `{path, mode}` folders; `[]` is valid, mode `ro` or `rw` (omitted mode normalizes to `rw`). Each folder must fit the new parent's effective grants. |
| `tools` | Ordinary hire requires explicit `bash`, `web`, `edit`, `subagents` booleans and `mcp` server list. Optional `orgtree` group booleans restrict the engine tools. Missing groups remain enabled, subject to inherited ceilings. |
| `org_visibility` | Required for ordinary hire: `self`, `team`, `subtree`, `full`, no broader than the future parent's. |
| `permission_mode` | Optional `default`, `acceptEdits`, `bypassPermissions`; omitted uses the org's effective default. Effective rights remain ancestor-clamped. |
| `effort` | Optional level offered by that harness/model/login; vocabulary `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `""` inherits. A vocabulary entry is not universal model support. |
| `account` | Optional provider account id. Omitted uses a valid compatible org default/normal placement, never the parent's account. Explicit `primary` selects the tier's ambient provider login; unknown, incompatible or org-excluded choices are refused. OpenRouter hires without a named key are placed on an eligible key and bound. |
| `account_fallback` | Optional per-agent opt-in to another eligible account of the same provider at a usage limit; omission leaves the org default applicable. |
| `clear_account_fallback` | Shared scope-schema field; a new hire has no stored override to clear. Omit it and use omission to inherit. |
| `team_charter` | Optional standing instructions for this agent's team. |
| `harness` | For OpenRouter, explicit `claude-code`, `codex-cli` or `opencode` pins this seat; omitted follows its key's harness. A selected harness must be installed. Other providers use their native route. |
| `audiences` | Optional array, at most 64 string targets; grants are checked under ordinary audience authority before kickoff. A failure rolls back the composite. |
| `work_item` | Optional existing docket slug assigned to the hire; a staffed backlog opens and assignment mail starts it. Requires the caller's management right on that item. |
| `kickoff` | Optional nonblank first task message, sent after admission. Without kickoff or assignment/wake mail, a new hire stays idle. |
| `kickoff_kind` | `message` default, or `question`. Use those offered kinds; legacy request/decision/status input normalizes to message. |

Orgtree groups are `docket`, `team`, `messaging`, `inspection`, `watchdogs`, `runtime`, `user`; unknown names/non-boolean grants are refused. Status remains available. Folder and basic-tool grants cannot exceed the future parent's capabilities; a broader manager grant does not silently pass through an intermediate parent.

## Credits and superior insertion

For an ordinary hire, each live direct report holds `seat + grant`; free capacity is `grant - sum(live direct reports' seat + grant)`. Credit cascade can raise intermediate descendant grants but stops at the acting agent's allocation. Insufficient capacity refuses the whole hire; it never grants the caller new credits from above.

With `hire_type: "superior"`, omit `add_dirs`, `tools`, `org_visibility` and `permission_mode`: the target's effective scope is inherited. Naming one is refused. Choose the new parent's sibling index from the target's former live siblings with the target excluded.

Creating a parent above **yourself** is allowed even at top level. Your free credits pay its seat plus the requested free parent grant; the external allocation stays fixed. If your seat/grant are `C/G`, reports hold `H`, new seat costs `P`, and requested free grant is `R`, require `G-H >= P+R`; your grant becomes `G-P-R`, parent grant `C+G-P`, parent free `R`. No ancestor grant increases. Its inherited fallback cannot enable fallback you lacked. The new superior gains ordinary powers over you; its account need not match yours.

Other-target superior insertion retains ordinary downward authority/funding and carries the target's existing stake. This new self-parent exception does not authorize top-level peer hiring or the same exception on rehire.

## Example and outcomes

After inspecting available tier/capacity and confirming a new name, this creates a narrowly scoped first report at index 0 (assuming that position exists and Sol is eligible):

```json
{"name":"draft-checker","tier":"sol","grant":0,"charter":"Check the assigned draft against source and report evidence.","index":0,"add_dirs":[],"tools":{"bash":false,"web":false,"edit":false,"subagents":false,"mcp":[]},"org_visibility":"self","permission_mode":"default","kickoff":"Read the assigned docket scope before beginning."}
```

The result names the admitted node, final parent/index/order, live sibling count, cascade and warnings, plus item/kickoff identity when supplied. Read all warnings. Scope/admission, audience, work assignment and kickoff are committed together; no partial hire survives a late refusal. Typical refusals include missing explicit hire fields, invalid sibling index, duplicate name, insufficient credits, unavailable tier/harness/account and overbroad folder/tool scope. Top-level callers have no ordinary power over other top-level agents.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)

For suggested team patterns, see `orgtree-committee-mode` and `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).

## Fast mode

`fast_mode` is an optional boolean for the seat being hired, restored or retooled.
An explicit `true` needs the exact model's advertised speed support; unsupported
models and non-booleans are refused. Explicit `false` overrides a hiring default.
New hires (including staff's hire form and Quick chat) use the org's per-tier
`default_fast_mode` when omitted, OFF by default. Rehire and retool retain the
seat's saved speed when omitted. This is node-local, never inherited from a parent.
A speed-only retool applies next turn in the same conversation without restarting
the CLI or changing model/account/session. A running turn keeps its speed.
`orgtree_state_inspect` shows the saved boolean under `scope.fast_mode`.

Read defaults with [orgtree_fast_defaults](../tool-fast-defaults/SKILL.md).
Only top-level agents whose superior is the user can write org defaults; other
managers pass explicit `fast_mode` on individual scoped hires/retools.
