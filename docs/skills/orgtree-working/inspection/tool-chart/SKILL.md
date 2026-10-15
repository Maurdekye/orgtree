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
| `team` | You, direct superior, peers and direct reports. |
| `subtree` | The team view plus descendants at every depth. |
| `full` | All agents in the org, subject to the archive option. |

For top-level callers, peers are the other top-level agents. Top-level position alone does not grant full visibility. A shown agent is attached to its nearest shown ancestor, so the text tree can omit hidden intermediate rows.

The tree emits at most 600 agent lines, followed by `… (more agents not shown)` when needed; it has no continuation cursor. Status summaries are shortened to a 140-character gist. Without archived rows, a footer counts the org's archived/unrecoverable agents; that count is not the same as a returned list of visible retired rows. An unrecoverable row should not be assumed rehirable merely because the generic footer mentions restoring context.

This is a read, not a wake or staffing action. Missing tool-group permission refuses it. For structured exact fields or a named descendant that the chart omits, use [state inspection](../tool-state-inspect/SKILL.md), whose descendant-read rule is broader than the chart's.

## Example

```json
{"include_archived":true,"include_standing_charter":false}
```

## See also

- [orgtree-visibility](../visibility/SKILL.md)
- [orgtree-reading-reports](../reading-reports/SKILL.md)
