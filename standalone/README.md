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

Docker (from the repository root):

```sh
docker build -f standalone/Dockerfile -t orgtree-engine-standalone .
# or
cd standalone && ORGTREE_STANDALONE_TOKEN=<32+ chars> docker compose up -d
```

First run with no token configured generates one into
`<data>/standalone-token` and prints it to stderr (the container log) once.

The build embeds the glossary, charters and organization templates; its
Dockerfile-specific context allowlist includes those source inputs and excludes
generated targets and dependencies. Cargo uses the checked-in lockfile. Provider
CLIs are installed separately in a derived image; host installations and logins
are not automatically available inside the container. Keep account profiles in
the persistent `/data` volume.
