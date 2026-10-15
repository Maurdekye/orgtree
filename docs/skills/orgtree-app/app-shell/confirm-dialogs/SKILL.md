---
name: orgtree-confirm-dialogs
description: Read operation confirmations and distinguish their targets and consequences.
---

Up: [orgtree-app-shell](../SKILL.md)

# Confirmations

Shared confirmation dialogs initially focus Cancel, trap Tab within the dialog, and allow Escape or the backdrop to cancel. Confirm closes the dialog before invoking its action. A confirmation concerns the named operation and target; a batch can still encounter changed state or individual refusals during execution.

| Confirmation | What to inspect before accepting |
|---|---|
| Delete organization | The organization name; the backend trashes the organization and moves its owned folders rather than purging database history |
| Delete agent | The complete target subtree and generations counted by the dialog; this is destructive removal rather than retirement |
| Retire | The agent stops and releases its stake; retained context supports rehire, subject to available capacity |
| Dissolve | Includes the named agent's entire suborganization |
| Retire all subordinates | Leaves the named parent live; the result distinguishes completed, already-retired, and failed targets |
| Rescind | Includes the subtree and, for a non-root agent, removes the stake from its superior's grant rather than returning that headroom |
| Batch halt/unhalt | The exact listed subtree or subordinates, whether the parent is included, and the requested direction |
| Cheap compact | Starts a fresh session for the same agent with a handoff; inspect the scope before selecting a single agent or branch |
| Compact now | Requests provider compaction of the current conversation; this differs from cheap compact |
| Undo hire | Retires the hired agent after it has begun working; its work and context remain archived |
| Cross-provider model switch | Read the conversation reset warning and whether a busy agent's switch is queued |

Bulk cheap compaction previews eligible and skipped agents. It skips busy agents, sessions that have not run since compaction, and agents without measured context. Execution proceeds sequentially, rechecks idleness, and reports per-target outcomes; one refusal does not cancel the remaining targets. Some older compaction wording mentions lineage behavior: use the source-checked workflow below for session semantics.

For lifecycle and credit rules see `orgtree-team-shape` (orgtree-working › team); for session behavior see `orgtree-context-and-compaction` (orgtree-working › runtime). Undo mechanics belong to [toasts and undo](../toasts-and-undo/SKILL.md).

## See also

- `orgtree-team-shape` (orgtree-working › team)
- `orgtree-context-and-compaction` (orgtree-working › runtime)
