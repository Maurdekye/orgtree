---
name: orgtree-tool-rehire
description: Restore an archived descendant with retained context and optional placement, scope and task overrides.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_rehire

Requires `team`. Use to restore useful expertise; to inspect its knowledge without running it, read the archived agent's [transcript](../../inspection/tool-read-transcript/SKILL.md). For a new role without useful retained context use [hire](../tool-hire/SKILL.md).

## Parameters

`node` is required: the archived descendant's current name. Omitted overrides retain stored values; you must still have authority over that identity. A live authorized target returns a no-op warning and cost 0.

| Optional parameter | Effect |
| --- | --- |
| `grant` | Nonnegative integer; default stored grant. Seat plus grant must fit the new parent; cascade obeys the actor's allocation boundary. |
| `target` | New parent within your team. Default old parent if live, otherwise nearest live ancestor. A destination must be live and outside the restored subtree. |
| `hire_type` | `subordinate` default; `superior` restores above a live authorized target and inherits its effective capability scope. Rehire has no new-hire self-parent top-level exception. |
| `name` | Optional new unique valid name, same name rules as hire; references to `node` use the old name. |
| `charter`, `team_charter` | Replace supplied nonblank role/team instructions; omitted/blank strings leave stored text. |
| `add_dirs` | **Whole replacement folder list**, not additive; `[]` removes the list. Each `{path,mode}` uses `ro`/`rw` (default `rw`). Omit to keep folders. |
| `tools` | Supplied keys merge into stored tools: `bash`, `web`, `edit`, `subagents`, `mcp`, and Orgtree group booleans. Omitted keys remain, subject to effective scope. |
| `org_visibility` | Supplied `self`, `team`, `subtree`, `full`; ordinary rehire validates grants against your capability. |
| `permission_mode` | Supplied `default`, `acceptEdits`, `bypassPermissions`; bounded by inherited capability. |
| `effort` | A level this tier/harness/login offers; `""` clears the override to inherit. |
| `account` | Default stored binding; explicit provider-compatible org-allowed id changes it. `primary` restores the provider's own login and cancels an older queued account choice. It does not itself thaw an independent usage freeze. |
| `account_fallback` | Set the per-agent fallback override. |
| `clear_account_fallback` | True removes the override, using org default; takes precedence over account_fallback. |
| `audiences` | Up to 64 string targets, granted under ordinary authority in the composite. |
| `work_item` | Assign an existing item; staffing a backlog opens it. |
| `kickoff`, `kickoff_kind` | First task text and `message` default or `question`; retired kinds normalize to message. |

Superior rehire must omit `add_dirs`, `tools`, `org_visibility` and `permission_mode`; they come from the target. Its optional `target` names the insertion anchor in this mode. Existing stored effort/account choices remain subject to admission checks.

There is **no `index` parameter**: passing index is refused. Ordinary restoration appends to its destination's live sibling order; superior restoration uses the anchor's old position. Use [reorder](../tool-reorder/SKILL.md) after restoration if needed. The standalone rehire schema does not expose a new `tier` or `harness` field; use the offered tools rather than undocumented operation arguments.

## Lifecycle and refusals

Rehire makes the selected identity live, clears its halt and reserves its current seat/grant. It resumes watchdogs paused by archival and requests a runtime wake; pending mail, assignment or kickoff supplies the work. It does not resurrect the entire former subtree. A recoverable conversation is retained; an unrecoverable session starts fresh with a handoff and saved history. Do not promise a provider cache hit or miss from restoration alone.

Invalid authority, destination inside the archived subtree, insufficient credits, unknown/incompatible account, unavailable provider/tier and scope above the caller are refused. A top-level caller may restore descendants under its team, not create a top-level peer with `target: "user"`. Superior restoration above a top-level target remains user-only.

```json
{"node":"draft-checker","kickoff":"Resume the existing docket item after reading its latest scope."}
```

This assumes draft-checker is an archived descendant with an admissible stored configuration. Inspect the returned node, warnings and cascade, including resumed-watchdog or fresh-session warnings. The hire/assignment/audience/kickoff composite rolls back on a late refusal.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
