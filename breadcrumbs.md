# v2-hub breadcrumbs

- 2026-09-07: Seed commit `81f5237` is present in the v2 repo; the scratch parent was not a git checkout, so a private no-hardlink clone was created at `repo/` from `E:/Libraries/Desktop/orgtree`.
- 2026-09-07: v1 reference is `E:/Libraries/Desktop/claude-orgtree/hub/mailhub` plus `backend/orgtree/net.py`; preserve durable queue, idempotent send, ACK custody, receipts, and attachment ownership/path validation. Exclude v1 UI/public listener.
- 2026-09-07: Implemented `engine/hub/service.py` and `client.py`: loopback dynamic-port lifecycle, atomic readiness discovery, SQLite queue/dedup/ACK/receipts, file-backed attachments, and client offline spool. Added isolated two-client lifecycle/retry/dedup/invalid-path tests; Python and npm tests pass. `npm` PowerShell shim itself was policy-blocked, while `npm.cmd test` passed.
- 2026-09-07: No remote/cross-machine transport was invented: configured hubs may address registered peers, but this integrated service binds only loopback; local readiness is not a connectivity claim.
- 2026-09-07: Review found recipient attachment metadata needed local delivery. `HubClient.poll_once` now downloads authorized blobs into `<client-v2-root>/mail-blobs/inbox/<message-id>/`, records a safe local path (or explicit error), persists that envelope, then ACKs; test verifies bytes.
