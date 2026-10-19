# Codex MCP elicitation

Codex `mcpServer/elicitation/request` is a human permission request, separate
from automatic command/file scope approvals and ordinary agent asks. Each
request gets its own existing AskInfo card on the agent desk and in Attention,
and uses the existing authenticated `/asks/{id}/answer` submit route. It goes
directly to the human regardless of the agent's user audience. This routing
and minimal UI extension were approved by the coordinator on 2026-10-19.

Form cards show the server message and typed fields (boolean, string, number,
integer, string enums and multi-select enums). Required fields and the protocol's
length, count, numeric and format constraints are checked before accepting.
Accept returns `{action:"accept",content:{...}}`; Decline and Cancel return
only their respective `action`. URL-mode cards show an HTTP(S) link for the
user to open themselves, followed by the same three decisions; they never
open a URL automatically. URL acceptance has no form content. Client metadata
is not forwarded or treated as permission.

Each request expires after five minutes, returning `decline`. Provider EOF,
engine shutdown and cancellation return `cancel` and remove its card. The
stdout reader keeps handling other requests and notifications while a human
decision is pending. Simultaneous requests have separate ids; wrong-org,
expired and duplicate answers are refused. No mutable ordinary ask is replaced,
no question limit is consumed, and no answer is sent as agent mail. The engine
keeps at most 128 pending requests; inputs/answers are bounded to 64 KiB and
forms to 32 properties/128 choices per field. Unknown modes, unsupported
nonprimitive schemas and unsafe URL schemes fail closed. No new setting/menu.

Pending requests and answers live only in memory and are not persisted across
an engine restart. Request handlers and answer processing do not log submitted
fields. The new path does not write saved provider/browser permission settings.

## Protocol evidence and reported saved permissions

An approved offline schema export with an isolated empty home/environment
identifies the installed Codex CLI 0.160.0 protocol. The generated `McpServerElicitationRequestParams` schema describes `serverName`,
`threadId`, nullable `turnId`, form/openai-form and URL modes; its response
schema requires `action` from `accept`, `decline`, `cancel` and permits content
and client metadata. This implementation supports the typed primitive MCP form
schema, including titled/legacy enums. The additional `openai/userVerification`
mode requires a device-authenticated proof and fails closed; this implementation
does not fabricate or substitute a form for that proof. No real Codex/browser session is used
for validation; tests send synthetic JSON-RPC through the production reader.

Before the fix, the unknown-method branch returned JSON-RPC -32601 without
saving any permission. The reporter's later saved-permission message cannot be
attributed to an Orgtree persisted refusal: this path has no such write, and
neither quoted error string occurs in the local 0.160.0 executable. That binary
string check does not locate the remote/browser error or establish causality.
Whether Codex, Browser Use or another component retained a refusal is unconfirmed;
no live permission state was inspected or cleared.
