---
name: orgtree-harness-claude-code
description: Explain Claude Code's Orgtree transport, account routing, native instructions and permission boundaries.
---
Up: [orgtree-providers](../SKILL.md)

# Claude Code seats

Claude Code is the installed agent harness for Claude and a selectable harness for OpenRouter and language servers. Model provider and harness are separate: using Claude Code for an OpenRouter/local model does not bill a Claude subscription.

## Runtime capabilities

One stream-JSON process serves the agent's turns. Orgtree tools use an in-process MCP control channel; PostToolUse callbacks can deliver mid-turn mail at a tool boundary. Process reuse and session resume are separate from provider cache continuity.

Claude tiers include Fable, Opus, Sonnet and Haiku; use the current tier/catalog offer instead of treating every model name as entitled. Authentication can be the native login, a registered profile or an explicitly selected key route. For account/window rules, see `orgtree-account-lanes` and `orgtree-usage-windows` (orgtree-working › accounts).

The terminal capability controls Bash/PowerShell availability. The launch disables nonessential CLI traffic and enables cached feature flags; it does not grant a tool switched off by scope. Background-work handling, warming and compaction are runtime policies; see `orgtree-context-and-compaction` (orgtree-working › runtime) for the latter.

## Permissions and instructions

The configured permission mode and current folder/tool grants determine approvals. Sensitive path writes can be gated above ordinary folder permissions; another spelling or retry is not a remedy. Bypass changes that posture and must not be inferred from a folder grant.

Claude startup reads its native managed/user/project notes, applicable rules/imports and limited auto-memory prefix. In the measured CLI, project AGENTS.md is a fallback when the project chain lacks nonempty Claude notes; granted-folder notes are also supplied by Orgtree when not loaded natively. Native startup-file edits are fingerprinted for subsequent launches/turns. For the rule-file sharing home, see the relevant instruction settings rather than copying another harness's precedence.

For built-in guides, discovered user bundles, pending cross-harness exports and global-instruction limits, read [skills and instructions](../skills-and-instructions/SKILL.md). For external server discovery and Refresh, read [MCP servers](../mcp-servers/SKILL.md).

## Diagnose a missing capability

Check the current provider/account, installed executable, effective scope, discovered MCP name/grant and process startup context. A missing tool does not justify switching credentials or loosening permission mode. Use the actual launch/approval error when explaining a failure.

## See also

- [orgtree-providers-tab](../providers-tab/SKILL.md)
- [orgtree-mcp-servers](../mcp-servers/SKILL.md)
- [orgtree-skills-and-instructions](../skills-and-instructions/SKILL.md)
