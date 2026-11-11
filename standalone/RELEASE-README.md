# Orgtree engine @VERSION@, standalone (headless), Linux x86_64

This is the official standalone build of the Orgtree engine @VERSION@: the same
engine as the Orgtree @VERSION@ desktop release, built from the same commit, to run
on a server with no desktop. Manage it over its authenticated HTTP/WebSocket API
and its user MCP endpoint.

Full guide: https://github.com/Maurdekye/orgtree/blob/v@VERSION@/docs/standalone-engine.md

## Requirements

- Linux x86_64 with glibc 2.35 or later (Ubuntu 22.04+, Debian 12+).
- PostgreSQL 16 or later, installed on the same machine. The engine runs its own
  cluster in the data directory with those binaries; it does not use a running
  PostgreSQL server. On Ubuntu/Debian: `sudo apt install postgresql` (16 on Ubuntu
  24.04, 17 on Debian 13), or PostgreSQL's own apt repository on older releases.
- Run it as an ordinary user, not root: PostgreSQL refuses to run as root.

## Start

```sh
tar -xzf orgtree-engine-standalone-@VERSION@-linux-x86_64.tar.gz
cd orgtree-engine-standalone-@VERSION@-linux-x86_64
ORGTREE_DATA=/srv/orgtree/data \
ORGTREE_P03_PG_BIN=/usr/lib/postgresql/16/bin \
./orgtree-engine standalone
```

The first start creates the database and a token, saved in
`<data>/standalone-token` (mode 0600) and printed to stderr once. Send it as
`Authorization: Bearer <token>` on every request; without it the engine answers
403. The engine prints a JSON ready line with its port on stdout:

```sh
curl -H "Authorization: Bearer $(cat /srv/orgtree/data/standalone-token)" \
  http://127.0.0.1:<port>/api/desktop/alive
```

SIGTERM, SIGINT or SIGHUP stop it cleanly, PostgreSQL included.

## Settings

| Variable | Meaning |
|---|---|
| `ORGTREE_DATA` | Absolute, writable data directory (required). Keep all of it: database, token, profiles. |
| `ORGTREE_P03_PG_BIN` | PostgreSQL 16+ binary directory, e.g. `/usr/lib/postgresql/16/bin`. |
| `ORGTREE_STANDALONE_TOKEN` | Optional fixed token: at least 32 visible ASCII characters, no whitespace. |
| `ORGTREE_BIND` | Listen address, default `127.0.0.1`. Prefer SSH forwarding or Tailscale to a public address; there is no built-in TLS. |
| `ORGTREE_PORT` | Fixed port; unset, the engine picks one and prints it in the ready line. |

Provider CLIs (Claude Code, Codex, ...) are not included: install and sign in to
the ones you need as the same user. The guide above covers sign-in over SSH.

## Check the download

`SHA256SUMS.txt` on the GitHub release lists this archive's SHA-256:

```sh
sha256sum -c --ignore-missing SHA256SUMS.txt
```

## Licence

Orgtree is MIT licensed (see `LICENSE`); third-party notices are in
`THIRD_PARTY_NOTICES.md`.
