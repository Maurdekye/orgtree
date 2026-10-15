---
name: orgtree-agent-tools-tab
description: Explain native tools, Orgtree tool groups and MCP server grants for an agent.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Tools tab

These are per-agent scope settings: `node:tools`, `node:tools.orgtree` and `node:tools.mcp`. The tab has Native Tools, Orgtree Tools and MCP Servers, in that order. Agents explain or suggest grants; they do not change settings themselves.

The field starts from the agent's configured tools. Missing native switches normalize on, missing Orgtree groups normalize on, and a missing MCP list normalizes to empty. Those normalization defaults are bounded by the superior's effective scope; they do not authorize an unavailable capability. Tool changes wait for Save; see [orgtree-agent-config](../agent-config/SKILL.md) for process and cache effects.

## Native Tools

| Toggle | Key | Purpose |
|---|---|---|
| Run commands | `tools.bash` | Terminal commands and programs. |
| Browse the web | `tools.web` | Native web search and opening web pages. |
| Edit files | `tools.edit` | Create/change files, including notebooks, within granted folders. |
| Use helper agents | `tools.subagents` | Temporary helper agents within the native harness. |

These control tools built into the harness, such as Claude Code or Codex. Helper agents are distinct from persistent Orgtree hires. A native switch is disabled if the superior lacks it, and the hint says why. A checkmark is not a promise the chosen harness implements every possible tool; enforcement and availability depend on that harness. Folder grants and file/command permission mode also apply.

## Orgtree Tools

| Group label | `tools.orgtree` key | Purpose |
|---|---|---|
| Docket work | `docket` | Read/update work items. |
| Team management | `team` | Staffing, structure, credits, models and agent configuration. |
| Messaging | `messaging` | Mail, inboxes, audiences and attachment transfers. |
| Organization reading | `inspection` | Chart, state, transcript, scratch, tier/org lists and saved usage reads. |
| Watchdogs | `watchdogs` | Persistent watchers. Command watchers also need Run commands. |
| Runtime and accounts | `runtime` | Interrupt/halt/resume, continuation and account marks. |
| User questions and delivery | `user` | Questions, documents, files and requests for scope/credits. |

Disabled groups remove their tool definitions and corresponding engine-owned instructions. Status reporting remains available even with every group off. Staffing a work item needs both Docket work and Team management. A fresh usage refresh additionally needs Runtime and accounts; the saved read belongs to Organization reading. These are capability gates alongside the tools' normal target/audience/ownership checks, not permission to contact the user or modify any agent.

Each group is disabled in the UI when the superior has denied it. Missing group flags preserve on for compatibility; unknown group names or nonboolean values are refused by the engine. See `orgtree-scope-and-permissions` (orgtree-working > team) for effective ceilings and `orgtree-tool-request-scope` (orgtree-working > user) for asking for missing capability.

## MCP Servers

The list shows registered external servers, with imported harness sources and transport where known. No servers produces **No MCP servers registered**. A server is selectable only if the superior holds that server or the `*` wildcard. A checked row means it is selected and within that ceiling; a disabled row explains the superior's missing permission.

`tools.mcp` is a list of names. A stored `*` means every registered server, including future ones. This tab renders individual toggles rather than an all-servers switch. Turning one off while `*` is held replaces the wildcard with all currently listed names except that server; future servers will then require a new grant. Turning one on in an explicit list adds its name.

**Refresh** rediscovers installed harness configurations and updates the list/source details. While it runs the button is disabled; failure says **Could not refresh MCP servers**. Refresh alone leaves running agents on their existing servers. Saving a server selection reconfigures the agent; it does not install or authenticate a server. Discovery/import details belong to the provider and shared-configuration pages.

Suggest a tool grant for an actual missing capability needed by the task, and check whether the superior must grant it first. Suggest Refresh when a newly configured server is absent from the list; a discovered name does not establish a working authenticated connection.

## See also

- `orgtree-scope-and-permissions` (orgtree-working > team).
- `orgtree-tool-request-scope` (orgtree-working > user).
- [orgtree-agent-visibility-access](../agent-visibility-access/SKILL.md).
- [orgtree-agent-folders-tab](../agent-folders-tab/SKILL.md).
