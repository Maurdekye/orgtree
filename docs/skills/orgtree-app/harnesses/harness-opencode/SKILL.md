---
name: orgtree-harness-opencode
description: Explain OpenCode's compatible provider routes, permission policy, queued mail and unknown accounting.
---
Up: [orgtree-harnesses](../SKILL.md)

# OpenCode over ACP

OpenCode is an optional installed harness for OpenRouter and language-server seats. Discovery requires an OpenCode 2.x ACP1 entrypoint with session/load negotiation; a filename alone is insufficient. It uses the selected Orgtree provider, not the user's OpenCode login.

## Session and tool behavior

The adapter uses isolated home/config/cache/state and provider credentials in its environment/config, never in diagnostic text or command-line arguments. Persistent lane state holds resume history; per-launch directories are removed on teardown. It disables project OpenCode configuration, updates, plugins, sharing, LSP/formatters and warming features in its isolated configuration.

Mail arriving while an ACP prompt runs waits for the next turn. Do not label it injected into the active prompt. Replay while loading a session is suppressed before transcript ingestion. Attachments use the existing text/path envelope; this adapter does not send native ACP image blocks.

## Permission policy

| Mode/capability | Behavior |
| --- | --- |
| Default/acceptEdits | Code Mode execute is refused because nested tools/fetch are not individually exposed for approval. |
| bypassPermissions | Code Mode, nested tools and fetch are allowed; no folder containment is claimed. |
| Direct native file tools | Every reported path is checked against grants; read-only grants do not authorize writes. Missing/unknown path decisions refuse. |
| Shell | Follows Bash capability; this is not an OS filesystem sandbox. |
| External MCP | Exact granted server namespaces permit their tools; arbitrary MCP arguments are not interpreted as native filesystem paths. |

Approvals are once-only; Orgtree does not choose always-allow or save an approval rule. Config-injected MCP is direct with `codemode:false`. Startup observes bridge initialize/tools-list for up to five seconds, then a measured 250 ms settle; otherwise the turn proceeds with a tools-may-appear-late note. It is a workaround, not proof the model has acknowledged every tool.

## Accounting and limits

Usage comes from per-prompt results. Custom-provider zero cost has no verified price provenance, so cost stays unknown; the provider key's own usage is authoritative. Cache lifetime is unknown. Generic ACP error wording does not establish a typed quota/reset freeze. Saved effort is not proof that a supported custom-provider option was negotiated.

At the checked base this adapter uses empty isolated skill/instruction lists. The pending native delivery contract and its verification limits live in [skills and instructions](../../providers/skills-and-instructions/SKILL.md); external server import lives in [MCP servers](../../providers/mcp-servers/SKILL.md).

## See also

- [orgtree-openrouter](../../providers/openrouter/SKILL.md)
- [orgtree-language-servers](../../providers/language-servers/SKILL.md)
- [orgtree-mcp-servers](../../providers/mcp-servers/SKILL.md)
- [orgtree-skills-and-instructions](../../providers/skills-and-instructions/SKILL.md)
