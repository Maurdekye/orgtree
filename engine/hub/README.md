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
`readiness.json`. It has no UI, fixed public listener, Docker dependency, or
access to the v1 data root. `HubClient` keeps a SQLite-backed offline spool in
the caller's v2 root, validates regular attachment paths, persists inbound
messages before ACK, and retries idempotent message IDs.

The wire contract retains v1 correspondence behavior: `register`, `send`,
long/short `poll`, custody `ack`, `receipts`, and owner/recipient-authorized
attachment upload/download. Recipients must be registered on the configured
hub; ordinary correspondence is not restricted to a local organization.
Loopback binding is local reachability only and does not claim cross-machine
transport.
