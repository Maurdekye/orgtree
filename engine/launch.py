"""Launch the existing Orgtree API as the isolated V2 engine process.

The launcher is intentionally small: V1 remains the domain authority while
this process owns the V2 data-root and desktop transport boundary.  The
V2 credential is captured and removed before importing legacy modules so it
cannot leak into provider children.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
from pathlib import Path
import random
import socket
import sys
from typing import Any, Awaitable, Callable

# Running ``python engine/launch.py`` puts only ``engine/`` on sys.path. The
# desktop launcher uses that script form, so make the bundled package root
# importable before the copied backend or hub is loaded.
_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_HUB_RUNTIME: Any = None
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))


def _required_path(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required; refusing an implicit V1 root")
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"{name} is not a directory: {path}")
    return path


def validate_data_root(root: Path) -> Path:
    """Validate the dedicated V2 root before any V1 import occurs."""
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise RuntimeError(f"ORGTREE_DATA is not a directory: {root}")
    forbidden = [Path.home() / "orgtree"]
    for key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT"):
        if os.environ.get(key, "").strip():
            forbidden.append(Path(os.environ[key]))
    for path in forbidden:
        path = path.expanduser().resolve()
        if root == path or path in root.parents or root in path.parents:
            raise RuntimeError("ORGTREE_DATA overlaps a V1 root")
    return root


def data_root_id(root: Path) -> str:
    # The shell compares this to its own realpath, so an opaque digest would
    # hide a mismatched root instead of proving the handshake identity.
    return str(root.resolve())


# Windows reserves shifting blocks of its dynamic range (49152 and up) for
# Hyper-V/WinNAT on every boot. A first port drawn from that range can turn
# unbindable after a reboot even though nothing listens on it. This is the
# PREFERRED range, not a guarantee: `_fresh_port` falls back to an
# OS-assigned port when it cannot find a free one here.
_FRESH_PORT_RANGE = (20000, 49151)
_IN_USE = {errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", errno.EADDRINUSE)}
# Windows answers a bind inside a reserved range with WSAEACCES (winerror
# 10013, which Python surfaces as errno 13). Measured on this machine: every
# kind of real occupancy — plain listener, SO_REUSEADDR, SO_EXCLUSIVEADDRUSE,
# bound-but-not-listening — reports EADDRINUSE instead, so access-denied says
# "a reservation, not a listener". It does NOT say the port is unusable
# forever — reservations shift on the next boot too — only that this process
# cannot serve the UI there now. Moving the origin does not DELETE what the
# browser stored under the old one — browser storage is per origin, so that
# data simply stops being reachable from the new one — but the user sees the
# same thing either way, so the move is made only for this case.
_RESERVED = {errno.EACCES, getattr(errno, "WSAEACCES", errno.EACCES)}


def _bind_error(port: int) -> OSError | None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as exc:
            return exc
    return None


def _fresh_port() -> int:
    low, high = _FRESH_PORT_RANGE
    for _ in range(64):
        candidate = random.randint(low, high)
        if _bind_error(candidate) is None:
            return candidate
    # 64 draws found nothing free in the preferred range, so take whatever the
    # OS hands out rather than refusing to start. That port comes FROM the
    # dynamic range this function is trying to avoid, and can be reserved out
    # from under the next boot — the recovery path in `_port` is what catches
    # that. Say "preferred range with a fallback", never "always below 49152".
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _persist_port(config: Path, port: int) -> None:
    temporary = config.with_suffix(".tmp")
    temporary.write_text(json.dumps({"port": port}) + chr(10), encoding="utf-8")
    os.replace(temporary, config)


def _port(data: Path) -> int:
    raw = os.environ.get("ORGTREE_V2_PORT", "0").strip()
    try:
        requested = int(raw or "0")
    except ValueError as exc:
        raise RuntimeError(f"ORGTREE_V2_PORT is not an integer: {raw}") from exc
    config = data / "engine-port.json"
    if requested:
        if not 1 <= requested <= 65535:
            raise RuntimeError("ORGTREE_V2_PORT must be between 1 and 65535")
        error = _bind_error(requested)
        if error is not None:
            raise RuntimeError(f"engine port {requested} is occupied") from error
        return requested
    if config.exists():
        try:
            saved = json.loads(config.read_text(encoding="utf-8"))
            port = int(saved.get("port"))
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            raise RuntimeError(f"invalid persisted engine port: {config}") from exc
        if not 1 <= port <= 65535:
            raise RuntimeError(f"invalid persisted engine port: {port}")
        error = _bind_error(port)
        if error is None:
            return port
        # A stored port belongs to this fresh engine only; a live listener is
        # refused instead of silently changing the UI origin or attaching to
        # it. An access-denied failure (Windows WSAEACCES on a reserved range)
        # says the port is UNAVAILABLE NOW to this process for a reason no
        # amount of waiting fixes — not that it is unusable forever — so the
        # origin moves rather than leaving the app unable to start.
        if error.errno in _IN_USE:
            raise RuntimeError(f"engine port {port} is occupied") from error
        if error.errno not in _RESERVED:
            raise RuntimeError(f"engine port {port} cannot be bound (errno {error.errno})") from error
        print(f"persisted engine port {port} is no longer bindable ({error.errno}); choosing a fresh port",
              file=sys.stderr, flush=True)
    port = _fresh_port()
    _persist_port(config, port)
    return port


class TokenGate:
    """ASGI middleware requiring the desktop token on every request."""

    def __init__(self, app: Callable[..., Awaitable[Any]], token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        supplied = headers.get(b"x-orgtree-desktop-token", b"").decode("utf-8")
        if supplied != self.token and scope.get("type") == "http" and scope.get("path") == "/api/agent" and scope.get("method") == "POST":
            from orgtree import agentauth
            identity = agentauth.verify(headers.get(b"x-orgtree-agent-token", b"").decode("utf-8"))
            if identity is not None:
                scope.setdefault("state", {})["agent_identity"] = identity
                await self.app(scope, receive, send)
                return
        if supplied != self.token:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4401})
                return
            body = b'{"detail":"invalid desktop token"}'
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def _install_desktop_routes(api_app: Any, data: Path, stop: Callable[[], None]) -> None:
    from orgtree import desktop_recovery
    from orgtree.ledger import LedgerError
    from fastapi import HTTPException

    @api_app.get('/api/desktop/import-v1/{slug}/recovery')
    def import_recovery(slug: str):
        return desktop_recovery.status(slug)

    @api_app.post('/api/desktop/import-v1/{slug}/resolve')
    def resolve_import(slug: str, body: dict[str, Any]):
        try:
            return desktop_recovery.resolve_import(slug,body.get('nodes'),body.get('action'),
                body.get('acknowledge_duplicate_work') is True,body.get('note',''))
        except LedgerError as exc:
            raise HTTPException(422,str(exc)) from exc

    """Add the small native-shell control surface to the real V1 app."""
    from orgtree import store, supervisor, desktop_maintenance, desktop_import_jobs  # noqa: PLC0415

    @api_app.get("/api/desktop/status")
    def desktop_status() -> dict[str, Any]:
        # totalAgents means CURRENTLY HIRED agents (user spec 2026-09-10):
        # the tray tooltip and the per-org rows both say n/m active/hired,
        # so this sums the same `live` count the org listing reports —
        # counting every node ever hired (archived seats included) made the
        # tray disagree with every other surface.
        total = 0
        for row in store.list_orgs():
            total += int(row.get("live") or 0)
        with supervisor._state_lock:
            states = list(supervisor._state.values())
            active = sum(bool(s.get("busy")) for s in states)
            idle = not any(s.get("busy") or s.get("waiting") or s.get("queue")
                           for s in states)
        import_active = desktop_import_jobs.active()
        return {"activeAgents": active, "totalAgents": total, "idle": idle and not import_active,
                "importActive": import_active,
                "maintenance": desktop_maintenance.pending(),
                "maintenance_outcome": desktop_maintenance.status()}

    @api_app.post("/api/desktop/maintenance/ack")
    def acknowledge_maintenance(body: dict[str, Any]) -> dict[str, bool]:
        return desktop_maintenance.acknowledge(str(body.get('id') or ''), str(body.get('outcome') or 'execute'))

    @api_app.post("/api/desktop/maintenance/failure")
    def maintenance_failure(body: dict[str, Any]) -> dict[str, Any]:
        return desktop_maintenance.execution_failed(str(body.get('id') or ''))

    @api_app.post("/api/desktop/shutdown")
    def desktop_shutdown() -> dict[str, bool]:
        stop()
        return {"accepted": True}

    # Attachment identity: lets a token holder prove WHICH engine it reached
    # (root and process), because a persisted port can move between boots and
    # possession of a stale descriptor must never pass for the right engine.
    @api_app.get("/api/desktop/identity")
    def desktop_identity() -> dict[str, Any]:
        return {"protocol": 1, "pid": os.getpid(), "dataRootId": data_root_id(data)}

    @api_app.get("/api/desktop/notifications")
    def desktop_notifications() -> dict[str, Any]:
        from orgtree.desktop_notifications import notices
        return notices()

    @api_app.get("/api/desktop/hub")
    def desktop_hub() -> dict[str, Any]:
        from fastapi import HTTPException
        if _HUB_RUNTIME is None:
            raise HTTPException(503, "hub runtime is not ready")
        return _HUB_RUNTIME.status()

    @api_app.put("/api/desktop/hub")
    def configure_desktop_hub(body: dict[str, Any]) -> dict[str, Any]:
        from fastapi import HTTPException
        if _HUB_RUNTIME is None:
            raise HTTPException(503, "hub runtime is not ready")
        try:
            return _HUB_RUNTIME.configure(body)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc


def load_app() -> tuple[Any, str, Path, int, dict[str, bool]]:
    """Validate environment, strip token, then import the V1 API app."""
    data = validate_data_root(_required_path("ORGTREE_DATA"))
    bundled_backend = Path(__file__).resolve().parent / "backend"
    backend = bundled_backend
    if not (backend / "orgtree" / "api.py").is_file():
        raise RuntimeError("bundled engine/backend/orgtree/api.py is missing")
    token = os.environ.get("ORGTREE_V2_TOKEN", "").strip()
    if not token:
        raise RuntimeError("ORGTREE_V2_TOKEN is required")
    port = _port(data)
    # Child MCP/tool processes inherit this concrete engine port. Never let
    # their copied V1 default (7360) target another installation.
    os.environ["ORGTREE_PORT"] = str(port)
    os.environ.pop("ORGTREE_BASE", None)
    os.environ["ORGTREE_DATA"] = str(data)
    os.environ.pop("ORGTREE_V2_TOKEN", None)
    os.environ['ORGTREE_DESKTOP_MANAGED'] = '1'
    sys.path.insert(0, str(backend))
    from orgtree import agentauth
    agentauth.enable()
    from orgtree import api  # noqa: PLC0415  (import must follow validation)
    from orgtree import desktop_import, desktop_recovery, desktop_maintenance, desktop_policy
    desktop_maintenance.install()
    os.environ['ORGTREE_DESKTOP_MANAGED'] = '1'
    desktop_import.configure(on_imported=desktop_recovery.resume_import)
    api.app.include_router(desktop_import.router)
    desktop_policy.install_routes(api.app)
    stopping = {"value": False}
    _install_desktop_routes(api.app, data, lambda: stopping.__setitem__("value", True))
    # The copied API installs its SPA fallback during import, before desktop
    # routers exist. Keep that fallback last when a packaged UI is present.
    routes = api.app.router.routes
    routes[:] = ([route for route in routes if getattr(route, 'path', None) != '/{path:path}']
                 + [route for route in routes if getattr(route, 'path', None) == '/{path:path}'])
    return TokenGate(api.app, token), token, data, port, stopping


def main() -> None:
    global _HUB_RUNTIME
    data = validate_data_root(_required_path("ORGTREE_DATA"))
    from engine.process_lifetime import arm_process_lifetime
    parent = os.environ.get("ORGTREE_V2_PARENT_PID", "").strip()
    try:
        guardian_pid = arm_process_lifetime(data, parent_pid=int(parent) if parent else None)
    except RuntimeError as exc:
        # The desktop parses stdout: a structured refusal lets it tell a lost
        # boot race from a broken engine and retry attachment instead of
        # showing a fatal dialog. NARROW on purpose (root ruling): only the
        # root-ownership refusal qualifies — any other lifetime failure (a
        # guardian timeout, a bad parent PID) is a real fault and must fail
        # fast, never trigger an attach-retry loop.
        if "owns this data root" in str(exc):
            # The machine-readable code is what the desktop retries on; the
            # prose is display-only. Keeps the retry decision decoupled from
            # exception wording (opus N1).
            print(json.dumps({"type": "refused", "code": "root-owned",
                              "reason": str(exc)[:300]},
                             separators=(",", ":")), flush=True)
        raise
    app, _token, data, port, stopping = load_app()
    # The v2 loopback hub is a sibling service, not an alternate API. Start it
    # only after the explicit root has been validated and the real API loaded;
    # shutdown is idempotent and always runs even when uvicorn exits early.
    from engine.hub_runtime import HubRuntime
    hub = HubRuntime(data)
    _HUB_RUNTIME = hub
    hub_ready = hub.start()
    # The copied production net client starts in the API startup hook. Give it
    # the embedded hub's dynamic address without rewriting remote configuration.
    # HubReadiness carries the owner token on the hardened hub contract;
    # getattr keeps this launcher importable while that sibling commit lands.
    import uvicorn  # noqa: PLC0415
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           access_log=False))
    async def serve() -> None:
        task = asyncio.create_task(server.serve())
        while not server.started and not task.done():
            await asyncio.sleep(0.01)
        if task.done():
            await task
            raise RuntimeError("engine exited before readiness")
        print(json.dumps({"type": "ready", "protocol": 1, "port": port,
                          "pid": os.getpid(), "dataRootId": data_root_id(data),
                          "guardianPid": guardian_pid,
                          "hubPort": hub_ready.port},
                         separators=(",", ":")), flush=True)
        while not task.done():
            if stopping["value"]:
                server.should_exit = True
            await asyncio.sleep(0.05)
        await task
    try:
        asyncio.run(serve())
    finally:
        hub.stop()


if __name__ == "__main__":
    main()
