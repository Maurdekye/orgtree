---
name: orgtree-standalone-engine
description: Run the standalone engine and use its authenticated user MCP interface, with its supported tools and limits.
---

Up: [orgtree-runtime](../SKILL.md)

# Standalone engine

`orgtree-engine standalone` runs the engine without the desktop or boot host.
It owns its PostgreSQL cluster, scratch and settings in one persistent data
root. Provider CLIs still need installation and sign-in on that host, or an
API-key/OpenRouter account configured through the authenticated API. This mode
uses the providers' native login flows over SSH, rather than an Orgtree login
service. Desktop attachment and a browser UI are unsupported.

## Start and stop

Configure the process environment, then start the existing engine binary:

```powershell
$env:ORGTREE_DATA = 'D:/orgtree-standalone/data'
.\orgtree-engine.exe standalone
```

| Variable | Contract |
| --- | --- |
| `ORGTREE_DATA` | Required absolute data-root path. A fresh root can initialize the bundled cluster. The root lock prevents another engine owning it. |
| `ORGTREE_STANDALONE_TOKEN` | Optional token of at least 32 visible ASCII characters, without whitespace. A nonempty environment value wins; malformed values refuse startup. Otherwise reuse `<data>/standalone-token`, or generate it on first use. An invalid stored token refuses startup. |
| `ORGTREE_BIND` | IP address, default `127.0.0.1`; a hostname is refused. A non-loopback listener is an explicit operator choice. |
| `ORGTREE_PORT` | Optional exact port, 1–65535. Unset reuses the persisted port choice; read the ready line for the selected address/port. |
| `ORGTREE_P03_PG_BIN` | Optional PostgreSQL binary directory; otherwise use the bundled `postgresql/bin` beside the engine. The variable name is historical. |

A newly generated token is written to the root's token file (mode 0600 on
Unix) and printed to stderr once, on that creation run. It is not written to
the engine log. Subsequent starts reuse it unless the environment overrides it.
Keep the data root to retain the database, files, port and generated token.

Authentication is mandatory in standalone mode. Ordinary HTTP API, UI-bundle
and push-socket requests need `Authorization: Bearer <token>` or
`X-Orgtree-Desktop-Token: <token>`; missing/wrong credentials return 403.
The language-server proxy and credential bridge retain their separate secret
checks; the credential bridge still requires a loopback peer. Named client
tokens do not replace either capability. The token authorizes user access to this engine, not a restricted
agent identity. Remote access can use loopback with SSH/Tailscale or a chosen
private listener; built-in TLS termination is not supplied.

## Named client tokens

The bootstrap/startup token remains a recovery key. All authenticated clients
act as the user, including client-token administration. The standalone-only
HTTP API is `GET/POST /api/standalone/clients` and
`DELETE /api/standalone/clients/<id>`. POST takes `{"name":"My client"}` and
returns `id`, `name`, `created_at` and a secret shown **once**. GET returns
`{"clients":[{"id":"...","name":"...","created_at":"..."}]}` only.

The orgless user MCP endpoint provides `orgtree_client_tokens`:

| Action | Fields | Result |
| --- | --- | --- |
| `list` (default) | none | Active id/name/created_at only. |
| `create` | `name` | New metadata plus one-time token. |
| `revoke` | `id` | Removes the client and immediately drops all its open HTTP/WS/MCP connections. |

Each action refuses unrelated fields. Names are trimmed, 1-100 characters,
without control characters; duplicates are allowed and IDs disambiguate them.
There are at most 128 active clients. Secrets contain 32 random bytes and only
SHA-256 hashes are persisted, in `standalone-clients.json` (Unix mode 0600).
An invalid saved registry refuses startup. Active clients survive restart;
revoked clients remain invalid. Creation/revocation logs contain IDs, not secrets.

Revoking the token you are using disconnects you; reconnect with another token
or the bootstrap key. No response is promised on self-revoke (EOF is acceptable).
A socket remembers every token authenticated on it; revoking any one closes
that shared socket. Unrelated sockets stay open. The bootstrap key cannot be
revoked by these operations. No expiry, rotation or desktop switch is supplied.

The existing HTTP API manages organizations, settings, providers, mail and
tree operations. Authenticated `/api/desktop/alive` reports readiness and
`/api/desktop/shutdown` requests shutdown. Standalone does not watch a desktop
parent process. Windows Ctrl+C and Unix SIGINT/SIGTERM/SIGHUP use clean shutdown.

These standalone-only environment settings do not configure ordinary `serve`
or `host`. In particular, an ordinary serve process with no desktop token is
not equivalent to the mandatory-authenticated standalone mode.

Current migrations require PostgreSQL 16 or later; the Docker runtime includes
PostgreSQL 17. Repository Docker assets use one persistent `/data` volume, bind inside the
container and publish to host loopback in the supplied compose file. The
build embeds the glossary, charters, templates and the Changelog's release list
and notes, with an allowlisted build context excluding generated
targets/dependencies.
BuildKit retains compiler caches and accepts explicit compiler-profile build
arguments for constrained machines; those do not change API authorization.
Provider CLIs must be
installed in a derived image; host installations/logins are not automatically
visible in the container. Synthetic Linux/amd64 image checks verify fresh
database initialization, HTTP/WebSocket/MCP authentication, restart persistence,
embedded glossary and clean shutdown; a separate spotcheck verifies actual host
loopback publication. A separate direct Ubuntu 24.04 WSL proof with PostgreSQL
16.2 passes startup, authentication, persistence and clean shutdown outside
Docker. PostgreSQL data needs restrictive Unix ownership/permissions: on WSL,
use the Linux filesystem when the Windows-mounted drive lacks Unix metadata;
the binaries may remain on that drive. Real provider sign-in and turns remain
unverified. Use `docs/rust-engine/STANDALONE-ENGINE.md` in the development
checkout for those source and verification boundaries.

## Provider login over SSH

Run each provider's own login on the server as the engine's Unix user; open its
authorization URL in your local browser. Default Claude/Codex use that user's
`~/.claude`/`~/.codex`. A managed or imported account instead uses its stored
profile directory: get `credential.path` from the authenticated HTTP account
response and run login with that same directory. A default login does not
sign in every managed profile.

Claude uses `env CLAUDE_CONFIG_DIR='<profile>' claude auth login --claudeai`
and a browser URL plus code pasted back into the SSH terminal. Codex uses
`CODEX_HOME=<profile>` with its native login: a supported device-auth option,
or its browser callback with that port forwarded through SSH. The current
Orgtree identity reader requires the profile's `auth.json`; a keyring-only
Codex login is not detected. Muse managed login uses both
`XDG_CONFIG_HOME=<profile>/config` and `XDG_DATA_HOME=<profile>/data` with
`muse login`, without an inherited `META_API_KEY`. Muse folder import is refused.

Existing authenticated `POST /api/accounts` supports managed rows and
Claude/Codex imported folders. `GET /api/accounts/<id>/identity` refreshes a
registered row after login. For the default profile, force the provider read
with `GET /api/providers?force=true&force_provider=claude` (or `openai`). These
HTTP routes have user authority; `orgtree_accounts` also exposes add/list/identity.

In Docker, login must run inside the derived container as its user. Keep the
account profiles under `/data`; the supplied compose file does not persist
`/home/orgtree`. Antigravity's Linux headless/keyring login is unverified.
Source inspection establishes the profile matching, not successful native
browser completion. The checkout's `docs/standalone-engine.md` gives the
operator recipes and their current verification limits.

## User MCP endpoint

Standalone exposes stateless Streamable HTTP MCP. A POST accepts one JSON-RPC
object or a batch processed sequentially. Requests with non-null IDs receive
response objects; a batch returns those responses as an array. A POST with no
ID-bearing requests returns HTTP 202 without a response body. Tool calls need
request IDs: an idless tools/call does not execute an action. A batch is not one
atomic transaction. GET returns 405, rather than opening a stream.
The routes return 404 outside standalone mode and require the same token:

| Endpoint | Served tools |
| --- | --- |
| `POST /api/mcp` | `orgtree_list_orgs`, `orgtree_list_tiers`, `orgtree_create_org`, `orgtree_client_tokens`, `orgtree_settings`, `orgtree_accounts`. |
| `POST /api/orgs/{slug}/mcp` | Orgless tools except client tokens, plus `orgtree_chart`, `orgtree_message`, `orgtree_send_notice`, `orgtree_inbox`, `orgtree_work`, `orgtree_hire`, `orgtree_retire`, `orgtree_interrupt`, `orgtree_answer`, `orgtree_move`, `orgtree_reorder`, `orgtree_retool`, `orgtree_rehire`, `orgtree_reallocate`, `orgtree_questions`. |

Calls act **as the user**, using the desktop's user-operation paths. This is
not the agent dispatcher with an invented caller. Agent audience and
descendant permissions do not define this endpoint's authority. `initialize`
states the current organization; `tools/list` supplies its current cards.
Agent-only tools such as status, ask, audiences, watchdogs, present/send-file
and session controls are absent and refused if called.

User tool cards describe this endpoint's supported fields and user authority.
Unsupported fields refuse before an action, including `queued`/`restart` even
when false or null. Mail supports only `metadata.to`, optional
`metadata.notice` on message, and `body`; send-notice is always passive.
Agent-mail kind, urgency, tags, options, attachments and reply-reference fields
are not served here. Flat mail routing and the existing answer/work ID aliases
remain compatibility inputs; do not mix flat routing with `metadata`.

| Tool/action | User-endpoint differences and required fields |
| --- | --- |
| `orgtree_create_org` | Required nonblank `name` from which the slug is derived; optional `dirs` array of host folder paths. Connect to the returned org's endpoint to manage it. |
| Message / send notice | `metadata.to` names one agent in this org (or a one-element array), with nonblank `body`. A notice is passive. Multiple recipients, outside mail, question-kind mail, attachments and `reply_to`/`replies` quoting are not supported here. |
| Inbox | The user's own inbox for list/fetch. `action=list` is default, with `limit` default 50, clamped 1–200 separately for pending/delivered/sent lists. `fetch` accepts 1–20 `message_ids`; unknown IDs refuse. `action=settings` reads the org outside-inbox mode; `action=configure mode=normal\|dnd\|closed` changes it through the desktop policy path as the user. Those policy actions accept no other fields. Conversation, chunk and agent-only pull are not supported here. |
| Hire / retire | User tree-operation validation and Undo recording apply. A hire with no parent/target is top-level; a superior hire requires `hire_type:superior` and `target` naming the insertion anchor. |
| `orgtree_move` | Organization endpoint only: `node`/`new_parent` or atomic `moves[{node,new_parent}]`. User tree validation and desktop Undo apply. |
| `orgtree_reorder` | Organization endpoint only: `node` and zero-based final `index`, after removing the node. User tree validation and desktop Undo apply. |
| `orgtree_retool` | Organization endpoint only: `node` plus supplied scope/charter fields; omitted fields stay. Folder restrictions propagate to descendants; existing user validation and Undo apply. |
| `orgtree_rehire` | Organization endpoint only: required `node`; omitted agent fields retain saved values. `target` and `hire_type` set placement; `index` is refused. Projects retain policy and refuse agent overrides. Existing user credit/scope validation applies; restoration is not an Undo-recorded operation. |
| `orgtree_reallocate` | Organization endpoint only: `node`, signed `delta`; increases grant or takes unused credits back. User caps, committed-credit checks and credit-bubbling settings apply. |
| Work | Acts as the user on the org docket. Use the current tool card for fields; do not assume the agent's ownership/participant authority model. |
| Interrupt | Required `node` agent. Stops its current turn; a runtime that does not answer within 60 seconds refuses. Agent queued/restart orchestration is not implemented here. |
| `orgtree_answer` | Required `ask` question-card ID (discover with `orgtree_questions`); ordinary `answers` is positional, one object per question with `selected` option labels and/or `text`, or `dismiss:true`. Return `rev` from the card. Native elicitation cards instead take `action:accept\|decline\|cancel` and typed `content` for accepted forms; private submitted content is not echoed. Fields from the wrong kind of answer are refused. |
| `orgtree_questions list/get` | Org endpoint only. `list` defaults to 50, accepts `limit` 1-200 and the previous `next_cursor` as `cursor`; returns `questions` and nullable `next_cursor`. Open cards only, ordered by ID, including native permission forms. Live pagination may change as cards arrive/resolve; reread amended cards. `get` requires open-card `id` in this org. |
| `orgtree_questions credit` | Credit-only card: `id`, `decision:approve\|deny`, optional `granted` TOTAL, `rev`, `dry:true` preview. Existing user credit validation applies. Mixed requests require batch. |
| `orgtree_questions batch` | `node`, the card's `revs`, and every present part: positional `answers` (null explicitly skips), `credits` with exactly one of `granted`, `deny:true`, `skip:true`, and `scope` with approve/deny/skip per item. Existing user whole-request/revision/scope/credit validation applies. |
| `orgtree_settings` | Required `scope:org\|defaults\|runtime\|provider`; `action:get` default, or configure plus `settings` object. Org scope requires org endpoint; global scopes work on either and affect every org. Get accepts no write fields. Org read returns stored/effective settings; configure uses org_dirs and compact_at percent 50-95. App defaults retain desktop compact_at fractions. Existing user handlers validate values. Runtime includes credit_bubble_hire_enabled/credit_bubble_alloc_enabled. Provider get reads cached discovery; configure needs provider plus exactly one boolean enabled/apikey_fallback/subscription_inference in settings. No generic API passthrough. |

Runtime settings also include `wrap_object_mentions` (boolean, default false):
the Display > Text > Wrap object mentions switch. Configure it through
`orgtree_settings` with `scope:"runtime"` and
`settings:{wrap_object_mentions:true}`; false restores unbroken object links.
The setting persists engine-wide and is pushed to open windows immediately.

Ordinary open request cards use `kind:"batch"` with `tabs`, even for one question
or a credit-only request. Inspect tab kinds and request parts to choose the
answer/credit/batch action; the outer kind alone does not require several
decisions. Native permission forms retain their own card shape. Discover IDs
from the cards, never from a domain submission's human-readable receipt.

Example JSON-RPC calls, sent to the appropriate authenticated endpoint:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"orgtree_create_org","arguments":{"name":"Example"}}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"orgtree_message","arguments":{"metadata":{"to":"worker"},"body":"Please inspect the assigned item."}}}
```

Other unlisted actions remain outside this MCP subset; the authenticated HTTP API
has its own operations. Tool errors return `isError` and explanatory text.
The ordinary agent tool pages describe a different caller/transport and must
not be used to infer extra user-MCP capabilities.

### Account administration

`orgtree_accounts` works on either endpoint and has engine-wide user authority.
Each action refuses unrelated fields and uses the existing desktop handler.
Native browser login remains separate; identity/key changes may contact the
provider. Secrets are accepted only through private MCP boundaries, never echoed
or logged. `list` exposes account metadata and profile paths, not stored keys.

The formatter also omits `tokio_postgres::query` records under debug/trace log
overrides: SQL parameter dumps can contain stored keys. Ordinary engine
operation diagnostics remain available.

| Action | Fields / behavior |
| --- | --- |
| list (default) | Optional org filter. |
| add | provider claude/openai/google/muse; kind managed, imported plus path, or apikey plus key. Muse imported folders are refused. |
| remove | id; normal user binding reconciliation. |
| enable | id, enabled boolean; normal admission/wake behavior. |
| identity | id; reread the registered profile using current user checks. |
| marks | id; inspect exact capacity-mark values before clearing. |
| clear_marks | id, source registry, pool, exact expected and reason; companion_expected where required. Changed marks write nothing; clearing adds no capacity and resumes no frozen agent. |
| claude_key_add | token from native setup-token; optional mint_config_dir. |
| order | keys array of account IDs in fallback order. |
| openrouter_key_add | key; optional label and harness. |
| openrouter_key_update | id; supplied key/label/harness. |
| openrouter_key_remove | id. |

## See also

Focused synthetic Linux verification passes 13/13 user-MCP tests, including
real database-backed user operations, private-form/log controls and fake
Claude/Codex managed-profile adoption. Real CLI/browser sign-in, Muse/Antigravity
login and provider-network key operations are not established by that proof.

- [orgtree-user](../../user/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- `orgtree-app-runtime-desktop` (orgtree-app › app-settings) for the desktop installation's separate startup controls.
