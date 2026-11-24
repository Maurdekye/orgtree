---
name: orgtree-tool-duplicate
description: "Copy a node below you, alone or with everything under it, inside this organization: settings, credits, folders, transcript and documents."
---
Up: [orgtree-team](../SKILL.md)

# orgtree_duplicate

Requires `team`. Makes a second copy of a node below you in this organization, without a file. The copy gets the original's settings, charters, credits, scratch folder, team folder, transcript, documents and watchdog definitions (paused). It does not get the original's docket items or its cost history, no mail is copied, and the org mailbox stays with the original. With `subtree: true` everything under the node is copied with it. The original is untouched and is not interrupted.

Use it to fork an agent whose context is worth keeping: try a second approach, split a workload, or keep one copy idle as a checkpoint. To start an agent without that history, [hire](../tool-hire/SKILL.md) instead. To bring a node in from a file, use [orgtree_import](../tool-import/SKILL.md), whose rules this tool shares.

| Parameter | Meaning |
|---|---|
| `node` | Required. A node below you. |
| `subtree` | `true` copies everything under it too. Default `false`. |
| `dest` | The node the copy goes under. Default: where the original is. It must be yourself or a node below you, so copying one of your direct reports needs no `dest`, and a copy cannot land beside you. |
| `index` | Zero-based position among `dest`'s live children. Default: the end. |
| `preview`, `expect`, `strategy` | As for `orgtree_import`: preview returns the plan and its `digest`; `expect` refuses a plan that changed; `strategy` (`bottom-up`, `top-down`, `even`) shrinks spare credits when the grants do not fit. |
| `job` | The id an earlier call returned. Reads that copy instead of starting one. |

**Names and credits.** The copy cannot keep the name: `worker` becomes `worker-2`, and mentions of renamed nodes in the copies' charters follow the new names. You pay the copy's seat and grant from your own free credits, as for a hire ([credits](../credits/SKILL.md)); when the grants do not fit and you name no `strategy` it is refused, and when not even the seats fit it is refused.

**The copy.** It arrives idle with the original's transcript on its desk and starts on a fresh CLI session with a handoff note where its harness cannot carry a session, else on a copy of the original's session under a new id. Its first turn begins with a notice that it is a copy and of whom. Its watchdogs are paused: resume the ones the copy should run, or they would do the original's work twice.

The top level is the user's alone, so a top-level agent cannot copy itself; only the user duplicates from the canvas menu, and only that copy is part of the undo history. Retire the copy to take it back.

```json
{"node":"reviewer","preview":true}
```

Returns the plan for a copy of `reviewer` beside it. Apply with `{"node":"reviewer","expect":"<digest>"}`.

## See also

- [orgtree-tool-import](../tool-import/SKILL.md)
- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
