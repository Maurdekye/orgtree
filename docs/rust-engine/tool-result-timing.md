# Tool execution time in agent results

Every agent-facing Orgtree tools/call result ends with a separate text content
block such as `execution time: 0.432ms`. The engine uses a monotonic Instant
around its common call boundary, from argument validation through completion
of dispatch and immediate response handling. This includes successful results,
argument refusals and dispatch failures. It excludes transport, model latency,
JSON serialization after dispatch and the timing-block formatting itself.
Milliseconds use three decimals, including sub-millisecond values.

The original content block is byte-for-byte unchanged, so a JSON response
remains parseable as its first block. No extra result fields are introduced.
Claude's control response and the AGY/Muse/OpenCode MCP bridge retain all blocks;
Codex maps each text block to its own inputText item. The synthetic rig's legacy
primary-text tool endpoint intentionally returns only the original block.
MCP handshake/list replies and separate user-facing standalone MCP are outside
this agent-tool boundary. Keepalive denial runs no tool and gains no fake time.

The varying timing text is result content; no tool definition, prompt prefix,
account, model or session changes. This does not promise a provider cache hit.

## Harness-native tools

The current Claude driver registers PostToolUse callbacks (and a keepalive-only
PreToolUse denial). AGY registers permission and invocation hooks. Codex handles
native approval requests and notifications; Muse MSP and OpenCode ACP carry
approval/session updates. These current engine integrations do not pair an
engine-controlled start and completion around native Bash/Read/etc. No native
tool time is inferred or appended. This is a statement about this integration,
not a claim that upstream harnesses can never provide another hook.

## Verification boundary

Focused tests cover exact formatting, unchanged JSON, errors and retry hints,
empty success, actual Codex and Claude reply adapters, and split/flat bridge
pipe transport. Bridge configuration source connects AGY, Muse and OpenCode
to that common path. These synthetic checks prove engine output preserves the
second block; actual third-party model consumption remains an alpha check.
