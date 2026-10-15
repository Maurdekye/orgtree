---
name: orgtree-mcp-servers
description: Explain installed-harness MCP discovery, formats, refresh, aliases and safe inventory metadata.
---
Up: [orgtree-providers](../SKILL.md)

# MCP servers

Orgtree imports external MCP definitions from installed harnesses' user configuration. Discovery reads files without starting a harness or MCP server, signing in, or editing the source configuration. Finding a definition establishes an available name, not working connectivity or authentication in a destination harness.

## Discovery sources

Each source is read only when its harness executable is installed. `~` below means the user's home; environment overrides are those visible to the engine.

| Source | Files, in discovery order | Section and format |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | JSON `mcpServers` |
| Codex | `$CODEX_HOME/config.toml`, otherwise `~/.codex/config.toml` | TOML `mcp_servers` |
| Antigravity | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, `~/.antigravity/mcp_config.json` | JSON `mcpServers` |
| Muse | `$XDG_CONFIG_HOME/muse/settings.json`, otherwise `~/.config/muse/settings.json` | JSON `mcp_servers` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` and `opencode.jsonc`, otherwise under `~/.config`; additionally those filenames in `$OPENCODE_CONFIG_DIR`, then the explicit `$OPENCODE_CONFIG` file | JSON/JSONC `mcp`, including comments and trailing commas |

This reader does not recursively import project or agent configurations. Generated Orgtree scratch/plugin paths and `.orgtree-mcp.json` are excluded, as are the `orgtree` server and commands whose arguments contain `mcp-bridge`. Missing, malformed, oversized, disabled and unsupported entries are skipped. Config files and OpenCode referenced files are limited to 4 MiB each.

## Portable definitions and references

- Stdio uses `command`, `args` and `env`. OpenCode uses a command array whose first item is the executable and remaining items are arguments, plus `environment`.
- Remote definitions use `url` or Antigravity's `serverUrl`, with `headers` or Codex's `http_headers`. A `type: "sse"` marker is preserved; other supported remote definitions normalize to HTTP.
- Codex supports inherited `env_vars`, `env_http_headers` mapping header names to environment-variable names, and `bearer_token_env_var`. Its ordinary strings stay literal.
- Claude, Muse and Antigravity strings expand `${VAR}` and `${VAR:-fallback}`. OpenCode expands `{env:VAR}` and `{file:path}`. File references are relative to the config file, or use `~/` or an absolute path; their contents are trimmed. Missing required references skip that entry.

For example, these source shapes normalize to the same stdio definition:

```json
{"mcpServers":{"docs":{"command":"example-runner","args":["serve"]}}}
```

```toml
[mcp_servers.docs]
command = "example-runner"
args = ["serve"]
```

```json
{"mcp":{"docs":{"type":"local","command":["example-runner","serve"]}}}
```

These are illustrative source snippets, not instructions to install or execute that command. Harness-private OAuth stores and nonportable options are not migrated. A remote MCP requiring OAuth can still need authentication in its destination harness.

## Names, collisions and public metadata

Equal normalized definitions under the same name combine their source labels. Differing definitions keep separate names. Discovery priority is Claude Code, Codex, Antigravity, Muse, OpenCode: the first variant keeps the plain name, later variants receive a source suffix such as `docs-codex`. Literal names are reserved first; a real `docs-codex` forces the collision alias to `docs-codex-2`, then higher numbers as needed. Select the returned alias rather than guessing from the source name.

The public response contains only `servers` (names) and `details` (name, sources, transport). Source labels explain provenance; stdio/HTTP/SSE describe transport. Commands, arguments, URLs, environment values and headers remain private. Skip diagnostics contain a source and static reason, not parser snippets or definition contents.

## Refresh and when changes apply

The MCP lists in settings display name, source and transport. **Refresh** rereads all installed sources through `POST /api/mcp-servers/refresh`. At the checked base, it updates the displayed list; a failed request keeps the previous list and displays an error. It does not save tool grants or reconfigure running agents.

Ordinary `GET /api/mcp-servers` and future process startup reuse a metadata cache until a config or referenced file's modification time or length changes. Explicit Refresh bypasses that cache, including for environment changes visible in the engine's own environment. A newly discovered definition applies at a future process start. Its tool prefix may change; Refresh does not establish a provider cache hit.

To control which discovered names an agent receives, use [agent Tools](../../agent-settings/agent-tools-tab/SKILL.md) and [org hire-default tools](../../org-settings/org-hire-defaults-tools/SKILL.md). Those pages own the grant rules.

## Sharing pipeline status

The five-source reader above is present at source base `b77512f`. The unlanded `agy-astra/skills-share` branch (`a8b71bc` checked) additionally imports installed Claude plugins through `.claude/plugins/installed_plugins.json`: applicable recorded installs, not marketplace catalogs or arbitrary cache directories. Its `.mcp.json` and declared plugin `mcpServers` use the same normalizer; `${CLAUDE_PLUGIN_ROOT}` resolves privately and file references stay inside the installed package. Private OAuth stores remain excluded.

That branch also expands the shared Refresh button to request MCP, skills and global-instruction refresh independently. Successful responses are retained and failed sources are named. The global-instruction endpoint belongs to a separate change; the combined button requires that composition before delivery. Treat this as pending pipeline behavior, not a claim about the currently running build or successful real-harness loading. See [skills and instructions](../skills-and-instructions/SKILL.md) for the common delivery contract.

## See also

- [orgtree-agent-tools-tab](../../agent-settings/agent-tools-tab/SKILL.md)
- [orgtree-org-hire-defaults-tools](../../org-settings/org-hire-defaults-tools/SKILL.md)
- [orgtree-skills-and-instructions](../skills-and-instructions/SKILL.md)
