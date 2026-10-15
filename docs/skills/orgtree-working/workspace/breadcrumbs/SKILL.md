---
name: orgtree-breadcrumbs
description: "Keep a durable chronological resumption log that a fresh session can use immediately."
---

Up: [orgtree-workspace](../SKILL.md)

# breadcrumbs.md

Maintain `breadcrumbs.md` in your working folder. Append important events, decisions, findings and open threads as they happen, a few lines at a time, newest last. Skip turns with no durable change. Do not wait until the task ends or the context is nearly full.

Write for a stranger resuming the assignment: what was decided and why, what has actually finished, what is in flight, where the files and evidence live, and what should happen next. Include a readable docket slug and exact branch/commit when those determine the next action. Distinguish a draft from approval, a commit from integration, and source inspection from an executed check.

For example:

```text
2026-10-15 11:20Z: Draft committed on writer/topic at <exact SHA>.
Reviewer requested one scope clarification; source anchors in review.md.
Next: fix that paragraph only, then send the follow-up commit for review.
```

A fresh session after compaction, replacement or a provider change can start with only a short handoff pointing to this file. Read it first, then recover the relevant conversation or docket rather than reconstructing the task from a partial transcript. Keep secrets out of the log and link large evidence instead of pasting it.

Use `AGENTS.md` for standing memories; breadcrumbs are the changing resumption record. The engine does not turn your log into completed work or automatically infer a handoff from it.

## See also

- [orgtree-context-and-compaction](../../runtime/context-and-compaction/SKILL.md)
- [orgtree-scratch-folder](../scratch-folder/SKILL.md)
