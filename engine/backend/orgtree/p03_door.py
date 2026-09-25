"""P03 door-routing hook (``engine/native/store/CONTRACT-M1.md`` §9).

The only P03 change to existing Python is the two lines in ``api.py`` that
import this module and call :func:`install`. It is **inert** — it installs
nothing at all — unless every one of these holds:

1. ``ORGTREE_P03_PROTOTYPE_ROOT`` is set;
2. it names the same folder as the backend's resolved data root;
3. that folder carries WS1's disposable prototype-root marker
   (``orgtree-p03-prototype-root.json``) whose ``root_path`` is that folder.

**Live-root refusal.** Once ``ORGTREE_P03_PROTOTYPE_ROOT`` is set at all,
:func:`install` RAISES if the data root (or the named prototype root) is, is
inside, or contains a live Orgtree location — ``%APPDATA%\\Orgtree v2`` (so
``%APPDATA%\\Orgtree v2\\data`` and everything under it), its
``%USERPROFILE%`` spelling, ``~/orgtree`` and the installed app folders —
whatever the marker says (plan R11). It never silently installs there.

When active, requests for the slice's agent verbs (:data:`SLICE_TOOLS`) are
forwarded to the Rust store service over its authenticated loopback channel;
every other request is untouched. At M1 the slice is empty: the family
workstreams add their verbs (and the authentication step before forwarding)
as they land.
"""

from __future__ import annotations

import json
import os
import socket
import struct
from pathlib import Path
from typing import Any, Mapping, Optional

ENV_VAR = "ORGTREE_P03_PROTOTYPE_ROOT"
MARKER_FILE = "orgtree-p03-prototype-root.json"
MARKER_SCHEMA = "orgtree.p03.prototype-root/v1"
DESCRIPTOR_FILE = "p03-store-service.json"
DESCRIPTOR_SCHEMA = "orgtree.p03.store-service/v1"
PROTOCOL = "orgtree.p03-store/v1"
OP_TAG_HEADER = "x-orgtree-p03-op-tag"
MAX_FRAME = 4 * 1024 * 1024

#: Agent tool verbs the store service serves on an active prototype root.
#: Empty at M1; each family workstream adds its verbs when it lands.
SLICE_TOOLS: frozenset[str] = frozenset()


class LiveRootRefused(RuntimeError):
    """The P03 hook was asked to run against live Orgtree data."""


def _norm(path: Any) -> str:
    """Resolved, lower-cased, backslash form; trailing dots and spaces of each
    component dropped (Windows ignores them, so ``Orgtree v2.`` is the same
    folder as ``Orgtree v2``)."""
    p = Path(os.path.expanduser(str(path)))
    try:
        p = p.resolve(strict=False)
    except OSError:
        p = Path(os.path.abspath(str(p)))
    s = str(p).replace("/", "\\")
    if s.startswith("\\\\?\\"):
        s = s[4:]
    parts = [c.rstrip(". ").lower() for c in s.split("\\")]
    return "\\".join(c for i, c in enumerate(parts) if c or i == 0)


def _within(a: str, b: str) -> bool:
    return a == b or a.startswith(b.rstrip("\\") + "\\")


def live_locations(env: Mapping[str, str]) -> list[tuple[str, str]]:
    """Every live Orgtree location derivable from ``env``."""
    out: list[tuple[str, str]] = []

    def var(k: str) -> Optional[str]:
        v = (env.get(k) or "").strip()
        return v or None

    if var("APPDATA"):
        out.append(("%APPDATA%\\Orgtree v2", os.path.join(var("APPDATA"), "Orgtree v2")))
    home = var("USERPROFILE") or var("HOME")
    if home:
        out.append(("%USERPROFILE%\\AppData\\Roaming\\Orgtree v2", os.path.join(home, "AppData", "Roaming", "Orgtree v2")))
        out.append(("~/orgtree", os.path.join(home, "orgtree")))
    if var("ProgramFiles"):
        out.append(("%ProgramFiles%\\Orgtree", os.path.join(var("ProgramFiles"), "Orgtree")))
    if var("LOCALAPPDATA"):
        out.append(("%LOCALAPPDATA%\\Programs\\Orgtree", os.path.join(var("LOCALAPPDATA"), "Programs", "Orgtree")))
    return out


def refuse_live(path: Any, env: Mapping[str, str]) -> None:
    """Raise :class:`LiveRootRefused` if ``path`` is, is inside, or contains a
    live location."""
    candidate = _norm(path)
    for label, live in live_locations(env):
        live_n = _norm(live)
        if _within(candidate, live_n) or _within(live_n, candidate):
            raise LiveRootRefused(f"P03 hook refused: {candidate} overlaps the live location {label}")


def _marker_ok(root: Path) -> bool:
    try:
        m = json.loads((root / MARKER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    rid = str(m.get("root_id") or "")
    return (
        m.get("schema") == MARKER_SCHEMA
        and m.get("disposable") is True
        and len(rid) == 32
        and all(c in "0123456789abcdef" for c in rid)
        and str(m.get("root_path") or "") == _norm(root)
    )


def active_root(data_root: Any = None, env: Optional[Mapping[str, str]] = None) -> Optional[Path]:
    """The prototype root when the hook must be active, else ``None``.
    Raises :class:`LiveRootRefused` (see the module docstring)."""
    env = os.environ if env is None else env
    proto = (env.get(ENV_VAR) or "").strip()
    if not proto:
        return None
    data = str(data_root) if data_root is not None else (env.get("ORGTREE_DATA") or "").strip()
    # The live-root refusal comes FIRST, before any equality or marker check.
    refuse_live(proto, env)
    if data:
        refuse_live(data, env)
    if not data or _norm(proto) != _norm(data):
        return None
    root = Path(proto)
    if not _marker_ok(root):
        return None
    return root


def install(app: Any, data_root: Any = None, env: Optional[Mapping[str, str]] = None) -> bool:
    """Install the router on ``app`` when the hook is active; otherwise do
    nothing at all. Returns whether it installed."""
    root = active_root(data_root, env)
    if root is None:
        return False
    app.middleware("http")(_Router(root))
    return True


class _Router:
    """Forwards slice verbs; passes everything else through untouched."""

    def __init__(self, root: Path) -> None:
        self.root = root

    async def __call__(self, request: Any, call_next: Any) -> Any:
        if not SLICE_TOOLS or request.url.path != "/api/agent":
            return await call_next(request)
        # M1: no slice verbs are registered, so this is unreachable. Families
        # add their verbs together with the authentication step
        # (``api._agent_identity``) that must run before forwarding.
        return await call_next(request)


# ---- the store-service client -------------------------------------------------


def _send(sock: socket.socket, obj: Any) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise ValueError("request frame too large")
    sock.sendall(struct.pack(">I", len(body)) + body)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("store service closed the connection")
        buf += chunk
    return bytes(buf)


def _recv(sock: socket.socket) -> Any:
    (n,) = struct.unpack(">I", _recv_exact(sock, 4))
    if n > MAX_FRAME:
        raise ConnectionError(f"store service sent a {n}-byte frame")
    return json.loads(_recv_exact(sock, n).decode("utf-8"))


class StoreClient:
    """One authenticated connection to the store service named by the
    descriptor in ``root``."""

    def __init__(self, root: Path, timeout: float = 30.0) -> None:
        d = json.loads((Path(root) / DESCRIPTOR_FILE).read_text(encoding="utf-8"))
        if d.get("schema") != DESCRIPTOR_SCHEMA:
            raise ConnectionError("store-service descriptor has an unknown schema")
        self._sock = socket.create_connection(("127.0.0.1", int(d["port"])), timeout=timeout)
        _send(self._sock, {"hello": str(d["token"])})
        try:
            hs = _recv(self._sock)["handshake"]
        except (ConnectionError, KeyError, TypeError) as exc:
            self._sock.close()
            raise ConnectionError("store service refused the handshake") from exc
        if hs.get("protocol") != PROTOCOL:
            self._sock.close()
            raise ConnectionError(f"store service speaks {hs.get('protocol')!r}, not {PROTOCOL}")
        self.handshake: dict[str, Any] = hs

    def call(self, verb: str, org: str, binding: dict[str, Any], args: dict[str, Any],
             op_tag: Optional[str] = None) -> Any:
        b = dict(binding)
        # The harness tag is honoured only by a qualification build (§5, §9).
        b["op_tag"] = op_tag if (op_tag and self.handshake.get("qualification") is True) else None
        _send(self._sock, {"verb": verb, "org": org, "binding": b, "args": args})
        return _recv(self._sock)

    def close(self) -> None:
        self._sock.close()
