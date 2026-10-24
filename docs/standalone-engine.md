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
ORGTREE_P03_PG_BIN=/usr/lib/postgresql/15/bin \
orgtree-engine standalone
```

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

The image runs as the unprivileged `orgtree` user and includes PostgreSQL. Compose
publishes port 7430 on host loopback only and stores the data root in a named
volume mounted at `/data`. With no configured token, read its first-start stderr
in the container log. Keep the volume when replacing the container.

The build includes embedded glossary pages, charters and templates. Its context
allowlist excludes unrelated checkout files, dependency installs and build targets.
Provider CLIs are separate: install them in a derived image and make their
executables available in the engine's PATH. A CLI installed or signed in on the
Docker host is not automatically available in the container.

## Connect through MCP or HTTP

Send `Authorization: Bearer <token>` on every API or push-socket request. The
existing `X-Orgtree-Desktop-Token` header is also accepted. Missing or wrong
credentials return 403. An authenticated client acts as the user of the engine.

Use `POST /api/mcp` to list or create organizations. Then connect to
`POST /api/orgs/<slug>/mcp` to manage that organization. The transport is stateless
Streamable HTTP; GET returns 405. Read its `tools/list` result for the supported
tool cards. The initial set includes chart, user mail and inbox, docket,
hire/retire, interrupt and question answers. Agent-only tools and unlisted
mail/interrupt options are refused. The existing HTTP API remains available for
management actions outside this MCP subset.

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
