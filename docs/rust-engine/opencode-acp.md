# OpenCode over ACP — implementation contract

OpenCode is an optional installed harness for OpenRouter and language-server
seats. It uses ACP version 1 over stdio. OpenCode 2.x is the first adapter for the
reusable transport; OpenCode-hosted accounts are outside this integration.

This branch is being implemented. The initial native compilation and 15 focused
ACP tests passed; isolated engine composition is still awaiting verification.

## Permissions

In default and acceptEdits modes, Orgtree refuses Code Mode `execute`. OpenCode
2.0.28 can report the outer script instead of the underlying nested call, and its
Code Mode fetch is not separately approved. Granted MCP servers are configured
with `codemode:false` so their tools can be called directly. ACP session/new and
session/load use an empty MCP list for this adapter because OpenCode's ACP
conversion does not preserve the codemode setting. Generic ACP adapters may use
the normal session MCP field.

Direct native file operations require all reported paths to lie within current
folder grants. Read-only grants never authorize a write. Unknown methods/tools,
missing paths and unsupported permission options are refused. Internal Orgtree
tools use exact scoped names; each granted external MCP server gets a reserved
hashed namespace. An external server grant permits its tools; Orgtree does not
interpret arbitrary external MCP arguments as file permissions.

Shell is allowed when the seat's bash switch is on, as on Claude Code. This is
not a filesystem or operating-system sandbox. Shell commands may access more
than the folder grants.

The user's 2026-10-13 19:34 UTC ruling makes bypassPermissions unrestricted:
Code Mode scripts, nested tools and fetch are allowed. Bypass does not claim
folder containment. Even bypass uses once-only ACP approvals; Orgtree never
selects an always-allow option or saves an approval rule.

## Sessions and accounting

The process has isolated configuration, home, cache and state roots. Configuration
and the selected provider key are passed in its environment, not command-line
arguments or diagnostics. Project OpenCode configuration is disabled; the engine
supplies the seat's current identity. Persistent lane data holds session history
for resume; per-launch directories are removed after the process closes. The
user's OpenCode configuration is untouched. Updates, sharing, warming, LSP and
formatters are disabled; no external plugins are configured.

The transport bounds frames, request/event queues and response deadlines.
Session/load replay is suppressed before transcript ingestion. Abandoned session
requests invalidate the connection so late output cannot become another turn's
output. Shutdown closes stdin first and uses the existing recorded forced-kill
path only after a bounded graceful wait.

ACP has no measured mid-turn steering primitive. Mail arriving during a prompt
waits for the next turn; it must never be labelled injected into the current turn.
Usage comes from per-prompt results, not cumulative context updates. Custom
provider zero cost has no verified price provenance and is unknown. The provider
key's own usage remains authoritative. Effort must use a negotiated supported
option, not an invented variant.

## Evidence and limits

Real OpenCode 2.0.28 ACP probes used local Qwen 3.8 and OpenRouter gpt-4.1-mini:
text, tools, permissions, cancellation, next-turn memory and session/load worked.
A new OpenRouter process resumed the same session and used an actual MCP tool.
Observed key-wide spend delta was $0.0096568; this is not isolated per-request
pricing. Raw receipts are outside the repository under the author's D evidence
root and contain no key.

A subsequent real local probe measured Windows Session ID 0 for both OpenCode
and its PowerShell tool, plus an actual file write. Direct MCP with execute
disabled also succeeded. Two immediate first prompts did not see configured MCP
tools even though connection subsequently completed; a probe with a two-second
settling delay did. That delay demonstrates the direct route, not a deterministic
readiness guarantee. A follow-up immediately after initialize/tools-list flush
also missed the tool; handshake plus 250 ms invoked the actual direct MCP tool.
The adapter now observes its own bridge's successful initialize/tools-list
responses, waits up to five seconds, and settles for 250 ms after observation.
That is a measured workaround, not a model-catalog acknowledgement. Timeout
does not fail a turn: the agent receives a one-line tools-may-appear-late note.
The generic ACP transport has no OpenCode readiness special case.

The 15 passing native cases cover session routing, replay suppression, cancel/close,
abandoned load, malformed/oversized/EOF frames, usage unknowns, direct path scope,
shell switch, exact/reserved MCP names, bypass and no persistent approvals. They
include readiness observed/timeout controls, Chat Completions path routing and
strict-template reminder preservation. Engine integration, credential changes,
Quit races and the isolated
engine rig still require verification. No effort option is configured yet for
custom providers: a saved effort is not evidence that the provider applied it.
Prompt content currently uses text blocks, including the existing attachment
path references in the turn envelope; it does not send native ACP image blocks.
Generic ACP error codes do not establish a provider quota/reset time, so this
adapter does not manufacture a quota freeze from untyped error wording.

The synthetic executable in `tools/rig/fakecli/src/acp.rs` exercises the actual
engine bridge and permission callback without an inference call. Its fixture
is a per-seat `acp-fixture.json`, and session records use the injected data root.
Rig discovery never falls through to the user's installed OpenCode: it requires
the rig's explicit executable. `proofs/opencode-acp.mjs` checks the shared
registry, key route, transcript, scope decisions and unknown accounting; it is
prepared but has not run at this checkpoint.

OpenCode is added to the shared installed-only registry after isolated ACP
discovery confirms version 2.x, ACP1 and session/load. A file named opencode
without that negotiation is not offered. Language-server requests use OpenAI
Chat Completions through the existing authenticated pass-through. OpenRouter
custom-provider cost and cache lifetime remain unknown; locally hosted inference
continues to be treated as unbilled hardware. The key's own usage is authoritative.
