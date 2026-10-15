---
name: orgtree-tool-staff
description: Atomically create or update a docket item and hire or restore the agent that will own it.
---
Up: [orgtree-docket](../SKILL.md)

# orgtree_staff

Requires **both `docket` and `team`**. It combines seat hire/rehire, item create/update and assignment in one transaction; a refusal leaves no partial seat/item/assignment. The assigned agent owns the item and receives its user replies; assignment mail starts work, so kickoff is optional.

For a live agent use [work assign](../tool-work/SKILL.md). For a new hire merely taking an existing unchanged item, [hire](../../team/tool-hire/SKILL.md) with work_item is sufficient. Staff is useful when both the seat and item need creation/restoration/updates together; it is not the user's Quick staff UI mode selector.

## Docket parameters

| Parameter | Meaning/default |
| --- | --- |
| `action` | create/update; inferred update when slug is supplied, otherwise create. |
| `slug` | Required for update, existing item you have management rights over. |
| `title`, `objective` | Required for create; optional replacements on update. title max 200 characters; objective is the standalone problem-first scope and may not be emptied. |
| `kind` | code/non-code for creation, default code. |
| `status` | Optional backlogged/open/in_progress/blocked/review/deploy_ready. Unlike work update, staff refuses approved/done/dropped here. A missing/backlogged creation status becomes open; staffing an existing backlog opens it. |
| `blocked_reason` | Required if resulting state is blocked, max 2,000 characters. |
| `attention`, `attention_reason`, `attention_amend` | Same manual-attention mechanics as work; reason max 1,500. Omitted preserves existing flag. Amendment needs an existing one. |
| `reopen` | For resuming a closed/archived existing item under ordinary work rules. |
| `done_so_far`, `working_on_next` | Optional here: omit both to preserve stored progress; on a new/empty item the composite supplies a staffed-owner next step. If provided, complete arrays of max 40 entries, max 500 characters each, not both empty. |
| `participants` | Creation collaborators; later membership edits use work participants. |
| `dependencies` | Creation prerequisite item slugs. |
| `parent` | **Parent WORK ITEM**, not the seat's parent. Docket nesting must be readable and acyclic. |

The owner is determined by the new/restored seat, not an owner parameter. The staff schema does not offer reviewer, objective_append, evidence, expected_rev or progress patch fields; use the corresponding [work](../tool-work/SKILL.md) action when those are needed. The internal composite checks the locked item and supplies its own revision for preserved lists; do not add undocumented fields to the exposed call.

## Seat parameters

| Parameter | Meaning/default |
| --- | --- |
| `staff_mode` | hire/rehire; node also selects rehire. |
| `node` | Required for rehire, archived descendant. Omitting node selects new hire unless staff_mode explicitly requests rehire, which then requires node. |
| `name` | Required new-hire name, optional rename on rehire; same 1–64 ASCII valid-name/reserved-name rules as hire. |
| `tier` | Required new-hire tier; optional rehire tier override in this composite. Offered model/provider and credit admission still apply. |
| `grant` | Required nonnegative integer for new hire; omitted rehire retains stored grant. |
| `charter` | Required full standing role for new hire; optional nonblank replacement for rehire. |
| `target` | Seat destination in your team; subordinate new-hire default yourself, rehire default old live parent/nearest live ancestor. |
| `hire_type` | subordinate default or superior insertion above target. New self-parent insertion has hire's special fixed-budget rule; rehire does not gain it. |
| `index` | Required zero-based live sibling position for new hire, excluding the anchor on superior insertion; refused on rehire. Ordinary rehire appends. |
| `harness` | OpenRouter claude-code/codex-cli/opencode choice; new hire can pin the installed route. Omitted follows normal seat/key rules. Rehire retains its existing route; do not assume this field repins an existing seat. |
| `add_dirs` | Required ordinary new-hire whole starting list; supplied rehire list **replaces**, despite the shared hire-oriented schema wording. Entries path and mode ro/rw, omitted mode rw; [] valid. |
| `tools` | Ordinary new hire explicitly states bash/web/edit/subagents and mcp. On rehire supplied keys merge; optional orgtree group booleans restrict own tools. |
| `org_visibility` | Required ordinary new hire: self/team/subtree/full; optional rehire override. Must fit effective rights. |
| `permission_mode` | default/acceptEdits/bypassPermissions; omitted new hire uses org default, omitted rehire retains stored mode. |
| `effort` | A level offered by the selected model/harness/login; empty inherits. Vocabulary none/minimal/low/medium/high/xhigh/max does not guarantee support by every model. |
| `account` | Compatible org-allowed account id, primary for provider's own login. Omitted new hire uses valid org default/placement, omitted rehire retains binding. |
| `account_fallback`, `clear_account_fallback` | Set per-agent same-provider fallback; true clear removes stored override on rehire and takes precedence. A new self-parent cannot enable fallback the caller lacked. |
| `team_charter` | Optional nonblank standing instructions for the staffed seat's whole team. |
| `audiences` | At most 64 string targets, checked/granted before kickoff under ordinary audience authority. |
| `kickoff`, `kickoff_kind` | Optional first task and message default/question kind; legacy kinds normalize to message. Assignment mail already starts the owner. |

For superior insertion omit add_dirs/tools/org_visibility/permission_mode: target effective scope is inherited. New self-parent insertion can be top-level; normal subordinate hire cannot create a peer and restored superior placement retains its existing restrictions. Parent work item and target agent name are separate identities.

## Example and outcomes

After checking tier/capacity, unique names and an available first-child index:

```json
{"action":"create","title":"Check draft references","objective":"The draft contains unchecked references. Verify them against current source.\n\nRecord source anchors and remaining limits.","kind":"non-code","name":"draft-checker","tier":"sol","grant":0,"charter":"Own the assigned reference-check docket item and record evidence.","index":0,"add_dirs":[],"tools":{"bash":false,"web":false,"edit":false,"subagents":false,"mcp":[]},"org_visibility":"self","permission_mode":"default"}
```

This intentionally relies on assignment mail rather than kickoff. A restored owner can use action update, existing slug and node, with optional changes; the item must be manageable and the restored seat admissible. A named live node is not a shortcut for assignment and may fail when the composite attempts reassignment to its existing owner.

The result gives node, item slug and the nested hire result plus a committed-together message. Inspect cascade/scope/fresh-session warnings and participant notice outcomes. Refusals include missing create scope, missing new-hire explicit fields, unsupported status, insufficient credits, missing/restricted item, invalid audience/account/scope or late ownership validation. All of those roll back the composite; if the response is lost, inspect the tree/item before retrying to avoid duplicate work.

## See also

- [orgtree-docket-items](../docket-items/SKILL.md)
- [orgtree-docket-statuses](../docket-statuses/SKILL.md)
- [orgtree-docket-review-and-attention](../docket-review-and-attention/SKILL.md)
