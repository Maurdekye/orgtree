# Run the engine without the desktop

The standalone engine runs directly or in Docker and exposes the existing HTTP
and WebSocket APIs plus an authenticated user MCP endpoint. It manages its own
PostgreSQL cluster. No desktop window or separate management CLI is needed.
Desktop attachment and a browser management UI are not supported by this mode.

## Start directly

Install the engine binary and PostgreSQL on the server. Run it as an ordinary
user, with an absolute writable data directory and the PostgreSQL binary directory:

```sh
ORGTREE_DATA=/srv/orgtree/data \
ORGTREE_P03_PG_BIN=/usr/lib/postgresql/17/bin \
orgtree-engine standalone
```

Current migrations need PostgreSQL 16 or later. The database data directory
needs Unix ownership and restrictive permissions. On WSL, keep the data root
on the Linux filesystem; a Windows-mounted drive without Unix metadata cannot
retain PostgreSQL's required permissions. Engine and database binaries may
remain on that mounted drive.

The first start initializes the database and creates `standalone-token` in the
data directory, mode 0600 on Unix. It prints that token to stderr once. Later
starts reuse it. Alternatively supply `ORGTREE_STANDALONE_TOKEN`, at least 32
visible ASCII characters with no whitespace. Preserve the whole data directory.

The listener defaults to `127.0.0.1`. Read the ready line for its port, or set
`ORGTREE_PORT` explicitly. `ORGTREE_BIND` accepts an IP address when a private
non-loopback listener is wanted. Remote access can use SSH forwarding or
Tailscale; built-in TLS termination is not supplied.

## Run in Docker

From a source checkout:

```sh
docker build -f standalone/Dockerfile -t orgtree-engine-standalone .
docker compose -f standalone/docker-compose.yml up -d
```

The image runs as the unprivileged `orgtree` user and includes PostgreSQL 17. The
current engine migrations require PostgreSQL 16 or later. Compose
publishes port 7430 on host loopback only and stores the data root in a named
volume mounted at `/data`. With no configured token, read its first-start stderr
in the container log. Keep the volume when replacing the container.

The build includes embedded glossary pages, charters, templates and the
Changelog's release list and notes. Its context allowlist excludes dependency
installs, build targets and the checkout outside the engine and docs folders.
Provider CLIs are separate: install them in a derived image and make their
executables available in the engine's PATH. A CLI installed or signed in on the
Docker host is not automatically available in the container.

BuildKit retains compiler caches. If compilation exceeds a build machine's memory
limit, the Dockerfile accepts explicit release optimization/LTO/codegen overrides;
see the [packaging notes](../standalone/README.md). The defaults retain normal
release optimization.

Synthetic Linux/amd64 image checks verify fresh database setup, authenticated
HTTP/WebSocket/MCP access, restart persistence and clean shutdown, including
HTTP/MCP access through the host's loopback port. That verification uses fake
CLIs and empty profiles. A separate direct Ubuntu 24.04 WSL run with PostgreSQL
16.2 passed the same startup, authentication, persistence and shutdown checks
outside Docker. Real provider browser login and turns remain unverified.

## Connect through MCP or HTTP

Send `Authorization: Bearer <token>` on every API or push-socket request. The
existing `X-Orgtree-Desktop-Token` header is also accepted. Missing or wrong
credentials return 403. An authenticated client acts as the user of the engine.
The language-server proxy and local-only credential bridge retain their
separate capability checks; named client tokens do not replace those secrets.

### Give each client its own token

Keep the startup token as your bootstrap recovery key. Authenticated clients
can create, list and revoke named client tokens through the engine-wide API:

| Request | Result |
| --- | --- |
| `POST /api/standalone/clients` with `{"name":"My client"}` | New `id`, `name`, `created_at` and a `token` shown once. Save the token now. |
| `GET /api/standalone/clients` | Active clients' `id`, `name` and `created_at`; no secrets or hashes. |
| `DELETE /api/standalone/clients/<id>` | Revokes that client and immediately disconnects its HTTP, WebSocket and MCP connections. |

The orgless MCP endpoint offers the same operations through
`orgtree_client_tokens`, with `action: "list"` (default), `"create"` plus `name`,
or `"revoke"` plus `id`. Every client has user authority, including token
administration. The bootstrap key cannot be revoked through these operations.

Revoking the token you are using disconnects you; reconnect with another token
or the bootstrap key. A self-revoke may end with EOF instead of a response.
If several tokens have authenticated on one shared TCP connection, revoking any
of them closes that connection; unrelated connections stay open.

Names contain 1-100 characters without control characters. Duplicate names are
allowed; use the returned ID to revoke a specific client. At most 128 client
tokens may be active. Each secret contains 32 random bytes. Only its SHA-256
hash and public metadata are saved in `standalone-clients.json` (mode 0600 on
Unix), alongside the existing data. Preserve this file across restarts. Revoked
clients leave the active list. Expiry, rotation and a desktop token UI are not
part of these operations.

Use `POST /api/mcp` to manage client tokens and list or create organizations. Then connect to
`POST /api/orgs/<slug>/mcp` to manage that organization. The transport is stateless
Streamable HTTP; GET returns 405. Read its `tools/list` result for the supported
tool cards. The initial set includes chart, user mail and inbox, docket,
hire/retire, interrupt and question answers. Agent-only tools and unlisted
mail/interrupt options are refused. The existing HTTP API remains available for
management actions outside this MCP subset.

The organization endpoint also provides `orgtree_move`, `orgtree_reorder`,
`orgtree_retool`, `orgtree_rehire` and `orgtree_reallocate`. Move accepts
`node`/`new_parent` or an atomic `moves` array. Reorder takes a zero-based final
`index`. Retool changes supplied scope/charter fields. Rehire restores saved
context and uses `target`/`hire_type` for placement; it does not accept `index`.
Reallocate applies a signed `delta` to an agent's grant. These use the desktop's
user operations, including ordinary scope/credit limits, credit-bubbling settings
and Undo where the desktop records it. Read each tool's current card for fields.

Use `orgtree_questions` on the organization endpoint to discover pending user
requests: `list` returns `questions` and `next_cursor`, with `limit` default 50
and maximum 200; pass that cursor to continue. `get` takes an `id`. This is a
live view of open cards, including questions, credits, scope requests and native
permission forms. Resolved cards are omitted; reread a card if it was amended.

Ordinary open cards use `kind:"batch"` and a `tabs` list, including a single
question or credit request. Inspect the tab kinds and request parts to choose
the answer or credit action; `kind` alone does not mean several decisions are
required. Native permission forms retain their own card shape.

`orgtree_answer` answers ordinary question cards with `ask`, positional `answers`
and the card's `rev`, or `dismiss:true`. For an elicitation card, pass `ask`,
`action: "accept"`, `"decline"` or `"cancel"`; accepted forms also need typed
`content`. Private submitted form values are delivered to the waiting request
and are not echoed in the answer response.

For credit-only cards use `orgtree_questions action:"credit"`, `id`,
`decision:"approve"` or `"deny"`, optional `granted` total, `rev` and `dry:true`
for preview. For combined requests use `action:"batch"`, `node`, the card's
`revs`, positional `answers` (null explicitly skips), `credits` containing one
of `granted`, `deny:true` or `skip:true`, and one `approve`/`deny`/`skip` per
`scope` item. Include decisions for every part the card contains. Existing
desktop revision, credit and scope validation applies.

`orgtree_settings` reads (`action:"get"`, default) or changes
(`action:"configure"`, plus a `settings` object) the existing desktop settings.
Choose `scope:"org"` on an organization endpoint, or engine-wide `defaults`,
`runtime` or `provider` on either endpoint. Organization reads return `stored`
and `effective`; writes use `org_dirs` for folder grants and `compact_at` as
50-95 percent. App defaults retain the desktop API's fraction convention for
`compact_at`. Runtime settings include the user's credit-bubbling switches.
Provider reads use cached discovery; to configure, supply `provider` and one
boolean switch in `settings`: `enabled`, `apikey_fallback` or
`subscription_inference`. Configure one provider switch per call. Global
changes affect all organizations; existing desktop value checks apply.

`orgtree_accounts` manages the engine-wide registry on either endpoint:

| Action | Fields |
| --- | --- |
| `list` (default) | Optional `org` filter. Account metadata and stored profile paths, without secrets. |
| `add` | `provider` (`claude`, `openai`, `google`, `muse`) and `kind`: `managed`, `imported` plus `path`, or `apikey` plus `key`. Muse import is refused. |
| `remove` / `identity` / `marks` | `id`. Removal uses existing binding reconciliation; identity rereads that profile; marks reads standing capacity marks. |
| `enable` | `id`, boolean `enabled`. Existing turns finish; the existing user handler governs future admission and wakes. |
| `clear_marks` | `id`, `source:"registry"`, exact `expected`, `pool`, `reason`, and `companion_expected` when required. Changed marks write nothing; clearing adds no capacity and resumes no frozen agent. |
| `claude_key_add` | Native `setup-token` output in `token`, optional `mint_config_dir`. |
| `order` | `keys`: account IDs in fallback order. |
| `openrouter_key_add` | `key`, optional `label` and `harness`. |
| `openrouter_key_update` | `id`, supplied `key`/`label`/`harness`. |
| `openrouter_key_remove` | `id`. |

Actions refuse unrelated fields. Credentials are accepted through private,
body-omitted MCP boundaries and never echoed. Identity/key changes retain the
desktop's provider checks and can contact the provider. Native CLI/browser login
remains a separate SSH step; account creation does not complete it.

Database-driver query logs are omitted even with a debug/trace log override,
because their SQL parameter dumps can contain stored account keys. Engine
operation diagnostics remain available.

Authenticated `GET /api/desktop/alive` checks readiness. Authenticated
`POST /api/desktop/shutdown` requests clean shutdown; Unix SIGTERM, SIGINT and
SIGHUP also use the clean shutdown path.

## Sign in to provider CLIs over SSH

Install provider CLIs separately and use their own login flows. Sign in as the
same Unix user that runs the engine. The browser may run on your laptop; the
CLI and its saved login must remain on the server. An Orgtree account's login
folder matters: signing in to your default CLI profile does not sign in all of
Orgtree's managed profiles.

Default Claude uses `~/.claude` and default Codex uses `~/.codex`. A registered
account instead uses its stored profile path. The authenticated `GET /api/accounts`
response supplies that path as `credential.path`. Create a managed row with
`POST /api/accounts` and `{"provider":"claude","kind":"managed"}` (or
`openai`/`muse`), then use the returned profile path for login. For Claude/Codex,
an existing signed-in folder can instead be registered with
`{"provider":"openai","kind":"imported","path":"/absolute/profile"}`.
Paths are on the engine's machine or inside its container, not on your laptop.

### Claude Code

In an interactive SSH terminal, run:

```sh
claude auth login --claudeai
# For a managed/imported account, use its actual credential.path instead:
env CLAUDE_CONFIG_DIR='/srv/orgtree/data/profiles/example' claude auth login --claudeai
```

Open the printed URL in your local browser and paste the resulting code into
the server terminal. Orgtree already launches that registered account with the
same `CLAUDE_CONFIG_DIR`.

### Codex

Use the installed CLI's native device-auth option when it supports that option
and your account enables it. The following is the upstream recipe; native
browser completion has not been tested as part of the standalone packaging proof:

```sh
codex -c 'cli_auth_credentials_store="file"' login --device-auth
# For a managed/imported account, prefix the same command:
env CODEX_HOME='/srv/orgtree/data/profiles/example' \
  codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

Approve its URL/code in your browser. Alternatively forward the native browser
callback port from your laptop. For the usual port 1455:

```sh
ssh -t -L 1455:127.0.0.1:1455 operator@server
# In that server terminal:
codex -c 'cli_auth_credentials_store="file"' login
```

Use the port reported by your CLI if it differs. For a registered account,
apply the same `CODEX_HOME` prefix. File credential storage matters: Orgtree's
current identity reader looks for `auth.json` in that home; a keyring-only
login is not detected by that reader.

### Muse and other harnesses

Muse's native `muse login` presents a browser approval code. For a managed
profile, use both of the roots Orgtree launches it with:

```sh
env -u META_API_KEY \
  XDG_CONFIG_HOME='/srv/orgtree/data/profiles/example/config' \
  XDG_DATA_HOME='/srv/orgtree/data/profiles/example/data' muse login
```

Muse imported-folder registration is deliberately unsupported; create the managed
row first. Antigravity uses its own interactive `agy` entry point; a working
headless Linux/keyring login has not been established by this verification.
OpenCode currently serves isolated OpenRouter/local-server routes, rather than
adopting an unrelated native subscription login.

For Docker, run these login commands through SSH plus `docker exec -it` inside
your derived container as its `orgtree` user. Use managed profiles under `/data`:
the supplied compose volume preserves them, while `/home/orgtree` is not persisted
by that compose file.

After login, authenticate to `GET /api/accounts/<id>/identity` for a registered
row. For the default profile use `GET /api/providers?force=true&force_provider=claude`
(or `openai`). Refresh reads the profile; it does not perform the browser login.
The native SSH/browser recipes above are source-based guidance, not evidence
of a completed real provider sign-in.

Synthetic Linux checks verified Claude/Codex managed-profile adoption: fake
login files in the returned profile changed its detected identity without
changing the default profile. The focused MCP group checks also passed. Real
browser sign-in and provider-network account/key operations remain unverified.
