"""Launch the existing Orgtree API as the isolated V2 engine process.

The launcher is intentionally small: V1 remains the domain authority while
this process owns the V2 data-root and desktop transport boundary.  The
V2 credential is captured and removed before importing legacy modules so it
cannot leak into provider children.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
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
        port = requested
    elif config.exists():
        try:
            saved = json.loads(config.read_text(encoding="utf-8"))
            port = int(saved.get("port"))
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            raise RuntimeError(f"invalid persisted engine port: {config}") from exc
        if not 1 <= port <= 65535:
            raise RuntimeError(f"invalid persisted engine port: {port}")
    else:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        temporary = config.with_suffix(".tmp")
        temporary.write_text(json.dumps({"port": port}) + "\n", encoding="utf-8")
        os.replace(temporary, config)
    # A stored port belongs to this fresh engine only; refuse a collision
    # instead of silently changing the UI origin or attaching to a listener.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(f"engine port {port} is occupied") from exc
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


def _install_desktop_routes(api_app: Any, stop: Callable[[], None]) -> None:
    """Add the small native-shell control surface to the real V1 app."""
    from orgtree import store, supervisor, desktop_maintenance  # noqa: PLC0415

    @api_app.get("/api/desktop/status")
    def desktop_status() -> dict[str, Any]:
        total = 0
        for row in store.list_orgs():
            total += int(row.get("nodes") or 0)
        with supervisor._state_lock:
            states = list(supervisor._state.values())
            active = sum(bool(s.get("busy")) for s in states)
            idle = not any(s.get("busy") or s.get("waiting") or s.get("queue")
                           for s in states)
        return {"activeAgents": active, "totalAgents": total, "idle": idle,
                "maintenance": desktop_maintenance.pending()}

    @api_app.post("/api/desktop/maintenance/ack")
    def acknowledge_maintenance(body: dict[str, Any]) -> dict[str, bool]:
        return desktop_maintenance.acknowledge(str(body.get('id') or ''), str(body.get('outcome') or 'execute'))

    @api_app.post("/api/desktop/shutdown")
    def desktop_shutdown() -> dict[str, bool]:
        stop()
        return {"accepted": True}

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
    sys.path.insert(0, str(backend))
    from orgtree import agentauth
    agentauth.enable()
    from orgtree import api  # noqa: PLC0415  (import must follow validation)
    from orgtree import desktop_import, desktop_recovery, desktop_maintenance
    desktop_maintenance.install()
    os.environ['ORGTREE_DESKTOP_MANAGED'] = '1'
    desktop_import.configure(on_imported=desktop_recovery.resume_import)
    api.app.include_router(desktop_import.router)
    stopping = {"value": False}
    _install_desktop_routes(api.app, lambda: stopping.__setitem__("value", True))
    return TokenGate(api.app, token), token, data, port, stopping


def main() -> None:
    global _HUB_RUNTIME
    data = validate_data_root(_required_path("ORGTREE_DATA"))
    from engine.process_lifetime import arm_process_lifetime
    parent = os.environ.get("ORGTREE_V2_PARENT_PID", "").strip()
    guardian_pid = arm_process_lifetime(data, parent_pid=int(parent) if parent else None)
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
