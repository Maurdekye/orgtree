---
name: orgtree-docket-review-and-attention
description: Route agent review, user questions and manual attention to the correct mechanism without leaving stale flags.
---
Up: [orgtree-docket](../SKILL.md)

# Pick the recipient and the decision

Ask for agent review when another agent should check the work against the scope and evidence. Name the reviewer and retain a responsible owner. Review and approved record agent outcomes; they are not the way to ask the user a question, nor a guarantee of landing or deployment. The exact reviewer/owner update rules live in [work](../tool-work/SKILL.md#actions-and-authority).

For missing information the user must answer, use [ask](../../user/tool-ask/SKILL.md) with the relevant work item. For a concrete non-question the user must see or confirm, use manual attention. The [reaching the user](../../user/reaching-the-user/SKILL.md) guide explains the allowed contact route. An open linked question already carries its own attention; do not add a redundant flag for the same question.

A useful attention reason contrasts the requested scope with the exact decision, special edge case or definition you added and states the confirmation needed. Routine implementation matching the scope does not need another acceptance round. A test report and "ready for review" do not identify a decision for the user.

Before ending a handoff, read current attention sources and linked questions. Retract your flag when it no longer matters; refine a standing reason with amendment rather than raising again. Respect a dismissal and require material new information before returning to it. Exact persistence, dismissal/reply behavior and parameter limits belong in [work's attention reference](../tool-work/SKILL.md#questions-and-user-attention).

Keep the evidence and authoritative decision in the item itself. A cleared manual flag does not imply every question was answered, and an item-owner reply can reach a different agent from the original question's asker.

## See also

- [orgtree-reaching-the-user](../../user/reaching-the-user/SKILL.md)
- [orgtree-tool-ask](../../user/tool-ask/SKILL.md)
