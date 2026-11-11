# Run the engine without the desktop

The standalone engine runs directly or in Docker and exposes the existing HTTP
and WebSocket APIs plus an authenticated user MCP endpoint. It manages its own
PostgreSQL cluster. No desktop window or separate management CLI is needed.
Desktop attachment and a browser management UI are not supported by this mode.

## The orgtree-engine package

`ghcr.io/maurdekye/orgtree-engine` runs **Orgtree orgs headless**: the Orgtree
engine and its own PostgreSQL 17 in one container, with no desktop window,
served over the authenticated HTTP, WebSocket and MCP API. It is for running
orgs on a server, a home lab or a cloud VM that stays on, and for driving them
from scripts, MCP clients or apps.

**It is optional.** The Orgtree desktop app (Windows installer, macOS and Linux
builds) has its own engine and works without this package; nothing in Orgtree
requires it.

| Tag | What it is |
| --- | --- |
| `<version>`, `latest` | The plain engine. Provider CLIs are not included. |
| `<version>-agents`, `latest-agents` | The same engine plus what agents need inside the container: Codex, Claude Code (pinned; installed on the first start), Node.js, ssh/git, python3 and the Docker CLI. See [the agents image](#the-agents-image). |

`latest` and `latest-agents` follow stable releases only; alphas and betas have
only their version tags. Each release also attaches both images as files with
their SHA-256 ([Download](#download)). Images are linux/amd64.

Orgtree has two other optional packages, each with its own purpose, and this one
is neither: the **standalone mail hub** (a server that carries mail between orgs
on different machines) and **Hubchat for the web** (the Hubchat app served to a
browser). This package runs orgs; it does not include a mail hub or Hubchat.

### Quick start

```sh
docker run -d --name orgtree-engine --restart unless-stopped \
  -p 127.0.0.1:7430:7430 -v orgtree-data:/data \
  ghcr.io/maurdekye/orgtree-engine:latest
docker logs orgtree-engine   # the first start prints the token once
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7430/api/desktop/alive
```

| | |
| --- | --- |
| Port | `7430` (HTTP, WebSocket and `POST /api/mcp`). Publish it on host loopback only, as above; reach it remotely over SSH forwarding or Tailscale. There is no built-in TLS. |
| Volume | `/data`: the whole data root (the PostgreSQL cluster in `pg/`, scratch folders, settings, `standalone-token`; in the agents image also `home/` and `agent-tools/`). Keep it when replacing the container. |
| `ORGTREE_STANDALONE_TOKEN` | The operator token (at least 32 visible characters, no spaces). Unset: the first start generates one, prints it once and saves it in `/data/standalone-token`. |
| `ORGTREE_PORT`, `ORGTREE_BIND` | Set by the image to `7430` and `0.0.0.0` inside the container; change the host side with `-p` instead. |
| `ORGTREE_DATA`, `ORGTREE_P03_PG_BIN` | Set by the image (`/data`, PostgreSQL 17); leave them. |

Compose: `standalone/docker-compose.yml`, with its `build:` block replaced by
`image: ghcr.io/maurdekye/orgtree-engine:<version>`.

**Tokens.** The startup token is the operator (bootstrap) key: full user
authority, and it cannot be revoked through the API. Give each client its own
named token instead ([Give each client its own token](#give-each-client-its-own-token)),
and give an app or script that only needs to look at one org a read-only
**viewer** token ([viewer tokens](#give-an-app-or-script-read-only-access-to-one-org-viewer-tokens)).

**Upgrade.** Back up first (below), then pull the new tag and recreate the
container on the same volume: `docker pull ghcr.io/maurdekye/orgtree-engine:<version>`,
`docker stop -t 60 orgtree-engine && docker rm orgtree-engine`, then the same
`docker run` with the new tag. The engine migrates the database on start; keep
the backup, since an older engine is not guaranteed to open a newer data root.

**Backup.** Stop the container (`docker stop -t 60 orgtree-engine`, so
PostgreSQL shuts down cleanly), copy the volume, start it again:

```sh
docker run --rm -v orgtree-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar -czf /backup/orgtree-data-$(date +%F).tar.gz -C /data .
```

Restore into an empty volume the same way with `tar -xzf`, preserving owners
(the `orgtree` user, uid 1000).

**More:** [Run in Docker](#run-in-docker), [the agents image](#the-agents-image),
[Connect through MCP or HTTP](#connect-through-mcp-or-http),
[Sign in to provider CLIs over SSH](#sign-in-to-provider-clis-over-ssh), and the
engine reference [`docs/rust-engine/STANDALONE-ENGINE.md`](rust-engine/STANDALONE-ENGINE.md).

## Download

Every Orgtree release, from 4.5.11 on, includes the official standalone engine,
built by the release CI from the same commit as the desktop release. On the
release's GitHub page (https://github.com/Maurdekye/orgtree/releases):

| Asset | What it is |
| --- | --- |
| `orgtree-engine-standalone-<version>-linux-x86_64.tar.gz` | The engine binary for Linux x86_64 (glibc 2.35+: Ubuntu 22.04+, Debian 12+), with a README and the licence. Bring your own PostgreSQL 16+. |
| `orgtree-engine-standalone-<version>-docker-amd64.tar.gz` | The Docker image (linux/amd64, PostgreSQL 17 included), for `docker load`. |
| `build-info-standalone.json` | Version, commit, the files' SHA-256 and the image's config digest. |
| `orgtree-engine-standalone-<version>-agents-docker-amd64.tar.gz` | The [agents image](#the-agents-image): the same engine with Claude Code, Codex, Node.js, ssh, python3 and the Docker CLI. |
| `build-info-standalone-agents.json` | The agents image's versions (engine, Claude Code, Codex), hashes and config digest. |
| `SHA256SUMS.txt` | The SHA-256 of every asset of the release. |

```sh
v=4.5.11   # the release you want
curl -LO https://github.com/Maurdekye/orgtree/releases/download/v$v/orgtree-engine-standalone-$v-linux-x86_64.tar.gz
curl -LO https://github.com/Maurdekye/orgtree/releases/download/v$v/SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt
tar -xzf orgtree-engine-standalone-$v-linux-x86_64.tar.gz
```

The engine is `orgtree-engine-standalone-<version>-linux-x86_64/orgtree-engine`.

The same build is also a Docker image, from GitHub's container registry (`latest`
is the newest stable release; alphas and betas have only their version tag) or
from the release's image file:

```sh
docker pull ghcr.io/maurdekye/orgtree-engine:4.5.11
# or, offline: the release's image file (check it against SHA256SUMS.txt first)
docker load -i orgtree-engine-standalone-4.5.11-docker-amd64.tar.gz
```

Both give the image `ghcr.io/maurdekye/orgtree-engine:<version>`. Its config
digest, the same on GHCR and in the file, is `image.config_digest` in
`build-info-standalone.json`; check GHCR's with
`docker buildx imagetools inspect --raw ghcr.io/maurdekye/orgtree-engine:<version>`
(`.config.digest`). Docker's image ID may instead be the manifest digest, which
differs between the two. To run it, see
[Run in Docker](#run-in-docker).

Each release's CI starts the binary on a fresh data root with Ubuntu 24.04's
PostgreSQL 16, and the image on a fresh volume, and checks the ready line, 403
without the token, 200 with it, the version and a clean SIGTERM exit. Building
from source (below) remains possible.

## Start directly

Install the engine binary (from the release, or built from source) and
PostgreSQL on the server. Run it as an ordinary
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

With the official image:

```sh
docker run -d --name orgtree-engine -p 127.0.0.1:7430:7430 \
  -v orgtree-data:/data ghcr.io/maurdekye/orgtree-engine:latest
docker logs orgtree-engine   # the first start prints the token once
```

Or with compose: in `standalone/docker-compose.yml`, replace the `build:` block
with `image: ghcr.io/maurdekye/orgtree-engine:<version>`.

To build the image yourself from a source checkout:

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
Provider CLIs are not in the plain image: use [the agents image](#the-agents-image),
or install them in a derived image and make their executables available in the
engine's PATH. A CLI installed or signed in on the
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

## The agents image

`ghcr.io/maurdekye/orgtree-engine:<version>-agents` (and `latest-agents`, the
newest stable release) is the same image with what agents need to run inside it
(USER 2026-11-11, "Variant with agents"):

| In the image | Notes |
| --- | --- |
| The same engine binary and PostgreSQL 17 | built on the release's plain image |
| Codex CLI (`codex`) | pinned per release; root-owned, so it cannot update itself |
| Claude Code (`claude`) | pinned per release, installed on the first start (below); auto-update off (`DISABLE_AUTOUPDATER=1`) |
| Node.js 22 and npm | for the CLIs' npm packages |
| OpenSSH client, git | `git clone git@github.com:...` works: GitHub's host keys are preinstalled, other hosts are accepted on first use (`StrictHostKeyChecking accept-new`) and a changed key is refused |
| python3, curl, the Docker CLI | for a Docker daemon, mount its socket (below) |

The versions of each release are its image labels (`dev.orgtree.claude-code.version`,
`dev.orgtree.codex.version`) and `tools` in the release's
`build-info-standalone-agents.json`.

**Claude Code is installed on the first start.** Claude Code's licence reserves
all rights, so the published image does not carry it. It carries a lockfile
pinning the release's version and every package's SHA-512, and the first start
installs exactly that from npm into `/data/agent-tools/claude-code` on the data
volume (it needs internet access once, about 30 seconds). Later starts, and new
containers on the same volume, reuse it. If the install fails, the log says so,
the engine starts without Claude Code (Codex and API-key accounts still work)
and the next start tries again. A new image version installs its own pinned
version on its first start.

**HOME is `/data/home`**, on the data volume, so the default `~/.claude`,
`~/.codex`, `~/.ssh` and `~/.gitconfig` survive a new container. Put SSH keys in
`/data/home/.ssh` (mode 0600, owned by the `orgtree` user, uid 1000 in the image).

```sh
docker run -d --name orgtree-engine -p 127.0.0.1:7430:7430 \
  -v orgtree-data:/data ghcr.io/maurdekye/orgtree-engine:latest-agents
docker logs -f orgtree-engine   # Claude Code's install, then the token once
docker exec -it orgtree-engine claude --version
```

To let agents use the host's Docker, also mount its socket
(`-v /var/run/docker.sock:/var/run/docker.sock`) and give the `orgtree` user the
socket's group (`--group-add $(stat -c %g /var/run/docker.sock)`). That grants
root-equivalent control of the host: do it only for agents you trust with that.

Sign in to the CLIs as in [Sign in to provider CLIs over SSH](#sign-in-to-provider-clis-over-ssh),
with `docker exec -it orgtree-engine` in front of each command. The healthcheck
(`orgtree-healthcheck`) asks the engine's `/api/desktop/alive` with its token and
needs no Node.js.

To build it yourself on a plain image:

```sh
docker build -f standalone/agents/Dockerfile \
  --build-arg BASE=ghcr.io/maurdekye/orgtree-engine:<version> \
  [--build-arg CLAUDE_CODE_VERSION=<v>] [--build-arg CODEX_VERSION=<v>] standalone/agents
```

`--build-arg CLAUDE_CODE_INSTALL=image` puts Claude Code in the image instead of
installing it on the first start. Anthropic allows preinstalling Claude Code only
under its Commercial Terms of Service and the conditions on
https://code.claude.com/docs/en/legal-and-compliance ("Can customers offer Claude
Code in their products?"): use it only for an image you are entitled to build
that way, and do not publish it.

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
| `POST /api/standalone/clients` with `{"name":"My client"}` (optional `"scope"`, and `"org"` for a viewer) | New `id`, `name`, `created_at`, `scope` and a `token` shown once. Save the token now. |
| `GET /api/standalone/clients` | Active clients' `id`, `name`, `created_at`, `scope` and, for a viewer, `org`; no secrets or hashes. |
| `DELETE /api/standalone/clients/<id>` | Revokes that client and immediately disconnects its HTTP, WebSocket and MCP connections. |

The orgless MCP endpoint offers the same operations through
`orgtree_client_tokens`, with `action: "list"` (default), `"create"` plus `name`,
or `"revoke"` plus `id`. A full client (the default) has user authority, including token
administration; a viewer client is read-only for one org (next section). The bootstrap key cannot be revoked through these operations.

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

### Give an app or script read-only access to one org (viewer tokens)

A token created with `"scope":"viewer"` and `"org":"<slug>"` (the org must exist)
can only look at that org. A leaked viewer token cannot manage tokens, send mail,
change agents, read agent chats or files, or reach any other org.

```
curl -H "Authorization: Bearer $BOOTSTRAP" -H "Content-Type: application/json" \
  -d '{"name":"Desk viewer","scope":"viewer","org":"galaxy"}' http://100.x.y.z:PORT/api/standalone/clients
```

`GET /api/standalone/clients` then shows each client's `scope` (`full` or `viewer`)
and, for a viewer, its `org`. The same fields work in the `orgtree_client_tokens`
MCP tool. Create one viewer token per org; revoking it disconnects its sockets at once.

A viewer may read, for its own org only: the org row, records, selection and changes, the
foreground tree, node detail and states, the live socket, the user's mail (inbox and one mail
in the `user` mailbox), presentations (list, one, mockup, download) and the docket (list,
one item, views, pages, references). It may write exactly two things: mark the user's mail
read (`POST /api/orgs/<slug>/inbox/read`) and mark presentations viewed
(`POST /api/orgs/<slug>/documents/viewed`). Everything else answers 403
`{"detail":"this client token is read-only"}`.

Its live socket (`/api/orgs/<slug>/ws`) is listen-only: it receives the same frames a window
gets without watching agent transcripts, may `ping`, and may `subscribe`/`unsubscribe`,
but agent mail and history windows are dropped from a subscribe, and `watch`, `attract` and any
other message are ignored. After 20 ignored messages the engine closes the socket (code 1008).
If a viewer's org is deleted, every request answers 403 until the token is revoked.
Version 1 token files still load (every token is `full`) and are rewritten as version 2.

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
