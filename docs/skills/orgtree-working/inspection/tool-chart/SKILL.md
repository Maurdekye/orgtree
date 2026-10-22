---
name: orgtree-tool-chart
description: Read the visible org chart with credits, status ages and optional retired agents.
---

Up: [orgtree-inspection](../SKILL.md)

# orgtree_chart

Use this for a readable roster and hierarchy before staffing or coordinating work. It shows tier, grant, seat price, free credits, last reported status and its age, with mid-turn/halted/frozen markers when present. Check retired agents before hiring a new one when previous context may be useful.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `include_archived` | `false` | Include archived and unrecoverable agent rows within chart visibility. Deleted rows are excluded. |
| `include_standing_charter` | `true` | Include each shown agent's nonempty team charter, shortened to a 300-character gist. |

There is no `node`, org selector, cursor, depth, or page-size argument. Requires effective `tools.orgtree.inspection` permission.

## Visibility and output limits

Chart visibility is inherited and narrowed by ancestors:

| Effective visibility | Shown agents |
|---|---|
| `self` | You and direct reports. |
| `team` | You, your superior, agents with the same superior, and your direct reports. |
| `subtree` | The team view plus descendants at every depth. |
| `full` | All agents in the org, subject to the archive option. |

Superior and report follow the [reporting chain](../../team/team-shape/SKILL.md#relationship-terms), skipping intervening projects. The team view also includes agents with the same superior, even if their physical parents differ and they are not peers. Agents with no agent superior are top-level even when placed inside projects; this view includes other such agents. Top-level position alone does not grant full visibility. At `self`, the chart also retains directly owned project rows; at wider visibility it retains the caller's parent/sibling project context. A shown node is attached to its nearest shown ancestor, so the text tree can omit hidden intermediate rows. Visibility of agents with the same superior does not grant cross-project mail reach.

Projects are marked `PROJECT node`, with waiting-mail counts instead of an agent tier/seat budget; they run no turns. Shown nodes include their **Subordinates may message each other** setting (the physical-child peer-mail switch) and effective audiences, naming any source project for inherited access. A project audience reaches live direct members only; chart visibility and communication permission remain separate.

The tree emits at most 600 agent lines, followed by `… (more agents not shown)` when needed; it has no continuation cursor. Status summaries are shortened to a 140-character gist. Without archived rows, a footer counts the org's archived/unrecoverable agents; that count is not the same as a returned list of visible retired rows. An unrecoverable row should not be assumed rehirable merely because the generic footer mentions restoring context.

This is a read, not a wake or staffing action. Missing tool-group permission refuses it. For structured exact fields or a named descendant that the chart omits, use [state inspection](../tool-state-inspect/SKILL.md), whose descendant-read rule is broader than the chart's.

## Example

```json
{"include_archived":true,"include_standing_charter":false}
```

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)
