---
name: orgtree-reading-reports
description: Inspect a report's conversation and artifacts before spending another turn asking it for a recap.
---

Up: [orgtree-inspection](../SKILL.md)

# Reading reports

Read before asking. A descendant's transcript and scratch artifacts often answer a progress question without waking the report or paying for another model turn. Ask only what the record cannot answer: an unstated decision, an unresolved ambiguity or an action that requires the report's judgment.

## A practical review

1. Read the relevant docket description and latest progress to establish the agreed task, owner and claimed result.
2. Read the report's recent [transcript](../tool-read-transcript/SKILL.md) for the actual operations and limitations, then its [breadcrumbs or handoff file](../tool-read-scratch/SKILL.md) when earlier context matters.
3. Check the claimed artifact directly in a folder you may read. A message saying a file exists is not the file; a named commit should resolve and contain the stated change. Review the relevant diff and recorded verification evidence.
4. Compare the result with the task requirements. Distinguish source inspection, a completed check, a commit, integration, deployment and observed runtime behavior.

Inspection is downward-only for conversations and scratch, even if other agents are visible on the chart. Tool limits can clip the evidence; do not treat a bounded recent read as a complete lifetime transcript. Use the tool pages for those bounds rather than assuming omitted output never existed.

If direct artifact access is outside your grants, use the authorized read tool or ask for the particular evidence needed. Do not infer permission from the report's folder grant. A successful test claim still needs its actual result and scope; a running build is not proof of working behavior.

When a factual gap remains, send one focused question that cites what you already read. Delegate a next action with an explicit outcome and return path; [delegating](../../team/delegating/SKILL.md) covers that workflow. Avoid requesting routine recaps that merely repeat the available record.

## See also

- [orgtree-tool-read-transcript](../tool-read-transcript/SKILL.md)
- [orgtree-tool-read-scratch](../tool-read-scratch/SKILL.md)
- [orgtree-delegating](../../team/delegating/SKILL.md)
