---
name: orgtree-tool-import
description: "Import an exported agent or team under yourself or a node below you: preview the plan, pay from your own credits, shrink grants by a strategy."
---
Up: [orgtree-team](../SKILL.md)

# orgtree_import

Requires `team`. Creates the nodes an export file holds under yourself or a node below you, with their charters, settings, credits, folders, transcripts, documents and docket items. Each node is created as a hire is, by you: the same authority and the same credit rules as [hiring](../hiring/SKILL.md). The file is one made by `orgtree_export` or by the user's Export; it may come from another organization or another computer, and needs nobody's approval.

| Parameter | Meaning |
|---|---|
| `file` | The export, relative to your working folder or absolute: a file in a folder you hold, or the path of a file that was sent to you (an attachment of mail you received, a file the user gave you), exactly as that mail names it. |
| `dest` | The node it goes under: yourself (the default) or a node below you. The top level is the user's alone; under a project that is above you is refused, as for a hire. |
| `index` | Zero-based position among `dest`'s live children. Default: the end. |
| `preview` | `true` returns the plan and creates nothing. |
| `expect` | The `digest` of the plan you previewed. The import is refused when the plan has changed since (a name was taken, credits moved, a model came or went). |
| `strategy` | `bottom-up`, `top-down` or `even`: how spare credits are taken away when the saved grants do not fit. |
| `resume_watchdogs` | `true` arms the imported watchdogs that can run anywhere. Default: all arrive paused. |
| `job` | The id an earlier call returned. Reads that import instead of starting one. |

**The plan.** `nodes` lists each node with its final `name`, `tier`, `account`, `seat`, `grant`, `saved_grant`, whether it arrives `retired` and its `warnings`. A name that is taken is numbered (`lead`, `lead-2`, `lead-3`), as at a hire. Tools, MCP servers, visibility, permission mode and folders are clamped to what `dest` holds, each with a warning; nothing is raised. An agent on a model this computer cannot staff arrives retired, with the nodes under it, to be rehired on another model.

**Credits.** You pay the root's seat and grant from what you can draw under `dest`: its free credits and what can be raised below you, never above you ([credits](../credits/SKILL.md)). Grants are the saved ones, raised only where this computer's seats cost more. When the seats fit and the grants do not, name a `strategy`: `bottom-up` takes spare credits from the lowest nodes first, `top-down` from the topmost agent first, `even` one credit from each agent in turn. Without one the import is refused: "this needs N credits and M can be drawn under X; name a shrink strategy". When not even the seats fit it is refused whatever the strategy; ask for credits first.

**After it.** The agents arrive idle and held until their history and files are in place. Each starts its next turn with one notice: where it came from, its new name, what was waiting for it. It goes on with its own CLI session where that came along (Claude Code, Codex, OpenCode), else on a fresh session with a handoff note. Mail is restored only between the imported nodes; mail with anyone else, undelivered mail and questions go to `imported-history/` in each agent's folder and are never delivered or asked again. Nothing is sent to them: they run when someone writes to them. An agent's import is not part of the user's undo history; retire the root to take it back.

**Result.** The call waits about 25 seconds, then answers `state: "done"` with `result.nodes`, `result.plan`, `result.notes` and `result.leftovers` (parts that could not be brought in; `result.held` names agents still held because their transcript is missing), or `state: "running"` with `id` to read later with `job`.

```json
{"file":"inbox/build-lead-team.orgtree.zip","dest":"platform-lead","preview":true}
```

Then apply it with the digest and, if the plan said credits were short, a strategy:

```json
{"file":"inbox/build-lead-team.orgtree.zip","dest":"platform-lead","expect":"<digest>","strategy":"bottom-up"}
```

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
- [orgtree-tool-duplicate](../tool-duplicate/SKILL.md)
