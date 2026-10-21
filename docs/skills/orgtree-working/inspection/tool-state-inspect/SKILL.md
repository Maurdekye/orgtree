---
name: orgtree-tool-state-inspect
description: Inspect permitted agents' structured state and effective scope without reading their conversations.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_state_inspect

Use this to diagnose agent state, folder grants, tool permissions, visibility, sibling positions or remaining work gates. It reads persisted structured records; a snapshot does not establish that an agent's implementation works or that a queued operation has completed.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `node` | Omitted | One exact agent name. |
| `nodes` | Omitted | Array of exact agent names; combined with `node` when both are given. |
| `include_archived` | `false` | Include non-live, non-deleted records otherwise permitted by the read rule. |

Names are trimmed and a leading `@` is accepted. With no names, return all permitted records. There is no caller-selectable org, cursor or page-size parameter. Requires effective `tools.orgtree.inspection` permission.

## Read access

You can inspect yourself and all descendants, including structural project rows, at every visibility, including `self`. With visibility other than `self`, you can also inspect your nearest agent superior and reporting peers, skipping projects, plus physical parent/sibling project context. With `full`, all non-deleted org nodes are eligible. Top-level callers have no agent superior; their reporting peers can sit in different projects. Top-level position alone does not grant full visibility or cross-project mail reach.

Every explicitly requested name must be in the returned permitted set. An unknown, deleted, out-of-scope, or archived-without-opt-in name causes `state inspection is outside your visible scope: …`; it does not return a successful partial answer for the other names. Invalid structural ancestry can refuse with `invalid scope ancestry` or `missing scope ancestor`.

## Returned fields

The response has `actor`, your effective `visibility`, and `nodes`. Agent records include:

- identity, parent, title, state, generation, tier/model and provider;
- grant, seat cost, free credits, and archive time;
- live `sibling_index` (zero-based), `live_sibling_count`, and `live_child_count`; archived rows have no live index;
- safe account-binding presence/missing flags, freeze provider/cause/pool/deadline, halt/limit-lock and mid-turn flags;
- last status name/time, safe pending-model-switch fields, occupancy/context window, and pending-mail count;
- effective scope: visibility, permission mode, folders and modes in `add_dirs`, Bash/web/edit/subagents switches, Orgtree group switches and MCP grants;
- OpenRouter session harness and pin flag when recorded.
- `kind: project` for structural project rows; their presence is not an agent runtime or a new scope ceiling;
- `audiences_held`, `audiences_explicit` and `audiences_inherited`, the last naming each `grantor` and source `project`;
- each returned node's active actor `interrupt` record when available, including queued/applied/refused/cancelled/restart outcome, turn and harness boundary. This runtime snapshot is not restored across an engine restart.

Folder grants are ancestor-clamped effective grants, not merely the target's configured request. Structural projects pass agent scope through rather than imposing their old scope keys as a new ceiling. `parent` still names the physical parent, and sibling indices/counts use physical siblings, not reporting peers. The mail count is pending mail, not message bodies and not a guarantee that every counted row will wake a turn. Free credits are not populated as a live funding balance for archived rows. Prompt text, transcripts, mail bodies and account secrets are absent.

## Example

```json
{"nodes":["worker","reviewer"],"include_archived":false}
```

For conversations use [read transcript](../tool-read-transcript/SKILL.md); for a human-readable roster use [chart](../tool-chart/SKILL.md).

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)

## Saved speed

`scope.fast_mode` is the node-local saved boolean (absent storage reads false),
not a claim about a running turn's serving speed or model eligibility. It is
never inherited. Managers change it with hire/rehire/staff/retool `fast_mode`;
[fast defaults](../../team/tool-fast-defaults/SKILL.md) affect future hires.
