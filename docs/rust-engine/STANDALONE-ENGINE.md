# Standalone Orgtree engine (4.4.0)

The engine is already its own program (`orgtree-engine serve`, its own
PostgreSQL cluster, its own HTTP/WebSocket API on 127.0.0.1). What was missing
for a supported headless run: a token is optional today (an empty
`ORGTREE_V2_TOKEN` serves `/api/*` unauthenticated), the bind address and port
cannot be chosen, a fresh data root may not create its cluster, and there is
no packaging. This is the design for closing that gap in phases; phases 1
and 2 below are implemented, the rest is deferred and named as such.

## Phase 1 (this slice): `orgtree-engine standalone`

One new subcommand of the existing binary. `serve` and `host` are unchanged:
every standalone-only environment variable is ignored outside `standalone`,
and the desktop launch protocol (stdout progress/`ready` lines, the data-root
lock, `engine-port.json`) is kept verbatim, so a desktop pointed at the same
data root gets the existing root-owned refusal instead of a second engine.
(Desktop *attachment* to a running standalone engine is not part of this
slice: attach still goes through the boot host's descriptor, which
standalone does not write.)

Configuration (environment only; there is no management CLI):

| Variable | Meaning | Default |
|---|---|---|
| `ORGTREE_DATA` | data root (required, absolute; holds `pg/`, `scratch/`, settings) | — |
| `ORGTREE_STANDALONE_TOKEN` | API token, at least 32 characters | generated once into `<data>/standalone-token` (0600 on Unix), reused after |
| `ORGTREE_BIND` | listen address (an IP) | `127.0.0.1` |
| `ORGTREE_PORT` | listen port | the persisted `engine-port.json` choice, as today |
| `ORGTREE_P03_PG_BIN` | PostgreSQL binaries (existing variable) | `postgresql/bin` beside the executable |

Behaviour in standalone mode:

- **Authentication is mandatory and fail-closed.** A token always exists
  (from the environment or generated). Every request — `/api/*`, both push
  sockets and the UI bundle — needs `Authorization: Bearer <token>` or the
  existing `X-Orgtree-Desktop-Token: <token>` header; anything else is 403.
  The two pre-existing secret-gated bypasses keep their own secrets and are
  unchanged: `/ls/*` (per-boot language-server proxy secret) and the
  credential-bridge routes (per-agent credentials). Token headers are masked
  in the verbose wire log. A generated token is printed to **stderr once**, on
  the run that creates it, and never written to the engine log.
- **Loopback by default.** A non-loopback bind is possible only through
  `ORGTREE_BIND` in standalone mode, which always has a token. Intended
  remote access is loopback + Tailscale/SSH, or a LAN/Tailscale bind chosen
  explicitly; never a public listener assumption in the docs.
- **Persistence is the data root.** Standalone mode may create the bundled
  PostgreSQL cluster on a fresh root (the existing initdb path); everything
  (cluster, scratch, port, token file) lives under `ORGTREE_DATA`, which is
  the one Docker volume.
- **No desktop coupling.** No parent-process watcher, no core/boot-host
  assumptions. Unix keeps the existing SIGTERM/SIGINT/SIGHUP clean shutdown;
  Windows standalone gains Ctrl+C clean shutdown.
- The existing management surface is the API the renderer already uses
  (orgs, settings, hiring/retiring via `/api/orgs/{slug}/ops`, docket,
  mailbox, `/api/desktop/{identity,alive,status,shutdown}`), now reachable
  by an authenticated remote caller.

Direct run (Windows alpha):

```powershell
$env:ORGTREE_DATA = "D:\orgtree-standalone\data"
.\orgtree-engine.exe standalone   # first run prints the token to stderr
curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port from the ready line>/api/desktop/alive
```

Docker: `standalone/Dockerfile` + `standalone/docker-compose.yml` ship in
this slice (multi-stage Rust build; runtime image carries PostgreSQL, binds
`0.0.0.0` **inside** the container with the compose file publishing to
`127.0.0.1` only, `/data` volume, token from the environment). Not yet
image-built in this slice; see Verification.

## Phase 2 (this slice): the user MCP endpoint

User ruling 2026-10-16 20:40Z: remote MCP acts **as the user**. In
standalone mode the engine serves stateless Streamable HTTP MCP (one
JSON-RPC message per POST, one JSON answer; GET answers 405) behind the
same token:

- `POST /api/mcp` — `orgtree_list_orgs`, `orgtree_list_tiers`,
  `orgtree_create_org`: enough to find or bootstrap an org.
- `POST /api/orgs/{slug}/mcp` — `orgtree_chart`, `orgtree_list_orgs`,
  `orgtree_list_tiers`, `orgtree_message`, `orgtree_send_notice`,
  `orgtree_inbox`, `orgtree_work`, `orgtree_hire`, `orgtree_retire`,
  `orgtree_interrupt`, `orgtree_answer`, `orgtree_create_org`.

These are not the agent dispatcher with a fake caller (agent tools read
the caller's own row and chain of command). Each tool runs against the
same internal paths the desktop's user actions take — `Actor::User` tree
ops (with the user's undo recording), `Who::User` on the docket,
`From::User` mail, the user's own inbox, the desktop's interrupt and
question-answer paths — so its authority is the user's by construction
(`tools::usermcp`). Agent-only tools (status, ask, audiences, watchdogs,
present/send-file, self/session tools…) are not listed; calling one is an
honest error. Outside standalone mode the routes answer 404.

Not on the endpoint yet: message attachments and reply quoting, inbox
`conversation`/`chunk`, tree ops beyond hire/retire (move, reorder,
retool…), settings/credits/provider-account administration (all reachable
through the authenticated HTTP API), and a question-card list (ids arrive
with the cards in the user's inbox and transcripts).

## Deferred (not in this slice)
- **Headless provider sign-in (phase 3).** Device-code or pasted-token flows.
  Until then a standalone host needs its provider CLIs installed and signed
  in by hand (or API-key/OpenRouter accounts added through the API).
- **Per-client named/revocable tokens, an audit log and a desktop "Remote
  control (MCP)" switch** (docket discussion 2026-10-13) build on the phase-1
  token; the token file format (one token per line) leaves room.
- **Desktop attaching to a standalone engine** (same or different machine)
  is out of scope for phase 1; attachment still runs through the boot host.
  The renderer bundle, if served, is reachable by any token holder, but no
  browser UI is a supported surface of this feature.
- **Separate engine repo/submodule extraction** (2026-10-12 note) stays
  optional; phase 1 is deliberately one binary in this workspace.
- TLS termination (use Tailscale/SSH/a reverse proxy), `.deb`/systemd
  packaging beyond the Docker assets.

## Test plan / verification (phases 1–2)

- Unit (pure helpers, `config.rs`, `http/mod.rs`, `tools/usermcp.rs`): token
  resolution (environment valid/short, file generate + reuse), bind/port
  parsing, Bearer accepted only in standalone mode, header token in both
  modes, wrong token refused; the user-MCP tool cards (org-less can find and
  create but not manage; org cards carry the user tools once each and no
  agent-only tool leaks).
- Rig smoke `tools/rig/standalone-engine.mjs` (synthetic data root, fake
  CLIs, offline): first `standalone` start creates its cluster and token
  file; unauthenticated and wrong-token requests are 403 on HTTP and the UI
  path; Bearer and desktop-token headers reach `/api/desktop/alive` and
  `/api/orgs`; the app socket upgrades only with the token; a restart reuses
  the token and the port; a short environment token refuses to start;
  shutdown goes through the authenticated API. The same smoke then drives
  the user MCP endpoint over HTTP: refused without the token, `initialize`,
  org-less and per-org `tools/list` shapes, `orgtree_create_org` visible to
  the HTTP API right after, `orgtree_chart`, `orgtree_work` list,
  `orgtree_inbox` list, and an honest `isError` mailing a nonexistent agent.
- Unverified in this slice: the Docker image build/run, a Linux run, and any
  real provider turn on a headless host.
