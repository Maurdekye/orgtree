---
name: orgtree-agents-list
description: Find agents in the hierarchical tray without losing ancestor context or confusing archived visibility with deletion.
---
Up: [orgtree-canvas](../SKILL.md)

# The agents list

The canvas tray lists agents by hierarchy, indenting each report below its superior. The host determines sibling ordering; the tray is a navigation surface, not a new tree owner. Clicking a row navigates to the agent and can bring a piled member forward. Right-clicking opens the shared [agent context menu](../context-menus/SKILL.md) without first navigating.

Filter agents matches the agent name case-insensitively. A filtered-out ancestor can remain as a dim ghost row when a descendant matches, preserving the chain. It is not an extra match or an archived identity by virtue of being dim. The name hover can show a charter gist, while the status-summary line has its own full-text tooltip.

Archived rows are initially folded behind Show archived when any exist; Hide archived folds them again. The count concerns the list's loaded agent set, not a claim that every historical identity has been fetched. A retired card hidden from the canvas can still be found through the appropriate list/navigation path; hidden is not deleted.

Rows include tier, pending-model badge, context wheel, live/queued/halted/frozen/idle status and age, plus the reported summary. If only a previous status is available it is shown dimmed rather than asserted as a new status. See [agent card](../agent-card/SKILL.md) for indicator meanings. Pin/popout actions live in the context menu rather than separate per-row buttons.

Use the list to locate evidence or the correct identity before advising a lifecycle action. Displaying a row does not itself resume a turn or grant a peer management rights; the agent-side read boundary is described by `orgtree-visibility` (orgtree-working › inspection).

## See also

- [orgtree-org-canvas](../org-canvas/SKILL.md)
