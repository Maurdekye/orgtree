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
    if root == Path(os.environ.get("ORGTREE_V1_ROOT", "")).expanduser().resolve():
        raise RuntimeError("ORGTREE_DATA must not be the V1 source root")
    return root


def data_root_id(root: Path) -> str:
    # The shell compares this to its own realpath, so an opaque digest would
    # hide a mismatched root instead of proving the handshake identity.
    return str(root.resolve())


def _port() -> int:
    raw = os.environ.get("ORGTREE_V2_PORT", "0").strip()
    try:
        requested = int(raw or "0")
    except ValueError as exc:
        raise RuntimeError(f"ORGTREE_V2_PORT is not an integer: {raw}") from exc
    if requested:
        if not 1 <= requested <= 65535:
            raise RuntimeError("ORGTREE_V2_PORT must be between 1 and 65535")
        return requested
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


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


def load_app() -> tuple[Any, str, Path, int]:
    """Validate environment, strip token, then import the V1 API app."""
    data = validate_data_root(_required_path("ORGTREE_DATA"))
    v1 = _required_path("ORGTREE_V1_ROOT")
    backend = v1 / "backend"
    if not (backend / "orgtree" / "api.py").is_file():
        raise RuntimeError(f"ORGTREE_V1_ROOT has no backend/orgtree/api.py: {v1}")
    token = os.environ.get("ORGTREE_V2_TOKEN", "").strip()
    if not token:
        raise RuntimeError("ORGTREE_V2_TOKEN is required")
    os.environ["ORGTREE_DATA"] = str(data)
    os.environ.pop("ORGTREE_V2_TOKEN", None)
    sys.path.insert(0, str(backend))
    from orgtree import api  # noqa: PLC0415  (import must follow validation)
    return TokenGate(api.app, token), token, data, _port()


def main() -> None:
    app, _token, data, port = load_app()
    import uvicorn  # noqa: PLC0415
    print(json.dumps({"type": "ready", "protocol": 1, "port": port,
                      "pid": os.getpid(), "dataRootId": data_root_id(data)},
                     separators=(",", ":")), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, access_log=False)


if __name__ == "__main__":
    main()
