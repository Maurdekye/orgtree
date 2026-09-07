# Desktop / Python transport v1

The Python engine retains existing `/api` domain semantics behind a facade. This seed does not replace those routes with a new domain protocol.

- Main launches `engine/launch.py` with a dedicated Python executable; packaged runtime belongs under `engine/runtime`. Development executable must be explicitly configured.
- Main sets `ORGTREE_DATA` to the isolated v2 root and `ORGTREE_V2_TOKEN` to a fresh random credential. Engine must verify the root before importing any v1 storage module. Never default to the v1 root.
- Engine binds IPv4 loopback on an available port and writes one stdout line: `{ "type":"ready", "protocol":1, "port":12345, "pid":123, "dataRootId":"opaque-id" }`. Logs otherwise use stderr; stdout is bounded protocol data.
- Requests carry `X-Orgtree-Desktop-Token`. Every route validates it before dispatch, including `/api/host`, files and event streams. No public listener. Main brokers HTTP; renderer sees no credential or port.
- `/api/*` return current domain status/data. Main accepts only validated method/path/body, disallows proxy traversal/arbitrary URLs and returns `{status,data}`. A 2xx send result remains acceptance, not provider acknowledgement.
- Main owns one engine process per application data root, survives ordinary window closes, and terminates its owned process tree on explicit exit. `Exit on close` defaults OFF.
- Domain and adapter owners must coordinate any readiness/transport change with the shell owner before editing this contract. No fake success when an engine/harness is missing.
- Multi-provider support remains. All multi-account management/fallback is deferred. Harness setup detects only and links official installation pages; never installs a CLI.

Initial shell event subscription is lifecycle-only. Domain event stream integration will be agreed with the engine owner using existing event identities; do not invent delivery acknowledgements in renderer code.

## Transport refinement under review
Preserve v1 browser fetch/WebSocket/artifact URLs. Shell will inject the credential using Electron session webRequest for the exact engine origin, instead of requiring every existing UI request to cross bespoke IPC. Native operations still use validated IPC. Auth compatibility for existing agent/MCP callers requires coordinator approval; do not silently treat missing Origin headers as authorization. The launcher must remove ORGTREE_V2_TOKEN from os.environ BEFORE importing legacy code because provider children inherit the environment. Main uses a single-instance lock and owns engine process lifetime.

## Chat source reply contract
ReplyContext identifies source by org/agent/generation/eventId with bounded quote. Engine validates identity and source permissions, resolves authoritative text/role, persists source reference with the outgoing mail and returns the durable receipt. A display quote is not source identity or authorization. Unresolvable sources must fail explicitly; do not attach another message. Renderer owner adds removable preview/context menu. Preserve the structured field in drafts/window transfer.
