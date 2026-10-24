# Standalone Orgtree engine

The supported standalone engine has its own PostgreSQL cluster, mandatory
authentication, configurable bind/port, HTTP/WebSocket APIs, user MCP and
Docker packaging. Direct Ubuntu WSL and container execution are verified
below. Named clients supplement the bootstrap recovery key. The phase notes
retain the original implementation sequence; the Deferred section names the
remaining scope. Ordinary `serve`/`host` behavior remains separate.

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
  unchanged: `/ls/*` (per-boot language model server proxy secret) and the
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

Docker: `standalone/Dockerfile` + `standalone/docker-compose.yml` provide a
multi-stage Rust build; the runtime image carries PostgreSQL, binds
`0.0.0.0` **inside** the container with the compose file publishing to
`127.0.0.1` only, `/data` volume, token from the environment. The image build
and synthetic Linux/amd64 runtime are verified below, along with a separate
direct Ubuntu WSL run. Real provider sign-in remains unverified.

### Packaging input repair (2026-10-24, 4.4.5)

The Docker build needs `engine/docs/charters`, `engine/docs/templates` and
`docs/skills` as well as the two Rust crates. The first two are compile-time
`include_str!` inputs; `build.rs` embeds the full glossary from the third.
Omitting the glossary can silently embed an empty library; omitting the other
assets fails compilation. The Dockerfile-specific context allowlist includes
all three and excludes unrelated files, targets and installed dependencies.
The recipe uses the checked-in Cargo lockfile, accepts `CARGO_BUILD_JOBS` and
`ORGTREE_BUILD_COMMIT` build arguments, and omits release debug information.
BuildKit cache mounts retain compiler/registry work across failed builds. Release
optimization, LTO and codegen-unit build arguments default to the workspace's
release settings and can be lowered explicitly on constrained build machines.
This is source-checked; Docker/Linux execution evidence is recorded separately.
[verified: `standalone/Dockerfile`, `orgtree-engine/build.rs`,
`domain/templates.rs`, `http/settings.rs`; 2026-10-24]

The image runtime uses PostgreSQL 17 on Debian trixie. Fresh-volume verification
found the old PostgreSQL 15 runtime cannot execute migration 0040, which uses
`pg_input_is_valid` (PostgreSQL 16+). The Debian bookworm Rust build remains
compatible with the newer runtime. The image revision label identifies packaging
separately from the engine's embedded build-commit field, allowing a runtime-only
recipe repair to reuse an unchanged compiled engine.
[verified: `migrations/0040_project_history.sql`, `standalone/Dockerfile`;
2026-10-24]

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

### User tool-card boundary (2026-10-23)

User cards must reflect the actual user handlers, independently of agent
authority and schemas. Shared chart/tier/hire/retire/docket descriptions name
user authority. Mail exposes one recipient, body and optional passive delivery;
inbox exposes only list/fetch/settings/configure fields; interrupt exposes node
without queued/restart. Unsupported root/mail/action fields refuse before
provider, database or runtime dispatch, including queued/restart set to false
or null. Existing flat-mail and answer/work ID aliases remain accepted without
advertising the agent-only options. Do not mix flat routing and metadata.

Pure `tools::usermcp::tests` cover card isolation, pre-dispatch refusal and
supported/compatibility inputs without starting an engine or database.
USER 2026-10-23 chose the documented subset, not implementation of the missing
agent options. [verified: `tools/usermcp.rs`; decided: user 2026-10-23]

Not on the endpoint: message attachments and reply quoting, inbox
`conversation`/`chunk`, and other unlisted actions. Their existing HTTP contracts
do not widen the smaller Oct23 user mail/interrupt tool cards.

### User tree MCP additions (2026-10-24)

The org endpoint exposes move (including atomic batches), reorder, retool,
rehire and reallocate over the existing desktop `Actor::User` operation paths.
The argument adapter maps move arrays to `moves` and rehire targets to parent,
as the agent adapter does, without inventing an agent caller. Recorded
operations use the existing user Undo path. Shared cards retain their fields
but describe user authority; agent cards and the Oct23 mail/interrupt refusals
remain unchanged. Source-based red control at the base finds all five tree
tools absent; focused mapping/card tests cover the new adapter.

### User question MCP additions (2026-10-24)

`orgtree_questions` lists/gets open cards through the existing `ask_card`
projection and ephemeral elicitation registry. Keyed per-org SQL filters open
requests, limits reads to page size plus one, and merges the bounded native
registry. ID cursors paginate a live view, not a durable snapshot. Credit and
batch actions call existing authenticated-user handlers. `orgtree_answer`
now uses the desktop answer handler for both ordinary and native permission
cards. Private input boundaries, validation and error serialization are
`#[nolog]`; answers bypass logged `Done::json`. The response never echoes native
form input. No agent ask/answer authority was added.

The user card's positional `{selected,text}` answer objects are adapted to the
existing desktop string/list values before dispatch, including the whole-batch
handler. Ordinary answers check the card's question count and retain the user
handler's revision checks. The earlier direct forwarding of `answers` did not
match the ordinary handler's `selected` input; the focused synthetic test now
exercises selected labels and free text through the real user endpoint.

### User settings MCP additions (2026-10-24)

`orgtree_settings` exposes existing org/default/runtime/provider settings as
the user. Mutations call the desktop handlers without new authority or generic
RPC dispatch. Org reads use the existing effective-settings projection over
one org row. Defaults retain the desktop fraction convention for compact_at;
org writes use percent. Provider writes change one existing boolean switch per
call, with no partial multi-switch submit. Runtime settings retain the existing
user credit-bubbling controls. Global scopes work on either MCP endpoint; org
scope requires an organization. Oct23 mail/interrupt refusals remain intact.

### User account MCP additions (2026-10-24)

`orgtree_accounts` provides engine-wide registry list/add/remove/enable/identity,
exact mark inspect/clear, native Claude setup-token addition/fallback order and
OpenRouter key add/update/remove through existing user handlers. There is no
HTTP/RPC passthrough or new authority path. Account arguments, typed decoding,
errors and serialized MCP responses remain nolog; wire logging already omits
all MCP bodies. Invalid types never include submitted values in their errors.
Normal binding reconciliation and provider checks remain in the handlers;
real network/provider auth is outside the synthetic verification scope.

## Provider sign-in: native CLI over SSH (2026-10-24)

USER 2026-10-24 chose separately installed provider CLIs and their native
browser login over SSH, without an Orgtree device-code service. See the
[operator guide](../standalone-engine.md#sign-in-to-provider-clis-over-ssh)
for commands and the distinction between source evidence and untested native
browser completion.

Default Claude/Codex use the engine Unix user's `~/.claude`/`~/.codex`, not
arbitrary profile environment inherited by an SSH session. Registered accounts
launch against their stored `config_dir`. Existing HTTP account creation
returns `credential.path`; login must use that directory with
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Existing folder import and per-account identity
refresh already adopt/check Claude/Codex logins; no new login protocol is needed.
Codex identity currently requires `auth.json`, so file credential storage is
needed if the native CLI would otherwise choose keyring-only storage. Muse
managed profiles need both `<profile>/config` and `<profile>/data` XDG roots;
Muse imports remain refused. Antigravity's Linux headless/keyring behavior is
unverified. Docker host logins are not container logins: install CLIs in a
derived image and use `/data` profiles so the compose volume persists them.
No real provider login was performed in this source audit.
[decided: user 2026-10-24; verified: `providers/mod.rs`,
`providers/muse_models.rs`, `http/accounts.rs`, `runtime/actor.rs`,
`apps/desktop/main/providerlogin.ts`]

## Deferred (not in this slice)
- **A desktop "Remote control (MCP)" switch and a dedicated audit-log UI**
  (docket discussion 2026-10-13) remain separate from standalone token
  management. Named client tokens are implemented as described below.
- **MCP extras:** USER 2026-10-24 approved tree operations
  (move/reorder/retool/rehire), question discovery/answering, and
  settings/credits/account administration. Their implementation follows the
  Docker/Linux slice; the 2026-10-23 mail/interrupt refusals remain in force.
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
- Unverified: any real provider sign-in/turn on a headless host. The direct
  Linux proof below is a separate WSL run, not a container result.

### Docker verification, 2026-10-24

Measured at source `d5766054287f4acad867d8f4227b3223bdd26935`:

- Linux/amd64 image builds with PostgreSQL 17 and runs as an ordinary user.
  The checked build used release opt-level 1, no LTO, 256 codegen units,
  debug info off and one Cargo job under a 6 GiB builder limit. A previous
  normal opt-level 3/thin-LTO attempt was OOM-killed at that same limit.
- The focused offline image check passes **33/33**: fresh-volume migrations,
  generated token and mode 0600, HTTP/UI/socket auth gates, user MCP org
  creation/chart/docket/inbox, unsupported interrupt-field refusal, embedded
  glossary, persisted organization/token/port, API and SIGTERM exits, database
  stop records and token absence from engine diagnostics. Only fake CLIs and
  synthetic profiles were supplied.
- A separate **5/5** spotcheck on the normal Docker bridge verifies actual
  host-loopback HTTP/MCP access, unauthenticated refusal and clean API shutdown.
  It used a fresh synthetic profile, fake CLIs and disabled external DNS.
- The original PG15 image failed migration 0040 before readiness; PG17 repairs
  that measured startup failure. The first offline-client adapter serialized
  HTTP statuses as strings; its corrected numeric contract is asserted before
  comparison. Failed/partial attempts are not counted as passing runs.

The verified image digest is
`sha256:c4764a4785b29ba6e2d77560cc209b79a2e57deae958fc4dea71bff5d3e35524`.
These are synthetic packaging/API proofs, not a provider authentication test or
a published image.

### Direct Ubuntu WSL verification, 2026-10-24

Measured outside Docker using the same release engine built at source
`d5766054287f4acad867d8f4227b3223bdd26935`, binary SHA256
`8f1a359c5af29b5ce7390403e85bd269ce0a3421c153ff26696dd7e9e4c49fe7`:

- Ubuntu 24.04, x86_64, WSL2 kernel 6.6.87.2, glibc 2.39, uid 1000.
  PostgreSQL 16.2 (`16.2-1ubuntu4`) server/client/libpq packages were extracted
  into an owned output tree; no root, system install, mount or distro
  configuration change was needed. Other runtime dependencies were already
  present. The cached 16.11 update-package URLs returned 404; the available
  base packages were used only for this isolated synthetic check.
- **40/40** checks pass: fresh database/migrations, generated 0600 token,
  HTTP/UI/WebSocket/MCP authentication, user org/chart/work/inbox, deliberate
  unsupported interrupt-field refusal, embedded glossary, restart persistence,
  API and SIGTERM clean exits, token absence from diagnostics, two database
  stops and removal of the temporary database and HOME.
- The direct process ran in a 6 GiB systemd user scope with an unprivileged
  network namespace: only loopback, no external IPv4 route. Namespace-local
  setup capabilities were dropped before launching the engine. Only fake
  provider CLIs and a minimal environment with an empty home were supplied.
- The mounted Windows output drive lacked Unix metadata: a chmod 0700 probe
  still read 0777. PostgreSQL data therefore used a fresh native Linux 0700
  temporary directory, removed after logs/results were copied out. Binaries
  remained on the Windows-mounted drive. This is an operator prerequisite,
  not an Orgtree mount-management feature.
- Two fixture failures preceded the passing run: loopback setup initially
  lacked namespace capabilities; then a sysfs interface check observed the
  host's existing mount. Socket enumeration and the process's route table
  verify the actual namespace. Partial runs are not counted as passes.

This verifies direct WSL Linux execution, not a generic Linux distribution
matrix or real provider login/turn. No engine source changed for this proof.
[verified: `pg.rs`, direct synthetic standalone run; 2026-10-24]

### Named client tokens, 2026-10-24 (4.4.5)

USER m786bcc0b3072: revocation must "Drop at once"; the bootstrap recovery key
stays and every client acts as the user. Coordinator m73ae357a3860 approved
self-revoke with no acknowledgement promise and tracking all credentials used
on shared TCP sockets. These replace the earlier single-token-only boundary.

- Standalone HTTP: `GET/POST /api/standalone/clients`,
  `DELETE /api/standalone/clients/{id}`. User MCP parity is the orgless
  `orgtree_client_tokens` list/create/revoke card. No agent identity, desktop
  switch, expiry or rotation is introduced. All clients may administer clients.
- Create needs a trimmed 1-100-character name without control characters;
  duplicate names are allowed, UUIDs identify revocation. A secret is 32 OS
  random bytes (64 hex characters), returned once. List returns only active
  id/name/created_at; at most128 active records. The independent bootstrap key
  is never included in, modified by or revocable through the registry.
- `standalone-clients.json` stores versioned metadata and SHA-256 hashes only.
  Writes use unique create-new 0600 temporary files, file fsync and atomic
  replacement. Failed persistence does not accept a create/revoke; malformed
  persisted state fails startup. A parent-directory fsync is attempted on Unix.
- The standalone listener carries a cloned raw TCP shutdown handle through
  ConnectInfo and upgrade. Authentication registers the socket before reading
  the body. The registry mutex serializes registration and durable revocation;
  removing a key shuts every live registered socket in both directions. It
  cuts idle keepalive, partial requests/inflight MCP and upgraded WebSockets.
  Any token used on a shared socket binds it to that key's future revocation;
  unrelated sockets remain open. Ordinary serve/host use their prior listener
  and bootstrap-header behavior.
- Self-revoke includes the calling socket, so EOF may replace a200/MCP result.
  Reconnect with another token or the bootstrap key. This is deliberate.
- Secret-bearing helpers/MCP return boundaries are nolog; HTTP token-admin
  and MCP bodies are omitted at the wire boundary, including unknown/rejected
  token-admin descendants. Safe create/revoke log entries contain only IDs.
- The guard also preserves `ConnectInfo<SocketAddr>` from the trusted client
  connection before the existing credential/language-server bypasses. The
  credential bridge's local-only peer and separate secret checks are unchanged;
  a named user token cannot replace that capability. [verified: `http/mod.rs`,
  `credential_bridge.rs`;2026-10-24]

[decided: user/coordinator 2026-10-24; verified: `client_tokens.rs`,
`client_tokens/transport.rs`, `http/{mod,client_tokens,usermcp}.rs`,
`tools/usermcp.rs`]

Focused Linux verification at `738cbb03b9515a309ed015447c1297ed5f663073`:
`cargo test --release -p orgtree-engine --bin orgtree-engine client_tokens::`
passes **3/3** (1,201 unrelated tests filtered out). Actual router, middleware,
TCP keepalive and upgraded WebSockets run over a database-free synthetic
Engine fixture. They cover idle HTTP, partial MCP body, shared socket and
self-revoke closure; unrelated-client survival; restart validity; HTTP/MCP
administration; hash-only persistence; Unix0600; active limit and malformed
saved-state refusal. A controlled build omitting raw socket shutdown fails
with all four socket-drop observations false. The corrected source passes.

Compilation used one job, a6GiB builder limit, engine package opt0 and
dependencies opt1/noLTO/debug0/256codegen units. The first fixture dropped its
unserviced app-feed inbox too early; retaining the inbox keeps its real
WebSocket open without database work. The first green command then reused the
red Cargo artifact due to Docker-layer source timestamps; forcing a fresh
transport-source timestamp caused an actual recompile and the passing run.
Those partial attempts are not passing evidence. This slice has a Linux
compile/socket proof, not a newly packaged build or real-provider test.

The peer-extension follow-up is separately verified at
`bf747991b515e7d1541687164d21c90fe26e1d31`, based on integrated `cbb3013`.
Removing only the legacy peer insertion makes the bridge reject a legitimate
loopback synthetic release with503 instead of200 (one expected red failure).
Restored source passes **4/4** focused client-token tests, including that
bridge case, wrong-secret/named-token refusal and a synthetic non-loopback
peer refusal. The release targets an absent synthetic broker; no pipe,
provider, real credential or running broker is touched. Fresh Linux compile
passes under the same6GiB/job1 limits. Windows compilation remains a separate
combined-build check.
