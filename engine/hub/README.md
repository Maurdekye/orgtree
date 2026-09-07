# Integrated v2 mail hub

`HubService` is the engine lifecycle boundary:

```python
from engine.hub import HubService, discover_hub

hub = HubService(explicit_v2_data_root)
ready = hub.start()             # binds 127.0.0.1 on a dynamic port; token-authenticated
endpoint = discover_hub(explicit_v2_data_root)
try:
    run_engine_workers(endpoint)
finally:
    hub.stop()                  # removes readiness.json after shutdown
```

The service owns `<v2-data-root>/hub/hub.sqlite3`, `blobs/`, and an atomic,
owner-readable `readiness.json` containing a per-instance token. It has no UI,
fixed public listener, Docker dependency, or access to the v1 data root.
Pass `host="0.0.0.0", advertise_host="<peer-address>"` only when an
authenticated peer connection is intentionally configured; the default stays
loopback. `HubClient` keeps a SQLite-backed offline spool in
the caller's v2 root. Construct it as `HubClient(root, url, slug, secret,
token)` for local access or with `peer_token=True` for a paired remote peer;
it validates regular attachment paths, downloads inbound
attachments below the caller's v2 root, persists messages before ACK, and
retries idempotent message IDs.

The wire contract retains v1 correspondence behavior: `register`, `roster`,
`unregister`, `send`, long/short `poll`, custody `ack`, `receipts`, and
owner/recipient-authorized attachment upload/download. Recipients must be
registered on the configured hub; ordinary correspondence is not restricted to
a local organization. Every route requires the local instance token or a
revocable identity-bound peer token, plus the caller's org credentials.
The local token alone may `POST /api/peers` with `{peer_id,slug}` to mint a
one-time-returned peer token and `DELETE /api/peers/{peer_id}` to revoke it.
