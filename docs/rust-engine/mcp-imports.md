# MCP imports from installed harnesses

Orgtree reads external MCP definitions from the installed harnesses' user
configuration. It never starts a harness or a server to discover them, edits
those files, or imports project/agent configurations recursively.

| Source | User files, in discovery order | Section |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Codex | `$CODEX_HOME/config.toml`, otherwise `~/.codex/config.toml` | `mcp_servers` |
| Antigravity | `~/.gemini/config/mcp_config.json`; compatibility locations `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, `~/.antigravity/mcp_config.json` | `mcpServers` |
| Muse | `$XDG_CONFIG_HOME/muse/settings.json`, otherwise `~/.config/muse/settings.json` | `mcp_servers` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` and `.jsonc` (default `~/.config`); explicit `OPENCODE_CONFIG_DIR` files and `OPENCODE_CONFIG` | `mcp` |

Presence of the installed executable gates each source; sign-in is not needed.
Explicit environment roots are ignored in the synthetic rig, which uses only its
fake home. Orgtree scratch/plugin paths, `.orgtree-mcp.json`, the `orgtree` server
and bridge commands are excluded. Missing, malformed, disabled and unsupported
entries are skipped. Diagnostics give a source and static reason, never file
contents or parser error snippets. Configs and referenced files are capped at
4 MiB each.

Supported portable definitions are stdio command/arguments/environment and
HTTP URL/headers (Claude's SSE marker is retained). OpenCode command arrays and
`environment`, Antigravity `serverUrl`, and Codex `http_headers`, `env_vars`,
`env_http_headers` and `bearer_token_env_var` are converted to that shape.
Claude/Muse/Antigravity `${VAR}` references and `${VAR:-fallback}`, OpenCode
`{env:VAR}` and `{file:path}` references are resolved locally. Missing required
references skip an entry. File paths are relative to the OpenCode config file,
or use `~/`/absolute paths. Their metadata is watched along with config metadata.
Codex strings stay literal; its explicit environment-reference fields resolve.
Refresh also picks up environment changes in the engine's own environment.
Harness-private OAuth stores and nonportable harness options are not migrated;
a remote server needing OAuth may require authentication in its destination
harness. Importing a definition does not prove that server connectivity works.

Identical normalized definitions under one name combine their source labels.
Different definitions keep both: Claude, then Codex, Antigravity, Muse, OpenCode
priority determines who keeps the plain name. Later definitions get `-codex`,
`-antigravity`, etc.; numeric suffixes disambiguate reserved literal names and
further collisions. Existing Claude grants retain their names. Grants remain
explicit names or `*`; discovery does not grant a newly found name by itself.

The existing Settings MCP lists show name, source and transport. **Refresh**
POSTs `/api/mcp-servers/refresh` and rereads all sources immediately. Regular GET
and future process startup automatically reread when file modification time or
length changes. Neither operation restarts/reconfigures an existing agent;
new MCP definitions affect future process starts. They may change that future
process's tool prefix; no provider cache-hit guarantee follows from refresh.

The renderer receives only `servers` (compatible name array) and `details`
(name, sources, transport). Definitions stay engine-side. Registry helpers and
Codex override generation are `#[nolog]`; Codex header and server keys use
quoted TOML keys where needed.

## Source references

- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Antigravity MCP](https://www.antigravity.google/docs/mcp)
- [Muse configuration](https://dev.meta.ai/docs/muse-code/configuration)
  and [extensions](https://dev.meta.ai/docs/muse-code/extending)
- [OpenCode configuration](https://docs.opencode.ai/docs/config/)
  and [MCP](https://docs.opencode.ai/docs/mcp-servers/)

## Verification hand-in

Author source checks only: rustfmt parses the new module; JS syntax and diff
checks. Compilation and all measured red/green results belong to rig-sol.

- `cargo test --locked -j 2 -p orgtree-engine --bin orgtree-engine mcp_import_ -- --test-threads=1`
  (five tests: source formats/headers, collisions/redaction, exclusions,
  refresh/file references, Codex launch headers and quoted names).
- `node tools/rig.mjs run tools/rig/proofs/mcp-import.mjs`: ten checks,
  synthetic five-source home, no real configs or server launches.
- `node apps/desktop/renderer/tests/run.mjs mcpimport orgsettings --output <owned-C-directory>`
  and root typecheck. Three new renderer tests cover provenance, refresh
  without grant writes/restarts, and failure retaining the previous list.
- Base red: copy only the new proof and renderer test onto `9735bd4`.
  Expected rig failures: all-source import, combined provenance, suffix,
  safe metadata shape, automatic pickup, explicit refresh, malformed-source
  isolation (seven); three renderer tests fail on the absent source label or
  Refresh button. No new unit module exists on the base, so do not call zero
  selected tests a red or a pass.
