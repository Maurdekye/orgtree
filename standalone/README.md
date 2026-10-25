# Standalone Orgtree engine packaging

Run the Orgtree engine with no desktop UI, directly or in Docker, and manage
it over its authenticated HTTP/WebSocket API. The design, the configuration
variables and the implemented user MCP endpoint are in
[`docs/rust-engine/STANDALONE-ENGINE.md`](../docs/rust-engine/STANDALONE-ENGINE.md).
For operator setup, persistence and provider login over SSH, read the
[standalone user guide](../docs/standalone-engine.md).

Direct:

```sh
ORGTREE_DATA=/srv/orgtree/data orgtree-engine standalone
```

Provide PostgreSQL 16 or later, using `ORGTREE_P03_PG_BIN` when its binaries
are not bundled beside the engine. On WSL, use a Linux-filesystem data root
if the Windows-mounted drive lacks Unix metadata; PostgreSQL needs restrictive
Unix ownership and permissions. Direct Ubuntu 24.04 WSL execution with
PostgreSQL 16.2 has passed synthetic startup, HTTP/WebSocket/MCP, persistence
and clean-shutdown checks. Real provider login remains unverified.

Docker (from the repository root):

```sh
docker build -f standalone/Dockerfile -t orgtree-engine-standalone .
# or
cd standalone && ORGTREE_STANDALONE_TOKEN=<32+ chars> docker compose up -d
```

First run with no token configured generates one into
`<data>/standalone-token` and prints it to stderr (the container log) once.

The build embeds the glossary, charters, organization templates and the
Changelog's release list and notes; its Dockerfile-specific context allowlist
includes those source inputs and excludes
generated targets and dependencies. Cargo uses the checked-in lockfile. Provider
CLIs are installed separately in a derived image; host installations and logins
are not automatically available inside the container. Keep account profiles in
the persistent `/data` volume.

The Dockerfile uses BuildKit cache mounts. For a memory-constrained build, its
`CARGO_PROFILE_RELEASE_OPT_LEVEL`, `CARGO_PROFILE_RELEASE_LTO` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS` arguments can override the normal release
defaults (3, thin and 16). This affects compiler optimization, not authentication
or persistence. For example, pass `--build-arg CARGO_PROFILE_RELEASE_OPT_LEVEL=1
--build-arg CARGO_PROFILE_RELEASE_LTO=false
--build-arg CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256` to `docker build`.
