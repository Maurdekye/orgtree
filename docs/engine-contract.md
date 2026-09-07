# Desktop and Python engine contract

The Python process retains the real orgtree.api domain and serves the copied existing UI. Relative HTTP, WebSocket, download, image and HTML URLs remain browser transport. IPC is only for native lifecycle/settings/setup operations.

## Managed startup

- Launch engine/launch.py with an absolute, real Python interpreter (packaged engine/runtime/python.exe). The engine package contains its own backend/orgtree source; v1 repository is never a runtime dependency.
- Main validates an explicit v2 data root, including existing symlink resolution, before spawning. It rejects the v1 root and ancestor/descendant overlap. Fresh startup uses a separate application data directory; import is a later Settings action owned by the engine.
- Env: ORGTREE_DATA is the resolved v2 root, ORGTREE_V2_UI_DIR the built renderer directory, ORGTREE_V2_TOKEN a fresh main-only credential. Engine must validate root BEFORE importing legacy storage and REMOVE the token from os.environ before importing modules that spawn children.
- Engine binds 127.0.0.1 on a dynamic first port, persists it in engine-port.json under the explicit v2 root, and reuses that port on later fresh launches. A collision refuses startup instead of changing the browser storage origin or attaching to another process. This preserves the existing localStorage namespace for drafts and layout; two-launch application verification remains required. Ready line: {"type":"ready","protocol":1,"port":12345,"pid":123,"dataRootId":"resolved absolute data root"}. Main checks PID, root, port and protocol. Other stdout lines are ignored with a bounded line buffer; logs must never carry credentials.
- Electron main remains alive in tray after normal close. The single-instance lock routes another launch to the existing window; there is no unauthenticated .port discovery or orphan-engine attachment.

## Browser and native boundaries

- Main registers the owning app window and blank portal children. Its session hook authenticates exact loopback HTTP/WS only for the owning top frame, initial app navigation, and portal stylesheet/font/image requests; embedded frames are never signed. Headers are stripped before every other destination. Actual Electron probes cover trusted HTTP/CSS/WS plus foreign-frame and srcdoc negative controls.
- Every engine browser route validates credentials, including files and WS. Missing Origin is NOT proof of authorization. MCP requires existing or newly scoped per-agent credentials bound to org/node/generation. Desktop operator credential never enters provider/MCP child environment.
- Preload exposes window.orgtreeDesktop only on the top-level engine UI. Native handlers also verify sender webContents, top frame and UI route. Blank portal children and embedded HTML have no bridge; preload compares the full expected origin including port. HTML presentation windows use separate sessions with one initial exact-wrapper-URL GET capability. All child engine requests are blocked; internet resources are permitted without desktop credentials. Captured actual _mockup_wrapper output is exercised, but real production API wrapper execution remains an integration check.
- Native blank child windows preserve the existing owner-mounted DOM portal. No new React App or engine session is mounted in the child. Actual Electron primitive test preserves the same input node and draft; full renderer integration remains separate evidence.

## Lifecycle and packaging

- Preferences: Start at login ON, Exit on close OFF. Dev builds never register electron.exe at login. Main close preserves all popouts. Exit-on-close applies only when the last visible view closes. Explicit quit first dispatches orgtree:before-exit for synchronous layout saving, then requests authenticated POST /api/desktop/shutdown. Launcher job-object/descendant cleanup remains engine-owned and must be verified before release; the shell fallback alone kills only its direct child.
- GET /api/desktop/status returns {activeAgents,totalAgents,idle}. Unknown/stale/unavailable state is never interpreted as idle. Idle update application also requires 60 seconds of OS user inactivity, then graceful engine stop. Packaged GitHub prerelease updater is enabled; actual signed update execution is not claimed by fixture tests.
- Installer defaults current user, permits all-users choice; unsigned prototype accepted. Runtime must preserve a real interpreter directory so sys.executable -m orgtree.mcptool works.
- Harness setup detects presence only and links official Claude Code, Codex and Antigravity setup. No CLI installation, login, provider calls or multi-account registry.

## Source replies

ReplyContext identifies source by org/agent/generation/eventId and bounded quote. Engine resolves authoritative source/role and validates identity; quote is never authorization. Renderer owns context menu/removable preview/source jump. Preserve replyTo in drafts, reload/popout transfer, outgoing mail and durable receipt.

## Scope and deadline

Deadline is 2026-09-08 01:00 UTC (04:00 Israel), not restarted by approval or seed. Preserve/improve existing UI, SQLite data contracts, integrated Docker-free hub, multi-provider support, history until removed, full copy import including active-work resumption. Deferred/removed: all account management/fallback, mobile, Git management, public/kiosk exposure and all agent-execution sandbox/isolation. Electron renderer isolation remains an OS-bridge boundary, not agent execution isolation.

Native notifications default to questions, urgent mail and ticket attention. Routine mail/completion is configurable (routineNotifications=false). No system sleep blocker is installed. Uninstall keeps user data. Login startup is quiet tray. The official Python3.13.15 embedded archive is checksum-pinned by tools/provision-runtime.py; its app-local dependency manifest records versions and hashes. Python-served UI is packaged as resources/ui, outside app.asar.
