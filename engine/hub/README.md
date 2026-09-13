# Integrated v2 mail hub

`HubService` is the engine lifecycle boundary:

```python
from engine.hub import HubService, discover_hub

hub = HubService(explicit_v2_data_root)
ready = hub.start()             # binds 127.0.0.1 on a dynamic port
endpoint = discover_hub(explicit_v2_data_root)
try:
    run_engine_workers(endpoint)
finally:
    hub.stop()                  # removes readiness.json after shutdown
```

The service owns `<v2-data-root>/hub/hub.sqlite3`, `blobs/`, and an atomic
`readiness.json`. It has no UI, fixed port, Docker dependency, or access to
the v1 data root.
Pass `host="0.0.0.0", advertise_host="<peer-address>"` only when an
TLS settings required by the surrounding network, and provide
`tls_certfile` plus `tls_keyfile`; non-loopback binds are rejected without
both. The default stays loopback. `tls_ca_file` is an optional private CA
bundle path exposed in readiness for clients. `HubClient` accepts `ca_file`
or a prepared `ssl_context`; CA chain verification remains enabled, with
hostname matching relaxed only for exact loopback owner URLs. Public
deployments therefore require manually provisioned trusted certificates.
`HubClient` keeps a SQLite-backed offline spool in
the caller's v2 root. Construct it as `HubClient(root, url, slug)`;
it validates regular attachment paths, downloads inbound
attachments below the caller's v2 root, persists messages before ACK, and
retries idempotent message IDs.

The wire contract retains v1 correspondence behavior: `register`, `roster`,
`unregister`, `send`, long/short `poll`, custody `ack`, `receipts`, and
owner/recipient attachment upload/download. Recipients must be registered on
the configured hub; ordinary correspondence is not restricted to a local
organization. Joining is address-only: the caller supplies one or more routing
addresses in `X-Org-Address`, and the surrounding network is the security
boundary.
