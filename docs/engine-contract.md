# Desktop and Python engine contract

The Python process retains the real orgtree.api domain and serves the copied existing UI. Relative HTTP, WebSocket, download, image and HTML URLs remain browser transport. IPC is only for native lifecycle/settings/setup operations.

## Managed startup

- Launch engine/launch.py with an absolute, real Python interpreter (packaged engine/runtime/python.exe). The engine package contains its own backend/orgtree source; v1 repository is never a runtime dependency.
- Main validates an explicit v2 data root, including existing symlink resolution, before spawning. It rejects the v1 root and ancestor/descendant overlap. Fresh startup uses a separate application data directory; import is a later Settings action owned by the engine.
- Env: ORGTREE_DATA is the resolved v2 root, ORGTREE_V2_UI_DIR the built renderer directory, ORGTREE_V2_TOKEN a fresh main-only credential. Engine must validate root BEFORE importing legacy storage and REMOVE the token from os.environ before importing modules that spawn children.
- Engine binds 127.0.0.1 on a dynamic port. Ready line: {"type":"ready","protocol":1,"port":12345,"pid":123,"dataRootId":"resolved absolute data root"}. Main checks PID, root, port and protocol. Other stdout lines are ignored with a bounded line buffer; logs must never carry credentials.
- Electron main remains alive in tray after normal close. The single-instance lock routes another launch to the existing window; there is no unauthenticated .port discovery or orphan-engine attachment.

## Browser and native boundaries

- Main session hook injects X-Orgtree-Desktop-Token only for exact loopback host+port over HTTP/WS, and strips any retained token before every other destination. Actual Electron probe verifies HTTP, stylesheet, WebSocket handshake and cross-origin redirect/fetch.
- Every engine browser route validates credentials, including files and WS. Missing Origin is NOT proof of authorization. MCP requires existing or newly scoped per-agent credentials bound to org/node/generation. Desktop operator credential never enters provider/MCP child environment.
- Preload exposes window.orgtreeDesktop only on the top-level engine UI. Native handlers also verify sender webContents, top frame and UI route. Blank portal children and embedded HTML have no bridge. External HTML resources are allowed by the renderer document sandbox; they do not receive desktop credentials or OS access.
- Native blank child windows preserve the existing owner-mounted DOM portal. No new React App or engine session is mounted in the child. Actual Electron primitive test preserves the same input node and draft; full renderer integration remains separate evidence.

## Lifecycle and packaging

- Preferences: Start at login ON, Exit on close OFF. Dev builds never register electron.exe at login. Explicit quit asks authenticated POST /api/desktop/shutdown then applies a bounded fallback to its OWN child only.
- GET /api/desktop/status returns {activeAgents,totalAgents,idle}. Unknown/stale/unavailable state is never interpreted as idle. Idle update application also requires 60 seconds of OS user inactivity, then graceful engine stop. Packaged GitHub prerelease updater is enabled; actual signed update execution is not claimed by fixture tests.
- Installer defaults current user, permits all-users choice; unsigned prototype accepted. Runtime must preserve a real interpreter directory so sys.executable -m orgtree.mcptool works.
- Harness setup detects presence only and links official Claude Code, Codex and Antigravity setup. No CLI installation, login, provider calls or multi-account registry.

## Source replies

ReplyContext identifies source by org/agent/generation/eventId and bounded quote. Engine resolves authoritative source/role and validates identity; quote is never authorization. Renderer owns context menu/removable preview/source jump. Preserve replyTo in drafts, reload/popout transfer, outgoing mail and durable receipt.

## Scope and deadline

Deadline is 2026-09-08 01:00 UTC (04:00 Israel), not restarted by approval or seed. Preserve/improve existing UI, SQLite data contracts, integrated Docker-free hub, multi-provider support, history until removed, full copy import including active-work resumption. Deferred/removed: all account management/fallback, mobile, Git management, public/kiosk exposure and all agent-execution sandbox/isolation. Electron renderer isolation remains an OS-bridge boundary, not agent execution isolation.
