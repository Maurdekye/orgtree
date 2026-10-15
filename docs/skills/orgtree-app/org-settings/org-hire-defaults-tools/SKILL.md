---
name: orgtree-org-hire-defaults-tools
description: Explain native, Orgtree-group and MCP tool defaults for future hires.
---

Up: [orgtree-org-settings](../SKILL.md)

# Hire-default tools

The tool controls in **Org settings > Hire defaults > Scope** edit
`org:default_tools` for future hires. They do not rewrite existing agents'
saved tool grants. Agents explain/suggest; the user edits. They use the shared
footer Save in [orgtree-org-basic](../org-basic/SKILL.md). Inherited effective
permissions still apply; see `orgtree-scope-and-permissions`
(orgtree-working > team).

## Native Tools

The four engine defaults are true:

| Switch | Field | Purpose |
| --- | --- | --- |
| Run commands | `bash` | Terminal commands and programs. |
| Browse the web | `web` | Web search and page access. |
| Edit files | `edit` | Creating/changing files, including notebooks, in granted folders. |
| Use helper agents | `subagents` | Temporary helper agents within the harness. These are distinct from permanent Orgtree hires. |

These grant the capabilities the selected harness exposes; a toggle is not a
promise that every harness implements the same native tools. Suggest disabling
capabilities that future agents do not need.

## Orgtree Tools

`org:default_tools.orgtree` contains the following boolean groups. Missing
groups default to enabled; all seven start enabled in effective scope.

| Label | Key | Purpose |
| --- | --- | --- |
| Docket work | `docket` | Read and update work items. Staffing also requires `team`. |
| Team management | `team` | Hire, retire, move/configure agents; credits and models. |
| Messaging | `messaging` | Mail, audiences and attachment transfers. |
| Organization reading | `inspection` | Chart, state, transcripts, scratch, tiers and organizations. |
| Watchdogs | `watchdogs` | Persistent watchers; command watchers also require Run commands. |
| Runtime and accounts | `runtime` | Interrupt, halt/resume, account changes and capacity marks. |
| User questions and delivery | `user` | Questions, presentations, files, scope and credit requests. |

Disabling a group removes its tools and instructions from the agent; status
reporting remains available. The endpoint refuses unknown group names or
non-boolean group values. Suggest groups according to the future agent's task,
remembering combined prerequisites such as staffing.

## MCP Servers

`org:default_tools.mcp` is a list of registered external server names. The
engine default is **empty**: no external servers. The UI's wildcard fallback
applies only when the payload omits this field; it is not the engine default.

**All registered servers (current and future)** stores `['*']`. While on, the
panel shows a read-only list of currently registered servers. Turning it off
copies the currently fetched server names into an explicit list, then shows
individual checkboxes. An explicit list does not automatically grant servers
registered later. **Refresh** rediscovers installed harness configurations;
running agents keep their current servers. An empty registry displays no
current servers, and a failed refresh displays an error. These are grants,
not installation or connection controls.

Suggest explicit server choices when future hires need a stable subset; suggest
the wildcard only when the user wants present and future registered servers
eligible by default. For registry/sharing details, see the provider section.

## See also

- `orgtree-scope-and-permissions` (orgtree-working > team).
- [orgtree-org-basic](../org-basic/SKILL.md).
