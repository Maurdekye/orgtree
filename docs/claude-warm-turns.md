# Claude warm turns and durable run credentials

Claude Code's main process can serve several turns, but its Orgtree MCP child
belongs to exactly one signed durable run. That child's credential is immutable.
The main process's environment contains no turn token: a shell or hook that
launches its own agent-call transport cannot acquire a successor's authority.
`api.agent_call` rejects a missing run credential with 403 and an ended claim
with 409. Engine callbacks retain the run captured by `_turn_callback`.

At admission, a claimed warm process must have no unfinished work from its prior
turn, and the prior request must no longer authorize operations. The engine uses
the supported stream-json `mcp_set_servers` control to replace the Orgtree child
with a new process carrying the newly admitted claim. The new child authenticates
through the existing agent-call gate before answering MCP initialize. A private,
single-use challenge ties that acknowledgement to the expected run; the control
reply then proves the child completed the round trip. The engine verifies the
child belongs to the claimed CLI and that its tool-list digest matches the prior
child. Only then may it send the user prompt. The challenge and credential are
transport environment values, never prompt or tool-definition content.

At the result boundary, all tool calls must have returned, foreground tasks and
background tasks must be empty, and no extra descendant process may have survived
its tool result. The engine removes the drained Orgtree child, verifies its exit,
and parks only the main CLI. Late tool activity taints the process and prevents
reuse. Administrative holds and request cancellation are checked at both ends of
the handoff. An unsupported control, missing acknowledgement, unknown process
state, changed tool list, or failed quiescence check discards the process and uses
the ordinary cold path. The per-turn queue does not feed another request into the
old authenticated child.

The MCP health monitor suspends missing-child recovery while this deliberately
empty CLI is parked. It resumes when a newly authenticated child is installed.
Other granted MCP server definitions are preserved during replacement.

## Verification and scope

The control was exercised on the pinned Claude Code 2.1.284 without a provider
request: consecutive replacements returned different child PIDs and different
immutable claims from one CLI process. `tests/test_claude_turn_transport.py`
checks production admission as well as handoff failures and stale identities.
This path applies to the Claude CLI, including tiers using that harness. It does
not remove the separate Antigravity guard or alter Codex's per-turn tool binding.
Local process reuse is not proof of a provider prompt-cache hit.

Design ruling: drag-opus, 2026-10-06. Coordinator authorization: 2026-10-06.
