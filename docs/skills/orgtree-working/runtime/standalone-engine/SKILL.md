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
does not supply a headless sign-in flow, desktop attachment or a supported
browser UI.

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
checks. The token authorizes user access to this engine, not a restricted
agent identity. Remote access can use loopback with SSH/Tailscale or a chosen
private listener; built-in TLS termination is not supplied.

The existing HTTP API manages organizations, settings, providers, mail and
tree operations. Authenticated `/api/desktop/alive` reports readiness and
`/api/desktop/shutdown` requests shutdown. Standalone does not watch a desktop
parent process. Windows Ctrl+C and Unix SIGINT/SIGTERM/SIGHUP use clean shutdown.

These standalone-only environment settings do not configure ordinary `serve`
or `host`. In particular, an ordinary serve process with no desktop token is
not equivalent to the mandatory-authenticated standalone mode.

Repository Docker assets use one persistent `/data` volume, bind inside the
container and publish to host loopback in the supplied compose file. The
initial source slice did not verify Docker/Linux deployment or a real
headless provider turn. Use `docs/rust-engine/STANDALONE-ENGINE.md` in the
development checkout for those source and verification boundaries.

## User MCP endpoint

Standalone exposes stateless Streamable HTTP MCP: one JSON-RPC message per
POST and one JSON response. GET returns 405, rather than opening a stream.
The routes return 404 outside standalone mode and require the same token:

| Endpoint | Served tools |
| --- | --- |
| `POST /api/mcp` | `orgtree_list_orgs`, `orgtree_list_tiers`, `orgtree_create_org`. |
| `POST /api/orgs/{slug}/mcp` | The three above, plus `orgtree_chart`, `orgtree_message`, `orgtree_send_notice`, `orgtree_inbox`, `orgtree_work`, `orgtree_hire`, `orgtree_retire`, `orgtree_interrupt`, `orgtree_answer`. |

Calls act **as the user**, using the desktop's user-operation paths. This is
not the agent dispatcher with an invented caller. Agent audience and
descendant permissions do not define this endpoint's authority. `initialize`
states the current organization; `tools/list` supplies its current cards.
Agent-only tools such as status, ask, audiences, watchdogs, present/send-file
and session controls are absent and refused if called.

| Tool/action | User-endpoint differences and required fields |
| --- | --- |
| `orgtree_create_org` | Required nonblank `name` from which the slug is derived; optional `dirs` array of host folder paths. Connect to the returned org's endpoint to manage it. |
| Message / send notice | `metadata.to` names one agent in this org (or a one-element array), with nonblank `body`. A notice is passive. Multiple recipients, outside mail, question-kind mail, attachments and `reply_to`/`replies` quoting are not supported here. |
| Inbox | The user's own inbox for list/fetch. `action=list` is default, with `limit` default 50, clamped 1–200 separately for pending/delivered/sent lists. `fetch` accepts 1–20 `message_ids`; unknown IDs refuse. `action=settings` reads the org outside-inbox mode; `action=configure mode=normal\|dnd\|closed` changes it through the desktop policy path as the user. Those policy actions accept no other fields. Conversation, chunk and agent-only pull are not supported here. |
| Hire / retire | User tree-operation validation and Undo recording apply. A hire with no parent/target is top-level; a superior hire requires `hire_type:superior` and `target` naming the insertion anchor. |
| Work | Acts as the user on the org docket. Use the current tool card for fields; do not assume the agent's ownership/participant authority model. |
| Interrupt | Required `node` agent. Stops its current turn; a runtime that does not answer within 60 seconds refuses. Agent queued/restart orchestration is not implemented here. |
| `orgtree_answer` | Required `ask` question-card ID; `answers` is positional, one object per question with `selected` option labels and/or `text`. `dismiss:true` dismisses instead. Return `rev` when supplied by the card. IDs come from the user's inbox/transcripts; there is no question-list action. |

Example JSON-RPC calls, sent to the appropriate authenticated endpoint:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"orgtree_create_org","arguments":{"name":"Example"}}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"orgtree_message","arguments":{"metadata":{"to":"worker"},"body":"Please inspect the assigned item."}}}
```

Move/reorder/retool, other settings/credit/account administration and the other
unlisted actions remain outside this MCP subset; the authenticated HTTP API
has its own operations. Tool errors return `isError` and explanatory text.
The ordinary agent tool pages describe a different caller/transport and must
not be used to infer extra user-MCP capabilities.

## See also

- [orgtree-user](../../user/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- `orgtree-app-runtime-desktop` (orgtree-app › app-settings) for the desktop installation's separate startup controls.
