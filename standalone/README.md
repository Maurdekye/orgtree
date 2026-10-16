# Standalone Orgtree engine packaging

Run the Orgtree engine with no desktop UI, directly or in Docker, and manage
it over its authenticated HTTP/WebSocket API. The design, the configuration
variables and what is still deferred (the user MCP endpoint, headless
provider sign-in) are in
[`docs/rust-engine/STANDALONE-ENGINE.md`](../docs/rust-engine/STANDALONE-ENGINE.md).

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
