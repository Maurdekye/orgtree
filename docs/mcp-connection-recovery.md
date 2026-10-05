# Automatic recovery of a lost Orgtree MCP connection

Claude Code can remain alive after its stdio Orgtree MCP connection fails. The
engine asks that process for `mcp_status` every 30 seconds (first probe after five
seconds), without sending a model prompt or an MCP mutation. It accepts only the
matching local control response or a CLI `system/init` server status. A failed or
disconnected `orgtree` server, or a previously present server disappearing from
an authoritative status reply, requests recovery. Pending, an unsupported control
request, silence, and failures of other servers do not request recovery.

The stdout owner consumes health replies, including delayed replies. They never
reach the turn's mail-consumption acknowledgement. Agent prose and tool-result
text are not used as health evidence.

A parked process is replaced through the existing generation-checked kill path.
A claimed process is untouched until its result boundary; the usual turn cleanup
then closes it, and the keeper prepares a replacement using the same session ID.
The normal builder selects `--resume` when the conversation exists. No conversation
is compacted, archived, or replaced, and no operation is replayed by recovery.
Existing operation receipts continue to govern ambiguous tool outcomes.

Automatic recovery attempts for the same org, agent and session back off by 30,
60, 120, 240, 480, then 900 seconds. A single healthy status reply does not reset
this delay. A stable interval of at least 15 minutes after the last delay expires
resets it. Backoff is engine-local; restarting the engine clears it. Each attempt
is recorded in `journals/warm.jsonl` as `mcp-recovery`, with org, agent, session,
process ID, reason, attempt and retry delay. The process exit has reason
`mcp-disconnected`. A process restart alone is not evidence of a provider cache
miss or a guaranteed cache hit.

## Other harnesses

Codex receives Orgtree tools through `dynamicTools`; an external MCP inventory
failure does not trigger this recovery. Antigravity print mode does not expose
authoritative live server health and does not retain the same print process
between turns; its next turn already starts a new process. It is not monitored
using guessed stderr or model text.

## Incident investigation

The 2026-10-05 incident transcript records loss of all 46 Orgtree tools during an
engine outage and later `CONNECT_TIMEOUT` results from the same CLI process.
The user's process restart restored tools. The diagnostic artifacts are in
`artifacts/mcp-connect-timeout-20261005/`.

A controlled inherited probe at c162ca0 sent an MCP tool request to a blocked local
HTTP fixture and then sent an MCP ping. The ping received no reply during the
0.5-second blocked interval. After release, the tool error and ping both returned;
the child remained alive and tools/list still worked. This establishes that the
synchronous stdio loop can delay health traffic during an engine stall. It does
not prove that the incident child exited, or establish the precise historical
cause of the CLI's reconnect timeout. This change does not replay or parallelize
MCP mutations to work around that stall.
