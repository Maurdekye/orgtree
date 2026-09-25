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
whatever the marker says (plan R11). It never silently installs there. It also
raises for any path that is not an absolute drive-letter path, typed or
resolved — UNC (``\\\\server\\share``, ``\\\\localhost\\C$``, ``\\\\?\\UNC\\``),
device (``\\\\.\\``), volume (``\\\\?\\Volume{GUID}\\``), ``\\\\?\\GLOBALROOT\\``
and relative paths — as WS1's Rust guard does.

When active, requests for the slice's agent verbs and REST routes are
dispatched to the handlers the family workstreams registered with
:func:`register` (which forward to the Rust store service over its
authenticated loopback channel); every other request is untouched. The router
authenticates ONCE, before any handler runs. Nothing is registered at M1.
"""

from __future__ import annotations

import inspect
import json
import os
import re
import socket
import struct
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

ENV_VAR = "ORGTREE_P03_PROTOTYPE_ROOT"
MARKER_FILE = "orgtree-p03-prototype-root.json"
MARKER_SCHEMA = "orgtree.p03.prototype-root/v1"
DESCRIPTOR_FILE = "p03-store-service.json"
DESCRIPTOR_SCHEMA = "orgtree.p03.store-service/v1"
PROTOCOL = "orgtree.p03-store/v1"
OP_TAG_HEADER = "x-orgtree-p03-op-tag"
MAX_FRAME = 4 * 1024 * 1024

#: Agent tool verbs the store service serves on an active prototype root.
#: Derived from the registry (:func:`register`); empty until a family lands.
SLICE_TOOLS: frozenset[str] = frozenset()


class LiveRootRefused(RuntimeError):
    """The P03 hook was asked to run against live Orgtree data."""


class DuplicateRegistration(ValueError):
    """A family tried to register a tool, route or family name already taken."""


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


#: THE live-location list, shared with the Rust guard (WS1's
#: ``orgtree-prototype-guard``, which compiles the same file in): lead ruling
#: 2026-09-25 09:02Z. Read only when the hook is asked to activate.
LIVE_LOCATIONS_FILE = Path(__file__).resolve().parents[2] / "native" / "prototype-guard" / "live-locations.json"
LIVE_LOCATIONS_SCHEMA = "orgtree.p03.live-locations/v1"
_FORBIDDEN = set('<>:"|?*')
REPARSE_POINT = 0x400
SCAN_LIMIT = 200_000


def _live_spec() -> list[dict[str, Any]]:
    spec = json.loads(LIVE_LOCATIONS_FILE.read_text(encoding="utf-8"))
    if spec.get("schema") != LIVE_LOCATIONS_SCHEMA or not isinstance(spec.get("locations"), list):
        raise LiveRootRefused(f"P03 hook refused: {LIVE_LOCATIONS_FILE} is not {LIVE_LOCATIONS_SCHEMA}")
    return spec["locations"]


def live_locations(env: Mapping[str, str]) -> list[tuple[str, str]]:
    """Every UNCONDITIONAL live location derivable from ``env`` (the entries of
    ``live-locations.json`` with ``unconditional: true``; ORGTREE_DATA, the
    one conditional entry, is handled by :func:`active_root`'s equality and
    marker rules). A missing or malformed list fails closed."""
    try:
        spec = _live_spec()
    except (OSError, ValueError) as exc:
        raise LiveRootRefused(f"P03 hook refused: cannot read the live-location list: {exc}") from exc
    out: list[tuple[str, str]] = []
    for loc in spec:
        if not loc.get("unconditional"):
            continue
        base = next((env.get(k, "").strip() for k in loc["base_env"] if (env.get(k) or "").strip()), "")
        if base:
            out.append((str(loc["label"]), os.path.join(base, *loc["parts"])))
    return out


def _refuse_bad_name(path: Any) -> None:
    s = str(path).replace("/", "\\")
    if s.startswith("\\\\?\\"):
        s = s[4:]
    for i, comp in enumerate(s.split("\\")):
        bad = [c for c in comp if (c in _FORBIDDEN and not (i == 0 and c == ":" and comp.endswith(":"))) or ord(c) < 32]
        if bad:
            raise LiveRootRefused(f"P03 hook refused: path component {comp!r} contains characters Windows forbids")


def refuse_reparse_points(root: Path) -> None:
    """Refuse ANY junction or symlink at or under ``root`` (WS1 guard rule)."""
    seen = 0
    stack = [Path(root)]
    while stack:
        p = stack.pop()
        try:
            st = os.stat(p, follow_symlinks=False)
        except OSError:
            continue
        if getattr(st, "st_file_attributes", 0) & REPARSE_POINT or os.path.islink(p):
            raise LiveRootRefused(f"P03 hook refused: reparse point (junction or symlink) at {p}")
        seen += 1
        if seen > SCAN_LIMIT:
            raise LiveRootRefused(f"P03 hook refused: more than {SCAN_LIMIT} entries under {root}")
        if p.is_dir():
            try:
                stack.extend(Path(e.path) for e in os.scandir(p))
            except OSError:
                pass


def _is_drive_path(s: str) -> bool:
    """``C:\\...`` or ``\\\\?\\C:\\...`` (any case, either slash) and nothing else."""
    low = s.replace("/", "\\").lower()
    if low.startswith("\\\\?\\"):
        low = low[4:]
    return len(low) >= 3 and "a" <= low[0] <= "z" and low[1:3] == ":\\"


def refuse_non_drive(path: Any, resolve: Any = None) -> None:
    """Refuse any path that is not an absolute drive-letter path, typed OR as
    it resolves (review N1, R3): UNC (``\\\\server\\share``, ``\\\\localhost\\C$``,
    ``\\\\?\\UNC\\``), device (``\\\\.\\``), volume (``\\\\?\\Volume{GUID}\\``),
    object-namespace (``\\\\?\\GLOBALROOT\\...``) and relative paths. This is
    the rule WS1's Rust guard applies (only Disk and VerbatimDisk prefixes):
    an alias of this kind reaches the live folder under a name no prefix
    comparison sees. ``resolve`` is the resolver, replaceable in tests."""
    resolve = resolve or (lambda p: Path(p).resolve(strict=False))
    typed = os.path.expanduser(str(path))
    forms = [typed]
    try:
        forms.append(str(resolve(typed)))
    except OSError:
        pass
    for s in forms:
        if not _is_drive_path(s):
            raise LiveRootRefused(f"P03 hook refused: {s!r} is not an absolute drive-letter path (UNC, device, volume and relative paths are refused)")


def refuse_live(path: Any, env: Mapping[str, str]) -> None:
    """Raise :class:`LiveRootRefused` if ``path`` is not an absolute
    drive-letter path (typed or resolved), or is, is inside, or contains a
    live location — typed and canonical forms, on both sides."""
    refuse_non_drive(path)
    _refuse_bad_name(path)
    forms = {_norm(path), os.path.abspath(str(path)).replace("/", "\\").lower().rstrip("\\")}
    for label, live in live_locations(env):
        live_forms = {_norm(live), os.path.abspath(live).replace("/", "\\").lower().rstrip("\\")}
        for c in forms:
            for l in live_forms:
                if _within(c, l) or _within(l, c):
                    raise LiveRootRefused(f"P03 hook refused: {c} overlaps the live location {label}")


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
    refuse_reparse_points(root)
    return root


def install(app: Any, data_root: Any = None, env: Optional[Mapping[str, str]] = None) -> bool:
    """Install the router on ``app`` when the hook is active; otherwise do
    nothing at all. Returns whether it installed."""
    root = active_root(data_root, env)
    if root is None:
        return False
    app.middleware("http")(_Router(root))
    return True


# ---- the family registration seam ---------------------------------------------
#
# A family module (``p03_door_mail.py`` and so on) calls :func:`register` once
# at import. A handler is called as ``handler(identity, body, op_tag,
# **path_params)``: ``identity`` is what authentication returned, ``body`` the
# parsed JSON request (the whole ``/api/agent`` envelope for a tool, ``{}``
# for an empty REST body), ``op_tag`` the harness header or ``None``. It
# returns a JSON-able value or a Starlette ``Response``; a plain function runs
# on the thread pool, a coroutine function on the loop.

Handler = Callable[..., Any]
Auth = Callable[[Any], Any]

_FAMILIES: set[str] = set()
_TOOLS: dict[str, tuple[str, Handler]] = {}
#: (METHOD, pattern) -> (family, handler, auth or None, compiled path regex)
_ROUTES: dict[tuple[str, str], tuple[str, Handler, Optional[Auth], Any]] = {}
_PARAM = re.compile(r"\{([^}:]+)(?::[^}]+)?\}")


def _route_regex(pattern: str) -> Any:
    from starlette.routing import compile_path  # noqa: PLC0415  (lazy: import-light module)
    return compile_path(pattern)[0]


def _probe(pattern: str) -> str:
    """A concrete path the pattern matches, for the overlap check."""
    return _PARAM.sub("p03probe", pattern)


def register(family: str, tools: Optional[Mapping[str, Handler]] = None,
             routes: Optional[Mapping[tuple[str, str], Any]] = None) -> None:
    """Register one family's agent ``tools`` ({tool name: handler}) and REST
    ``routes`` ({(method, path pattern): handler or (handler, auth)}).

    All or nothing: every entry is checked before any is stored. Refused with
    :class:`DuplicateRegistration` when the family name is taken, or a tool or
    route is already registered (by any family, or twice in this call). Two
    routes of the same method whose patterns can match the same path count as
    the same route. ``auth(request)`` replaces the default operator check for
    that one route; it must raise ``HTTPException`` to refuse."""
    global SLICE_TOOLS
    if not isinstance(family, str) or not family.strip():
        raise ValueError("a family needs a non-empty name")
    if family in _FAMILIES:
        raise DuplicateRegistration(f"family {family!r} is already registered")
    new_tools: dict[str, tuple[str, Handler]] = {}
    for name, handler in (tools or {}).items():
        if not isinstance(name, str) or not name or not callable(handler):
            raise ValueError(f"{family}: tool {name!r} needs a name and a callable handler")
        if name in _TOOLS:
            raise DuplicateRegistration(f"{family}: tool {name!r} is already registered by {_TOOLS[name][0]!r}")
        new_tools[name] = (family, handler)
    new_routes: dict[tuple[str, str], tuple[str, Handler, Optional[Auth], Any]] = {}
    for key, value in (routes or {}).items():
        method, pattern = key
        method = str(method).upper()
        handler, auth = value if isinstance(value, tuple) else (value, None)
        if not (isinstance(pattern, str) and pattern.startswith("/api/")) or pattern == "/api/agent":
            raise ValueError(f"{family}: route {key!r} must be an /api/ path other than /api/agent")
        if not callable(handler) or (auth is not None and not callable(auth)):
            raise ValueError(f"{family}: route {key!r} needs a callable handler (and auth, if given)")
        regex = _route_regex(pattern)
        for (m, p), (owner, _h, _a, rx) in [*_ROUTES.items(), *new_routes.items()]:
            if m == method and (rx.match(_probe(pattern)) or regex.match(_probe(p))):
                raise DuplicateRegistration(f"{family}: route {method} {pattern} collides with {m} {p} of {owner!r}")
        new_routes[(method, pattern)] = (family, handler, auth, regex)
    _FAMILIES.add(family)
    _TOOLS.update(new_tools)
    _ROUTES.update(new_routes)
    SLICE_TOOLS = frozenset(_TOOLS)


def _tool_name(body: Mapping[str, Any]) -> str:
    """The verb a call is making — the WRAPPED one for ``orgtree_op_call``,
    exactly as ``toolwait.tool_name`` reads it."""
    name = body.get("tool")
    if name == "orgtree_op_call":
        args = body.get("args")
        name = args.get("tool") if isinstance(args, dict) else None
    return name if isinstance(name, str) else ""


def _agent_auth(body: Mapping[str, Any], request: Any) -> Any:
    """The same authentication ``agent_call`` runs, plus its halt and
    killswitch gates. ``api`` is reached lazily: it imports this module."""
    from . import api  # noqa: PLC0415
    from fastapi import HTTPException  # noqa: PLC0415
    from pydantic import ValidationError  # noqa: PLC0415
    try:
        call = api.AgentCall.model_validate(dict(body))
    except ValidationError as exc:
        raise HTTPException(422, f"malformed agent call: {exc.errors()[:3]}") from exc
    identity = api._agent_identity(call, request, durable=True)
    blocked = api.supervisor.halt.blocked(call.org, call.node)
    if blocked == "halt":
        raise HTTPException(409, "agent is halted — tools cannot execute until unhalt")
    if blocked == "killswitch":
        raise HTTPException(409, "the org killswitch is latched — tools cannot execute until the user releases it")
    return identity


def _operator_auth(request: Any) -> Any:
    """The operator check REST diagnostics use (``diagnostics._operator_only``):
    the desktop token was already required by ``launch.TokenGate``, so only
    kiosk and bridge callers remain to refuse."""
    from fastapi import HTTPException  # noqa: PLC0415
    state = request.scope.get("state") or {}
    if state.get("public_slug") or state.get("bridge_slug"):
        raise HTTPException(403, "this prototype route is available only to the host operator")
    return {}


class _Router:
    """Authenticates, then dispatches registered slice verbs and routes;
    passes everything else through untouched. ``agent_auth(body, request)``
    and ``operator_auth(request)`` are replaceable in tests."""

    def __init__(self, root: Path, agent_auth: Optional[Callable[[Any, Any], Any]] = None,
                 operator_auth: Optional[Auth] = None) -> None:
        self.root = root
        self.agent_auth = agent_auth or _agent_auth
        self.operator_auth = operator_auth or _operator_auth

    async def __call__(self, request: Any, call_next: Any) -> Any:
        path, method = request.url.path, request.method.upper()
        if path == "/api/agent" and method == "POST" and _TOOLS:
            # Starlette caches the body, so a pass-through below still reads it.
            try:
                body = json.loads(await request.body())
            except ValueError:
                return await call_next(request)
            entry = _TOOLS.get(_tool_name(body)) if isinstance(body, dict) else None
            if entry is None:
                return await call_next(request)
            return await self._dispatch(request, entry[1], lambda: self.agent_auth(body, request), body, {})
        for (m, _p), (_f, handler, auth, regex) in list(_ROUTES.items()):
            match = regex.match(path) if m == method else None
            if match is None:
                continue
            raw = await request.body()
            try:
                body = json.loads(raw) if raw.strip() else {}
            except ValueError:
                return _error(422, "the request body is not JSON")
            check = auth or self.operator_auth
            return await self._dispatch(request, handler, lambda: check(request), body, match.groupdict())
        return await call_next(request)

    async def _dispatch(self, request: Any, handler: Handler, authenticate: Callable[[], Any],
                        body: Any, params: dict[str, Any]) -> Any:
        from starlette.concurrency import run_in_threadpool  # noqa: PLC0415
        from starlette.exceptions import HTTPException  # noqa: PLC0415
        from starlette.responses import JSONResponse, Response  # noqa: PLC0415
        # A middleware sits outside FastAPI's exception handlers, so a refusal
        # is turned into its response here instead of surfacing as a 500.
        try:
            # AUTHENTICATION FIRST. Nothing a handler does may happen for a
            # caller this step refuses (lead 2026-09-25 11:49Z).
            identity = await run_in_threadpool(authenticate)
            op_tag = request.headers.get(OP_TAG_HEADER)
            if inspect.iscoroutinefunction(handler):
                result = await handler(identity, body, op_tag, **params)
            else:
                result = await run_in_threadpool(handler, identity, body, op_tag, **params)
        except HTTPException as exc:
            return _error(exc.status_code, exc.detail, getattr(exc, "headers", None))
        return result if isinstance(result, Response) else JSONResponse(result)


def _error(status: int, detail: Any, headers: Optional[Mapping[str, str]] = None) -> Any:
    from starlette.responses import JSONResponse  # noqa: PLC0415
    return JSONResponse({"detail": detail}, status_code=status, headers=dict(headers) if headers else None)


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
