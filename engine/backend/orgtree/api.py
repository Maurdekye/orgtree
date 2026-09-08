# pyright: strict, reportPrivateUsage=false, reportUnnecessaryIsInstance=false
# (the two relaxations restate pyrightconfig.json's project-wide rulings —
#  cross-module _helpers are deliberate, runtime isinstance guards stay —
#  which a bare file-level strict comment would otherwise override)
"""FastAPI layer — the UI's backend and (later) the supervisor's host process.

Run:  python -m orgtree.api          (serves API + built frontend on one port)
Dev:  uvicorn orgtree.api:app --reload --port 7360   (vite dev server proxies /api)

v0.1 scope: org CRUD, tree view, the ledger ops, an event tail, and a WebSocket that
pings "changed" after every successful op so the UI refreshes. Session spawning is v0.2.
"""

from __future__ import annotations

import asyncio
import importlib.util
import ipaddress
import json
import math
import os
import posixpath
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
import weakref
from functools import partial
import anyio
from urllib.parse import urlsplit

# typing wave: Any/Response types must be RUNTIME imports — FastAPI evaluates
# endpoint annotation strings (PEP 563) at decoration time. Helper-only types
# stay under TYPE_CHECKING so the runtime import graph is unchanged.
from typing import TYPE_CHECKING, Any, cast

# ⚠ BEFORE ANY orgtree MODULE IS IMPORTED, so nothing can print ahead of it.
#
# The launcher redirects this process's stdout to `backend.log`, and on
# Windows a REDIRECTED stream is cp1252 — `print` of any character outside it
# raises `UnicodeEncodeError`. MEASURED 2026-09-03: 25 `print()` calls across
# five modules carry `—`, `⚠` or `…` (supervisor 15, this file 5, sandbox 3,
# externtool 1, warmpool 1), and the live `backend.log` contained ZERO
# non-ASCII bytes — none of them had ever reached it.
#
# ⚠ THAT IS A LATENT CRASH, NOT JUST A LOST MESSAGE. Most of those sites are
# not wrapped, so the raise PROPAGATES — including supervisor's "CLAUDE CLI
# PROBLEM" banner, a line whose entire job is to tell the operator something
# is badly wrong and which would instead take the process down on the way.
# The one site that WAS wrapped was worse in its own way: this file's
# slow-request alarm sat behind `except Exception: pass`, so it printed
# nothing at all through 32 requests that crossed its threshold and left no
# trace of failing.
#
# ⚠ `errors="replace"`, never `ignore`: a mangled glyph is debuggable, a
# silently dropped line is the failure being fixed. And this is the whole fix
# — the 24 other call sites are deliberately NOT edited, because a future
# author typing an em-dash must not have to know any of this.
#
# `mcptool.py` has done exactly this for its own stdio since it was written;
# this is the same idiom, applied to the entry point that was missing it.
# `hasattr`-guarded because a captured or replaced stream (tests, a harness)
# is not a TextIOWrapper.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]  # TextIO stub lacks reconfigure; runtime TextIOWrapper has it (hasattr-guarded)

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, model_validator

from . import crashreports
from . import events
from . import refs
from . import deployment
from . import frozen_install
from . import workitems
from . import opreceipts
from . import ledger as ledger_mod
from . import (accounts, antigravity_limits, appsettings, bridgeauth,
               codex_limits, codex_route, limits, net,
               providers, restart_wake, sandbox, store, subproxy, supervisor, warmpool)
from .ledger import LedgerError, Org, USER, VIS_LEVELS, actor_of, norm_dirs, norm_tools

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    import httpx
    # aliased: `Scope` is taken by the pydantic body model of the same name
    from starlette.types import ASGIApp, Receive, Scope as ASGIScope, Send

    # aliased: `KioskCfg` is taken by the pydantic body model of the same name
    from .schema import DirGrant, KioskCfg as KioskDoc, MailEntry, UserMailEntry

app = FastAPI(title="orgtree", version="1.0.0")

from .history import router as history_router
app.include_router(history_router)

#: THIS PROCESS's identity — a fresh value on every start.
#:
#: A redeploy replaces both halves of the app, but only the server half
#: restarts: every browser already open keeps running the bundle it loaded,
#: against a backend that may have changed its payloads underneath it. The
#: symptom is a UI that looks fine and is subtly wrong, and the fix has always
#: been "tell the user to hit refresh". Stamping every response with this lets
#: the client notice the change itself (see `noteInstance` in api.ts) — no new
#: endpoint, no extra request, and no poller: the heartbeats that already run
#: carry it.
INSTANCE = secrets.token_hex(8)


class InstanceStamp:
    """Adds `X-Orgtree-Instance` to every HTTP response.

    Pure ASGI rather than `@app.middleware("http")`: Starlette's
    BaseHTTPMiddleware re-wraps the response body in its own StreamingResponse,
    and this sits in front of multi-GB virtual-disk downloads. Rewriting one
    header on the `http.response.start` message touches nothing else."""

    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: ASGIScope, receive: Receive,
                       send: Send) -> None:
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)

        # /api/ responses also get no-store: the restart detector compares the
        # instance stamp per response, and a heuristically-cached GET replaying
        # an OLD instance id after a reload would re-trigger the reload — a
        # loop. One header closes it; static assets keep their own caching.
        api = scope.get("path", "").startswith("/api/")

        async def _send(msg: Any) -> None:
            if msg["type"] == "http.response.start":
                msg = dict(msg)
                msg["headers"] = [*(msg.get("headers") or []),
                                  (b"x-orgtree-instance", INSTANCE.encode()),
                                  *([(b"cache-control", b"no-store")] if api else [])]
            await send(msg)
        await self.inner(scope, receive, _send)


class FrozenAdminBoundary:
    """Keep the bare ASGI admin app loopback-only in frozen mode.

    The supported launcher also binds the admin listener to loopback. This
    request boundary prevents a direct/custom ASGI server from turning a
    non-loopback bind into an unauthenticated admin surface. Authenticated
    bridge traffic is marked by ``BridgeGateway`` before it reaches the app.
    """

    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: ASGIScope, receive: Receive,
                       send: Send) -> None:
        if scope["type"] not in ("http", "websocket") \
                or deployment.current_policy().allow_admin_exposure \
                or (scope.get("state") or {}).get("bridge_slug"):
            return await self.inner(scope, receive, send)

        client = scope.get("client")
        host = str(client[0]).split("%", 1)[0] if client else ""
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if loopback:
            return await self.inner(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = json.dumps({
            "detail": "the frozen deployment profile exposes the admin API "
                      "to loopback clients only",
        }).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


# ── the access record (D-239) ────────────────────────────────────────────────
#
# WHY THIS EXISTS. Until 2026-09-03 nothing in this system knew how long
# anything took. The log carried uvicorn's stock line —
# `INFO: 127.0.0.1:61975 - "GET /api/orgs/orgtree HTTP/1.1" 200 OK` — with no
# duration, no response size and no timestamp. Two days of 11-38 second
# requests sat in `backend.log` looking exactly like 12 ms ones: of 12,055
# lines, ONE carried anything duration-shaped. The regression was found by
# attaching py-spy to the live process, which is not a thing anyone should
# have to do to answer "which endpoint is slow".
#
# ⚠ INSTRUMENT THE BOUNDARY, NOT THE SPAN YOU SUSPECT. There already WAS a
# latency tripwire — `org_tree`'s "tree() took >1s" warning, written against a
# redteam's O(n²) `Org.children` finding. It never fired, for three reasons
# worth keeping: its timer stopped three lines short of `annotate`, which
# owned 91% of the request; it guarded a hypothesis rather than a surface, and
# the real cost arrived from a direction nobody had connected to it; and its
# `_tree_slow_warned` set only ever grew, so even a hit would have said so once
# and then gone quiet forever. A threshold that latches once per process tells
# you nothing about a trend. Hence: every request, at the outermost boundary,
# and a repeat window that RESETS.
#
# ⚠ THE ROUTE TEMPLATE, NEVER THE CONCRETE PATH, AND NEVER THE QUERY STRING.
# Not only because `/api/orgs/{slug}/nodes/{nid}/chat` aggregates and
# `/api/orgs/orgtree/nodes/perf-latency/chat?last=120` does not — but because
# this middleware sits on `app`, and the BRIDGE listener wraps that same
# object. Its uvicorn access log is deliberately suppressed in frozen mode
# (see `bridge_log` in `main`) because THE ORG CREDENTIAL RIDES IN THE URL:
# the frozen CLI cannot attach a private header. Logging concrete paths here
# would have quietly re-opened exactly that hole from a different file. A
# template carries no parameter values, so this is safe by construction on
# every listener rather than by a policy check someone can forget.
#
# This ADDS a line rather than replacing uvicorn's. Suppressing uvicorn's
# access log per listener is a security-reviewed decision in `main` (the
# bridge case above) and not worth reopening for log volume.

_access_inflight = 0          # HTTP requests currently inside the app
_SLOW_MS = 500.0              # a handler this slow is worth a line of its own
_SLOW_REPEAT_S = 60.0         # …and at most one such line per route per minute
_slow_last: dict[str, float] = {}        # route -> when it last warned
_slow_held: dict[str, int] = {}          # route -> slow requests since then


class AccessRecord:
    """One line per HTTP request: duration, bytes, route template, in-flight.

    Pure ASGI for the reason `InstanceStamp` gives (BaseHTTPMiddleware re-wraps
    the body, and this sits in front of multi-GB disk downloads); the only work
    per body chunk is one integer add.

    ⚠ TWO DURATIONS, AND THE THRESHOLD USES THE FIRST. `handler` is time to
    `http.response.start` — the part this codebase can fix. `total` includes
    shipping the body, which for a virtual-disk download is physics, not a
    defect. Warning on `total` would fill the log with alarms about large
    files working correctly, and that is how a threshold gets ignored.

    ⚠ `inflight` IS NOT DECORATION — it is the field that would have caught
    the 2026-09-03 outage's most confusing symptom. "Agent chats no longer
    load" pointed at the chat handler, which measured 2.3-2.7 s throughout and
    was blameless: HTTP/1.1 caps a browser at ~6 sockets per origin, the tree
    poll had no in-flight guard, and the chat request was never SENT. No
    per-request duration can show that. A depth of 5 on one route can.
    """

    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: ASGIScope, receive: Receive,
                       send: Send) -> None:
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        # Plain int, no lock: every ASGI callable runs in the one uvicorn event
        # loop (`main` gathers its servers onto a single `asyncio.run`), and
        # there is no `await` between the read and the write. The handlers
        # themselves are `def` and run in the threadpool, but they are not
        # here. A wrong count would cost a misleading log field, never
        # correctness.
        global _access_inflight
        _access_inflight += 1
        depth = _access_inflight
        t0 = time.perf_counter()
        handler_ms = -1.0
        status = 0
        nbytes = 0

        async def _send(msg: Any) -> None:
            nonlocal handler_ms, status, nbytes
            if msg["type"] == "http.response.start":
                handler_ms = (time.perf_counter() - t0) * 1000.0
                status = int(msg.get("status") or 0)
            elif msg["type"] == "http.response.body":
                nbytes += len(msg.get("body") or b"")
            await send(msg)

        try:
            await self.inner(scope, receive, _send)
        finally:
            # `finally`, so a handler that raises is still recorded — an
            # endpoint that fails slowly is exactly as interesting as one that
            # succeeds slowly, and it is the one uvicorn's line describes worst.
            _access_inflight -= 1
            total_ms = (time.perf_counter() - t0) * 1000.0
            try:
                _access_emit(scope, status, handler_ms, total_ms, nbytes, depth)
            except Exception:                                   # noqa: BLE001
                pass      # a log line may never be the reason a request fails


def _route_label(scope: ASGIScope) -> str:
    """The matched route's TEMPLATE. `<unmatched>` when nothing matched, which
    is a real answer (404s and gateway rejections) and never a path."""
    path = getattr(scope.get("route"), "path", None)
    return str(path) if path else "<unmatched>"


def _access_emit(scope: ASGIScope, status: int, handler_ms: float,
                 total_ms: float, nbytes: int, depth: int) -> None:
    """⚠ EVERY BYTE THIS PRINTS MUST BE ASCII, and that is not a style rule.

    The backend's stdout is redirected to `backend.log` by the launcher, and
    on Windows a redirected stream is cp1252 — `print` of a non-ASCII
    character raises `UnicodeEncodeError`. The caller wraps this in a bare
    `except Exception: pass` so a log line can never fail a request, which
    means such a failure is COMPLETELY SILENT.

    Found in production on the first deploy that carried this middleware: the
    access line (ASCII) appeared 236 times while the slow-request alarm, whose
    only difference was a `⚠` glyph, appeared ZERO times across 32 requests
    that qualified for it. The instrument built to make slow requests visible
    was itself invisible, hidden by its own safety net.

    `test_access_record.py` §7 pins it by encoding the emitted lines as
    cp1252, which is the actual failure and cannot be satisfied by inspection.
    """
    route = _route_label(scope)
    method = str(scope.get("method") or "?")
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[orgtree.access] {stamp} {method} {route} {status} "
          f"handler={handler_ms:.0f}ms total={total_ms:.0f}ms "
          f"bytes={nbytes} inflight={depth}", flush=True)
    if handler_ms < _SLOW_MS:
        return
    # The alarm. Rate-limited per route by a TIME WINDOW rather than by a set
    # of routes already seen — that distinction is the whole lesson of
    # `_tree_slow_warned`, which could only ever fire once per process and so
    # could not describe a problem getting worse. The window resets on its own
    # and the held count carries what happened inside it, so a route that is
    # slow every time reports "+N more" and a route that was slow once says so
    # and goes quiet.
    now = time.time()
    last = _slow_last.get(route)
    if last is not None and now - last < _SLOW_REPEAT_S:
        _slow_held[route] = _slow_held.get(route, 0) + 1
        return
    held = _slow_held.pop(route, 0)
    _slow_last[route] = now
    # ⚠ ASCII ONLY ON THIS LINE — see the note on `_access_emit`.
    print(f"[orgtree.slow] SLOW {method} {route} took {handler_ms:.0f}ms "
          f"(>{_SLOW_MS:.0f}ms), {nbytes} bytes, {depth} in flight"
          + (f" — and {held} more like it in the last "
             f"{_SLOW_REPEAT_S:.0f}s" if held else ""), flush=True)


# on the APP, so all three listeners (admin, kiosk, bridge) inherit it — they
# are gateways wrapped around this same object
app.add_middleware(InstanceStamp)
app.add_middleware(FrozenAdminBoundary)
# LAST, therefore OUTERMOST: it must time the whole stack, including
# `FrozenAdminBoundary`'s own rejections, or it is measuring a subset again.
app.add_middleware(AccessRecord)


@app.exception_handler(RequestValidationError)
async def _validation_error(  # type: ignore[unused-function]  # registered by the decorator
        _request: Request, exc: RequestValidationError) -> Response:
    """FastAPI's default 422 echoes the offending value back as `input`, RAW.

    JSON may carry a lone surrogate (`"\\ud800"`), Python's decoder happily
    produces it, and the echo then kills the UTF-8 encode of the RESPONSE —
    turning a 422 into an uncaught UnicodeEncodeError, i.e. a 500, on every
    body-taking endpoint at once. (Handler-authored messages are safe: they
    interpolate with !r, which escapes it.)

    Same payload shape as the default handler — only the strings are made
    encodable, so nothing that reads a 422 today sees a difference."""
    def fix(v: Any) -> Any:
        if isinstance(v, str):
            return v.encode("utf-8", "replace").decode("utf-8")
        if isinstance(v, list):
            return [fix(x) for x in cast("list[Any]", v)]
        if isinstance(v, dict):
            return {k: fix(x) for k, x in cast("dict[str, Any]", v).items()}
        return v
    from fastapi.encoders import jsonable_encoder
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422,
                        content={"detail": fix(jsonable_encoder(exc.errors()))})


def _encodable(v: Any) -> Any:
    """Replace UNPAIRED SURROGATES anywhere in a decoded request body.

    ☠ This one is a persistent denial of service, not a cosmetic bug. JSON may
    contain `"\\ud800"`; Python's decoder accepts it into a str; `json.dump`
    writes it straight back out as an escape (ensure_ascii, so the SAVE
    succeeds); and every response that later includes that string dies in
    pydantic's UTF-8 serializer. One kiosk message body was enough to make
    GET /api/orgs/<slug>, /events, /chat and /inbox answer 500 for that org
    FOREVER — the poison is on disk and nothing removes it.

    So it is scrubbed at the only door it can arrive through: the request
    body, recursively, before validation — which covers free-form dicts
    (`args`, `max_scope`, `tools`) as well as declared string fields."""
    if isinstance(v, str):
        try:
            v.encode("utf-8")
            return v
        except UnicodeEncodeError:
            return v.encode("utf-8", "replace").decode("utf-8")
    if isinstance(v, list):
        return [_encodable(x) for x in cast("list[Any]", v)]
    if isinstance(v, dict):
        return {_encodable(k): _encodable(x)
                for k, x in cast("dict[Any, Any]", v).items()}
    return v


class Body(BaseModel):
    """Base for every request-body model — see _encodable."""

    @model_validator(mode="before")
    @classmethod
    def _scrub(cls, data: Any) -> Any:
        return _encodable(data)


# ---- kiosk v2 (user vision): preauthenticated public URLs. Each kiosk-enabled
# org carries a secret token; the PUBLIC listener serves nothing but
# /k/<token>/… — the token IS the authentication and maps to exactly one org.
# The admin app binds 127.0.0.1 only, so root access never leaves this machine.
# The gate is SERVER-SIDE — hiding UI buttons is not enforcement.
_TOKEN_RE = re.compile(r"^/k/([A-Za-z0-9_-]{8,64})(/.*)?$")
_PUBLIC_STATIC = ("/assets/", "/favicon", "/vite.svg")   # index.html's absolute refs
_token_cache: dict[str, Any] = {"at": 0.0, "map": {}}


def _kiosk_token_map() -> dict[str, str]:
    """token → slug for every kiosk-enabled org. Rebuilt on a short TTL and
    invalidated on any kiosk-config write, so rotation revokes instantly."""
    if time.time() - _token_cache["at"] > 5:
        m: dict[str, str] = {}
        # ONE parse per org, not two (see `store.list_orgs_with_docs`). An org
        # whose document will not read is still absent from the map — it is
        # dropped by the scan instead of by a `LedgerError` here — so an
        # unreadable org still fails CLOSED.
        for o, org in store.list_orgs_with_docs():
            k = org.d.get("kiosk") or {}
            if k.get("enabled") and k.get("token"):
                m[k["token"]] = o["slug"]  # type: ignore[typeddict-item]  # guard proves the key
        _token_cache.update(at=time.time(), map=m)
    return _token_cache["map"]


def _public_denied(method: str, rest: str, slug: str) -> tuple[int, str] | None:
    """The public restriction matrix, applied to the post-token path. Config
    surfaces are admin-only; all access is scoped to the token's own org."""
    # FastAPI's own routes sit OUTSIDE /api, so the "not /api ⇒ it's the SPA"
    # rule handed them to visitors: /k/<token>/openapi.json served the
    # complete 51 KB schema of every frozen admin endpoint and body model,
    # and /docs + /redoc served a working console for firing at them.
    if rest.rstrip("/") in ("/openapi.json", "/docs", "/redoc",
                            "/docs/oauth2-redirect"):
        return 404, "not found"
    if not rest.startswith("/api"):
        return None                              # the SPA itself
    if rest == "/api/orgs" and method == "GET":
        return None                              # handler filters to this org
    frozen_config = (
        (method == "POST" and rest == "/api/orgs")           # create org
        # ⚠ NOT a blanket `startswith("/api/orgs/")`: that also froze
        # DELETE …/nodes/…/mail/<id>, the mail-retraction button the visitor
        # UI renders unconditionally (desk.tsx) — a control that could only
        # ever 403. Freeze the org-delete route itself, which is the one this
        # clause was ever about.
        or (method == "DELETE"
            and re.fullmatch(r"/api/orgs/[^/]+", rest) is not None)
        or rest.endswith("/settings")                        # org settings
        # ⚠ the user's per-node override (ruling 2026-08-06). `node_unstick`
        # passes USER as the actor UNCONDITIONALLY, so this route IS the
        # authority boundary — `Org.unstick`'s user-only check can say
        # nothing about a request that arrives already wearing the user's
        # name. Unfrozen, a share-token holder could clear a fable halt and a
        # usage-limit freeze on any node of the org and re-drive it. (The
        # org-level spend_frozen flag is checked separately at turn start and
        # unstick does not touch it, so this was never a way past the spend
        # cap — only past every other lock the owner relies on.)
        or rest.endswith("/unstick")                         # user-only override
        # /scope is OPEN (ceiling spec §2): visitors retool freely WITHIN the
        # kiosk permission ceiling — the ledger clamps, never a 403 here
        or rest.endswith("/kiosk")                           # kiosk caps/token/ceiling
        # the PostToolUse steer fetch: an agent-process path, authorised by
        # loopback or the bridge secret, never by a browser (the frontend has
        # no call site for it). Reachable from the kiosk it POPPED the node's
        # pending mid-task mail — reading it AND destroying the delivery.
        or rest.endswith("/steer")
        or rest.endswith("/steer/ack")                       # its receipt door (D1)
        # The warm-process toggle kills/spawns host CLI processes and is an
        # admin-only control. Public desks still receive passive lifecycle
        # status, but a kiosk token must never be able to use it as a DoS or
        # process-spawn surface.
        or rest.endswith("/process")
        # The rename repair takes the ACTOR off the wire (that is how the
        # renamed agent, not only the user, can put its own stranded records
        # back), so the ledger's authority check is the whole bound and this
        # matrix is what keeps a share-token holder from simply claiming to
        # be the user. It rewrites ownership of documents and work items:
        # admin-only, like every other repair surface.
        or rest.endswith("/repair-rename")
        or rest == "/api/fs"                                 # filesystem browse
        or re.match(r"^/api/orgs/[^/]+/git(?:/|$)", rest) is not None
        or (method == "PUT" and rest.endswith("/orgmd"))     # org.md edits
        # rewrites the whole docket and writes a JSON export to disk — an
        # operator control, frozen explicitly like `/settings` beside it
        or rest.endswith("/migrate-work-identity")
        or rest == "/api/agent"                              # node MCP gateway
        or rest == "/api/mcp-servers"
        # machine-local account routing (2026-08-25): which accounts this
        # machine may bill — and their usage standings — is machine-global
        # admin config, none of a visitor's business. The trailing
        # `parts[2] == "orgs"` test below would 404 these anyway — frozen
        # EXPLICITLY because an incidental 404 is not an access rule, and the
        # next person to touch that test would not know they were holding
        # this up.
        or rest.startswith("/api/accounts")
        or rest.startswith("/api/providers")
        or rest.startswith("/api/app-settings")
        # Frozen bridge rotation/attestation is an operator control. A kiosk
        # bearer must never rotate the sandbox's own bridge identity or read
        # its generation/fingerprint receipt.
        or re.fullmatch(
            r"/api/orgs/[^/]+/bridge-credential(?:/rotate)?", rest) is not None
    )
    if frozen_config:
        return 403, "kiosk: configuration is managed from the admin side"
    parts = rest.split("/")
    if not (len(parts) > 3 and parts[2] == "orgs" and parts[3] == slug):
        return 404, "not found"                  # other orgs, other surfaces
    return None


class PublicGateway:
    """ASGI wrapper served ONLY on the public port: resolves /k/<token>,
    rewrites the path so the normal routes handle it, stamps the request state
    with the org slug, and 404s everything else — no org list, no discovery."""

    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner

    async def __call__(self, scope: ASGIScope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            # the admin server owns the app's lifespan — running FastAPI
            # startup twice would double-wire notify + reconcile
            while True:
                msg = await receive()
                if msg["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif msg["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] not in ("http", "websocket"):
            return await self.inner(scope, receive, send)
        path = scope.get("path", "")
        if scope["type"] == "http" and path.startswith(_PUBLIC_STATIC):
            return await self.inner(scope, receive, send)
        m = _TOKEN_RE.match(path)
        slug = _kiosk_token_map().get(m.group(1)) if m else None
        if not slug:
            return await self._reject(scope, send, 404, "not found")
        rest = m.group(2) or "/"  # type: ignore[union-attr]  # slug non-None ⇒ m matched
        deny = _public_denied(scope.get("method", "GET"), rest, slug)
        if deny:
            return await self._reject(scope, send, deny[0], deny[1])
        scope = dict(scope)
        scope["path"] = rest
        scope["raw_path"] = rest.encode()
        scope["state"] = {**(scope.get("state") or {}), "public_slug": slug}
        await self.inner(scope, receive, send)

    async def _reject(self, scope: ASGIScope, send: Send, code: int, detail: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4000 + code})
            return
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": code,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def _public_slug(request: Request | None) -> str | None:
    return getattr(request.state, "public_slug", None) if request is not None else None


# A free-form `dict[str, Any]` off the wire (max_scope, tools, add_dirs) hits
# ledger normalizers that assume the documented SHAPE — `{"tools": 5}` came
# back out as an AttributeError, i.e. a 500 rather than a 422. Pydantic can't
# help: the field really is Any. Catch the shape errors where the untyped dict
# crosses into the ledger, and only there.
_BAD_SHAPE = (TypeError, AttributeError, ValueError, KeyError, IndexError)


def _no_nul(path: str) -> str:
    """Refuse an embedded NUL before it reaches os.path.

    Every path-taking endpoint funnels into `os.path.realpath`, and on Windows
    that raises `ValueError: embedded null character` from inside ntpath —
    below every `except OSError` in this file, so it surfaced as a bare 500.
    One `?path=%00` did it on /scratch, /file, /disk/file, /disk/delete and the
    message-attachment stager. A refusal is the contract; a 500 is not."""
    if "\x00" in path:
        raise HTTPException(422, "path contains a null byte")
    return path


# ---- the sandbox bridge: the ONE door out of a kiosk container. Serves only
# the agent gateway + the steering fetch, gated by either the standard
# deployment's legacy org secret or a frozen deployment's rotatable org token.
_bridge_cache: dict[str, Any] = {"at": 0.0, "map": {}}
_STEER_RE = re.compile(r"^/api/orgs/([a-z0-9@-]+)/nodes/([^/]+)/steer$")


def _bridge_secret_map() -> dict[str, str]:
    if time.time() - _bridge_cache["at"] > 5:
        m: dict[str, str] = {}
        # ONE parse per org, not two — and fails closed on an unreadable org
        # for the same reason as `_kiosk_token_map` above.
        for o, org in store.list_orgs_with_docs():
            d = org.d
            # kiosk sandboxes and normal-org sandboxes alike (user ruling)
            for s in ((d.get("kiosk") or {}).get("sandbox_secret"),
                      (d.get("sandbox") or {}).get("secret")):
                if s:
                    m[s] = o["slug"]
        _bridge_cache.update(at=time.time(), map=m)
    return _bridge_cache["map"]


class BridgeGateway:
    """ASGI wrapper served ONLY on the bridge port (containers reach it via
    host.docker.internal): everything except the two sanctioned paths is a
    bare 403. Every credential pins an org. Nodes inside one sandbox are
    mutually trusted here because they share a root-capable container; the
    frozen bearer is rotatable but is not a per-node isolation boundary."""

    def __init__(self, inner: ASGIApp) -> None:
        # In a real frozen launch this constructor runs while assembling the
        # bridge listener. Mint/read the host-only key now so an unwritable or
        # malformed credential store refuses startup, before any request.
        if not bridgeauth.legacy_credentials_allowed():
            bridgeauth.install_key()
        self.inner = inner

    async def __call__(self, scope: ASGIScope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            while True:                      # the admin server owns app lifespan
                msg = await receive()
                if msg["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif msg["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            await send({"type": "websocket.close", "code": 4403})
            return
        secret = ""
        raw_headers: list[tuple[bytes, bytes]] = scope.get("headers") or []
        for hk, hv in raw_headers:
            if hk == b"x-orgtree-bridge":
                secret = hv.decode("latin1")
        path, method = scope.get("path", ""), scope.get("method", "GET")
        # proxied-subscription traffic carries the secret IN THE PATH — the
        # CLI can set a base URL but not custom headers we control
        rewritten = None
        pm = re.match(r"^/anthropic/([^/]+)(/.*)$", path)
        if pm:
            secret = pm.group(1)
            rewritten = "/anthropic" + pm.group(2)
        slug = bridgeauth.resolve_org_credential(secret) if secret else None
        legacy = False
        if slug is None and secret and bridgeauth.legacy_credentials_allowed():
            slug = _bridge_secret_map().get(secret)
            legacy = slug is not None
        if slug is not None and not legacy:
            try:
                # A persisted forbidden selector or copied subscription file
                # invalidates even an already-running sandbox's bridge access.
                # This is deliberately before every allowed route.
                sandbox.container_auth(store.load_org(slug))
            except (LedgerError, deployment.DeploymentConfigError):
                slug = None
        m = _STEER_RE.match(path)
        steer_ok = bool(m and m.group(1) == slug)
        allowed = slug and (
            rewritten is not None
            or (method == "POST"
                and (path == "/api/agent" or steer_ok)))
        if not allowed:
            body = json.dumps({"detail": "forbidden"}).encode()
            await send({"type": "http.response.start", "status": 403,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        scope = dict(scope)
        if rewritten is not None:
            scope["path"] = rewritten
            scope["raw_path"] = rewritten.encode()
        scope["state"] = {**(scope.get("state") or {}),
                          "bridge_slug": slug,
                          "bridge_scope": "legacy-org" if legacy else "org",
                          "bridge_legacy": legacy}
        await self.inner(scope, receive, send)


_LAN_IP: str | None = None
_origin_cache: dict[str, Any] = {"at": 0.0, "val": ""}


def _public_origin() -> str:
    """ORGTREE_PUBLIC_ORIGIN wins; otherwise the live tunnel hostname that
    expose.ps1 drops into <data>/.public_origin (TryCloudflare quick-tunnel
    URLs change per run, so this is re-read on a short TTL)."""
    if PUBLIC_ORIGIN:
        return PUBLIC_ORIGIN
    if time.time() - _origin_cache["at"] > 5:
        _origin_cache["at"] = time.time()
        try:
            _origin_cache["val"] = open(
                os.path.join(store.DATA_ROOT, ".public_origin"),
                encoding="utf-8").read().strip()
        except OSError:
            _origin_cache["val"] = ""
    return _origin_cache["val"]


def _share_url(token: str | None) -> str | None:
    """The preauthenticated URL for a kiosk token: explicit origin, else the
    running tunnel's hostname, else best-guess this machine's LAN address."""
    global _LAN_IP
    if (not deployment.current_policy().allow_public_listener
            or not token or not PUBLIC_PORT):
        return None
    origin = _public_origin()
    if origin:
        return f"{origin.rstrip('/')}/k/{token}"
    if _LAN_IP is None:
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            _LAN_IP = s.getsockname()[0]  # type: ignore[constant-redefinition]  # lazily-computed cache, not a constant
            s.close()
        except OSError:
            _LAN_IP = "127.0.0.1"  # type: ignore[constant-redefinition]  # lazily-computed cache, not a constant
    return f"http://{_LAN_IP}:{PUBLIC_PORT}/k/{token}"


def _kiosk_cap_check(org: Org) -> None:
    """Kiosk credit cap: NO operation may push total top-level holdings past
    the cap — covers hires, §4.6 cascades, rehires, reallocations and
    credit-request approvals in one invariant (checked before save). Applies
    to admin actions too: one invariant, and the admin can raise the cap."""
    k = supervisor.kiosk_cfg(org)
    if k and int(k.get("credits") or 0) > 0:
        held = org.audit()["top_level_holds"]
        if held > int(k["credits"]):  # type: ignore[typeddict-item]  # guard above proves the key
            raise LedgerError(
                f"kiosk credit cap: the org may hold at most "
                f"{int(k['credits'])} credits (this would make it {held:g})")  # type: ignore[typeddict-item]


mail_notify: Callable[[str, str, str], None] = \
    lambda slug, frm, to: None   # wired at startup (thread-safe fanout)


def _external_candidates(name: str) -> dict[str, list[str]]:
    """Bare-name transport resolution (user ruling 2026-08-05, relayed via
    the redteam): the outside knowledge the hermetic ledger cannot hold.
    `org` = local orgs whose slug matches exactly (sealed kiosks answer like
    nonexistent orgs, same as interorg_send); `net` = hub peers whose full
    slug OR leading name segment matches. The @mcp: tier lives in the org's
    own correspondence log, resolved ledger-side."""
    out: dict[str, list[str]] = {"org": [], "net": []}
    try:
        for o in store.list_orgs():
            if o.get("slug") == name:
                try:
                    if store.load_org(name).d.get("kiosk") is not None:
                        continue
                except LedgerError:
                    continue
                out["org"].append(name)
    except OSError:
        pass
    for p in net.remote_peers():
        s = str(p.get("slug") or "")
        s = s[5:] if s.startswith("@net:") else s
        if s == name or s.split(".")[0] == name:
            out["net"].append(s)
    return out


ledger_mod.external_candidates = _external_candidates


@app.on_event("startup")  # type: ignore[deprecated]  # migrating to lifespan is a runtime change (D-079: inert wave)
async def _wire_notify() -> None:  # type: ignore[unused-function]  # registered by the decorator
    global mail_notify, _LOOP
    # A direct ``uvicorn orgtree.api:app`` launch bypasses main(), so repeat
    # the install-wide preflight at the ASGI lifecycle boundary. It must run
    # before warm processes or background drivers can admit a turn.
    _deployment_preflight()
    # Mark that THIS process began watching the Antigravity lane. Without it
    # the window record cannot tell "orgtree was down, a wall may have passed
    # unseen" from "nothing happened", and every reconstructed window would
    # claim a coverage it never had. On its own thread because the marker
    # first asks whether this machine even has the CLI, and that answer costs
    # a subprocess on a cold cache: it must not sit in front of the warm pool.
    threading.Thread(target=antigravity_limits.note_boot,
                     name="agy-boot-mark", daemon=True).start()
    loop = asyncio.get_running_loop()
    _LOOP = loop  # type: ignore[constant-redefinition]  # captured-at-startup cell, not a constant
    try:
        # hook processes get a sanitized env — the steering hook finds us here
        open(os.path.join(store.DATA_ROOT, ".port"), "w",
             encoding="utf-8").write(str(PORT))
    except OSError:
        pass

    def notify(slug: str, node: str, event: str,
               detail: dict[str, Any] | None = None) -> None:
        asyncio.run_coroutine_threadsafe(
            hub.node_event(slug, node, event, detail), loop)

    def _mail(slug: str, frm: str, to: str) -> None:
        # pure animation signal for the UI (spark on the wire) — no state rides on it
        asyncio.run_coroutine_threadsafe(
            hub._send(slug, {"type": "mail", "org": slug, "from": frm, "to": to}),
            loop)

    mail_notify = _mail

    def stream(slug: str, node: str, payload: dict[str, Any]) -> None:
        payload = supervisor.capture_reply_stream(slug, node, payload)
        asyncio.run_coroutine_threadsafe(
            hub._send(slug, {"type": "node_stream", "org": slug, "node": node,
                             **payload}), loop)

    supervisor.notify = notify
    supervisor.stream = stream
    supervisor.mail_spark = _mail
    # G2: every persisted change announces itself, from wherever it was made —
    # an endpoint, an agent's MCP call, the supervisor's own turn bookkeeping.
    # The explicit hub_changed() calls left at a few endpoints are now
    # redundant but harmless (they coalesce into the same window).
    store.on_save = hub_changed
    # D-201: the warm pool starts FIRST, before every turn driver below
    # (auto-resume, the usage/watchdog engines, reconcile's re-drives), and
    # its first pass runs synchronously inside this call. The user's ruling
    # is "start all active agents' processes immediately on orgtree launch,
    # BEFORE a turn begins" — an ordering where any driver can admit a turn
    # ahead of the boot pre-warm makes the feature absent at exactly the
    # moment it was specified to be present, on every restart. Pinned by
    # test_warmpool's startup-order check.
    warmpool.start_warm_pool()
    supervisor.start_auto_resume_loop()
    # user ruling 2026-08-18: keep the subscription's usage readout warm, so a
    # usage freeze can stamp its reset time from cache instead of blocking the
    # document lock on a >1 s fetch (limits.py owns the cadence)
    supervisor.start_usage_warm_loop()
    # storage watchdog (user spec): catches single long tool calls —
    # clones/builds/downloads — that balloon past the limit MID-CALL
    supervisor.start_storage_watchdog()
    # (the chatq external bridge that used to register every org here is
    # GONE — user ruling 2026-08-05: @ext: retired, chats ride the hub)
    # F-06: the mail-hub client — connectivity TRANSITIONS broadcast an org
    # `changed` so the UI's status dots are realtime without polling
    net.notify_changed = hub_changed
    net.start_net_client()
    # compose-stage sweep: in-memory ids died with the last process, so every
    # file already in <data>/net_stage is unreachable — remove them all
    _prune_stage(max_age_s=0.0)
    # §9.2: warn EARLY when the subscription's refresh token nears expiry —
    # an unattended box discovers an auth lapse as a pile of failed turns
    supervisor.start_cred_watcher()
    # FR-18: the watchdog scanner — polls due dogs and re-arms stream dogs'
    # children, which is also their restart-recovery (the doc is the registry)
    supervisor.start_watchdog_engine()
    supervisor.start_extern_sweeper()          # D-166
    # D-236: a mid-turn message whose recipient is inside a long tool call has
    # no injection point until that call ends — this is what tells the SENDER,
    # which is the half no answer available at send time could give.
    supervisor.start_steer_late_watchdog()
    # FR-27: the primed-restart engine. Same shape and same reason as the
    # watchdog scanner above — the durable record is the registry and this is
    # only its runtime attachment, which is exactly what makes an armed prime
    # survive the bounce that just brought us up here.
    supervisor.start_prime_restart_engine()
    # one-time migration of the retired v1 env-var kiosk mode into the org doc
    legacy = os.environ.get("ORGTREE_KIOSK")
    if legacy:
        try:
            with store.DOC_LOCK:
                org = store.load_org(legacy)
                if not org.d.get("kiosk"):
                    org.d["kiosk"] = {
                        "enabled": True, "token": secrets.token_hex(16),
                        "credits": int(os.environ.get("ORGTREE_KIOSK_CREDITS", "0") or 0),
                        "spend_limit": float(os.environ.get("ORGTREE_KIOSK_SPEND_LIMIT", "0") or 0),
                        "storage_limit_mb": 0,
                    }
                    store.save_org(org)
            print(f"[orgtree] ORGTREE_KIOSK is retired — {legacy!r} is now a kiosk "
                  f"org (secret URL on the admin dashboard); set "
                  f"ORGTREE_PUBLIC_PORT to expose it")
        except LedgerError:
            print(f"[orgtree] ORGTREE_KIOSK={legacy!r}: no such org — ignored")
    # D-219 one-shot heal: an old 'plan' org default left 'plan' stamped in
    # node scopes, and a headless plan-mode agent is mute — every bare rehire
    # of a stamped expert stalled (user incident 2026-09-01). Runs before
    # reconciliation so re-driven turns spawn with the healed mode.
    for o in store.list_orgs():
        healed: list[str] | None = None
        try:
            with store.DOC_LOCK:
                horg = store.load_org(o["slug"])
                healed = horg.heal_plan_stamps()
                if healed is not None:
                    store.save_org(horg)
        except Exception as e:                       # noqa: BLE001
            print(f"[orgtree] {o['slug']}: plan-stamp heal failed ({e})")
        if healed:
            print(f"[orgtree] {o['slug']}: healed permission_mode "
                  f"'plan' → 'acceptEdits' on {len(healed)} node(s)")
    for o in store.list_orgs():                   # №31 eager reconciliation
        marked = supervisor.reconcile(o["slug"], active_only=True)
        if marked:
            print(f"[orgtree] {o['slug']}: marked unrecoverable at startup: {marked}")
    # Durable `working` statuses survive the restart. Start their cache keeper
    # only after reconciliation classifies missing sessions and re-drives
    # interrupted work, so maintenance cannot race startup repair.
    supervisor.start_working_cache_keeper()
    restart_wake.on_backend_startup()

PORT = int(os.environ.get("ORGTREE_PORT", "7360"))
PUBLIC_PORT = int(os.environ.get("ORGTREE_PUBLIC_PORT", "0") or 0)
PUBLIC_ORIGIN = (os.environ.get("ORGTREE_PUBLIC_ORIGIN") or "").strip()
FRONTEND_DIST = os.path.normpath(os.environ.get("ORGTREE_V2_UI_DIR") or
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))


# ------------------------------------------------------------------ websocket
class Hub:
    """Per-org 'something changed' fanout. Payloads are deliberately dumb — the UI
    refetches the tree; the ledger stays the single source of truth."""

    def __init__(self) -> None:
        self.rooms: dict[str, set[WebSocket]] = {}
        # sockets that joined through the PublicGateway (kiosk visitors): a live
        # payload carrying typed segments is projected for them (design §6) —
        # the room is shared, the projection is not
        self.public: set[WebSocket] = set()

    async def join(self, slug: str, ws: WebSocket, *, public: bool = False) -> None:
        await ws.accept()
        self.rooms.setdefault(slug, set()).add(ws)
        if public:
            self.public.add(ws)

    def leave(self, slug: str, ws: WebSocket) -> None:
        self.rooms.get(slug, set()).discard(ws)
        self.public.discard(ws)

    async def _send(self, slug: str, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        raw_segments = payload.get("segments_raw")
        admin_payload = payload
        public_payload = payload
        if raw_segments is not None:
            # journal-form segments never leave the process: each socket gets its
            # profile's wire projection (operator: full events; visitor: PublicEvent)
            base = {k: v for k, v in payload.items() if k != "segments_raw"}
            admin_payload = {**base, "segments": events.wire_segments(raw_segments, public=False)}
            public_payload = {**base, "segments": events.wire_segments(raw_segments, public=True)}
        for ws in self.rooms.get(slug, set()):
            try:
                await ws.send_json(public_payload if ws in self.public else admin_payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.leave(slug, ws)

    async def changed(self, slug: str) -> None:
        await self._send(slug, {"type": "changed", "org": slug})

    async def node_event(self, slug: str, node: str, event: str,
                         detail: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"type": "node_event", "org": slug,
                                   "node": node, "event": event}
        if detail:
            payload.update(detail)
        await self._send(slug, payload)


hub = Hub()
# captured at startup — threadsafe broadcasts from sync code
_LOOP: asyncio.AbstractEventLoop | None = None


_BCAST_COALESCE = 0.4      # seconds; see hub_changed
_bcast_pending: set[str] = set()
_bcast_lock = threading.Lock()


def hub_changed(slug: str) -> None:
    """Schedule a 'changed' broadcast from any thread (№22: the heavyweight
    endpoints are plain `def` now — they run in the threadpool and can't
    await).

    G2: this is now driven by `store.save_org` itself rather than by ~30
    endpoints remembering to call it, which means it fires far more often —
    a single turn writes the doc many times (mail drain, budget, status,
    journal). So it COALESCES: the first save opens a 0.4 s window and every
    save inside that window rides the same broadcast. The clients refetch a
    ~4 KB tree, so the worst case is ~2.5 refetches/second/org under sustained
    writes, and the common case is one broadcast per burst.
    """
    if _LOOP is None:
        return
    with _bcast_lock:
        if slug in _bcast_pending:
            return                      # a broadcast is already coming
        _bcast_pending.add(slug)

    async def _fire() -> None:
        await asyncio.sleep(_BCAST_COALESCE)
        with _bcast_lock:
            _bcast_pending.discard(slug)
        await hub.changed(slug)

    asyncio.run_coroutine_threadsafe(_fire(), _LOOP)


# ---------------------------------------------------------------------- orgs
class KioskSpec(Body):
    credits: int = 30                 # top-level holdings cap (user ruling)
    spend_limit: float = 50.0         # USD hard limit (user ruling 2026-07-31)
    storage_limit_mb: int = 4096      # sandboxed: the org DISK size (4096 MB
                                      # floor, user ruling 2026-08-01);
                                      # unsandboxed: loose workspace+scratch cap
    sandbox: bool = True              # run agent turns in a Docker container
    # ceiling spec §3: the permission ceiling is visible/editable AT CREATION —
    # the default is permissive (mcp "*", user ruling), so narrowing it must
    # be a conscious act rather than something discovered later
    max_scope: dict[str, Any] | None = None   # None = the default ceiling
    auto_raise: bool = False          # admin over-ceiling grants auto-raise it
    # auth is NOT configurable (user ruling): every sandbox uses the proxied
    # subscription — the host attaches the token, the sandbox never sees it


class OrgCreate(Body):
    name: str
    dirs: list[str] = []
    permission_mode: str = "acceptEdits"
    kiosk: KioskSpec | None = None    # present = the org is BORN a kiosk
    sandbox: bool = False             # normal orgs may sandbox too (user ruling)
    disk_mb: int | None = None        # sandboxed non-kiosk orgs: virtual-disk
                                      # size (≥4096; None = DISK_MB fallback)
    net_autoconnect: bool = True      # F-06: join the LOCAL mail hub (creation
                                      # checkbox; not gated on hub detection)
    net_hubs: list[str] = []          # F-06: remote hub addresses, typed
                                      # explicitly (names discovered on connect)


@app.get("/api/orgs")
def orgs_list(request: Request) -> list[dict[str, Any]]:
    pub = _public_slug(request)
    if pub:
        # public visitors see exactly their token's org — nothing to discover,
        # and no document body needed, so this branch keeps the cheap listing
        return [{**o, "kiosk": True} for o in store.list_orgs()
                if o["slug"] == pub]
    # admin: attach the kiosk dashboard summary (incl. the secret token —
    # this listener is loopback-only).
    #
    # ONE parse per org, not two. This used to call `store.list_orgs()` (which
    # reads and parses every org document) and then `store.load_org()` per org
    # (which parses every one of them again) — 168 ms per request against this
    # machine's 18.53 MB data root, on a route the desk polls every 3 s.
    out: list[dict[str, Any]] = []
    for o, org in store.list_orgs_with_docs():
        row = {**o, "cost_usd_total": org.cost_total(),
               # F-09: agents with a running turn. Deliberately absent from the
               # public/kiosk branch above — visitors don't see how busy an org is.
               "working": supervisor.working_count(o["slug"])}
        k = org.d.get("kiosk")
        if k:
            row["kiosk_cfg"] = {
                "enabled": bool(k.get("enabled")),
                "token": k.get("token"),
                "credits": int(k.get("credits") or 0),
                "spend_limit": float(k.get("spend_limit") or 0),
                "storage_limit_mb": int(k.get("storage_limit_mb") or 0),
                "spend_frozen": bool(org.d.get("spend_frozen")),
                "storage_blocked": bool(org.d.get("storage_blocked")),
                "sandbox": bool(k.get("sandbox")),
                "held": org.audit()["top_level_holds"],
                # stale-served + background-refreshed: the walk never runs on
                # the request path (arti's took ~7 s and stalled every load)
                "storage_mb": (round(u / 1048576, 2)
                               if (u := supervisor.workspace_usage_cached(org))
                               is not None else None),
                "share_url": _share_url(k.get("token")),
            }
        out.append(row)
    return out


def _bridge_credential_attestation(slug: str, request: Request) -> dict[str, Any]:
    """Admin-only, secret-free state for the frozen per-org bridge bearer."""
    if _public_slug(request):
        raise HTTPException(403, "bridge credentials are operator-managed")
    if deployment.current_policy().allow_legacy_sandbox_credentials:
        raise HTTPException(
            409, "rotatable bridge credentials are active only in the frozen "
                 "deployment profile")
    try:
        org = store.load_org(slug)
        # Retain the authoritative frozen selector/copied-file checks before
        # reporting this sandbox as ready.
        sandbox.container_auth(org)
        return bridgeauth.credential_attestation(org)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    except deployment.DeploymentConfigError as e:
        raise HTTPException(409, str(e))
    except bridgeauth.BridgeCredentialError as e:
        raise HTTPException(503, str(e))


@app.get("/api/orgs/{slug}/bridge-credential")
def bridge_credential_status(slug: str, request: Request) -> dict[str, Any]:
    """Inspect the frozen org credential without returning the bearer."""
    return _bridge_credential_attestation(slug, request)


@app.post("/api/orgs/{slug}/bridge-credential/rotate")
async def bridge_credential_rotate(
        slug: str, request: Request) -> dict[str, Any]:
    """Rotate one frozen org bearer and prove the planted old one is dead."""
    _bridge_credential_attestation(slug, request)
    try:
        receipt = bridgeauth.rotate_org_credential(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    except deployment.DeploymentConfigError as e:
        raise HTTPException(409, str(e))
    except bridgeauth.BridgeCredentialError as e:
        raise HTTPException(503, str(e))
    await hub.changed(slug)
    return {**receipt, "existing_processes_must_refresh": True}


@app.post("/api/orgs")
def orgs_create(body: OrgCreate) -> dict[str, Any]:
    from . import desktop_policy
    try:
        desktop_policy.validate(body.model_dump())
        desktop_policy.validate(load_org_defaults())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    policy = deployment.current_policy()
    # Validate global defaults before create_org writes a workspace or doc.
    dflt = load_org_defaults()
    default_kiosk = (dflt.get("kiosk")
                      if isinstance(dflt.get("kiosk"), dict) else {})
    if not policy.allow_legacy_sandbox_credentials and (
            str(dflt.get("api_key") or "").strip().lower() == "subscription"
            or str(default_kiosk.get("api_key") or "").strip().lower()
            == "subscription"):
        raise HTTPException(
            422, "the frozen deployment profile forbids the 'subscription' "
                 "sandbox auth value in org defaults; use proxied auth or an "
                 "explicit API key")
    requested_sandbox = (bool(body.kiosk.sandbox)
                         if body.kiosk is not None else bool(body.sandbox))
    if policy.require_sandboxed_orgs and not requested_sandbox:
        raise HTTPException(
            422, "the frozen deployment profile requires every org to be "
                 "sandboxed — create this org with sandbox enabled")
    # sandboxed orgs ride a fixed-size virtual disk with a 4096 MB minimum
    # (the system seed and transcripts count inside the cap) — refuse smaller
    # limits at creation instead of silently flooring them at migration
    # (user ruling 2026-08-01)
    if body.kiosk is not None and body.kiosk.sandbox \
            and int(body.kiosk.storage_limit_mb) < 4096:
        raise HTTPException(422, "sandboxed orgs ride a fixed-size disk with "
                                 "a 4096 MB minimum — set storage to at "
                                 "least 4096 MB")
    if body.kiosk is None and body.sandbox and body.disk_mb is not None \
            and int(body.disk_mb) < 4096:
        raise HTTPException(422, "sandboxed orgs ride a fixed-size disk with "
                                 "a 4096 MB minimum — set disk_mb to at "
                                 "least 4096")
    try:
        org = store.create_org(body.name, body.dirs, body.permission_mode)
    except LedgerError as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        # create_org mkdirs the workspace before the ledger ever sees the
        # name; a name the host filesystem refuses (too long, a reserved
        # device name, an unwritable data root) surfaced as a bare 500
        raise HTTPException(422, f"could not create the org's workspace: {e}")
    # global default org settings (user spec): every new org is born with them.
    # net_hub_address is CONFIG for the local hub entry, not an org-doc key —
    # popped here and translated below, never written raw into the doc.
    # ⚠ THE FALLBACK IS net._default_address(), NEVER
    # DEFAULT_HUB_ADDRESS RAW. This line held the second implementation of
    # "which hub does a new org point at", and the two disagreed the moment
    # one of them grew a floor: _default_address refuses the operator's real
    # hub for a data root under the OS temp directory, and this did not, so
    # a test rig's fixture orgs were still born pointing straight at it.
    # MEASURED 2026-09-04 in a throwaway root: _default_address() answered
    # the discard port while an org created through THIS endpoint came out
    # holding http://127.0.0.1:7370. The pop stays — it is what keeps the
    # key out of the org doc — and only the fallback moves, which also
    # puts the explicit value in exactly one place instead of two.
    # The Luna pool-order preference is app-wide, unlike the other
    # org-creation defaults above. Keep it in defaults.json and out of each
    # org document so an absent per-agent preference remains live-inherited.
    dflt.pop("prefer_reserve", None)
    local_hub_addr = str(dflt.pop("net_hub_address", "") or "") \
        or net._default_address()
    if dflt:
        with store.DOC_LOCK:
            org.d.update(dflt)  # type: ignore[arg-type]  # defaults.json holds org-doc-shaped keys
            store.save_org(org)
    if body.kiosk is not None:
        # kiosk orgs are a DISTINCT TYPE, born as kiosks with their limits
        # defined at creation (user ruling) — never converted from a normal
        # org. Token + sandbox secret are minted with the org.
        with store.DOC_LOCK:
            o = store.load_org(org.d["slug"])
            o.d["kiosk"] = {
                "enabled": True,
                "token": secrets.token_hex(16),
                "credits": max(0, int(body.kiosk.credits)),
                "spend_limit": max(0.0, float(body.kiosk.spend_limit)),
                "storage_limit_mb": max(0, int(body.kiosk.storage_limit_mb)),
                "sandbox": bool(body.kiosk.sandbox),
                "sandbox_secret": secrets.token_hex(16),
                "auto_raise": bool(body.kiosk.auto_raise),
                "max_scope": None,     # set via the normalizer just below
            }
            try:
                prov = body.kiosk.max_scope
                if prov is not None and "add_dirs" not in prov:
                    # the create dialog edits tools/vis/pm; dir bounds default
                    # to the org's own folders unless explicitly stated
                    prov = {**prov,
                            "add_dirs": o.default_kiosk_ceiling()["add_dirs"]}
                o.d["kiosk"]["max_scope"] = o._norm_ceiling(
                    prov if prov is not None else o.default_kiosk_ceiling())
            except (LedgerError, *_BAD_SHAPE) as e:
                # unwind: without this, the org survived its own failed
                # creation as a non-kiosk org (registered + saved above)
                # while the 422 told the caller nothing was made
                # ⚠ A NARROW RACE, closed for the same reason the
                # delete endpoint takes the polite exit: this org was
                # saved as a NON-kiosk one, and the net poller mints an
                # identity and registers any non-kiosk org it finds. If
                # a pass landed in that window the unwind would leave a
                # roster row for an org that never finished being made.
                # Snapshot before the rename; never let it fail the
                # unwind, which is already an error path.
                try:
                    _doc = dict(store.load_org(org.d["slug"]).d)
                except LedgerError:
                    _doc = {}
                store.delete_org(org.d["slug"])
                if _doc:
                    net.unregister_org(_doc)
                raise HTTPException(422, str(e))
            # a capped org never inherits the 50-credit hire pre-fill (user
            # report: the first hire swallowed the whole pool) — grants in a
            # kiosk are deliberate drags; the admin can set a sub-cap default
            o.d["default_top_grant"] = 0
            store.save_org(o)
            if o.d["kiosk"]["sandbox"]:
                sandbox.warm(o)        # prebuild image+container in background
        _token_cache["at"] = 0.0
        _bridge_cache["at"] = 0.0
    elif body.sandbox:
        # a sandboxed NORMAL org (user ruling): same container isolation,
        # no kiosk limits or public URL
        with store.DOC_LOCK:
            o = store.load_org(org.d["slug"])
            o.d["sandbox"] = {"enabled": True, "secret": secrets.token_hex(16),
                              **({"limit_mb": int(body.disk_mb)}
                                 if body.disk_mb is not None else {})}
            store.save_org(o)
            sandbox.warm(o)
        _bridge_cache["at"] = 0.0
    if body.kiosk is None:
        # F-06: non-kiosk orgs mint their permanent network identity at birth
        # (kiosks are sealed and mint none). The hub list starts with the
        # local entry (unless opted out) plus any typed remote addresses.
        with store.DOC_LOCK:
            o = store.load_org(org.d["slug"])
            net.mint_identity(o)
            o.d["net_autoconnect"] = bool(body.net_autoconnect)
            o.d["net_hubs"] = net.hub_entries(
                body.net_autoconnect, body.net_hubs, local_hub_addr)
            store.save_org(o)
    return {"slug": org.d["slug"]}


@app.delete("/api/orgs/{slug}")
def orgs_delete(slug: str) -> dict[str, Any]:
    # THE POLITE EXIT, taken BEFORE the document is renamed away (2026-09-04).
    # An org's roster row on a mail hub outlived the org by up to
    # ORG_RETENTION_DAYS, and the compose picker went on offering it as a
    # recipient that can never receive anything — the user's own 2026-08-06
    # complaint arriving by a second road. The hub's /api/unregister has
    # existed since that same wave; nothing here ever called it.
    #
    # The snapshot is read first because unregistering needs the identity
    # SECRET, and delete_org renames the document out from under us. Only the
    # holder of that secret can prove the org is gone — which is why this is a
    # polite exit by the owner rather than a sweep by an observer.
    try:
        doc = dict(store.load_org(slug).d)
    except LedgerError:
        doc = {}                       # unloadable: delete_org still decides
    try:
        store.delete_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    # ⚠ AFTER the delete has succeeded, and it can NEVER fail one. A hub that
    # is down, slow or gone is an ordinary condition; an org that could not be
    # deleted because some unrelated machine was unreachable would be a worse
    # defect than a stale row, and the row still ages out on the hub's own
    # retention. Errors are reported in the response, not raised.
    net_exit = net.unregister_org(doc) if doc else {"unregistered": []}
    # state-only purge: delete is a reversible rename, so scratch dirs stay
    # (a restore brings the files back) but runtime state must die with the
    # org or a restore resurrects phantom busy/queued agents.
    # ⚠ The org's own net_identity is NOT touched, deliberately: a RESTORE
    # re-registers on the next 401 with the same secret and the hub re-mints
    # the identical address (net._clear_registration).
    supervisor.forget_state(slug)
    supervisor.remote_reap(slug)     # FR-01: no server outlives its org
    sandbox.remove(slug)            # container down; files stay (like scratch)
    return {"ok": True, "net": net_exit}


@app.get("/api/net/probe")
def net_probe(request: Request, address: str = "") -> dict[str, Any]:
    """F-06: is a hub reachable at this address RIGHT NOW? A creation-form
    HINT only — the auto-connect checkbox never gates on it (a hub that is
    down at config time still gets configured; the daemon retries forever)."""
    if _public_slug(request):
        raise HTTPException(404, "not found")
    addr = address.strip() or net.DEFAULT_HUB_ADDRESS
    try:
        import httpx
        r = httpx.get(f"{addr}/healthz", timeout=2.0)
        if r.status_code == 200:
            d = cast("dict[str, Any]", r.json())
            return {"ok": True, "name": d.get("name")}
    except Exception:                                            # noqa: BLE001
        pass
    return {"ok": False}


@app.get("/api/orgs/{slug}/net")
def org_net(slug: str, request: Request) -> dict[str, Any]:
    """F-06: the org's network identity — the ONE place the secret is
    returned (loopback admin listener only, like the kiosk token). The
    settings panel's reveal/export reads this; the public gateway never
    reaches it. Kiosks have no identity by design."""
    if _public_slug(request):
        raise HTTPException(404, "not found")
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    if org.d.get("kiosk"):
        return {"identity": None, "hubs": [], "autoconnect": False}
    if not org.d.get("net_identity") or "net_hubs" not in org.d:
        # existing (pre-F-06) orgs backfill lazily on first reveal — the FULL
        # default config, not just the identity: identity without a hub list
        # is an org that silently never joins while the panel says autoconnect
        # is on (researcher finding 2026-08-05). Mirrors the chatq precedent
        # (existing orgs register automatically; opt-out lives in settings).
        with store.DOC_LOCK:
            org = store.load_org(slug)
            net.mint_identity(org)
            if "net_hubs" not in org.d:
                addr = str(load_org_defaults().get("net_hub_address") or "") \
                    or net.DEFAULT_HUB_ADDRESS
                org.d.setdefault("net_autoconnect", True)
                org.d["net_hubs"] = net.hub_entries(
                    bool(org.d.get("net_autoconnect", True)), [], addr)
            store.save_org(org)
    return {"identity": {k: v for k, v in (org.d.get("net_identity") or {}).items()
                         if k != "secret"},
            "hubs": [{k: v for k, v in h.items() if k not in {"token", "peer_token"}}
                     for h in org.d.get("net_hubs") or []],
            "autoconnect": bool(org.d.get("net_autoconnect", True))}


class NetInvitation(Body):
    peer_id: str
    peer_slug: str


class NetPairing(Body):
    address: str
    peer_id: str
    peer_slug: str
    peer_token: str


def _pairing_org(slug: str, request: Request) -> Any:
    if _public_slug(request):
        raise HTTPException(404, "not found")
    try:
        org = store.load_org(slug)
    except LedgerError as exc:
        raise HTTPException(404, str(exc)) from exc
    if org.d.get("kiosk") is not None:
        raise HTTPException(403, "kiosk orgs cannot use peer connections")
    ident = org.d.get("net_identity") or {}
    if not ident.get("slug") or not ident.get("secret"):
        raise HTTPException(422, "org has no network identity")
    return org


def _hub_client_for(org: Any, *, address: str | None = None,
                    peer_token: bool = False) -> Any:
    from engine.hub import HubClient
    ident = cast("dict[str, Any]", org.d["net_identity"])
    hub_address = (address or os.environ.get("ORGTREE_V2_HUB_ADDRESS", "").strip())
    owner_token = os.environ.get("ORGTREE_V2_HUB_TOKEN", "").strip()
    if not hub_address or not owner_token:
        raise HTTPException(503, "embedded hub is not ready")
    return HubClient(store.DATA_ROOT, hub_address, str(ident["slug"]),
                     str(ident["secret"]), owner_token, peer_token=peer_token,
                     ca_file=os.environ.get("ORGTREE_V2_HUB_CA_FILE") or None)


@app.post("/api/orgs/{slug}/net/invitations")
def create_net_invitation(slug: str, body: NetInvitation,
                          request: Request) -> dict[str, Any]:
    """Mint a one-time scoped peer credential for manual handoff.

    The returned token is the explicit invitation result only. It is never
    included in normal org/tree/status payloads or persisted in the response
    history; the receiving operator must supply it to the pairing action.
    """
    org = _pairing_org(slug, request)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", body.peer_id):
        raise HTTPException(422, "malformed peer id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", body.peer_slug):
        raise HTTPException(422, "malformed peer slug")
    client = _hub_client_for(org)
    try:
        result = client.create_peer(body.peer_id, body.peer_slug)
    except Exception as exc:  # transport details are not a route contract
        raise HTTPException(502, "hub invitation failed") from exc
    address = os.environ.get("ORGTREE_V2_HUB_ADVERTISED", "").strip() or os.environ.get("ORGTREE_V2_HUB_ADDRESS", "").strip()
    return {"version": 1, "address": address, "peer_id": body.peer_id,
            "slug": body.peer_slug, "peer_slug": body.peer_slug,
            "peer_token": str(result["peer_token"]), "one_time": True}


@app.post("/api/orgs/{slug}/net/pair")
def pair_net_hub(slug: str, body: NetPairing,
                 request: Request) -> dict[str, Any]:
    """Store a remote peer credential in private connection configuration."""
    org = _pairing_org(slug, request)
    address = net.normalize_hub_address(body.address)
    if not address or not urlsplit(address).scheme in {"http", "https"}:
        raise HTTPException(422, "address must be an HTTP(S) hub URL")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", body.peer_id):
        raise HTTPException(422, "malformed peer id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", body.peer_slug):
        raise HTTPException(422, "malformed peer slug")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", body.peer_token):
        raise HTTPException(422, "malformed peer token")
    ident = org.d["net_identity"]
    if body.peer_slug != str(ident["slug"]):
        raise HTTPException(422, "peer_slug must equal this connecting org's network identity")
    if body.peer_id == net.LOCAL_HUB_ID:
        raise HTTPException(422, "peer_id is reserved for the embedded hub")
    parsed = urlsplit(address)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(422, "hub address must not contain credentials, query or fragment")
    if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(422, "remote hub connections require HTTPS; HTTP is allowed only on loopback")
    from engine.hub import HubClient
    try:
        client = HubClient(store.DATA_ROOT, address, str(ident["slug"]),
                           str(ident["secret"]), body.peer_token, peer_token=True)
        client.register(org_name=str(org.d.get("name") or slug))
    except Exception as exc:
        raise HTTPException(502, "remote hub refused pairing or is unavailable") from exc
    with store.DOC_LOCK:
        current = store.load_org(slug)
        hubs = cast("list[dict[str, Any]]", current.d.setdefault("net_hubs", []))
        existing = next((h for h in hubs
                         if str(h.get("id")) == body.peer_id
                         or str(h.get("address")) == address), None)
        if existing is None:
            existing = {"id": body.peer_id, "address": address,
                        "enabled": True}
            hubs.append(existing)
        existing.update({"address": address, "enabled": True,
                         "peer_token": body.peer_token,
                         "peer_slug": body.peer_slug})
        current.d["net_hubs"] = hubs
        store.save_org(current)
    return {"id": str(existing["id"]), "address": address,
            "peer_slug": body.peer_slug, "enabled": True, "paired": True}


@app.delete("/api/orgs/{slug}/net/invitations/{peer_id}")
def revoke_net_invitation(slug: str, peer_id: str, request: Request) -> dict[str, Any]:
    org = _pairing_org(slug, request)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", peer_id):
        raise HTTPException(422, "malformed peer id")
    try:
        _hub_client_for(org).revoke_peer(peer_id)
    except Exception as exc:
        raise HTTPException(502, "hub invitation revocation failed") from exc
    return {"revoked": peer_id}


_tree_slow_warned: set[str] = set()


def _rederive_freeze_reset(node: dict[str, Any],
                           cache: dict[str, dict[str, Any]]) -> None:
    """Re-derive a usage-limit freeze's reset from the CURRENT account roster.

    ⚠ THE STAMPED NUMBER DESCRIBES A ROSTER THAT MAY NO LONGER EXIST.
    `frozen.until` / `until_ts` are written ONCE, at freeze time, from the
    account that hit the wall (supervisor, the `_ensure_frozen` block). Add a
    key, remove one, or reorder them and nothing writes them again — user
    report 2026-08-26: "the refresh time doesn't adapt to account changes or
    keys being added / removed". The record is the supervisor's to stamp, so
    the only honest place to CORRECT it is where it is read.

    ⚠ IT REPORTS CAPACITY, NEVER A WAKE — and that is the deeper half of the
    same bug. The old wording promised "resumes <time>", which is false on
    any org with `auto_resume` OFF (the default): nothing wakes the node when
    capacity returns, the operator does. User ruling 2026-08-26 — "off means
    off" — so a second account appearing is not consent nobody gave. This
    says what the ROSTER supports and leaves resuming to ▶.

    ⚠ THREE STATES, AND THE THIRD IS THE POINT. When no account carries a
    real refresh time there is NO T — an auth freeze marks no lane by design
    — and computing a plausible-looking countdown for it is exactly the
    invented-T failure the expired-login rule exists to prevent. It says the
    time is unknown instead. It also never SHORTENS a mark: it reads the
    marks rather than recomputing a horizon, so it inherits the pool `max()`
    floor by construction.

    Scope is deliberately narrow — a pure `limit` freeze that is not
    `limit_locked`. A connection freeze owns its own timer and both consumers
    render it down a separate branch; a fable weekly lock is not a
    subscription-pool question and `resolve` cannot describe it.

    `cache` memoises per tier for the life of ONE tree render: `resolve`
    re-reads the roster file per call, and a large org would otherwise pay
    that once per frozen node (the O(n²) warning above is already watching
    this endpoint).
    """
    fz = node.get("frozen")
    if not isinstance(fz, dict):
        return
    if not fz.get("limit") or fz.get("connection") or node.get("limit_locked"):
        return
    # ⚠ AN AUTH FREEZE IS A LIMIT FREEZE IN SHAPE ONLY (D-156), and without
    # this it lands here and gets its label REWRITTEN. The freeze deliberately
    # cleared `until_ts` and said "credential rejected — replace it, then
    # resume"; re-deriving would replace that with "capacity available", which
    # is TRUE and completely beside the point — the credential is what is
    # broken, and the operator would be told the opposite of what to fix.
    # (This was only reachable once `cause` reached the payload at all: the
    # projection dropped it, so this function could not see it and quietly
    # clobbered the one label that says what to do.)
    if fz.get("cause") in ("auth", "balance"):
        # …and a BALANCE refusal (OpenRouter 402, 2026-09-05) for the same
        # reason: its label names the remedy ("check balance or in-flight
        # requests"), and the roster's capacity is not the question
        return
    # ⚠ THE PAYLOAD FIELD IS `tier`, NOT `model`. The node DOCUMENT calls it
    # `model`; `tree()` renames it on the way out. Reading `model` here found
    # nothing, returned early on every node, and made this whole function a
    # silent no-op that looked exactly like a working feature — caught before
    # it shipped only by checking the projection rather than assuming it.
    tier = str(node.get("tier") or "")
    if tier not in accounts.TIERS:
        return
    # ⚠ THE MESSAGE'S OWN DEADLINE OUTRANKS THE ROSTER, WHATEVER IT SAYS
    # (user ruling 2026-09-07 14:56Z; coordinator decisions 15:03Z and
    # 15:32Z). A freeze whose reset was parsed from the limit message
    # (`text`) or stated by the provider for that turn (`provider`) carries
    # the one time that describes THIS wall, for this model. The roster's
    # `refresh_at` is the pool mark — mirrored across haiku/sonnet/opus with
    # `max()` and, until that ruling, recorded from the cached readout — so
    # it could show a sibling tier's later, cache-derived time in place of
    # the reset the provider actually named; and a roster that reports
    # capacity AVAILABLE (another account, an unmarked fallback) is a
    # separate fact about routing that must not ERASE the stated time.
    # While the message deadline is still ahead it is displayed; the roster
    # answers only for a freeze with no applicable message deadline. Routing
    # itself (`accounts.resolve` at spawn) is untouched by this projection.
    fzd = cast("dict[str, Any]", fz)
    src = str(fzd.get("reset_src") or "")
    try:
        own = float(fzd.get("until_ts") or 0)
    except (TypeError, ValueError):
        own = 0.0
    now = time.time()
    if src in ("text", "provider") and now < own <= now + limits.MAX_HORIZON:
        fz["until"] = (
            ("capacity recheck " if fzd.get("schedule_kind") == "probe"
             else "capacity resets ") + supervisor._reset_label(own))
        fz["until_ts"] = own
        return
    if tier not in cache:
        cache[tier] = accounts.resolve(tier)
    got = cache[tier]
    if got.get("available"):
        # An open pool can still contain an unmarked fallback whose capacity
        # is not observable until a turn is attempted. Do not erase a valid
        # retry deadline merely because routing still sees that lane as
        # eligible. A probe is a bounded recheck, not a reset promise.
        if fz.get("pool") == "open":
            try:
                ts = float(fz.get("until_ts") or 0)
            except (TypeError, ValueError):
                ts = 0.0
            now = time.time()
            if now < ts <= now + limits.MAX_HORIZON:
                src = str(fz.get("reset_src") or "")
                kind = str(fz.get("schedule_kind") or "")
                if (kind == "probe" or src not in ("provider", "text")
                        and not src.startswith("usage:")):
                    fz["until"] = "capacity recheck " + supervisor._reset_label(ts)
                else:
                    fz["until"] = "capacity resets " + supervisor._reset_label(ts)
                return
        fz["until"], fz["until_ts"] = "capacity available — ▶ to resume", None
        return
    ts = got.get("refresh_at")
    if not ts:
        fz["until"], fz["until_ts"] = "reset time unknown", None
        return
    fz["until"] = f"capacity resets {supervisor._reset_label(float(ts))}"
    fz["until_ts"] = float(ts)


@app.get("/api/orgs/{slug}")
def org_tree(slug: str, request: Request) -> dict[str, Any]:
    try:
        org = store.load_org_snapshot(slug, ("org_inbox",))
    except LedgerError as e:
        raise HTTPException(404, str(e))
    _t0 = time.perf_counter()
    tree = org.tree()
    # FR-27: the primed restart is a MACHINE fact, not an org one — it is
    # armed from one org and cuts every org on the box. So it is injected
    # here, after the per-org projection, and every org's header renders the
    # same chip. Putting it in `tree()` would have meant putting it in an org
    # doc, which would have shown it only to the org that armed it.
    tree["primed_restart"] = supervisor.primed_restart()
    # user ruling 2026-08-06 on the redteam's O(n²) Org.children finding:
    # "not relevant until the typical execution time exceeds one second" —
    # this makes the threshold self-announcing instead of relying on someone
    # noticing. Once per org per process; the fix, when it matters, is a
    # children index (or, per the ruling, a rewrite in Rust).
    _dt = time.perf_counter() - _t0
    if _dt > 1.0 and slug not in _tree_slow_warned:
        _tree_slow_warned.add(slug)
        print(f"[orgtree] ⚠ tree() for {slug!r} took {_dt:.2f}s — the ruled "
              f"one-second threshold is crossed; the O(n²) children scan "
              f"is now relevant (see the 2026-08-06 ruling)", flush=True)

    # one roster read per TIER per render, not per frozen node
    _cap_cache: dict[str, dict[str, Any]] = {}

    def annotate(node: dict[str, Any]) -> None:
        _rederive_freeze_reset(node, _cap_cache)
        # A model capability is derived from the tier, not historical turn
        # state. Existing nodes may still carry an older CLI observation in
        # their document after a provider updates its published window; never
        # project that stale value back onto the desk while waiting for the
        # node's next completed turn to rewrite it.
        node["context_window"] = supervisor.context_window(node)
        # ⚠ WILL ▶ ACTUALLY RESUME THIS NODE? Composed here for the same reason
        # `ran_as_label` below is: the backend owns the rule, and a second copy
        # of it is a second thing to disagree. User report 2026-08-26 — the
        # resume banner read "resume 2 · 2 agents frozen" for an org whose two
        # frozen agents had been RETIRED. Retiring does not clear the freeze
        # record (a retired agent keeps its context and can be rehired), and
        # the banner was counting every node that still carried one. Nothing
        # behind it was broken: `_resumable` already refused those nodes, so ▶
        # resumed nobody. Only the count lied.
        #
        # The first fix mirrored `_resumable` in TypeScript and guarded the two
        # with a source-text check. That is two expressions of one rule — and a
        # source check cannot tell a rule that got STRONGER from one that got
        # weaker, fires on a rename, and misses a semantic change that keeps
        # the spelling. So the rule stays in one place and its answer travels.
        #
        # ⚠ READS THE DOCUMENT NODE, NOT THE PAYLOAD ONE THIS FUNCTION IS
        # HANDED. `_resumable` is written against NodeDoc, and `resume_frozen`
        # iterates `org.nodes.items()` — so passing the doc makes this field
        # provably the same question the button asks. The projection is NOT a
        # safe substitute and this is not a stylistic preference: `tree()`
        # renames `model` → `tier`, and it rebuilds `frozen` from a fixed key
        # list that omits `spend`. `_resumable` refuses a node carrying any
        # other kind flag, so on a payload node a SPEND freeze would read as
        # resumable — the exact class of silent wrong answer the `tier`/`model`
        # warning above was written about.
        node["resumable"] = supervisor.resumable(org.node(node["id"]))
        st = supervisor.state(slug, node["id"])
        node["busy"] = st["busy"]
        # №12: three states wore one pulse — split them: waiting on a turn
        # slot vs actually responding vs busy-but-between (draining/queued)
        node["waiting"] = bool(st.get("waiting"))
        node["responding"] = bool(st.get("responding"))
        node["phase"] = st.get("phase")     # e.g. "compacting" (№3)
        # api_fallback (user feature 2026-08-19): this agent's IN-FLIGHT turn
        # is billing the org's own API key, not the subscription. Captured at
        # spawn by the supervisor, so it stays true for the whole turn even
        # after the window shuts — the card wears red for exactly as long as
        # the spend it describes.
        node["on_fallback"] = bool(st.get("on_fallback"))
        # ⚠ WHICH ACCOUNT ACTUALLY SERVED THIS TURN — captured at spawn from
        # the RESOLVED environment, not from what the org intended. This is
        # the only field that describes what HAPPENED: the switch row and the
        # panel's "serving" line both describe intent and state, so without
        # this a turn served by the ambient account while the panel says
        # "fallback" looks identical to a correct one. An account uuid, or
        # "ambient" / "api-key" / "token:unattributed". Never a credential.
        node["ran_as"] = st.get("ran_as") or None
        # …and the same fact in the form a READER needs (user ruling
        # 2026-08-25): "fallback 2 · <uuid>" when this turn is running off a
        # fallback, None otherwise. Composed in the backend because it owns
        # the registry — the desk cannot count key rows it never fetched, and
        # a second count is a second thing to disagree.
        # ⚠ the uuid is dropped for kiosk visitors: `/api/accounts` is frozen
        # whole on the public side, and this payload is NOT, so composing the
        # label without that guard would route account identity straight
        # around D-145's bound.
        node["ran_as_label"] = accounts.serving_label(
            str(st.get("ran_as") or ""), with_uuid=_public_slug(request) is None)
        # ⚠ WHICH POOL A LUNA IS ACTUALLY ON (item 12; user spec 2026-09-04:
        # a header token when Luna RUNS ON RESERVE). The in-memory record
        # is the turn in flight or the last one this process ran; the
        # document's `codex_route_last` covers a restart. `live` is what
        # separates "reserve" from "last: reserve" — a token that cannot
        # tell a running turn from yesterday's is the stale-state failure
        # the spec names. Composed here from the same label rule the
        # backend owns (`codex_route.route_label`) so the desk and the
        # card cannot word it two ways. Null for every tier that does not
        # route and for a direct luna with nothing to disclose.
        _rt = st.get("codex_route")
        if not isinstance(_rt, dict):
            _rt = org.node(node["id"]).get("codex_route_last")
        if isinstance(_rt, dict):
            _live = bool(_rt.get("live")) and bool(st.get("busy"))
            _rt_view = cast("codex_route.Route", _rt)
            node["codex_route"] = {
                "route": _rt.get("route"), "pool": _rt.get("pool"),
                "model": _rt.get("model"), "requested": _rt.get("requested"),
                "reason": _rt.get("reason"), "selection": _rt.get("selection"),
                "prefer": _rt.get("prefer"),
                "outcome": _rt.get("outcome"),
                "reported_model": _rt.get("reported_model"),
                # the server's `model/rerouted`, when it sent one, and the
                # pool that answer attributes the turn to (None = unknown);
                # the label already follows both, this is for the tooltip
                "rerouted": _rt.get("rerouted"),
                "served_pool": _rt.get("served_pool"),
                "live": _live, "at": _rt.get("at"),
                "label": codex_route.route_label(_rt_view, live=_live)}
        else:
            node["codex_route"] = None
        node["queued"] = len(st["queue"])
        # D-201 (contract frozen with styling 2026-08-30): is a pre-warmed
        # CLI process PARKED for this seat right now, holding a current
        # system prompt? A SPEED property, never health: false is the normal
        # state for codex/antigravity lanes, archived seats, mid-turn seats and
        # the kill-switch-off arm, and a false agent answers perfectly well —
        # it just pays a cold spawn. Always present (never absent) on every
        # node this block decorates.
        node["proc_warm"] = bool(st.get("proc_warm"))
        node["proc_live"] = bool(st.get("proc_live"))
        node["proc_relaunch"] = bool(st.get("proc_relaunch"))
        node["proc_relaunch_reason"] = (
            str(st.get("proc_relaunch_reason"))
            if st.get("proc_relaunch_reason") else None)
        control = warmpool.process_control_status(
            org, node["id"], public=_public_slug(request) is not None)
        node["proc_paused"] = bool(control.get("paused"))
        node["proc_control_enabled"] = bool(control.get("enabled"))
        node["proc_control_action"] = control.get("action")
        node["proc_control_reason"] = (
            str(control.get("reason")) if control.get("reason") else None)
        last_mcp = org.node(node["id"]).get("last_turn_mcp_tool_count")
        node["mcp_tool_count"] = (
            int(st["mcp_tool_count"])
            if isinstance(st.get("mcp_tool_count"), int)
            and not isinstance(st.get("mcp_tool_count"), bool) else None)
        node["last_turn_mcp_tool_count"] = (
            int(last_mcp) if isinstance(last_mcp, int)
            and not isinstance(last_mcp, bool) else None)
        node["mcp_tool_count_provider"] = str(
            st.get("mcp_tool_provider") or
            providers.provider_of(str(org.node(node["id"]).get("model") or "")))
        node["mcp_tool_count_source"] = (
            str(st.get("mcp_tool_source")) if st.get("mcp_tool_source") else None)
        # A KNOWN count owes the reader no excuse. `_mcp_tool_count_publish`
        # clears the reason on SUCCESS, and this fallback then filled that
        # silence with "no live provider process" — so a node with a resolved
        # count and a live process reported that it had neither. Measured
        # 2026-09-01: all five live nodes said it simultaneously, every one of
        # them serving turns. The fallback belongs to the unknown case, which
        # is the only one that has anything to explain.
        node["mcp_tool_count_reason"] = (
            str(st.get("mcp_tool_reason")) if st.get("mcp_tool_reason")
            else None if node["mcp_tool_count"] is not None
            else "no live provider process")
        node["mcp_readiness_waiting"] = bool(
            st.get("mcp_readiness_waiting"))
        node["mcp_readiness_state"] = (
            str(st.get("mcp_readiness_state"))
            if st.get("mcp_readiness_state") else None)
        node["mcp_readiness_reason"] = (
            str(st.get("mcp_readiness_reason"))
            if st.get("mcp_readiness_reason") else None)
        # ⚠ ARCHIVED SEATS DO NOT PAY FOR THIS. A forecast is a claim about
        # what the NEXT turn's provider cache will do; an archived agent has
        # no next turn until it is rehired, and rehiring re-derives the whole
        # book anyway. So the answer was never rendered — `CacheForecastMark`
        # and `CacheForecastWarning` both return null on a null forecast —
        # while the computation ran in full.
        #
        # MEASURED 2026-09-03, this org (6 live seats, 179 archived): the call
        # cost 1.8-4.0 s per tree render, ~92% of it on archived seats, and
        # `GET /api/orgs/{slug}` took 11-38 s (113 s with two in flight)
        # against a 45 s client deadline — the "signal timed out" banner. The
        # cost is `_cache_semantic_inputs` → `_build_cmd` → `transcript_path`,
        # a glob whose wildcard component is the project directory, so every
        # node re-listed the user's entire ~/.claude/projects (349 dirs,
        # 14 ms a call). Live seats still pay it; there are six of them.
        #
        # The test is STATE, not liveness: a live-but-parked seat holding no
        # warm process is exactly who the forecast is for (its next turn is
        # the one at risk), so gating on a process check would delete the
        # feature's whole value. Only `archived` is skipped.
        #
        # ⚠ EXPLICIT None, never a missing key: `Org.tree()` has already put
        # the node's PERSISTED `cache_continuity.public` row here, and that
        # row is a durable record of some past turn that never went through
        # `cachecontinuity.public` classification. Leaving it would render a
        # stale verdict on an archived card — worse than none.
        node["cache_forecast"] = (
            None if node["state"] == "archived"
            else supervisor.cache_forecast_public(org, node["id"]))
        # The composer's mid-turn steer-window warning has to say which of two
        # things a missed window costs, and that depends on whether the
        # compactor is on FOR THIS NODE. Resolved here rather than threaded
        # through the UI from the org default: the effective value is the org
        # setting merged with this node's own scope override, and only
        # `_auto_cheap_cfg` knows that. Passing the org value down instead
        # would render the wrong sentence on every node that overrides it.
        _cheap_cfg = supervisor._auto_cheap_cfg(org, node["id"])
        node["cheap_compact_on"] = _cheap_cfg is not None
        # …and the compactor's own occupancy threshold, because the same
        # banner is threshold-gated (user ruling 2026-09-02 19:19Z): with the
        # compactor on it shows only at or above THIS fraction (the
        # destructive gate's inclusive minimum, `_auto_cheap_context_ready`);
        # off, only above the fixed 25% floor `_cache_precompact_decision`
        # uses. None when the compactor is off — there is no threshold then.
        node["cheap_compact_occ"] = (
            float(_cheap_cfg["occ"]) if _cheap_cfg else None)
        # concurrently running subagents (Task/Agent tool calls in flight) —
        # the desk header shows it beside the working clock, only when > 0
        node["tasks"] = int(st.get("tasks") or 0)
        # …and BACKGROUND subagents, counted apart because they mean something
        # different: they outlive the turn's own reply, so a node can sit
        # `busy` for a long time with nothing else to show for it. Before the
        # 2026-08-20 fix that state was invisible AND fatal (the idle watchdog
        # killed it); now it is merely invisible.
        # ⚠ API-ONLY so far: unlike `tasks` above, nothing renders this yet —
        # no field in the frontend's types, no chip on the desk. It is here so
        # the state is observable at all (and it is what the tests read); the
        # desk chip that would answer "why has this agent been working for
        # twenty minutes" is still to be built.
        node["bg_tasks"] = int(st.get("bg_tasks") or 0)
        node["last_error"] = st["last_error"]
        # G4: what the agent is doing RIGHT NOW, derived from the live tail the
        # supervisor already keeps. The client used to accumulate this itself
        # from the websocket (`activity`, keyed by node, cleared on turn_done),
        # which meant a missed `turn_done` stranded an indicator until the
        # socket reconnected — a second copy of a fact the server already had.
        # Derived here per request, stored nowhere: the newest row wins, and
        # `busy` (above) is what decides whether it renders at all.
        live = cast("list[dict[str, Any]]", st.get("live") or [])
        last = live[-1] if live else {}
        kind = last.get("kind")
        node["activity"] = (
            {"phase": "tool", "tool": last.get("text")} if kind == "tool"
            else {"phase": "writing"} if kind == "text"
            else {"phase": "thinking"})
        # Occupancy stays document-owned. Context-window capability is derived
        # above, rather than mirrored from process state.
        for c in node["children"]:
            annotate(c)

    for r in tree["roots"]:
        annotate(r)
    k = supervisor.kiosk_cfg(org)
    if k:
        tree["kiosk"] = {
            "credits": int(k.get("credits") or 0) or None,
            "spend_limit": float(k.get("spend_limit") or 0) or None,
            "storage_limit_mb": int(k.get("storage_limit_mb") or 0) or None,
            "spend_frozen": bool(tree.get("spend_frozen")),
            "storage_blocked": bool(tree.get("storage_blocked")),
            # the permission ceiling — the admin gear edits it; _scrub_public
            # drops it (host paths) for visitors
            "max_scope": k.get("max_scope"),
            "auto_raise": bool(k.get("auto_raise")),
            # the tier cap rides OUTSIDE max_scope too: it's public-safe (a
            # tier name) and the visitor UI needs it to hide spawn tokens
            "max_tier": (k.get("max_scope") or {}).get("max_tier"),
            # per-kiosk admin controls live in the org's own settings panel
            # (user ruling 2026-07-31 — the all-kiosks dashboard is gone);
            # share_url is admin-only, _scrub_public pops it
            "enabled": bool(k.get("enabled")),
            "sandbox": bool(k.get("sandbox")),
            "share_url": _share_url(k.get("token")),
        }
        if k.get("storage_limit_mb"):
            u = supervisor.workspace_usage_cached(org)
            if u is not None:
                tree["kiosk"]["storage_mb"] = round(u / 1048576, 2)
    if sandbox.is_sandboxed(org) and sandbox.on_disk(slug):
        # the org disk's headline numbers ride every tree payload: the
        # persistent hard-full alert is STATE (survives reload), and the
        # storage chip needs used/total without a second request
        from . import disk as dsk
        du = dsk.usage(slug, max_age=15.0)
        tree["disk"] = {
            "used_mb": round(du[0] / 1048576, 1) if du else None,
            "total_mb": round(du[1] / 1048576, 1) if du else None,
            "blocked": bool(tree.get("storage_blocked")),
            "full": bool(org.d.get("storage_full")),
            # the yellow divergence (pending shrink): requested vs actual
            "pending_mb": (org.d.get("disk") or {}).get("pending_size_mb"),
        }
    # F-06: hub config + live connectivity for the status surfaces — never
    # the secret (status_block guarantees it); None for kiosks
    tree["net"] = net.status_block(cast("dict[str, Any]", org.d))
    if tree["net"]:
        # transport sets (user spec 2026-08-05): every roster peer names
        # which transports resolve it — a hub peer that is ALSO a local org
        # on this instance reads {org, net}; everyone else {net}. Derived
        # from the same data the bare-name resolver consults.
        # ⚠ `org.d` IS PASSED IN, and that is the point: this used to call
        # `store.list_orgs()`, which full-parses every org document on disk to
        # read a handful of short strings — 80.3 ms for 18.7 MB, MEASURED
        # 2026-09-03, against a 233 ms floor for this whole endpoint. One of
        # those parses re-did the `load_org` at the top of this handler.
        local_net = store.local_net_slugs(cast("dict[str, Any]", org.d))
        for h in cast("list[dict[str, Any]]", tree["net"].get("hubs") or []):
            for r in cast("list[dict[str, Any]]", h.get("roster") or []):
                r["transports"] = (["org", "net"]
                                   if str(r.get("slug")) in local_net
                                   else ["net"])
    tree["headless"] = bool(org.d.get("headless"))
    # WHETHER a key is set, never the key (settings needs the fact)
    tree["api_key_set"] = bool(org.d.get("api_key"))
    if _public_slug(request):
        # tells the UI to lock itself down; the SERVER gate is the enforcement
        tree["public"] = True
        _scrub_public(tree)
    return tree


_WINPATH = re.compile(r"(?:[A-Za-z]:[\\/]|/(?:home|Users|opt|mnt|tmp)/)[^\s'\"]*")


def _scrub_public(tree: dict[str, Any]) -> None:
    """№18: a kiosk share link served the operator's ABSOLUTE host paths and
    username in every tree payload (workspace, every dir grant, session ids,
    raw error strings). Public visitors get basenames and scrubbed errors —
    they interact with the org, not the operator's filesystem."""
    def base(p: Any) -> str:
        return os.path.basename(str(p).rstrip("/\\")) or "folder"
    # F-06: hub addresses + rosters are the operator's network topology —
    # visitors get none of it (kiosks carry no identity anyway, belt+braces)
    tree.pop("net", None)
    if tree.get("workspace"):
        tree["workspace"] = base(tree["workspace"])
    dirs: list[dict[str, Any]] = tree.get("dirs") or []
    tree["dirs"] = [{**d, "path": base(d.get("path", ""))} for d in dirs]
    if isinstance(tree.get("kiosk"), dict):
        # the ceiling's add_dirs are host paths; visitors see clamp warnings
        # naming the ceiling, never the ceiling itself
        tree["kiosk"].pop("max_scope", None)
        tree["kiosk"].pop("auto_raise", None)
        tree["kiosk"].pop("share_url", None)

    def walk(n: dict[str, Any]) -> None:
        n.pop("session_id", None)
        # an @mcp: peer id is a bearer credential, not a label: anyone holding
        # it can GET /api/extern/{peer}/messages and read that channel. Kiosk
        # visitors get the org, never its outside channels.
        n.pop("external_handles", None)
        sc: dict[str, Any] = n.get("scope") or {}
        if sc.get("add_dirs"):
            sc["add_dirs"] = [{**d, "path": base(d.get("path", ""))}
                              for d in sc["add_dirs"]]
        if n.get("last_error"):
            n["last_error"] = _WINPATH.sub("<path>", str(n["last_error"]))
        # the other two ENGINE-generated strings on a node. `frozen.error` is
        # a raw CLI/limit error and `last_denials[].arg` is the argument of a
        # headless auto-denied tool call — i.e. routinely a host file path.
        # Both rode the tree payload unscrubbed while last_error beside them
        # was cleaned (measured: a denial arg leaked E:\… and a freeze error
        # leaked the operator's username).
        fz: dict[str, Any] = n.get("frozen") or {}
        if fz.get("error"):
            fz["error"] = _WINPATH.sub("<path>", str(fz["error"]))
        # …and `last_approvals` (2026-09-05) rides the same row shape with
        # the same host-path exposure, plus a `cwd` that is ALWAYS a host
        # path — scrub both lists, both fields, or the new one leaks exactly
        # the way the old one was measured to.
        for key in ("last_denials", "last_approvals"):
            rows: list[Any] = n.get(key) or []
            for dn in rows:
                if not isinstance(dn, dict):
                    continue
                d2 = cast("dict[str, Any]", dn)
                for fld in ("arg", "cwd"):
                    if d2.get(fld):
                        d2[fld] = _WINPATH.sub("<path>", str(d2[fld]))
        children: list[dict[str, Any]] = n.get("children") or []
        for c in children:
            walk(c)
        lineage: list[Any] = n.get("lineage") or []
        for ln in lineage:
            if isinstance(ln, dict):
                cast("dict[str, Any]", ln).pop("session_id", None)
    roots: list[dict[str, Any]] = tree.get("roots") or []
    for r in roots:
        walk(r)


def _scrub_events(evts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Public callers (audit 2026-08-01): event details and warnings can embed
    host paths — dir revokes, scope dumps, clamp warnings — so every string
    leaf is regex-scrubbed. Returns scrubbed COPIES; the doc is untouched."""
    def scrub(v: Any) -> Any:
        if isinstance(v, str):
            return _WINPATH.sub("<path>", v)
        if isinstance(v, list):
            return [scrub(x) for x in cast("list[Any]", v)]
        if isinstance(v, dict):
            return {k: scrub(x) for k, x in cast("dict[str, Any]", v).items()}
        return v
    return [cast("dict[str, Any]", scrub(e)) for e in evts]


class Settings(Body):
    org_dirs: list[Any] | None = None       # external folders [{path, mode}] (ws excluded)
    max_top_grant: int | None = None
    default_top_grant: int | None = None    # pre-filled grant for top-level hires
    compact_at: int | None = None           # compaction threshold in percent, 50..95
    clear_fable_lock: bool = False
    fable_limit_policy: str | None = None   # halt | opus | dissolve
    fable_filter_policy: str | None = None  # halt | opus | auto-autopsy (content-filter flags)
    fable_filter_model: str | None = None   # model tier when policy == auto-autopsy (fable not selectable)
    default_tools: dict[str, Any] | None = None  # {bash, web, edit, subagents, mcp: []|["*"]}
    default_visibility: str | None = None   # self|team|subtree|full
    permission_mode: str | None = None      # default|acceptEdits|bypassPermissions
                                            # — the mode NEW hires are born with
                                            # (existing nodes keep theirs; the ⚙
                                            # panel changes those one at a time)
    default_effort: str | None = None       # ""=CLI default | low..max (live inherit)
    # app-wide Luna pool-order default; agents with no individual preference
    # inherit it (deliberately not an org-doc setting)
    prefer_reserve: bool | None = None
    auto_resume: bool | None = None         # restart limit-frozen agents at reset+1min
    auto_resume_compact: bool | None = None  # cheap-compact a limit-frozen node
                                             # right before the AUTO resume wakes
                                             # it (the freeze outlived the cache
                                             # TTL; manual ▶ is untouched)
    cascade_hire: bool | None = None        # hires bubble costs up the chain (§4.6)
    cascade_alloc: bool | None = None       # allocations/upgrades bubble costs up
    net_hub_address: str | None = None      # F-06 (global defaults only): the
                                            # local hub's address for NEW orgs
    net_autoconnect: bool | None = None     # F-06 (per-org): keep/join the
                                            # local hub entry
    net_hubs: list[Any] | None = None       # F-06 (per-org): authoritative hub
                                            # list [{id?, address, enabled?}]
    headless: bool | None = None            # §9.6: no user present; requires
                                            # an api_key (both directions)
    api_key: str | None = None              # §9.5: per-org ANTHROPIC_API_KEY
    clear_api_key: bool = False             # refused while headless is on
    api_fallback: bool | None = None        # 2026-08-17: the key is a SPARE —
                                            # subscription bills routine turns;
                                            # the key takes over only while a
                                            # usage limit has the lane frozen,
                                            # reverting at the limit's reset
    fable_api_fallback: bool | None = None  # 2026-08-23: also spend the spare
                                            # key on a TRUSTED fable-tier
                                            # weekly hit, instead of leaving it
                                            # to fable_limit_policy (requires
                                            # api_fallback + api_key already)
    # Cache-protective cheap compaction — {enabled, occ (0..1 fraction of the
    # context window)}. Expiry is derived from same-lane positive receipts
    # (60m subscription, 5m API key), never an editable idle timeout.
    auto_cheap_compact: dict[str, Any] | None = None


# ------------------------------------------- global default org settings
# (user spec): configured from the root page; every NEWLY created org is
# born with these values. Stored org-doc-shaped in <data>/defaults.json.
_DEFAULTS_BASE = {
    "max_top_grant": 1000, "default_top_grant": 50, "compact_at": 0.80,
    "fable_limit_policy": "halt", "fable_filter_policy": "halt",
    "fable_filter_model": "opus",
    "prefer_reserve": True,
    "cascade_hire": True, "cascade_alloc": True, "auto_resume": False,
    "auto_resume_compact": False,
    # F-06: NOT an org-doc key — popped + translated into the "local" hub
    # entry at creation (orgs_create), shown on the root defaults page
    "net_hub_address": net.DEFAULT_HUB_ADDRESS,
}


def load_org_defaults() -> dict[str, Any]:
    try:
        d = json.load(open(os.path.join(store.DATA_ROOT, "defaults.json"),
                           encoding="utf-8"))
        if not isinstance(d, dict):
            return {}
        acc = d.get("auto_cheap_compact")
        if isinstance(acc, dict):
            acc = dict(acc)
            acc.pop("idle_s", None)       # legacy timeout is never a TTL
            d["auto_cheap_compact"] = acc
        return cast("dict[str, Any]", d)
    except (OSError, json.JSONDecodeError):
        return {}


@app.get("/api/defaults")
def defaults_get() -> dict[str, Any]:
    result = {**_DEFAULTS_BASE, **load_org_defaults()}
    # Old installs (and malformed hand-edits) have no valid app-wide value;
    # preserve the historical reserve-first behavior on the wire too.
    if not isinstance(result.get("prefer_reserve"), bool):
        result["prefer_reserve"] = True
    return result


@app.post("/api/defaults")
def defaults_set(body: Settings) -> dict[str, Any]:
    from . import desktop_policy
    try:
        desktop_policy.validate(body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    d = load_org_defaults()
    if body.max_top_grant is not None and body.max_top_grant > 0:
        d["max_top_grant"] = int(body.max_top_grant)
    if body.default_top_grant is not None and body.default_top_grant >= 0:
        d["default_top_grant"] = int(body.default_top_grant)
    if body.compact_at is not None:
        d["compact_at"] = min(95, max(50, int(body.compact_at))) / 100.0
    if body.fable_limit_policy in ("halt", "opus", "dissolve"):
        d["fable_limit_policy"] = body.fable_limit_policy
    if body.fable_filter_policy in ("halt", "opus", "auto-autopsy"):
        d["fable_filter_policy"] = body.fable_filter_policy
    if body.fable_filter_model is not None:
        if body.fable_filter_model == "fable":
            raise HTTPException(422, "fable cannot be used as the auto-autopsy model")
        if not providers.is_known_tier(body.fable_filter_model):
            raise HTTPException(422, f"unknown model tier '{body.fable_filter_model}'")
        d["fable_filter_model"] = body.fable_filter_model
    if body.default_tools is not None:
        d["default_tools"] = norm_tools(body.default_tools)
    if body.default_visibility in VIS_LEVELS:
        d["default_visibility"] = body.default_visibility
    if body.default_effort is not None \
            and body.default_effort in ("", *Org.EFFORTS):
        d["default_effort"] = body.default_effort
    if body.prefer_reserve is not None:
        d["prefer_reserve"] = bool(body.prefer_reserve)
    if body.auto_resume is not None:
        d["auto_resume"] = bool(body.auto_resume)
    if body.auto_resume_compact is not None:
        d["auto_resume_compact"] = bool(body.auto_resume_compact)
    if body.auto_cheap_compact is not None:
        acc = body.auto_cheap_compact
        # An old client may submit only `idle_s`. That field is retired, so a
        # timeout-only write is a no-op rather than silently turning a policy
        # off. Recognised partial updates preserve the other current value.
        if "enabled" in acc or "occ" in acc:
            old = cast("dict[str, Any]", d.get("auto_cheap_compact") or {})
            d["auto_cheap_compact"] = {
                "enabled": bool(acc.get("enabled", old.get("enabled", False))),
                "occ": min(0.95, max(0.05, float(
                    acc.get("occ", old.get("occ", 0.5)))))}
    if body.cascade_hire is not None:
        d["cascade_hire"] = bool(body.cascade_hire)
    if body.cascade_alloc is not None:
        d["cascade_alloc"] = bool(body.cascade_alloc)
    if body.net_hub_address is not None:
        d["net_hub_address"] = body.net_hub_address.strip() \
            or net.DEFAULT_HUB_ADDRESS
    with open(os.path.join(store.DATA_ROOT, "defaults.json"), "w",
              encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    return defaults_get()


@app.post("/api/orgs/{slug}/settings")
def org_settings(slug: str, body: Settings) -> dict[str, Any]:
    from . import desktop_policy
    try:
        desktop_policy.validate(body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    """Org-level knobs. Folder holdings (org_dirs) are edited from the eye's
    gear panel: the workspace is permanent; additions apply to FUTURE hires;
    removals revoke everywhere; rw→ro downgrades propagate to every grant."""
    with store.DOC_LOCK:
        return _org_settings_locked(slug, body)


def _org_settings_locked(slug: str, body: Settings) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    if body.api_key is not None \
            and body.api_key.strip().lower() == "subscription" \
            and not deployment.current_policy().allow_legacy_sandbox_credentials:
        raise HTTPException(
            422, "the frozen deployment profile forbids 'subscription' auth "
                 "because it copies host credentials into the sandbox; use "
                 "proxied auth or an explicit API key")
    ws = org.d.get("workspace")
    warnings: list[str] = []
    if body.org_dirs is not None:
        # `org_dirs` is typed `list[Any]` on the wire, and norm_dirs assumes
        # every entry is a str or a {path: str} mapping — `[null]` and
        # `[{"path": 123}]` both reached it and came back out as an
        # AttributeError, i.e. a 500. Say what is wrong instead.
        for d in body.org_dirs:
            ok = isinstance(d, str) or (
                isinstance(d, dict)
                and isinstance(cast("dict[str, Any]", d).get("path"), str))
            if not ok:
                raise HTTPException(
                    422, "org_dirs entries must be a path string or "
                         f"{{path, mode}} — got {d!r}")
        # org folder holdings live on the eye's gear (user ruling). Removals
        # revoke everywhere; an rw→ro downgrade propagates to every node's
        # grant (upgrades don't auto-propagate — grant per node deliberately).
        new: list[DirGrant] = [
            {"path": os.path.normpath(d["path"]), "mode": d["mode"]}
            for d in norm_dirs(body.org_dirs)
            if os.path.normpath(d["path"]) != ws]
        old = {d["path"]: d["mode"] for d in org.d["dirs"] if d["path"] != ws}
        newmap = {d["path"]: d["mode"] for d in new}
        for gone in [p for p in old if p not in newmap]:
            for root in org.children(None, live_only=False):
                r = org.revoke_dir(USER, root, gone)
                for nid in r["removed_from"]:
                    warnings.append(f"revoked {gone} from {nid}")
        for p, mode in newmap.items():
            if mode == "ro" and old.get(p) == "rw":
                for nid, n in org.nodes.items():
                    for d in n["scope"]["add_dirs"]:
                        if d["path"] == p and d["mode"] == "rw":
                            d["mode"] = "ro"
                            warnings.append(f"downgraded {p} to read-only for {nid}")
        ws_dir: list[DirGrant] = [{"path": ws, "mode": "rw"}] if ws else []
        org.d["dirs"] = ws_dir + new
    if body.max_top_grant is not None and body.max_top_grant > 0:
        org.d["max_top_grant"] = int(body.max_top_grant)
        # D-014: the cap is a real ledger precondition now. Existing over-cap
        # grants are grandfathered (no sweep — which agents shrink is the
        # user's choice, D-003), but lowering past them deserves the truth
        over = [f'{nid} (grant {org.nodes[nid]["grant"]})'
                for nid in org.children(None)
                if org.nodes[nid]["grant"] > int(body.max_top_grant)]
        if over:
            warnings.append(
                "top-level grants already above the new cap (kept as-is; "
                "the cap binds increases): " + ", ".join(over))
    if body.default_top_grant is not None and body.default_top_grant >= 0:
        org.d["default_top_grant"] = int(body.default_top_grant)
    if body.compact_at is not None:
        # 50–95%; the 95% ceiling is NOT configurable (user ruling)
        org.d["compact_at"] = min(95, max(50, int(body.compact_at))) / 100.0
    if body.clear_fable_lock and org.d.get("fable_lock"):
        org.clear_fable_lock()
        warnings.append("fable lock cleared — fable agents may run and be rehired again")
    if body.fable_limit_policy in ("halt", "opus", "dissolve"):
        org.d["fable_limit_policy"] = body.fable_limit_policy
    if body.fable_filter_policy in ("halt", "opus", "auto-autopsy"):
        org.d["fable_filter_policy"] = body.fable_filter_policy
    if body.fable_filter_model is not None:
        if body.fable_filter_model == "fable":
            raise HTTPException(422, "fable cannot be used as the auto-autopsy model")
        if not providers.is_known_tier(body.fable_filter_model):
            raise HTTPException(422, f"unknown model tier '{body.fable_filter_model}'")
        org.d["fable_filter_model"] = body.fable_filter_model
    if (body.default_tools is not None or body.default_visibility in VIS_LEVELS
            or body.permission_mode is not None):
        # agent defaults: applied to unspecified hires — top level directly,
        # deeper as ∩ with the superior's capability (clamped at hire time).
        # Routed through the ledger so the kiosk ceiling clamps stored
        # defaults too (admin surface → auto_raise applies)
        r = org.set_hire_defaults(
            default_tools=body.default_tools,
            default_visibility=(body.default_visibility
                                if body.default_visibility in VIS_LEVELS
                                else None),
            # admin surface only — /settings is frozen for kiosk visitors, so
            # a share-token holder can never raise the born-with mode
            permission_mode=body.permission_mode,
            raise_ceiling=bool((org.d.get("kiosk") or {}).get("auto_raise")))
        warnings.extend(r.get("warnings") or [])
    if body.default_effort is not None \
            and body.default_effort in ("", *Org.EFFORTS):
        # deliberately outside the ceiling (user cost-dial ruling): no clamp;
        # "" = CLI default; unset-node efforts inherit this LIVE at turn time
        org.d["default_effort"] = body.default_effort
    if body.auto_resume is not None:
        org.d["auto_resume"] = bool(body.auto_resume)
    if body.auto_resume_compact is not None:
        org.d["auto_resume_compact"] = bool(body.auto_resume_compact)
    if body.cascade_hire is not None:
        org.d["cascade_hire"] = bool(body.cascade_hire)
    if body.cascade_alloc is not None:
        org.d["cascade_alloc"] = bool(body.cascade_alloc)
    if body.auto_cheap_compact is not None:
        acc = body.auto_cheap_compact
        if "enabled" in acc or "occ" in acc:
            old = cast("dict[str, Any]",
                       org.d.get("auto_cheap_compact") or {})
            org.d["auto_cheap_compact"] = {
                "enabled": bool(acc.get("enabled", old.get("enabled", False))),
                "occ": min(0.95, max(0.05, float(
                    acc.get("occ", old.get("occ", 0.5)))))}
    # ---- §9.5/§9.6: per-org API key + headless (couplings are HARD rules) --
    if body.api_key is not None and body.api_key.strip():
        org.d["api_key"] = body.api_key.strip()
        warnings.append("API key set — held as the usage-limit fallback (the "
                        "subscription still bills routine turns)"
                        if org.d.get("api_fallback") else
                        "API key set — this org's turns now bill the key, "
                        "not the subscription")
    if body.clear_api_key:
        if org.d.get("headless"):
            raise HTTPException(
                422, "this org runs headless, which REQUIRES an API key "
                     "(subscription auth ends in an interactive re-login "
                     "nobody is present to perform) — turn headless off "
                     "first")
        org.d.pop("api_key", None)
        if org.d.pop("api_fallback", None):
            org.d.pop("api_fallback_until", None)
            org.d.pop("api_fallback_since", None)
            org.d.pop("fable_api_fallback", None)
            warnings.append("API-key fallback off with it — nothing left to "
                            "fall back to")
        warnings.append("API key cleared — turns use the subscription again")
    # ---- api_fallback (user feature 2026-08-17): the key as a SPARE lane ----
    if body.api_fallback is not None:
        if body.api_fallback and not org.d.get("api_fallback"):
            if not org.d.get("api_key"):
                raise HTTPException(
                    422, "the fallback needs an API key to fall back TO — "
                         "set one in the same panel first")
            if org.d.get("headless"):
                raise HTTPException(
                    422, "a headless org bills its key full-time "
                         "(subscription auth ends in an interactive re-login "
                         "nobody is present to perform) — the fallback shape "
                         "only fits orgs on the subscription")
            org.d["api_fallback"] = True
            warnings.append("API-key fallback ON — turns bill the "
                            "subscription; the key takes over only while a "
                            "usage limit has the subscription lane frozen, "
                            "and reverts at the limit's own reset")
        elif not body.api_fallback and org.d.get("api_fallback"):
            org.d.pop("api_fallback", None)
            org.d.pop("api_fallback_until", None)
            org.d.pop("api_fallback_since", None)
            if org.d.pop("fable_api_fallback", None):
                warnings.append("fable-tier fallback OFF with it — it has "
                                "no fallback left to ride")
            if org.d.get("api_key"):
                warnings.append("API-key fallback OFF — the stored key bills "
                                "every turn again")
    # ---- fable_api_fallback (user feature 2026-08-23): opt the fable TIER's
    # own weekly quota into the same billing lane, instead of leaving a
    # trusted hit to fable_limit_policy alone ----
    if body.fable_api_fallback is not None:
        if body.fable_api_fallback and not org.d.get("fable_api_fallback"):
            if not org.d.get("api_fallback"):
                raise HTTPException(
                    422, "this needs the API-key fallback itself ON first "
                         "(same panel) — it rides that window, it doesn't "
                         "open its own")
            org.d["fable_api_fallback"] = True
            warnings.append("fable-tier fallback ON — a trusted weekly Fable "
                            "limit now opens the same key-billing window a "
                            "normal usage limit does, instead of applying "
                            "fable_limit_policy; reverts at the limit's own "
                            "reset like any other fallback window")
        elif not body.fable_api_fallback and org.d.get("fable_api_fallback"):
            org.d.pop("fable_api_fallback", None)
            warnings.append("fable-tier fallback off — a weekly Fable limit "
                            "goes back to fable_limit_policy (halt/opus/"
                            "dissolve)")
    if body.headless is not None:
        if body.headless and not org.d.get("headless"):
            if org.d.get("kiosk") is not None:
                raise HTTPException(422, "a kiosk cannot run headless — it "
                                         "is sealed from the org mail that "
                                         "headless depends on")
            if not org.d.get("api_key"):
                raise HTTPException(
                    422, "headless REQUIRES an API key (set it in the same "
                         "panel): subscription auth ends in an interactive "
                         "re-login that a headless org, by definition, has "
                         "nobody to perform")
            if org.d.get("api_fallback"):
                raise HTTPException(
                    422, "the API key is currently a usage-limit FALLBACK, "
                         "which keeps routine turns on the subscription — "
                         "headless needs the key full-time; turn the "
                         "fallback option off first")
            halted = [k for k in ("fable_limit_policy", "fable_filter_policy")
                      if org.d.get(k, "halt") == "halt"]
            if halted:
                raise HTTPException(
                    422, f"headless refuses while {' and '.join(halted)} "
                         f"is 'halt' — a halted headless org is a dead org "
                         f"nobody will notice; switch the policy first")
            org.d["headless"] = True
            if not org.d.get("auto_resume"):
                org.d["auto_resume"] = True
                warnings.append("auto-resume forced ON — a limit freeze must "
                                "not park an org nobody will un-park")
        elif not body.headless and org.d.get("headless"):
            org.d["headless"] = False
            warnings.append("headless off — review the user inbox for what "
                            "accumulated while nobody was watching")
    # ---- F-06: mail-hub config (non-kiosk orgs only; kiosks are sealed) ----
    if body.net_autoconnect is not None and org.d.get("kiosk") is None:
        org.d["net_autoconnect"] = bool(body.net_autoconnect)
        hubs = list(org.d.get("net_hubs") or [])
        has_local = any(h.get("id") == net.LOCAL_HUB_ID for h in hubs)
        if body.net_autoconnect and not has_local:
            addr = str(load_org_defaults().get("net_hub_address") or "") \
                or net.DEFAULT_HUB_ADDRESS
            hubs.insert(0, {"id": net.LOCAL_HUB_ID, "address": addr,
                            "enabled": True})
        elif not body.net_autoconnect:
            hubs = [h for h in hubs if h.get("id") != net.LOCAL_HUB_ID]
            warnings.append("local hub entry removed — the org no longer "
                            "auto-connects")
        org.d["net_hubs"] = hubs
    if body.net_hubs is not None and org.d.get("kiosk") is None:
        # authoritative replacement of the hub LIST. Ids (and discovered
        # names) survive by id OR BY ADDRESS (redteam ②: minting a fresh id
        # for an identical address orphaned every spooled entry — net_spool
        # keys on the hub id); entries under truly-removed hubs re-key to the
        # first enabled hub (addresses are hub-agnostic, ruled)
        old_hubs = list(org.d.get("net_hubs") or [])
        old_by_id = {str(h.get("id")): h for h in old_hubs}
        old_by_addr = {str(h.get("address")): h for h in old_hubs}
        new_hubs: list[dict[str, Any]] = []
        for h in body.net_hubs:
            if not isinstance(h, dict):
                raise HTTPException(422, "net_hubs entries must be "
                                         "{id?, address, enabled?}")
            hd = cast("dict[str, Any]", h)
            # bare host / host:port entries are valid (user spec 2026-08-05):
            # no scheme assumes http, no port assumes the hub default 7370
            addr = net.normalize_hub_address(str(hd.get("address") or ""))
            if not addr:
                continue
            kept = old_by_id.get(str(hd.get("id") or "")) \
                or old_by_addr.get(addr) or {}
            hid = str(hd.get("id") or "") or str(kept.get("id") or "") \
                or uuid.uuid4().hex[:8]
            new_hubs.append({"id": hid, "address": addr,
                             "enabled": bool(hd.get("enabled", True)),
                             **({k: kept[k] for k in ("peer_token", "peer_slug") if k in kept}
                                if str(kept.get("address")) == addr else {}),
                             **({"name": kept["name"]}
                                if kept.get("name") else {})})
        org.d["net_hubs"] = new_hubs
        org.d["net_autoconnect"] = any(
            h["id"] == net.LOCAL_HUB_ID for h in new_hubs)
        # re-key orphaned spool entries so nothing queued becomes invisible
        spool: dict[str, list[Any]] = org.d.get("net_spool") or {}
        live_ids = {h["id"] for h in new_hubs}
        target = next((str(h["id"]) for h in new_hubs if h["enabled"]), None)
        for gone in [k for k in list(spool) if k not in live_ids]:
            entries: list[Any] = spool.pop(gone) or []
            if entries and target:
                spool.setdefault(target, []).extend(entries)
                warnings.append(f"{len(entries)} queued message(s) moved to "
                                f"the remaining mailserver")
            elif entries:
                spool[gone] = entries    # keep; ① blocks new ones doorside
                warnings.append(f"{len(entries)} queued message(s) have no "
                                f"mailserver to leave through — enable one")
        org.d["net_spool"] = spool
    if (body.net_hubs is not None or body.net_autoconnect is not None) \
            and org.d.get("kiosk") is None:
        # per-hub STATE dies with the configuration it described (redteam
        # second wave): a removed id keeps no registration (a re-added local
        # entry must start hidden until it answers again), and a changed
        # ADDRESS keeps no dedupe ring (a ring carried to a different machine
        # silently swallows a re-homed peer's re-sent ids — dropping it risks
        # a bounded duplicate, never a loss). The net daemon reconciles the
        # same way for direct doc edits.
        cells = cast("dict[str, dict[str, Any]]",
                     org.d.get("net_state") or {})
        addr_now = {str(h.get("id")): str(h.get("address"))
                    for h in org.d.get("net_hubs") or []}
        for k in list(cells):
            if k not in addr_now \
                    or (cells.get(k) or {}).get("address") != addr_now[k]:
                cells.pop(k, None)
    store.save_org(org)
    hub_changed(slug)
    net.kick()
    return {"dirs": org.d["dirs"], "warnings": warnings}


class KioskCfg(Body):
    enabled: bool | None = None
    credits: int | None = None            # top-level holdings cap (0 = uncapped)
    spend_limit: float | None = None      # USD hard limit (0 = unlimited)
    storage_limit_mb: int | None = None   # workspace-dir size cap (0 = unlimited)
    rotate_token: bool = False            # mint a new secret URL (revokes the old)
    max_scope: dict[str, Any] | None = None   # the permission ceiling; setting it SWEEPS
    auto_raise: bool | None = None        # admin over-ceiling grants auto-raise it


@app.post("/api/orgs/{slug}/kiosk")
async def org_kiosk(slug: str, body: KioskCfg) -> dict[str, Any]:
    """Admin-only (the public gateway 403s the path): enable/disable an org as
    a kiosk, adjust its caps, rotate its secret URL. Raising a breached limit
    clears the matching hard freeze — ▶ resume then replays halted turns."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        if not org.d.get("kiosk"):
            # kiosk is a creation-time TYPE (user ruling) — no conversion
            raise HTTPException(
                422, "not a kiosk org — kiosks are created as kiosks (from "
                     "the dashboard's new-kiosk form), never converted")
        # the raise-guard above proves the key; declared so the None arm
        # doesn't cascade through every touch below
        k: KioskDoc = org.d["kiosk"]  # type: ignore[typeddict-item, assignment]
        if body.enabled is not None:
            k["enabled"] = bool(body.enabled)
        if body.credits is not None:
            k["credits"] = max(0, int(body.credits))
        if body.spend_limit is not None:
            k["spend_limit"] = max(0.0, float(body.spend_limit))
        if body.storage_limit_mb is not None:
            # sandboxed kiosks: the limit IS the disk size — same 4096 MB
            # floor as creation, or the migration would silently re-floor it
            if k.get("sandbox") and int(body.storage_limit_mb) < 4096:
                raise HTTPException(
                    422, "sandboxed orgs ride a fixed-size disk with a "
                         "4096 MB minimum — set storage to at least 4096 MB")
            k["storage_limit_mb"] = max(0, int(body.storage_limit_mb))
        # security review 2026-08-01: subscription-auth (copied host OAuth
        # credentials ON the org disk) and a public kiosk URL are mutually
        # exclusive — structurally, not by filename filter (root-in-container
        # can copy the token anywhere the recovery browser serves)
        if k.get("enabled") and k.get("sandbox") \
                and sandbox.uses_subscription_auth(dict(k)):
            raise HTTPException(
                422, "this org's sandbox runs on COPIED host credentials "
                     "(subscription auth) — a public kiosk URL would let "
                     "visitors reach them. Switch to proxied auth first.")
        if (k.get("enabled") and not k.get("token")) or body.rotate_token:
            k["token"] = secrets.token_hex(16)
        # the permission ceiling (consensus spec): setting it SWEEPS every
        # node's stored scope to fit — determinate, so it automates; affected
        # live agents are notified with what they lost
        ceiling_warnings: list[str] = []
        if body.max_scope is not None:
            try:
                r = org.set_kiosk_ceiling(body.max_scope,
                                          auto_raise=body.auto_raise)
            except LedgerError as e:
                raise HTTPException(422, str(e))
            except _BAD_SHAPE as e:
                raise HTTPException(422, f"malformed max_scope: {e}")
            ceiling_warnings = r.get("warnings") or []
            k = org.d["kiosk"]  # type: ignore[typeddict-item, assignment]  # set_kiosk_ceiling keeps the key
        elif body.auto_raise is not None:
            k["auto_raise"] = bool(body.auto_raise)
        # user ruling: the cap can never go BELOW what the org already holds —
        # retire/dissolve agents first, then lower it
        if k.get("enabled") and int(k.get("credits") or 0):
            held = org.audit()["top_level_holds"]
            if int(k["credits"]) < held:  # type: ignore[typeddict-item]  # guard above proves the key
                raise HTTPException(
                    422, f"cap below current holdings: the org holds {held:g} "
                         f"credits — retire or dissolve agents first, then lower it")
        org.d["kiosk"] = k
        cleared: list[str] = []
        spent = org.cost_total()            # incl. deleted agents' burn
        lim = float(k.get("spend_limit") or 0)
        over = k.get("enabled") and lim and spent >= lim
        drive_after: list[str] = []
        if org.d.get("spend_frozen") and not over:
            supervisor.clear_hard_freeze(org, "spend")
            cleared.append("spend")
            # review C7: nodes whose freeze dropped entirely (no interrupted
            # turn to replay via ▶) but whose mailbox filled during the freeze
            # would sit idle until a restart's revive scan — drive them now
            drive_after = [k for k, v in org.nodes.items()
                           if v["state"] == "live" and not v.get("frozen")
                           and (org.d.get("mail") or {}).get(k)]
        store.save_org(org)
        need_freeze = over and not org.d.get("spend_frozen")
    # limits apply in REAL TIME (user ruling), both directions: lowering the
    # spend limit below what's already spent freezes now, not at the next
    # turn's end; the storage recheck applies/lifts the write block likewise
    if need_freeze:
        supervisor.hard_freeze(slug, "spend", "kiosk spend limit reached")
    for t in drive_after:
        supervisor.send_message(
            slug, t, "(orgtree) The spend freeze was lifted — you have mail "
                     "above that arrived while frozen; handle it now.",
            mail_ping=True, ping_reason="freeze_lifted")
    if supervisor.storage_check(slug) == "cleared":
        cleared.append("storage")
    _token_cache["at"] = 0.0             # rotation/enable takes effect now
    await hub.changed(slug)
    safe = {kk: v for kk, v in k.items()
            if kk not in ("api_key", "sandbox_secret")}
    return {"kiosk": safe, "share_url": _share_url(k.get("token")),
            "freezes_cleared": cleared,
            **({"warnings": ceiling_warnings} if ceiling_warnings else {})}


class HireDefaults(Body):
    default_tools: dict[str, Any] | None = None  # {bash, web, edit, subagents, mcp}
    default_visibility: str | None = None   # self|team|subtree|full
    raise_ceiling: bool = False             # admin bridge (ignored for visitors)


@app.post("/api/orgs/{slug}/defaults")
async def org_hire_defaults(slug: str, body: HireDefaults,
                            request: Request) -> dict[str, Any]:
    """Agent-hire defaults — OPEN to kiosk visitors (user ruling 2026-07-31):
    a default is a pre-filled grant, so the ceiling clamps it like any grant.
    The rest of /settings (org folders, caps, policies) stays admin-only."""
    pub = bool(_public_slug(request))
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            rc = (not pub) and (bool((org.d.get("kiosk") or {}).get("auto_raise"))
                                or body.raise_ceiling)
            result = org.set_hire_defaults(
                default_tools=body.default_tools,
                default_visibility=body.default_visibility,
                raise_ceiling=rc)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if pub and isinstance(result, dict):
        result.pop("bridge", None)
    await hub.changed(slug)
    return result


class Scope(Body):
    add_dirs: list[dict[str, Any]] | None = None  # [{path, mode: rw|ro}]
    tools: dict[str, Any] | None = None     # {bash, web, edit, subagents, mcp: []}
    org_visibility: str | None = None
    permission_mode: str | None = None      # rides the ceiling (spec §2)
    charter: str | None = None              # §15: this node's role card
    team_charter: str | None = None         # §15: binds this node's whole subtree
    effort: str | None = None               # thinking effort: low|medium|high|"" clears
    model_version: str | None = None        # a VERSION inside the tier ("" clears)
    # item 12: try the reserve pool first (True) or the plan pool first
    # (False); omitted = unchanged. Luna only has an effect; stored
    # for any tier so it survives a switch.
    prefer_reserve: bool | None = None
    clear_prefer_reserve: bool = False  # return this node to the app default
    # {enabled?, occ?} per-node cache-protection override; {} clears to inherit
    auto_cheap_compact: dict[str, Any] | None = None
    # post-hire @mcp:<peer> response handles (2026-08-22). REPLACES the node's
    # set; [] clears. Read the current set off the org tree first if you mean
    # to ADD one. Superior-only — a handle is an outbound-mail bypass.
    external_handles: list[str] | None = None
    raise_ceiling: bool = False             # the one-action bridge (spec §1)


@app.post("/api/orgs/{slug}/nodes/{nid}/scope")
# plain `def`, not `async` (No.22): the body does load_org + save_org under a
# THREADING lock, and an `async def` runs that ON THE EVENT LOOP -- so while it
# waits for the lock or the disk, every other request and every websocket frame
# waits with it. As a sync def FastAPI runs it in the threadpool and only this
# request pays. Measured 3-22 ms either way, so this is NOT the cause of the
# reported effort lag; it is a hazard that sat on the path and cost nothing to
# remove. 15 other async routes still do doc IO on the loop -- listed in the
# docket, deliberately not swept here.
def node_scope(slug: str, nid: str, body: Scope,
               request: Request) -> dict[str, Any]:
    pub = bool(_public_slug(request))
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            rc = (not pub) and (bool((org.d.get("kiosk") or {}).get("auto_raise"))
                                or body.raise_ceiling)
            result = org.set_scope(USER, nid, add_dirs=body.add_dirs, tools=body.tools,
                                   org_visibility=body.org_visibility,
                                   permission_mode=body.permission_mode,
                                   charter=body.charter,
                                   team_charter=body.team_charter,
                                   effort=body.effort,
                                   model_version=body.model_version,
                                   auto_cheap_compact=body.auto_cheap_compact,
                                   external_handles=body.external_handles,
                                   raise_ceiling=rc,
                                   clear_prefer_reserve=body.clear_prefer_reserve,
                                   prefer_reserve=body.prefer_reserve)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if pub and isinstance(result, dict):
        result.pop("bridge", None)
    # (the explicit broadcast is gone: store.save_org announces every write
    # now -- G2 -- so this was a second, uncoalesced copy of one signal)
    return result


@app.get("/api/fs")
def fs_list(path: str = "") -> dict[str, Any]:
    """Directory listing for the IN-APP folder picker (user ruling: a native
    server-side dialog only works when the browser and server share a desktop;
    this works from anywhere the UI is reachable). Directories only; an empty
    path lists the roots (drives on Windows) plus the home shortcut."""
    if not path:
        if os.name == "nt":
            import string as _string
            roots = [f"{c}:\\" for c in _string.ascii_uppercase
                     if os.path.exists(f"{c}:\\")]
        else:
            roots = ["/"]
        return {"path": "", "parent": None,
                "dirs": [{"name": r, "path": r} for r in roots],
                "home": os.path.expanduser("~")}
    p = os.path.normpath(path)
    if not os.path.isdir(p):
        raise HTTPException(404, f"not a directory: {p}")
    try:
        names = sorted((e for e in os.listdir(p)
                        if os.path.isdir(os.path.join(p, e))), key=str.lower)
    except PermissionError:
        raise HTTPException(403, f"permission denied: {p}")
    parent = os.path.dirname(p)
    if parent == p:
        parent = ""            # drive/filesystem root → back to the roots list
    return {"path": p, "parent": parent,
            "dirs": [{"name": e, "path": os.path.join(p, e)} for e in names]}


CHARTERS_DIR = os.path.normpath(os.path.join(
    os.path.dirname(__file__), "..", "..", "docs", "charters"))


#: A SANITY BOUND on a served preset body, not a charter limit — charters
#: themselves are uncapped (ledger.CHARTER_LONG, user ruling 2026-09-04).
#:
#: This was `body[:6000]`, a bare slice: a longer preset was cut mid-word and
#: neither the payload nor the UI said a word, so the hire form offered a card
#: whose text simply stopped. Two things changed. The cut is DECLARED — see
#: `chars` and `truncated` below — and the bound was raised far above any real
#: preset (the largest shipped one is ~4.3k) so that in practice it never
#: bites at all.
#:
#: It is not removed, because unlike a charter the input here is not something
#: a person typed and can see: the endpoint serializes whatever .md files
#: happen to sit in the directory into one JSON response for the browser. One
#: stray large file should not become an unbounded response. If this bound is
#: ever actually reached, the payload says so rather than going quiet.
PRESET_MAX = 100_000


def user_charters_dir() -> str:
    """The documented, user-editable charter document location: every .md in
    `~/.orgtree/charters` is a charter preset the user may edit or add to with
    any editor. Resolved at call time so HOME/USERPROFILE changes (tests,
    per-user installs) take effect. Populated during onboarding from the
    bundled presets, never overwriting a file the user already has."""
    return os.path.join(os.path.expanduser("~"), ".orgtree", "charters")


def _charter_records(folder: str, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not os.path.isdir(folder):
        return out
    for f in sorted(os.listdir(folder)):
        if not f.endswith(".md"):
            continue
        try:
            with open(os.path.join(folder, f),
                      encoding="utf-8", errors="replace") as stream:
                text = stream.read()
        except OSError:
            continue
        body = text.split("\n---\n", 1)[-1].strip()
        out.append({"name": f[:-3].replace("-", " "),
                    "file": f,
                    "source": source,
                    "content": body[:PRESET_MAX],
                    # the length BEFORE the cut — what makes the cut
                    # visible instead of silent
                    "chars": len(body),
                    "truncated": len(body) > PRESET_MAX,
                    # shown on hover of a picked preset card (user spec)
                    "path": os.path.abspath(os.path.join(folder, f))})
    return out


@app.get("/api/charters")
def charters_list() -> dict[str, Any]:
    """Named charter presets for the manual hire form (user ruling): every
    .md in docs/charters/ is a preset. A file may open with an explanatory
    header ending at a '---' line — only what follows is the charter body.

    User documents in `~/.orgtree/charters` (see `user_charters_dir`) are
    listed alongside the bundled presets and win over a bundled preset with
    the same filename, so editing a populated copy replaces the shipped text
    without touching the installation. Per-agent charters live in each
    organization document and are unaffected by any of this.

    Each record carries `chars` (the body's TRUE length, before any cut) and
    `truncated`, so a cut is never silent. The payload carries `charter_long`
    (ledger.CHARTER_LONG) — NOT a limit, just the length above which the hire
    form mentions that a charter is re-sent on every turn of that agent's life.
    """
    user = _charter_records(user_charters_dir(), "user")
    shadowed = {r["file"] for r in user}
    bundled = [r for r in _charter_records(CHARTERS_DIR, "bundled")
               if r["file"] not in shadowed]
    out = sorted(user + bundled, key=lambda r: r["name"])
    return {"charters": out, "preset_max": PRESET_MAX,
            "user_dir": user_charters_dir(),
            "charter_long": ledger_mod.CHARTER_LONG}


#: A charter document filename (without .md): plain names only — no path
#: separators, drive letters, dots or leading/trailing spaces, so a request
#: can never name a file outside the user charters directory.
CHARTER_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,118}[A-Za-z0-9])?")


@app.post("/api/charters/populate")
def charters_populate() -> dict[str, Any]:
    """Copy every bundled preset into `~/.orgtree/charters` — the documented
    charter document location — creating the directory if needed. A file the
    user already has is NEVER overwritten, so running this repeatedly (every
    onboarding, a reinstall) preserves user edits. Returns what was created
    and what was left alone."""
    folder = user_charters_dir()
    os.makedirs(folder, exist_ok=True)
    created, existing = [], []
    if os.path.isdir(CHARTERS_DIR):
        for f in sorted(os.listdir(CHARTERS_DIR)):
            if not f.endswith(".md"):
                continue
            target = os.path.join(folder, f)
            if os.path.lexists(target):
                existing.append(f)
                continue
            try:
                blob = open(os.path.join(CHARTERS_DIR, f), "rb").read()
                with open(target, "xb") as out_file:
                    out_file.write(blob)
                created.append(f)
            except FileExistsError:
                existing.append(f)
            except OSError as exc:
                raise HTTPException(503, f"Could not populate {f}: {exc}") from exc
    return {"dir": folder, "created": created, "existing": existing}


class CharterDoc(BaseModel):
    content: str


@app.put("/api/charters/{name}")
def charters_save(name: str, body: CharterDoc) -> dict[str, Any]:
    """Save one charter document under `~/.orgtree/charters/<name>.md`. This
    is the editing seam for charter documents: the hire form and any editor
    write here, never into the bundled presets, and the next /api/charters
    read serves the updated text. Per-agent charters live in each
    organization document and are untouched by this route."""
    if not CHARTER_NAME.fullmatch(name):
        raise HTTPException(422, "charter names are plain words, digits, spaces, - and _")
    if len(body.content) > PRESET_MAX:
        raise HTTPException(422, f"charter documents are bounded at {PRESET_MAX} characters")
    folder = user_charters_dir()
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, f"{name}.md")
    try:
        with open(target, "w", encoding="utf-8", newline="") as out_file:
            out_file.write(body.content)
    except OSError as exc:
        raise HTTPException(503, f"Could not save the charter document: {exc}") from exc
    return {"saved": f"{name}.md", "path": os.path.abspath(target)}


@app.get("/api/mcp-servers")
def mcp_servers() -> dict[str, Any]:
    """Names of the user's globally registered MCP servers, grantable per node.
    sandbox_mcp = the experimental ORGTREE_SANDBOX_MCP flag: without it, ALL
    servers are excluded from sandboxed orgs (external contact points the
    sandbox restricts) and the UI greys them out."""
    return {"servers": sorted(supervisor.registered_mcp_servers()),
            "sandbox_mcp": supervisor.sandbox_mcp_enabled()}


# the host subscription's rate-limit standing — the same bars Claude Code
# shows under /usage. Admin-only by construction: the public gateway 404s any
# /api path outside /api/orgs/<own>.
@app.get("/api/usage")
async def claude_usage(force: bool = False) -> dict[str, Any]:
    """The bars the header usage modal renders. The fetch, the 30 s cache and
    the normalization all live in `limits` — the freeze path reads the SAME
    readout to time a limit (user ruling 2026-08-18), and two caches of one
    account-wide standing would disagree about when a limit lifts.

    Contract (frontend UsagePayload): `{available, error?, limits?[], plan?}`,
    stale-on-error, unknown `kind`s rendered generically."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(limits.fetch, force)


# the same standing, read from cache alone — what the header button's near-
# the-wall glow polls. Deliberately a SEPARATE route rather than a flag on
# /api/usage: the modal may spend an upstream request, the always-on glow may
# not, and a caller that cannot ask for the expensive behaviour cannot
# accidentally get it.
@app.get("/api/usage/peek")
def claude_usage_peek() -> dict[str, Any]:
    """Cache-only usage standing for the header glow — see `limits.peek`."""
    return limits.peek()


@app.get("/api/codex/usage")
async def codex_usage(force: bool = False) -> dict[str, Any]:
    """The signed-in Codex account's rate-limit windows.

    The local Codex app-server owns both the protocol and the credentials;
    this route only normalizes its read-only response for the shared bars.
    The process exchange is blocking, so keep it off the event loop.
    """
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(codex_limits.fetch, force)


@app.get("/api/codex/usage/peek")
def codex_usage_peek() -> dict[str, Any]:
    """Cache-only Codex usage standing for the header warning glow."""
    return codex_limits.peek()


@app.get("/api/antigravity/usage")
def antigravity_usage() -> dict[str, Any]:
    """The Antigravity account's standing for the header modal — OBSERVED,
    never fetched. The CLI exposes no usage readout in print mode (measured;
    see `antigravity_limits`), so this reads the last wall a turn hit and
    the reset parsed from it. Synchronous: no process, no network.

    It also carries `usage_estimate`: what the RECORDED intervals support,
    which is a different question from the standing (an interval is measured
    after its wall has lifted, and with none running from an observed reset to
    a later wall it refuses to give a number at all). Attached here rather
    than inside `fetch` so the standing stays the standing; it reads local
    journal files only."""
    data = antigravity_limits.fetch()
    data["usage_estimate"] = antigravity_limits.standing_estimate()
    return data


@app.get("/api/antigravity/usage/peek")
def antigravity_usage_peek() -> dict[str, Any]:
    """Cache-only Antigravity standing for the header warning glow."""
    return antigravity_limits.peek()


@app.get("/api/openrouter/usage")
async def openrouter_usage(force: bool = False) -> dict[str, Any]:
    """The stored OpenRouter key's credit standing for the header modal.

    OpenRouter is a prepaid credit balance, not a rolling percentage window
    (see `openrouter_limits`'s module docstring); `GET /api/v1/key` is a
    plain HTTP call routed off the event loop like every other fetch here.
    """
    from . import openrouter_limits              # noqa: PLC0415 — one lane
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(openrouter_limits.fetch, force)


@app.get("/api/openrouter/usage/peek")
def openrouter_usage_peek() -> dict[str, Any]:
    """Cache-only OpenRouter standing for the header warning glow."""
    from . import openrouter_limits              # noqa: PLC0415
    return openrouter_limits.peek()


# ------------------------------------------ machine-local account routing
# (user redesign 2026-08-25.) Machine-global config, NOT org-scoped: which
# accounts this machine may bill and where each model tier's prompts route.
# Admin-only -- `_public_denied` freezes the whole `/api/accounts` prefix
# explicitly rather than relying on its trailing 404, because "it happens to
# fall through" is not an access rule anyone can safely edit around later.
#
# NO TOKEN MATERIAL IN ANY PAYLOAD HERE: a pasted key crosses the wire once,
# inward, at registration -- after that every response speaks in row ids.
class AccountKey(BaseModel):
    token: str
    # The mint happened in an external CLI before this request. This optional
    # operator-supplied fact is absent when unknown; the backend must not infer
    # it from its own session and call that provenance.
    mint_config_dir: str | None = None


class AccountKeyOrder(BaseModel):
    keys: list[str]


@app.get("/api/accounts")
def accounts_readout() -> dict[str, Any]:
    """The panel: the primary login (whoever Claude Code is signed in as on
    this machine -- not switchable from here), the key rows in priority
    order, and which account each model tier currently routes to."""
    return accounts.readout()


@app.post("/api/accounts/keys")
async def accounts_add_key(body: AccountKey) -> dict[str, Any]:
    """Register a pasted `claude setup-token` key as a secondary account row.

    STORE FIRST, RESOLVE AFTER -- the user's standing ruling: the CLI shows a
    minted token exactly once ("you won't be able to see it again"), so the
    write to the token store happens before anything can form an opinion
    about the value. The identity lookup — which supplies the uuid the panel
    renders beside the row, and nothing else since D-148 retired the
    duplicate-of-primary check — runs afterwards, against a copy that is
    already durable; threadpooled because it is a network call. The token is
    never echoed back, never logged, and never appears in any response."""
    from fastapi.concurrency import run_in_threadpool
    try:
        rec = await run_in_threadpool(accounts.register_key, body.token,
                                      body.mint_config_dir)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return {**accounts.readout(), "registered": rec["id"]}


@app.delete("/api/accounts/keys/{kid}")
def accounts_delete_key(kid: str) -> dict[str, Any]:
    """Remove a key row AND its stored key. Irreversible from orgtree's side
    -- the CLI cannot show a token again, so this is a re-mint, not an
    undo. The row's routing marks go with it."""
    removed = accounts.remove_key(kid)
    return {**accounts.readout(), "removed": removed}


@app.put("/api/accounts/order")
def accounts_key_order(body: AccountKeyOrder) -> dict[str, Any]:
    """The secondary rows' priority order (the panel's drag). A row omitted
    by a stale panel is appended rather than deleted -- a POST from a page
    that loaded before the last registration must not drop a key."""
    accounts.set_key_order(list(body.keys))
    return accounts.readout()


@app.get("/api/accounts/usage")
async def accounts_usage_all() -> dict[str, Any]:
    """Every account's usage standing, primary first then keys in priority
    order -- the header usage modal's list (user ruling 2026-08-25: the
    overall usage button shows every registered account, fallbacks
    included). Network, cached ~30 s per account; threadpooled."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(accounts.usage_all)


@app.get("/api/accounts/usage/{account}")
async def accounts_usage_one(account: str) -> dict[str, Any]:
    """One account's usage standing -- `primary` or a key row id. Unknown
    rows answer `{available: False, error}` rather than 404: the panel's
    button must degrade to a message, not an error toast, when a row was
    deleted under it."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(accounts.account_usage, account)


@app.get("/api/host")
def host_info() -> dict[str, Any]:
    """Host capabilities the UI adapts to (e.g. no Docker → the sandbox
    checkbox is disabled at org creation)."""
    return {"docker": sandbox.docker_available(),
            "sandbox_mcp": supervisor.sandbox_mcp_enabled(),
            # the commit this backend was started from, so the UI can show
            # which deploy is actually serving (frozen at process start —
            # see build_info)
            "build": supervisor.build_info(),
            "cli_version": supervisor.cli_version(),
            # WHICH cli, not just its version: a bare version number is only
            # actionable to someone who already knows what it should be, so a
            # vanished pin was invisible on every surface the user can see.
            # `cli_diagnosis` is None on a healthy machine.
            "cli": supervisor.cli_resolution(),
            "cli_problem": supervisor.cli_diagnosis(),
            # None = uvicorn has no WebSocket implementation, so pushed updates
            # never reach the browser and the UI is running on its polling
            # heartbeats alone. Reported here so the deployment can SAY it
            # rather than just feeling slow (see _ws_impl).
            "websockets": _ws_impl(),
            # which interpreter is serving. `venv` false means the deps live in
            # a system-wide Python shared with every other project, which is
            # how the missing-websockets bug stayed invisible for so long
            # (D-46). Reported so the answer needs no process forensics: on
            # Windows a venv-launched process reports the BASE exe in the task
            # list, so "which python is this" is genuinely hard to see from
            # outside.
            "python": {"prefix": sys.prefix,
                       "venv": sys.prefix != sys.base_prefix,
                       "version": sys.version.split()[0]}}


def _providers_payload() -> dict[str, Any]:
    """Compose one provider document for reads and preference writes."""
    live = accounts.live_identity()
    inst = supervisor.claude_install_state()
    return providers.providers_payload({
        "installed": bool(inst["installed"]),
        "path": inst["path"],
        "source": inst["source"],
        "version": supervisor.cli_version() if inst["installed"] else None,
        "connected": bool(inst["installed"] and live.get("uuid")),
        "email": live.get("email") or None,
    })


_TIER_DISCOVERY_FIELDS = (
    "tier", "provider", "seat", "model", "letter", "color", "accent",
    "name", "label", "vendor", "prompt", "completion", "context",
    "price_unknown", "price_source", "tools", "image", "reasoning",
)
_TIER_DISCOVERY_NUMBERS = frozenset({
    "seat", "prompt", "completion", "context",
})
#: Fields whose only legitimate values are `True`, `False` and `None`.
#: ⚠ THEY NEED THEIR OWN BRANCH. The default arm below admits `str` or `None`
#: and rejects everything else, so simply naming `tools` in the tuple above
#: would make every OpenRouter tier a "malformed tier" and take the whole
#: discovery document down with it. Identity checks, not truthiness: `0`/`1`
#: are not this field's values, and `1 == True` would let an int through a
#: `value in (True, False)` test.
#: `image` and `reasoning` joined 2026-09-05 (unit C) — measured before the
#: change: naming either in the tuple alone failed the whole document.
_TIER_DISCOVERY_TRISTATE = frozenset({"tools", "image", "reasoning"})


def _tier_discovery_payload() -> dict[str, Any]:
    """A secret-free, allowlisted projection of the provider document.

    This result is turn data, never a tool definition. Missing prices remain
    ``None`` rather than becoming a plausible zero-cost seat.
    """
    try:
        document = _providers_payload()
    except Exception as exc:  # noqa: BLE001 — fail closed at discovery boundary
        raise RuntimeError("tier discovery is unavailable") from exc
    if not isinstance(document, dict):
        raise RuntimeError("provider discovery returned malformed data")
    raw = document.get("providers")
    if not isinstance(raw, list):
        raise RuntimeError("provider discovery returned no provider list")
    out: list[dict[str, Any]] = []
    for provider in raw:
        if not isinstance(provider, dict) or not isinstance(
                provider.get("tiers"), list):
            raise RuntimeError("provider discovery returned malformed data")
        provider_id = provider.get("id")
        label = provider.get("label")
        reason = provider.get("reason")
        hire_enabled = provider.get("hire_enabled")
        if (not isinstance(provider_id, str) or not isinstance(label, str)
                or reason is not None and not isinstance(reason, str)
                or not isinstance(hire_enabled, bool)):
            raise RuntimeError("provider discovery returned malformed data")
        tiers: list[dict[str, Any]] = []
        for row in provider["tiers"]:
            if not isinstance(row, dict) or not isinstance(row.get("tier"), str):
                raise RuntimeError("provider discovery returned a malformed tier")
            item: dict[str, Any] = {}
            for key in _TIER_DISCOVERY_FIELDS:
                if key not in row:
                    continue
                value = row[key]
                if key in _TIER_DISCOVERY_NUMBERS:
                    if value is not None and (isinstance(value, bool)
                                              or not isinstance(value, (int, float))
                                              or isinstance(value, float)
                                              and not math.isfinite(value)):
                        raise RuntimeError(
                            "provider discovery returned a malformed tier")
                elif key == "price_unknown":
                    if (not isinstance(value, list)
                            or not all(isinstance(x, str) and x in (
                                "prompt", "completion", "cache_read",
                                "cache_write") for x in value)):
                        raise RuntimeError(
                            "provider discovery returned a malformed tier")
                    value = list(dict.fromkeys(value))
                elif key in _TIER_DISCOVERY_TRISTATE:
                    if not (value is True or value is False or value is None):
                        raise RuntimeError(
                            "provider discovery returned a malformed tier")
                elif key == "price_source":
                    if value not in (
                            "openrouter-catalog", "legacy-catalog-snapshot"):
                        raise RuntimeError(
                            "provider discovery returned a malformed tier")
                elif value is not None and not isinstance(value, str):
                    raise RuntimeError(
                        "provider discovery returned a malformed tier")
                item[key] = value
            item.setdefault("seat", None)
            tiers.append(item)
        out.append({
            "id": provider_id,
            "label": label,
            "hire_enabled": hire_enabled,
            "reason": reason,
            "tiers": tiers,
        })
    return {
        "advisory": (
            "Machine availability only. A hire or switch rechecks fresh "
            "provider evidence plus caller scope, credits and kiosk/headless "
            "rules, and can still refuse a listed tier."),
        "providers": out,
    }


@app.get("/api/providers")
async def providers_info() -> dict[str, Any]:
    """The provider axis (FR-15 preview): each vendor's tier family and this
    machine's install/connect state for its CLI. The claude entry is composed
    from state the API layer already owns; the codex entry is providers.py's
    own read-only detection. Threadpooled: a cold codex probe may run a
    `--version` subprocess (hard 15s timeout), which must not stall the
    event loop the way it would stall nothing else."""
    from fastapi.concurrency import run_in_threadpool

    return await run_in_threadpool(_providers_payload)


class ProviderPreference(Body):
    enabled: bool


@app.put("/api/providers/{provider_id}/enabled")
async def provider_preference(
    provider_id: str, body: ProviderPreference,
) -> dict[str, Any]:
    """Set one machine-wide admission choice and return fresh provider state.

    There is deliberately no org slug: this choice controls future admissions
    in every org installed under the same ORGTREE_DATA root.
    """
    if provider_id not in appsettings.PROVIDERS:
        raise HTTPException(404, f"unknown provider {provider_id!r}")
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(
            appsettings.set_provider_enabled, provider_id, body.enabled)
    except (appsettings.AppSettingsUnreadable, OSError) as e:
        raise HTTPException(500, str(e)) from e
    return await run_in_threadpool(_providers_payload)


# ── the OpenRouter lane's own doors (2026-09-02) ───────────────────────────
# Machine-wide like the provider switch above: the key, the favorites and the
# catalog belong to this MACHINE, never to an org. Nothing here returns the
# key — the status document says `key_set` and what openrouter.ai answered.

class OpenRouterKey(Body):
    key: str


class OpenRouterFavorite(Body):
    id: str
    selected: bool


def _openrouter_doc(force: bool = False) -> dict[str, Any]:
    from . import openrouter                    # noqa: PLC0415 — one lane
    st = openrouter.status(force)
    st["tiers"] = openrouter.tier_infos()
    st["user_enabled"] = appsettings.provider_enabled(openrouter.PROVIDER_ID)
    return st


@app.get("/api/openrouter")
async def openrouter_status(force: bool = False) -> dict[str, Any]:
    """Key standing (secret-free), credits, and the favorites as tier rows.
    `force` re-asks openrouter.ai past the 60s cache (the panel's refresh)."""
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(_openrouter_doc, force)


@app.put("/api/openrouter/key")
async def openrouter_set_key(body: OpenRouterKey) -> dict[str, Any]:
    """Store the machine-wide key; answers with the fresh standing so the
    panel can show 'connected · label · credits' or the rejection at once."""
    from . import openrouter                    # noqa: PLC0415
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(openrouter.set_key, body.key)
    except openrouter.OpenRouterError as e:
        raise HTTPException(422, str(e)) from e
    except OSError as e:
        raise HTTPException(500, str(e)) from e
    return await run_in_threadpool(_openrouter_doc, True)


@app.delete("/api/openrouter/key")
async def openrouter_clear_key() -> dict[str, Any]:
    from . import openrouter                    # noqa: PLC0415
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(openrouter.set_key, "")
    except OSError as e:
        raise HTTPException(500, str(e)) from e
    return await run_in_threadpool(_openrouter_doc, True)


@app.get("/api/openrouter/models")
async def openrouter_models(q: str = "", offset: int = 0, limit: int = 0,
                            sort: str = "relevance", order: str = "",
                            group_by_vendor: bool = False) -> dict[str, Any]:
    """The picker's page over the catalog (`openrouter.PAGE_*` bounds it; 0
    here means "whatever the module's default is", so the page length lives
    in one place rather than being restated on the wire). A cold
    catalog costs one GET to openrouter.ai, which is why this is
    threadpooled; a dead network with a stale disk copy still answers.

    `sort`/`order`/`group_by_vendor` are the picker's ordering controls (user
    spec 2026-09-04) and are applied SERVER-SIDE because the page is 8 rows
    out of 426 — a client-side sort would reorder one page and be wrong. An
    unknown sort falls back to relevance rather than erroring: an ordering
    preference is not worth failing a catalog read over."""
    from . import openrouter                    # noqa: PLC0415
    from fastapi.concurrency import run_in_threadpool
    try:
        return await run_in_threadpool(openrouter.search, q, offset, limit,
                                       sort, order, group_by_vendor)
    except openrouter.OpenRouterError as e:
        raise HTTPException(502, str(e)) from e


@app.put("/api/openrouter/favorites")
async def openrouter_favorite(body: OpenRouterFavorite) -> dict[str, Any]:
    """Select (adopt as a hireable tier) or deselect (stop offering) one
    catalog model. Model ids carry a `/`, hence a body rather than a path."""
    from . import openrouter                    # noqa: PLC0415
    from fastapi.concurrency import run_in_threadpool
    try:
        if body.selected:
            await run_in_threadpool(openrouter.add_favorite, body.id)
        else:
            await run_in_threadpool(openrouter.remove_favorite, body.id)
    except openrouter.OpenRouterError as e:
        raise HTTPException(422, str(e)) from e
    except OSError as e:
        raise HTTPException(500, str(e)) from e
    return await run_in_threadpool(_openrouter_doc)


class RuntimePreference(Body):
    # `enabled` is the established process-warming wire key. Keep it stable;
    # the explicit second key lets either control change without rewriting the
    # other durable value.
    enabled: bool | None = None
    working_checkups_enabled: bool | None = None
    wait_for_mcp_tools_enabled: bool | None = None
    idle_docket_reminders_enabled: bool | None = None
    git_periodic_fetch_enabled: bool | None = None


def _runtime_preferences() -> dict[str, bool]:
    return {
        "git_periodic_fetch_enabled": appsettings.git_periodic_fetch_enabled(),
        "warming_enabled": warmpool.warm_enabled(),
        "working_checkups_enabled": appsettings.working_checkups_enabled(),
        "wait_for_mcp_tools_enabled": (
            appsettings.wait_for_mcp_tools_enabled()),
        "idle_docket_reminders_enabled": (
            appsettings.idle_docket_reminders_enabled()),
    }


@app.get("/api/app-settings/runtime")
async def runtime_preference_info() -> dict[str, bool]:
    """Return machine-wide process and reported-working lifecycle choices.

    Process warming still reads D-201's warm.flag through warmpool rather than
    mirroring it in app-settings.json. The stale-working choice is additive
    runtime policy and lives in the application settings record.
    """
    from fastapi.concurrency import run_in_threadpool

    return await run_in_threadpool(_runtime_preferences)


@app.put("/api/app-settings/runtime")
async def runtime_preference(body: RuntimePreference) -> dict[str, bool]:
    """Update one runtime choice without disturbing the others."""
    from fastapi.concurrency import run_in_threadpool

    if (body.enabled is None and body.working_checkups_enabled is None
            and body.wait_for_mcp_tools_enabled is None
            and body.idle_docket_reminders_enabled is None
            and body.git_periodic_fetch_enabled is None):
        raise HTTPException(422, "one runtime setting is required")
    try:
        if body.enabled is not None:
            await run_in_threadpool(warmpool.set_enabled, body.enabled)
        if body.working_checkups_enabled is not None:
            await run_in_threadpool(
                appsettings.set_working_checkups_enabled,
                body.working_checkups_enabled)
        if body.wait_for_mcp_tools_enabled is not None:
            await run_in_threadpool(
                appsettings.set_wait_for_mcp_tools_enabled,
                body.wait_for_mcp_tools_enabled)
        if body.idle_docket_reminders_enabled is not None:
            await run_in_threadpool(
                appsettings.set_idle_docket_reminders_enabled,
                body.idle_docket_reminders_enabled)
        if body.git_periodic_fetch_enabled is not None:
            await run_in_threadpool(appsettings.set_git_periodic_fetch_enabled, body.git_periodic_fetch_enabled)
        result = await run_in_threadpool(_runtime_preferences)
    except (appsettings.AppSettingsUnreadable, OSError) as e:
        raise HTTPException(500, str(e)) from e
    return result


class Reorder(Body):
    before: str | None = None
    after: str | None = None


@app.post("/api/orgs/{slug}/nodes/{nid}/reorder")
async def node_reorder(slug: str, nid: str, body: Reorder) -> dict[str, Any]:
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            result = org.reorder(USER, nid, before=body.before, after=body.after)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    await hub.changed(slug)
    return result


class Message(Body):
    text: str
    # relative uploads/ paths already landed via the upload endpoint — the
    # composer stages them and sends them WITH the mail (user spec 2026-07-31)
    attachments: list[str] = []
    # FR-05: when this is an inline mailbox REPLY, a snapshot of the mail it
    # answers ({id, from, at, gist}) — quoted in the agent's [MAIL] block.
    # LEGACY path (design §8): an ordinary message with a quote.
    reply_to: dict[str, Any] | None = None
    # STEP 4: the qualified reply target — identity keys only (events.ReplyTarget);
    # the server fetches the object and mints reply.mail / reply.document /
    # reply.docket. Exactly one of `target` / `reply_to`.
    target: dict[str, Any] | None = None


def _send_receipt(org: Org, slug: str, nid: str, r: Mapping[str, Any], *,
                  public: str | None) -> dict[str, Any]:
    """The durable receipt of a mail-producing send (TypedReplyReceipt): the
    delivered id, its `@mail:` ref and the minted event in the CALLER's
    projection (`ev` for the operator, `ev_public` for a visitor — never both).
    The event is read back from the stored row, so what the receipt says is
    exactly what the websocket row for the same id will say."""
    mid = str(r.get("id") or "")
    out: dict[str, Any] = {"id": mid, "ref": refs.mail(slug, nid, mid) or ""}
    rows = [*((org.d.get("mail") or {}).get(nid) or []),
            *((org.d.get("mail_log") or {}).get(nid) or [])]
    row = next((m for m in rows if str(m.get("id")) == mid), None)
    if row is not None:
        w = events.wire_row(row, public=bool(public))
        for k in ("ev", "ev_public"):
            if k in w:
                out[k] = w[k]
    return out


@app.post("/api/orgs/{slug}/nodes/{nid}/message")
def node_message(slug: str, nid: str, body: Message,
                 request: Request = cast(Request, None)) -> dict[str, Any]:
    """A user message IS mail (user ruling — the direct-message channel was
    folded into the mail system): it lands persisted in the node's mailbox
    (and in your Sent folder), then the node is driven; a busy node gets it
    mid-task via steering, never an interrupt. Talking to a non-top-level
    node notifies its whole superior chain (§7.4) and grants a user audience."""
    if not body.text.strip():
        raise HTTPException(422, "empty message")
    if body.target is not None and body.reply_to is not None:
        raise HTTPException(422, "send one of target, reply_to")
    target: dict[str, str] | None = None
    if body.target is not None:
        try:
            target = events.parse_reply_target(body.target)
        except events.EventInvalid as e:
            raise HTTPException(422, f"target: {e}")
    stripped = body.text.strip()
    # SLASH COMMAND (user-approved, 2026-07-31): a session command, not
    # correspondence — no mail entry, and it must reach the CLI with the
    # "/" at position 0 (the envelope would prepend [MAIL …] otherwise).
    # Command-SHAPED only (review C3b): "/compact", "/context foo" — a first
    # token with internal slashes ("/e/Libraries/report.md — pick this up")
    # is correspondence and keeps full MAIL semantics (durability, a Sent copy,
    # delivery at rehire). What a command DOES share with a message, since
    # 2026-08-03, is the two consequences of direct user contact: the superior
    # chain is notified and the node gains a user audience. Those are about who
    # the user reached, not about whether a copy was filed.
    if stripped.startswith("/") \
            and re.fullmatch(r"/[A-Za-z?][\w-]*", stripped.split()[0]):
        with store.DOC_LOCK:
            try:
                org = store.load_org(slug)
                n = org.node(nid)
            except LedgerError as e:
                raise HTTPException(404, str(e))
            # review C3a: the old path returned "accepted" for nodes that run
            # nothing, while the composer printed "delivering"/"deferred —
            # delivers at rehire" — affirmatively false, since the command
            # path persists no copy anywhere. Refuse with the real reason
            # instead (house style: manual_compact's own 409).
            if n["state"] != "live":
                raise HTTPException(
                    409, f"{nid} is {n['state']} — a session command runs "
                         f"nothing there and is not mail (nothing would "
                         f"survive to deliver at rehire); rehire first, or "
                         f"send it as a plain message")
            if n.get("frozen"):
                raise HTTPException(
                    409, "frozen (usage limit) — a session command would be "
                         "dropped, not queued; ▶ resume the org first")
            if n.get("remote_controlled"):
                # FR-01 (redteam): the remote park queues MAIL, but a command
                # has no mailbox behind it — success here would be a lie
                raise HTTPException(
                    409, "under remote control — a session command would be "
                         "dropped, not queued; release remote control first")
            # A command is direct user contact, so it carries the same two
            # consequences a message does: the superior chain is told, and the
            # node gains a user audience (user report 2026-08-03 — running a
            # command did neither, so the user could `/compact` an agent deep
            # in a tree and nobody above it would ever know). Done HERE, after
            # the validity checks and before any of the three command paths
            # below, so all of them get it from one place — the branch has
            # several returns and per-return calls would rot apart.
            org.user_deep_reach(nid, stripped[:160], kind="command")
            store.save_org(org)
        if stripped.split()[0] == "/compact":
            # review C4: one word, one meaning. The hinted /compact used to
            # compact the CLI session IN PLACE — same desk, same word as the
            # compact button, opposite §8 consequence (no knowledge bearer).
            # It now routes to the same org split the button runs.
            if n.get("bearer_state"):
                raise HTTPException(422, "a knowledge bearer never re-compacts (§8.3)")
            if n.get("remote_controlled"):
                # FR-01: unreachable today (the endpoint's own remote gate
                # refuses first), kept HERE like busy/bearer so the branch
                # stays safe if it ever moves — the fork rebinds the session
                # id out from under the phone
                raise HTTPException(409, "under remote control — release it "
                                         "before compacting")
            if not n.get("occupancy"):
                raise HTTPException(422, "no conversation yet — nothing to compact")
            if n.get("compacted_unrun"):
                # A just-compacted node used to be blocked here by its
                # occupancy being None; it now carries the post-compaction fill
                # instead (user bug 2026-08-20), so the refusal has to be said
                # out loud. Re-forking a session whose whole content is a
                # summary costs a full CLI child and mints a bearer holding
                # nothing the successor lacks.
                raise HTTPException(422, "just compacted — nothing to compact "
                                         "until it takes a turn")
            if supervisor.state(slug, nid)["busy"]:
                raise HTTPException(409, "busy — wait for the current turn to finish")

            def run() -> None:
                try:
                    supervisor.manual_compact(slug, nid)
                except RuntimeError:
                    pass      # raced into busy — the 409 precheck caught most

            threading.Thread(target=run, daemon=True).start()
            r: dict[str, Any] = {"accepted": True, "compacting": True}
            if stripped != "/compact":
                r["warnings"] = ["/compact arguments are ignored — org "
                                 "compaction preserves the whole session as "
                                 "a knowledge bearer"]
            return r
        # /context-class commands (user spec): answered IMMEDIATELY via a
        # throwaway session fork — works mid-turn, output rides the live feed
        if supervisor.immediate_command(slug, nid, stripped):
            return {"accepted": True, "command": True, "immediate": True}
        return supervisor.send_message(slug, nid, stripped, command=True)
    # staged attachments: already-uploaded files in the node's own scratch —
    # verify each really exists there (traversal-guarded) and ride metadata
    metas: list[dict[str, Any]] = []
    missing: list[str] = []
    if body.attachments:
        # same rule as /scratch: `nid` reaches the filesystem here (via
        # scratch_dir's makedirs), so it must name a real node first — an
        # unresolved `..\..\..\x` created a directory outside the data root
        # and only THEN got its 422 from post_mail
        try:
            store.load_org(slug).node(nid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        base = os.path.realpath(supervisor.scratch_dir(slug, nid))
        extra = len(body.attachments) - ledger_mod.ATTACHMENT_MAX
        for rel in body.attachments[:ledger_mod.ATTACHMENT_MAX]:
            full = os.path.realpath(
                os.path.join(base, _no_nul(str(rel)).lstrip("/\\")))
            # ⚠⚠ RESOLVE-OR-REPORT, AND IT IS DELIBERATE — do not "helpfully"
            # fall back to guessing a filename from `rel` (D-171). A caller
            # MUST send back the `path` this org's upload endpoint returned:
            # that endpoint de-duplicates, so the name it stores is often NOT
            # the name that was uploaded (`shot.png` becomes `shot-2.png`),
            # and a guess would attach the WRONG existing file — silently, and
            # to whoever the earlier upload belonged to. Refusing to guess is
            # the safe half; what was missing until D-171 was the other half,
            # SAYING SO. @org:resonite measured the gap against a live backend
            # (HTTP 200, no mail line, no warning, nothing to detect) and it
            # was reproduced here before the fix. The report below is now
            # load-bearing for callers that fail loudly on a missing path — it
            # is not decoration, and deleting it re-opens a defect an outside
            # party had to find for us. Pinned by test_inline_images.py §5.
            if full.startswith(base + os.sep) and os.path.isfile(full):
                metas.append({"name": os.path.basename(full),
                              "path": str(rel).replace("\\", "/"),
                              "bytes": os.path.getsize(full)})
            else:
                missing.append(f"{rel} — no such file in your working folder "
                               f"(never uploaded, or the upload failed)")
        if extra > 0:
            # bounded on purpose: the report names what it can and COUNTS the
            # rest, rather than echoing an unbounded caller-supplied list into
            # an agent's context
            missing.append(f"{extra} further attachment(s) — past the "
                           f"{ledger_mod.ATTACHMENT_MAX}-per-message limit")
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            reply_meta: dict[str, Any] | None = None
            if body.reply_to is not None and target is None:
                raw_ref = body.reply_to.get("source_event_ref")
                source_ref, quote = supervisor.resolve_chat_event(org, nid, raw_ref)
                reply_meta = {"source_event_ref": source_ref,
                              "quoted_context": quote,
                              "gist": " ".join(quote.split())[:200]}
            if target is not None:
                ref, extra = org.resolve_reply_target(target, nid)
                # a literal per kind: the coverage scan (test_events_ledger §7)
                # wants every mint( site to name its variant as a string literal
                if target["kind"] == "mail":
                    rev = events.mint("reply.mail", actor_of(USER), ref, body=body.text, **extra)
                elif target["kind"] == "document":
                    rev = events.mint("reply.document", actor_of(USER), ref, body=body.text)
                else:
                    rev = events.mint("reply.docket", actor_of(USER), ref, body=body.text,
                                      **extra)
                # the legacy quote still rides the row for old readers (kind=mail)
                legacy_rt = ({"id": ref["id"], "from": ref["sender"], "at": ref["at"],
                              "gist": extra["quote"]["gist"]}
                             if target["kind"] == "mail" else None)
                r = org.post_mail(USER, nid, "", attachments=metas or None,
                                  reply_to=legacy_rt, missing=missing or None, ev=rev)
            else:
                r = org.post_mail(USER, nid, body.text, attachments=metas or None,
                                  reply_to=reply_meta, missing=missing or None,
                                  typed=True)
            receipt = _send_receipt(org, slug, nid, r, public=_public_slug(request))
            # 80 chars truncated most instructions mid-clause; the notice is a
            # gist, but it has to survive being read on its own
            org.user_deep_reach(nid, body.text.strip().splitlines()[0][:160])
            store.save_org(org)
        except LedgerError as e:
            raise HTTPException(422, str(e))
    mail_notify(slug, USER, nid)
    # ⭐ D-171: `warnings` reaches CODE; the [MAIL] line reaches an AGENT. Both
    # halves are needed and neither substitutes for the other — an HTTP client
    # cannot read an agent's context, and an agent cannot retry the caller's
    # upload. post_mail has always built this list and this endpoint always
    # threw it away, which is why a message whose attachment never resolved
    # was indistinguishable from a clean send. Status stays 200: the message
    # WAS delivered, and a non-200 for delivered mail would be its own lie.
    warn = list(r.get("warnings") or [])
    if r.get("deferred"):
        # archived recipient (user ruling): the mail waits in its inbox and is
        # acted on at rehire — nothing to drive now
        return {"accepted": True, "deferred": True, "queued": 0, **receipt,
                **({"warnings": warn} if warn else {})}
    sent = supervisor.send_message(
        slug, nid,
        "(orgtree) The mail above includes a message from the user, addressed "
        "to you — act on it now.", mail_ping=True, ping_reason="user_mail")
    # D-236: the same honest sentence the agent-side send now gets. NO
    # `sender` is passed: the late-steer alarm mails an AGENT, and the user's
    # own desk already renders the pending "delivering mid-task…" bubble live
    # for exactly this wait — a notice they cannot be sent would be the wrong
    # instrument for a reader who is already watching it happen.
    sent = {**sent, "delivery": supervisor.delivery_note(slug, nid, sent), **receipt}
    if warn:
        sent = {**sent, "warnings": warn + list(sent.get("warnings") or [])}
    return sent


class SteerClaim(Body):
    tool_use_id: str = ""
    transcript_path: str = ""


class SteerAck(Body):
    delivery_id: str
    tool_use_id: str = ""


@app.post("/api/orgs/{slug}/nodes/{nid}/steer")
def node_steer(slug: str, nid: str, body: SteerClaim | None = None) -> dict[str, Any]:
    """Called by the PostToolUse steering hook inside a node's turn: pops ALL
    the node's pending mid-task mail — user and agent alike — for immediate
    delivery (sender attribution rides inside each message).

    Plain `def` (№22): this loads and saves the org document under DOC_LOCK,
    which is not work to do ON the event loop — least of all here, where the
    loop is what carries the very `steered` frame this call produces."""
    # storage-bypass audit: every tool call gives the storage limit a chance
    # to land MID-TURN (throttled + backgrounded inside)
    supervisor.maybe_storage_check(slug)
    # D-236: this door is hit after EVERY tool call whether or not there is
    # mail, which makes it the one free measurement of "when did this agent
    # last have an injection point". Recorded BEFORE the pop, so a message
    # arriving during this very call is timed against the boundary it missed
    # rather than the one it caught.
    supervisor.note_steer_poll(slug, nid)
    # ⚠ the `steered` frame is NOT emitted here any more. It used to be, and
    # that was the whole reason the codex and antigravity legs had none: they call
    # `pop_steer` in-process and never pass this door, so their mid-turn mail
    # went durable with nothing on the wire to say so and the desk waited for
    # its next 2.5 s heartbeat to notice. Delivery and its announcement are one
    # fact, so they are stated in one place — `supervisor.commit_steer`, which
    # every lane reaches. Same frame, same cap, same declared truncation.
    if body is not None and body.tool_use_id:
        # D1 (user ruling, reset-action-plan item 3): the fetch is a CLAIM,
        # not a commit. The hook names the tool call it runs in (its owner)
        # and the transcript the CLI will record into; the messages are
        # committed only when that record appears (`scan_steer_records`).
        did, msgs = supervisor.claim_steer(slug, nid, body.tool_use_id,
                                           body.transcript_path)
        return {"messages": msgs, "delivery_id": did}
    # an old hook (no stdin identity) still gets the legacy fetch-is-commit
    # behaviour rather than nothing at all — its rows are labelled
    # level="handoff" (unconfirmed), never "recorded", and the fallback is
    # said in the log the first time it happens per node
    msgs = supervisor.pop_steer(slug, nid)
    if msgs:
        st = supervisor.state(slug, nid)
        if not st.get("steer_legacy_said"):
            st["steer_legacy_said"] = True
            print(f"[orgtree] {slug}/{nid}: steer fetch WITHOUT hook identity "
                  f"(no tool_use_id) — legacy fetch-is-commit served; these "
                  f"rows are unconfirmed handoffs, not recorded deliveries")
    return {"messages": msgs, "legacy": True}


@app.post("/api/orgs/{slug}/nodes/{nid}/steer/ack")
def node_steer_ack(slug: str, nid: str, body: SteerAck) -> dict[str, Any]:
    """The hook's RECEIPT for a claimed delivery, after it has printed the
    context. Owner-checked, idempotent, commits nothing (D1)."""
    return supervisor.ack_steer(slug, nid, body.delivery_id, body.tool_use_id)


@app.get("/api/orgs/{slug}/nodes/{nid}/steer-state")
def node_steer_state(slug: str, nid: str) -> dict[str, Any]:
    """The mid-turn delivery window, as a readable fact (D-236).

    `wait` is how long this node has gone without a tool-call boundary — the
    length of the tool call it is inside — or null when it is not responding
    and the question does not apply. `pending` is how many carriers are
    sitting in the steer store right now, i.e. accepted mail that the agent
    has NOT been shown yet. Read-only; it pops nothing."""
    return supervisor.steer_view(slug, nid)


@app.post("/api/orgs/{slug}/nodes/{nid}/interrupt")
def node_interrupt(slug: str, nid: str) -> dict[str, Any]:
    """Manual ⏸: stop the node's current response (the only sanctioned
    interrupt — message delivery never interrupts, user ruling)."""
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    return supervisor.interrupt_turn(slug, nid)


class ProcessControl(Body):
    action: str


@app.post("/api/orgs/{slug}/nodes/{nid}/process")
def node_process(slug: str, nid: str, body: ProcessControl,
                 request: Request) -> dict[str, Any]:
    """Admin-only stop/start for an idle node's parked CLI process.

    The endpoint delegates admission and generation checks to
    ``warmpool.process_control``. The browser's tree copy is only a hint; the
    backend rechecks every turn/lifecycle gate while reserving the seat.
    """
    if _public_slug(request):
        # PublicGateway denies this path before FastAPI, but keep the route
        # safe when called through a mounted app or directly in a test.
        raise HTTPException(
            403, "kiosk: process controls are managed from the admin side")
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    try:
        return warmpool.process_control(slug, nid, body.action)
    except LedgerError as e:
        # The node can be retired/deleted after the optimistic validation above
        # but before process_control takes DOC_LOCK; report that race as a 404.
        raise HTTPException(404, str(e)) from e
    except warmpool.ProcessControlRefused as e:
        raise HTTPException(409, str(e)) from e


@app.post("/api/orgs/{slug}/nodes/{nid}/compact")
def node_compact(slug: str, nid: str) -> dict[str, Any]:
    """Manual compaction (user ruling: the context wheel is a BUTTON in the
    zoomed view): the same §8 split as the automatic threshold — fork, compact
    the fork into a successor, archive this self as a knowledge bearer."""
    try:
        org = store.load_org(slug)
        n = org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    if n["state"] != "live":
        raise HTTPException(422, f"{nid} is {n['state']} — rehire it first")
    if n.get("bearer_state"):
        raise HTTPException(422, "a knowledge bearer never re-compacts (§8.3)")
    if n.get("remote_controlled"):
        # FR-01 (redteam): compaction forks this session id and rebinds the
        # node to a new one — the phone would keep driving an orphaned id
        raise HTTPException(409, "under remote control — release it before "
                                 "compacting (the fork would strand the "
                                 "controlled session)")
    if not n.get("occupancy"):
        raise HTTPException(422, "no conversation yet — nothing to compact")
    if n.get("compacted_unrun"):
        # the wheel is a button, and a just-compacted node now draws a real
        # arc again — the "already compacted" refusal that its None occupancy
        # used to make silently has to be spoken (2026-08-20). The UI hides the
        # button in this state; this is the surface that must not be fooled.
        raise HTTPException(422, "just compacted — nothing to compact "
                                 "until it takes a turn")
    if n.get("frozen"):
        raise HTTPException(409, "frozen by a usage limit — resume it first")
    if supervisor.state(slug, nid)["busy"]:
        raise HTTPException(409, "busy — wait for the current turn to finish")

    def run() -> None:
        # №27: manual_compact latches busy for the whole fork — mail arriving
        # mid-split queues instead of driving the doomed old session
        try:
            supervisor.manual_compact(slug, nid)
        except RuntimeError:
            pass          # raced into busy — the 409 precheck caught most; harmless

    threading.Thread(target=run, daemon=True).start()
    return {"started": True}


@app.post("/api/orgs/{slug}/lineage/{nid}/recover")
def lineage_recover(slug: str, nid: str) -> dict[str, Any]:
    """Rescue a LOST generation into a consultable knowledge bearer (user
    ruling 2026-08-20: an explicit opt-in verb, never automatic).

    A generation the CLI compacted in place was written off as unconsultable
    while every one of its records was still sitting above the boundary in the
    successor's session file. This cuts them into a session of its own. The
    prospective half of that fix rides the turn path; this is the half that
    reaches rows already written — without a route it was unreachable from any
    surface, so the whole population it exists for stayed broken (redteam
    round 2). Refuses phantoms, naming the sibling that holds the content."""
    try:
        store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    try:
        result = supervisor.recover_lost_generation(slug, nid)
    except LedgerError as e:
        raise HTTPException(422, str(e))
    hub_changed(slug)
    return result


@app.post("/api/orgs/{slug}/lineage/{nid}/drop-phantom")
def lineage_drop_phantom(slug: str, nid: str) -> dict[str, Any]:
    """Remove a PHANTOM lineage row — a generation that never existed, minted
    when orgtree logged its own §8 compaction a second time as a loss.

    Deletes rather than recovers because the phantom's content is not merely
    recoverable but already held, in full, by the sibling bearer the split
    created; recovering it would mint a second bearer holding a copy of the
    first. FAILS CLOSED (user ruling): the row is dropped only on a complete
    positive match — every record above its boundary provably present in the
    sibling's file — and refuses on unique content, a missing sibling, an
    unreadable file, or any row whose own boundary cannot be identified."""
    try:
        store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    try:
        result = supervisor.drop_phantom_generation(slug, nid)
    except LedgerError as e:
        raise HTTPException(422, str(e))
    hub_changed(slug)
    return result


@app.post("/api/orgs/{slug}/dissolve-all")
async def org_dissolve_all(slug: str) -> dict[str, Any]:
    """Dissolve EVERY agent in the org at once (context kept — rehire revives)."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            freed = nodes = 0
            for root in list(org.children(None)):
                r = org.dissolve(USER, root)
                freed += r["freed"]
                nodes += len(r["nodes"])
            store.save_org(org)
        except LedgerError as e:
            raise HTTPException(422, str(e))
    await hub.changed(slug)
    return {"freed": freed, "nodes": nodes}


@app.post("/api/orgs/{slug}/killswitch")
async def org_killswitch(slug: str) -> dict[str, Any]:
    """⏹ STOP ALL: interrupt every active agent, clear pending queues, and
    PAUSE EVERY WATCHDOG so nothing wakes an agent back up.

    ⚠ `pause_watchdogs=True` belongs HERE and only here. `interrupt_all`'s
    other caller is the kiosk spend-limit freeze, which recovers by itself;
    this route is the emergency stop the user asked to be blunt. Nothing
    un-pauses the dogs automatically — resume is per-watchdog and manual,
    either the operator visiting one or an agent resuming its own."""
    try:
        store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    result = supervisor.interrupt_all(slug, pause_watchdogs=True)
    await hub.changed(slug)
    return result


@app.post("/api/orgs/{slug}/resume")
async def org_resume(slug: str) -> dict[str, Any]:
    """The ▶ button: restart every usage-limit-frozen agent at once."""
    try:
        store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    try:
        resumed = supervisor.resume_frozen(slug)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    await hub.changed(slug)
    return {"resumed": resumed}


class CreditDecision(Body):
    id: str
    action: str = "approve"    # approve | deny
    # F-05 counter-offer: the amount the user actually grants — any legal
    # value (below the ask, above it, or a clawback down to the committed
    # floor). Absent = the asked amount, the old one-click approve.
    granted: int | None = None
    # dry run: validate + return the stranding warnings for `granted`,
    # mutating nothing — the card shows them BEFORE the user commits
    dry: bool = False


@app.post("/api/orgs/{slug}/credit-requests")
async def credit_request_decide(slug: str, body: CreditDecision) -> dict[str, Any]:
    """Decide a top-level agent's credit request: approve as asked, counter-
    offer any legal amount (F-05), or deny. The outcome reaches the agent as
    ordinary user MAIL (the unified ask system: the answer is a mail that
    drives a turn), wearing honest wording — a partial grant is not an
    approval, and the matter stays the agent's to continue."""
    if body.dry:
        if body.granted is None:
            raise HTTPException(422, "dry run needs `granted`")
        with store.DOC_LOCK:
            try:
                return store.load_org(slug).credit_preview(body.id, body.granted)
            except LedgerError as e:
                raise HTTPException(422, str(e))
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            req = org.credit_request_action(body.id, body.action,
                                            granted=body.granted)
            _kiosk_cap_check(org)
            notice = req.get("notice")
            drive = False
            if notice and req["node"] in org.nodes:
                # typed: decision.credit rides the result as `ev`; the body is
                # its rendering (== `notice`)
                drive = not org.post_mail(
                    USER, req["node"], "", ev=req["ev"]).get("deferred")
            req = {k: v for k, v in req.items() if k != "ev"}
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if drive:
        mail_notify(slug, USER, req["node"])
        supervisor.send_message(
            slug, req["node"],
            "(orgtree) The mail above contains the user's decision on your "
            "credit request — proceed accordingly.", mail_ping=True,
            ping_reason="credit_decision")
    await hub.changed(slug)
    return req


class RemoteControl(Body):
    action: str                       # "start" | "stop"


@app.post("/api/orgs/{slug}/nodes/{nid}/remote-control")
def remote_control(slug: str, nid: str, body: RemoteControl,
                   request: Request) -> dict[str, Any]:
    """FR-01: hand the agent's real session to the user's claude.ai / mobile
    app (`claude remote-control --session-id`). Strictly user-triggered —
    starting the server enrolls THIS device on the user's account — and
    loopback-only (never the kiosk gateway)."""
    if _public_slug(request):
        raise HTTPException(404, "not found")
    if body.action == "start":
        r = supervisor.remote_control_start(slug, nid)
    elif body.action == "stop":
        r = supervisor.remote_control_stop(slug, nid)
    else:
        raise HTTPException(422, "action must be start or stop")
    if r.get("error"):
        raise HTTPException(422, str(r["error"]))
    hub_changed(slug)
    return r


@app.get("/api/orgs/{slug}/documents")
def documents_list(slug: str, offset: int = 0, limit: int = 100, node: str = "") -> dict[str, Any]:
    """FR-03 gallery: every presented document in the org, newest first.
    Reads `documents` directly (not the tree walk) so a retired, rehired or
    deleted presenter still has its cards. Evicted bodies surface as rows
    with `evicted: true` from the `present_evicted` log. Metadata only —
    the reader still fetches the body by id. Kiosk visitors are the user
    of their org — readable."""
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    gallery = org.document_gallery()
    if node:
        gallery = [row for row in gallery if row["node"] == node]
    for d in gallery:
        if isinstance(d, dict) and d.get("id"):
            d["ref"] = refs.doc(slug, str(d["id"]))
    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    return {"documents": gallery[offset:offset + limit], "total": len(gallery),
            "next_offset": offset + limit if offset + limit < len(gallery) else None}


@app.get("/api/orgs/{slug}/documents/{did}")
def document_get(slug: str, did: str) -> dict[str, Any]:
    """FR-03: the reader fetches the BODY on open (the tree payload carries
    metadata only). Kiosk visitors are the user of their org — readable."""
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    doc = _document_or_404(org, did)
    out: dict[str, Any] = {
        "id": doc["id"], "node": doc["node"], "title": doc["title"],
        "body": doc["body"], "at": doc["at"],
        "format": doc.get("format") or "markdown",
        "ref": refs.doc(slug, str(doc["id"]))}
    if doc.get("format") == "html":
        # the body is "" by construction (ledger.present_document); the page
        # itself is only ever served through the sandboxed wrapper below
        out["bytes"] = int(doc.get("bytes") or 0)
        out["mockup"] = f"/api/orgs/{slug}/documents/{doc['id']}/mockup"
    return out


@app.get("/api/orgs/{slug}/documents/{did}/download")
def document_download(slug: str, did: str) -> Response:
    """Download the original presented source with a useful filename.

    Markdown is stored inline; HTML presentations are immutable outbox
    snapshots and are served as attachments, never executed by this route.
    """
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    doc = _document_or_404(org, did)
    from .artifact_downloads import build_document_download, ArtifactNotFound, ArtifactForbidden
    if doc.get("format") == "html" and not str(doc.get("file") or "").startswith("outbox/"):
        raise HTTPException(422, "document is not an outbox snapshot")
    try:
        artifact = build_document_download(did, doc,
            supervisor.scratch_dir(slug, str(doc["node"])))
    except ArtifactNotFound as exc:
        raise HTTPException(410, str(exc)) from exc
    except ArtifactForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    return Response(artifact.bytes, media_type=artifact.content_type,
                    headers={"Content-Disposition": f'attachment; filename="{artifact.filename}"'})


def _document_or_404(org: Org, did: str) -> dict[str, Any]:
    doc = next((x for x in org.d.get("documents", []) if x["id"] == did), None)
    if doc is None:
        raise HTTPException(
            404, f"no document {did!r} — it was removed or is unavailable "
                 f"in the imported history")
    return doc


# present-html-mockups-in-a-new-browser-tab (2026-09-06). The mockup's bytes
# are AGENT-AUTHORED, EXECUTABLE HTML. The admin app authenticates by loopback
# alone and the kiosk by the token in the URL path, and there is no CORS layer
# — so a page of that kind rendered at the app origin with script would act
# as the user against every /api route. It is therefore never served as a
# document of its own. The ONLY route is this trusted wrapper: a page the
# backend writes, carrying the mockup as an HTML-ESCAPED `srcdoc` inside a
# sandboxed iframe (opaque origin: no cookies, no storage, no parent/top
# access, no top navigation, no popups), under a response CSP that forbids
# frame navigation and form submission while allowing resource loads, and
# with `<base href="about:blank">` + no-referrer so the child cannot learn
# this page's URL (and on a kiosk, the token in it) through baseURI,
# referrer or location — measured by feature-astra in Chromium 2026-09-06:
# location=about:srcdoc, baseURI=about:blank, referrer="". `frame-src 'none'`
# is what stops the child navigating ITSELF to an arbitrary URL: about:srcdoc
# is exempt, everything else is a frame navigation the wrapper's policy
# refuses. Root scope ruling: the preview is OPERATOR-ONLY — a kiosk visitor
# gets 403, not a script-disabled substitute.
# V2 retained decision: remote resources are permitted. The dedicated native
# artifact session authenticates only the initial wrapper GET and denies all
# subsequent engine destinations; the opaque child never receives app auth.
# Local snapshot dependencies are embedded, never fetched from engine routes.
_MOCKUP_CSP = ("sandbox allow-scripts allow-forms allow-modals; "
               "default-src 'none'; script-src 'unsafe-inline' data: blob: https: http:; "
               "style-src 'unsafe-inline' data: https: http:; img-src data: blob: https: http:; "
               "font-src data: https: http:; media-src data: blob: https: http:; "
               "connect-src https: http: wss: ws:; "
               "form-action 'none'; frame-src 'none'; "
               "frame-ancestors 'none'; base-uri about:")
_MOCKUP_HEADERS = {
    "Content-Security-Policy": _MOCKUP_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    # Cache-Control: no-store is stamped on every /api/ response by the
    # instance middleware above; not repeated here (a doubled header)
}


def _mockup_wrapper(title: str, payload: str) -> str:
    """The trusted page around an untrusted mockup. Everything the child
    could read is fixed here: `<base href="about:blank">` (baseURI), the
    iframe's referrerpolicy (referrer), the srcdoc itself (location). The
    payload is escaped with quote=True so a `"` in the mockup cannot close
    the attribute — the ONE escaping step this whole boundary rests on."""
    import html as _html
    return ("<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
            "<base href=\"about:blank\">"
            f"<title>{_html.escape(title, quote=True)}</title>"
            "<style>html,body{margin:0;height:100%;background:#fff}"
            "iframe{border:0;width:100%;height:100%;display:block}</style>"
            "</head><body>"
            "<iframe sandbox=\"allow-scripts allow-forms allow-modals\" "
            "referrerpolicy=\"no-referrer\" "
            f"srcdoc=\"{_html.escape(payload, quote=True)}\"></iframe>"
            "</body></html>")


@app.get("/api/orgs/{slug}/documents/{did}/mockup")
def document_mockup(slug: str, did: str, request: Request) -> Response:
    """The new-tab URL behind an HTML mockup card: the sandboxed wrapper
    described above, and nothing else. 403 on the public gateway (root
    ruling), 404 for a markdown document or one that is gone, 410 when the
    record stands but its outbox snapshot was deleted from disk."""
    if _public_slug(request):
        raise HTTPException(403, "mockup previews are operator-only — the "
                                 "card's metadata is still readable")
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    doc = _document_or_404(org, did)
    if doc.get("format") != "html":
        raise HTTPException(404, f"document {did!r} is not an HTML mockup")
    rel = str(doc.get("file") or "")
    base = os.path.realpath(supervisor.scratch_dir(slug, str(doc["node"])))
    full = os.path.realpath(os.path.join(base, rel.replace("/", os.sep)))
    if not rel.startswith("outbox/") or not full.startswith(
            os.path.join(base, "outbox") + os.sep):
        raise HTTPException(422, "the mockup record does not point into "
                                 "the presenter's outbox")
    try:
        with open(full, "rb") as fh:
            data = fh.read(_MOCKUP_MAX + 1)
    except OSError:
        raise HTTPException(410, f"the mockup file for {did!r} is no longer "
                                 f"in the presenter's outbox")
    if len(data) > _MOCKUP_MAX:
        raise HTTPException(422, "the mockup file grew past the 4 MB cap "
                                 "after it was presented")
    from .artifact_downloads import build_document_preview, ArtifactNotFound, ArtifactForbidden
    try:
        payload = build_document_preview(did, doc, base, max_bytes=_SENDFILE_MAX)
    except ArtifactNotFound as exc:
        raise HTTPException(410, str(exc)) from exc
    except ArtifactForbidden as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(_mockup_wrapper(str(doc.get("title") or ""), payload),
                    media_type="text/html; charset=utf-8",
                    headers=dict(_MOCKUP_HEADERS))


@app.delete("/api/orgs/{slug}/documents/{did}")
async def document_dismiss(slug: str, did: str) -> dict[str, Any]:
    """FR-03: the card's ✕ — remove a presented document."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            r = org.dismiss_document(did)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        store.save_org(org)
    await hub.changed(slug)
    return {"ok": True, "node": r["node"]}


class RenameRepair(Body):
    """The allowlist for one bounded rename repair. `rename_at` names the
    logged rename event; `documents` and `work_items` name the records to
    move, work items by SLUG. `actor` is the identity the ledger checks; the
    default is the user."""
    rename_at: str
    documents: list[str] = []
    work_items: list[str] = []
    actor: str = USER


@app.post("/api/orgs/{slug}/repair-rename")
async def repair_rename(slug: str, body: RenameRepair) -> dict[str, Any]:
    """Finish a rename for records an earlier rename stranded under the old id
    — presented documents, and the current ownership fields of work items.

    A ROUTE, not a script: `store.DOC_LOCK` is per-process, so only code in
    this process can run the repair inside the load → mutate → save cycle
    every other write uses. Nothing outside can take that lock, and a
    compare-and-swap on the stored row protects the instant of the write only.

    The bounds are the ledger's (`Org.repair_rename_identity`): one logged
    rename event, an explicit allowlist, every record still holding the old
    id, an intact identity chain, and the user or the renamed identity as
    actor. No MCP tool — a new tool definition would change every agent's
    prompt, and this is a repair, not a capability."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            # Convert an old-identity document IN THIS SAVE, like every other
            # docket mutation. The ledger's own guard runs from `_work_sweep`,
            # which this repair does not go through — it writes item fields
            # directly, because the docket's mutators refuse for exactly the
            # reason being repaired. Without this the repair would save a
            # legacy document and the next read would 409.
            migrated = _work_identity_ready(org, slug)
            r = org.repair_rename_identity(
                body.actor, body.rename_at,
                documents=body.documents, work_items=body.work_items)
        except LedgerError as e:
            # nothing is saved on a refusal, so a document that was pending
            # conversion is still pending — the repair does not convert it as
            # a side effect of failing
            raise HTTPException(422, str(e))
        store.save_org(org)
    await hub.changed(slug)
    return {"ok": True, "migrated": migrated, **r}


# ---------------------------------------------------------------- the docket
# Work items (docs/work-items.md, docket-final-spec.md). The user-side surface
# is deliberately small: read, reply to the last updater, dismiss a manual
# flag, accept. Everything else is the agent tool `orgtree_work` below.

class WorkReply(Body):
    body: str
    # the recipient the user CHOSE (user 2026-09-06): the item's owner or one
    # of its participants, validated against the stored item at send time.
    # Omitted → the assignment, exactly as before.
    to: str | None = None


class WorkDismiss(Body):
    # the flag revision the Dismiss button was rendered for (CAS — a delayed
    # click must not clear a NEWER reason the user never read)
    set_rev: int


class WorkAccept(Body):
    note: str | None = None


# ---- slug-only identity (user 2026-09-05). A document written under the old
# `w########` scheme has to be converted once. Three rules shape this:
#
#   * A READ NEVER WRITES. Serving a half-identity document — some items named,
#     some not — would be worse than failing, because every caller would have
#     to carry a fallback and one of them would get it wrong. So a read of an
#     unconverted document REFUSES, loudly, naming the route that fixes it.
#   * THE BACKUP HAPPENS BEFORE THE FIRST MIGRATING SAVE, once per org, from
#     the committed state — `store.export_json` reconstructs from the rows, so
#     it captures the document as it stands, not the one being edited.
#   * ATOMICITY IS THE CALLER'S LOCK, not a property of the transform. Every
#     path below is already inside `store.DOC_LOCK`; the conversion rides that
#     same lock and that same `save_org`, so a failure anywhere leaves the
#     stored document untouched.
WORK_IDENTITY_STALE = (
    "this organization's docket still uses the retired opaque item ids. "
    "Items are identified solely by their readable name now — convert it "
    "once with POST /api/orgs/{slug}/migrate-work-identity (it exports a "
    "JSON backup first)")


def _work_identity_ready(org: Any, slug: str) -> dict[str, Any] | None:
    """Convert IN THIS SAVE if needed. Caller must hold `store.DOC_LOCK` and
    must be about to `save_org`. Returns the migration report, or None when
    the document was already converted — which is what makes calling it at
    the head of every mutation cheap and idempotent."""
    if org.work_identity_state() == "slug":
        return None
    # the pre-migration backup, from committed state, exactly once per org
    store.export_json(slug)
    return org.work_identity_migrate()


def _work_identity_guard(org: Any) -> None:
    """Read paths: refuse rather than serve a document we would have to
    describe with two different kinds of name."""
    if org.work_identity_state() != "slug":
        raise HTTPException(409, WORK_IDENTITY_STALE)


@app.post("/api/orgs/{slug}/migrate-work-identity")
def work_identity_migrate(slug: str) -> dict[str, Any]:
    """The one-shot conversion. Idempotent: a second call reports
    `already: true` and writes nothing at all."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            report = _work_identity_ready(org, slug)
        except LedgerError as e:
            # a refusal (e.g. two items already sharing a name) must leave the
            # stored document exactly as it was — nothing has been saved yet
            raise HTTPException(422, str(e))
        if report is None:
            return {"already": True}
        store.save_org(org)
    return {"already": False, **report}


@app.get("/api/orgs/{slug}/work-items")
def work_items_list(slug: str, archived: int = 0,
                    backlogged: int = 0) -> dict[str, Any]:
    """Every item, split by the DERIVED archive and backlog rules, newest
    docket update first; `counts` over the full set for the toolbar badge.
    `?archived=1` adds the archived group and `?backlogged=1` the backlog
    group — the modal's two independent header checkboxes, each of which only
    APPENDS its group below the main list. Read-only: the physical archive
    sweep runs on the next docket write, never here."""
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    _work_identity_guard(org)
    return _work_refs(slug, org.work_list(
        USER, include_archived=bool(archived),
        include_backlogged=bool(backlogged)))


@app.get("/api/orgs/{slug}/work-items/{wid}")
def work_item_get(slug: str, wid: str) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    _work_identity_guard(org)
    try:
        it = org.work_get(USER, wid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    it["ref"] = refs.item(slug, str(it["slug"]))
    return {"item": it}


@app.post("/api/orgs/{slug}/work-items/{wid}/reply")
def work_item_reply(slug: str, wid: str, body: WorkReply,
                    request: Request = cast(Request, None)) -> dict[str, Any]:
    """The general reply box: mail to THE ASSIGNMENT, exactly — the agent the
    item is assigned to, which is its owner (user ruling 2026-09-05: assignment
    IS ownership). Question attachments and dismissals never move that
    recipient, and when it cannot be reached the failure is returned rather
    than a substitute chosen.

    It used to reach the last updater instead. Measured on the live document
    the day this changed: 26 of 39 items had an owner different from their last
    updater, and in 25 of those the last updater was the coordinator — so the
    user's reply on nearly every finished item was landing on the coordinator
    rather than on the agent holding the work.

    AN ADDRESSED REPLY (user 2026-09-06): `to` names the owner or one of the
    item's participants. It is validated against the STORED item under the
    lock — the panel's list is a rendering, not an authorization — and a name
    that is neither is refused with nothing sent and nobody substituted. A
    participant is told, in the mail and in the wake, that the reply is
    addressed to it as a participant and who owns the item; ownership does
    not move. `role` in the response says which of the two was reached."""
    text = str(body.body or "").strip()
    if not text:
        raise HTTPException(422, "empty reply")
    to = str(body.to or "").strip()
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            _work_identity_ready(org, slug)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        try:
            org._work_find(wid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            tgt = (org.work_reply_recipient(wid, to) if to
                   else org.work_reply_target(wid))
            nid = str(tgt["node"])
            role = str(tgt.get("role") or "owner")
            # the CANONICAL name, not the caller's spelling — this string is
            # an instruction the recipient will act on, and it must resolve
            name = str(tgt.get("item") or wid)
            if role == "participant":
                how = (f"(the user replied on this docket item ADDRESSED TO "
                       f"YOU AS A PARTICIPANT — the item is owned by "
                       f"{tgt.get('owner') or 'nobody (unassigned)'}, not by "
                       f"you; treat this as item-linked mail, act on it, and "
                       f"coordinate any update with the owner)")
            else:
                how = ("(the user replied on this docket item — treat it as "
                       "item-linked mail and update the item if it changes "
                       "the work)")
            # typed (family linked_reply): reply.docket — the header/instruction
            # prose is the renderer's; the body is the user's text
            r = org.post_mail(USER, nid, "", ev=events.mint(
                "reply.docket", actor_of(USER),
                org.work_item_ref(org._work_find(wid)[0]), body=text, role=role,
                owner=(str(tgt.get("owner") or "") if role == "participant" else None)))
            receipt = _send_receipt(org, slug, nid, r, public=_public_slug(request))
            org.user_deep_reach(nid, text.splitlines()[0][:160])
            # A successful user reply acknowledges manual attention without
            # taking the explicit-dismissal path (which blocks the item).
            # Attached questions deliberately keep attention active.
            org.work_clear_attention_on_user_reply(wid)
            store.save_org(org)
        except LedgerError as e:
            raise HTTPException(422, str(e))
    mail_notify(slug, USER, nid)
    if r.get("deferred"):
        # archived recipient: the mail waits in its inbox for a rehire — the
        # UI says so; nobody else is picked
        return {"accepted": True, "to": nid, "role": role, "deferred": True,
                "node_state": tgt.get("state"), **receipt}
    sent = supervisor.send_message(
        slug, nid,
        ("(orgtree) The mail above is the user's reply on a docket item you "
         f"PARTICIPATE in (owner: {tgt.get('owner') or 'unassigned'}) — it "
         "is addressed to you; act on it now."
         if role == "participant" else
         "(orgtree) The mail above is the user's reply on a docket item "
         "ASSIGNED TO YOU — act on it now."), mail_ping=True,
        ping_reason="docket_reply")
    return {"accepted": True, "to": nid, "role": role, "deferred": False,
            "node_state": tgt.get("state"),
            "delivery": supervisor.delivery_note(slug, nid, sent), **receipt}


@app.post("/api/orgs/{slug}/work-items/{wid}/dismiss-attention")
def work_item_dismiss(slug: str, wid: str, body: WorkDismiss) -> dict[str, Any]:
    """Dismiss a MANUAL attention flag: clears it, sets the work Blocked,
    records the dismissal; pending questions are untouched (they keep the
    item orange). 409 on a stale `set_rev` or an already-cleared flag."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            _work_identity_ready(org, slug)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        try:
            org._work_find(wid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            r = org.work_dismiss_attention(wid, int(body.set_rev))
        except LedgerError as e:
            raise HTTPException(409, str(e))
        notify = r.get("notify")
        if notify:
            # passive: the flag's author learns the user saw and dismissed it,
            # and that the work now stands Blocked — without spending a turn
            try:
                # typed (family answer_decision): decision.attention_dismissed on
                # the item's WorkItemRef (canonical slug — the old text echoed the
                # caller's spelling of `wid`, identical for a canonical name)
                it, _ = org._work_find(wid)
                org.post_mail(
                    USER, str(notify), "", kind="status",
                    ev=events.mint("decision.attention_dismissed", actor_of(USER),
                                   org.work_item_ref(it),
                                   reason=str(r.get("reason") or ""),
                                   pending_questions=int(r.get("pending_questions") or 0),
                                   dismissed_by=USER))
            except LedgerError:
                notify = None
        store.save_org(org)
    if notify:
        supervisor.send_message(
            slug, str(notify),
            "(orgtree) A notice arrived in your mail above — informational, "
            "no reply expected. Note it and continue your current task.",
            wake=False, mail_ping=True, ping_reason="notice")
    return {k: v for k, v in r.items() if k != "notify"}


@app.post("/api/orgs/{slug}/work-items/{wid}/accept")
def work_item_accept(slug: str, wid: str, body: WorkAccept) -> dict[str, Any]:
    """The user accepts an item as done (the same rule the tool enforces
    for a superior: never the owner)."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            _work_identity_ready(org, slug)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        try:
            org._work_find(wid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            r = org.work_accept(USER, wid, body.note)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    return r


@app.delete("/api/orgs/{slug}/work-items/{wid}")
def work_item_delete(slug: str, wid: str, note: str = "") -> dict[str, Any]:
    """The user deletes an item PERMANENTLY (user 2026-09-07) — the same
    rule the tool enforces (`Org.work_delete`): the record leaves the docket
    and its archive, pointers other items hold to it are cleared, and the
    refusals (nested children, an open attached question) are the ledger's."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            _work_identity_ready(org, slug)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        try:
            org._work_find(wid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        try:
            r = org.work_delete(USER, wid, note)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    return r


def _row_out(row: Mapping[str, Any], *, public: bool) -> dict[str, Any]:
    """The WIRE projection of one stored row — events.wire_row (design §6): full
    `ev` for the operator, `ev_public` for a visitor, never the row-encoded form."""
    return events.wire_row(row, public=public)


def _rows_out(rows: list[Any], *, public: bool) -> list[Any]:
    return [_row_out(r, public=public) if isinstance(r, dict) else r for r in rows]


def _mail_refs(org_slug: str, box: str, rows: list[Any],
               node: str | None = None, *, public: bool = False) -> list[Any]:
    """Stamp each mail row with its own reference, so a reader can link to a
    message that already exists rather than only to one it just sent.

    The BOX is the caller's, because a mail id alone does not address a mail —
    the three box families mint ids independently."""
    delivered = ("user_inbox" if box == "user"
                 else "@org" if box == "org" else str(node or ""))
    rows = _rows_out(rows, public=public)
    for r in rows:
        if isinstance(r, dict) and r.get("id"):
            ref = refs.mail(org_slug, delivered, str(r["id"]))
            if ref:
                r["ref"] = ref
    return rows


def _sent_refs(org_slug: str, rows: list[Any], *, public: bool = False) -> list[Any]:
    """Stamp SENT rows, which are a different question from delivered ones.

    ⚠ A SENT ROW IS A COPY OF A MAIL THAT LIVES IN SOMEBODY ELSE'S BOX, so it
    is addressed from its own `to`. Addressing it from the box being read names
    a message that is not there — and on a colliding id, a different one that
    is. A `to` with no local box gets no reference rather than an invented one.
    """
    rows = _rows_out(rows, public=public)
    for r in rows:
        if isinstance(r, dict) and r.get("id"):
            to = str(r.get("to") or "")
            ref = refs.mail(org_slug,
                            "user_inbox" if to == USER else to,
                            str(r["id"]))
            if ref:
                r["ref"] = ref
    return rows


def _work_refs(org_slug: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Stamp every listed item with its own reference. A LIST is where a
    reader most often needs one — the user asked to link EXISTING work, not
    only work that was just created."""
    for group in ("items", "archived", "backlogged"):
        for it in payload.get(group) or []:
            if isinstance(it, dict) and it.get("slug"):
                it["ref"] = refs.item(org_slug, str(it["slug"]))
    return payload


def _attach_ref(org_slug: str, tool: str, result: dict[str, Any]) -> None:
    """Give a result the ready-to-paste reference for what it just made.

    ⚠ EVERY BRANCH READS THE ACTUAL RECORD, never the request. A mail ref is
    built from the DELIVERY record's own `delivered`/`id` — the same pair the
    desk's existing "open in mailbox" link uses — so a send that produced no
    local box entry gets no reference rather than a plausible one pointing
    nowhere. `orgtree_status` is in the mail family only because it CAN post
    mail; when it did not, there is no pair and no ref (Astra 2026-09-05:
    do not assume every status result is mail).

    Agents must never compose one of these by hand: an org segment assembled
    from memory is exactly the mistake the org segment exists to prevent.
    """
    if result.get("ref"):
        return                       # the docket sets its own, in _work_mutate
    if tool in ("orgtree_message", "orgtree_send_notice", "orgtree_status"):
        r = refs.mail(org_slug, str(result.get("delivered") or ""),
                      str(result.get("id") or ""))
        if r:
            result["ref"] = r
        return
    if tool == "orgtree_present" and result.get("presented"):
        result["ref"] = refs.doc(org_slug, str(result["presented"]))


def _work_ref(a: dict[str, Any]) -> str:
    """The item a work action names. ONE argument, `slug`, because an item has
    one identity.

    ⚠ A CALL STILL USING `id` IS REFUSED BY NAME, NOT IGNORED. Reading `slug`
    and nothing else would leave an old caller sending `id=git-review-workspace`
    with an empty reference and the useless message "no work item ''". This is
    not an alias — nothing is resolved from `id`, and a caller passing both is
    told to stop rather than quietly served."""
    if "id" in a:
        # ⚠ BY PRESENCE, not by emptiness: a call sending BOTH would otherwise
        # be served from `slug` while its `id` said something else. A name
        # shaped like a retired id is still fine when it arrives as `slug`.
        raise LedgerError(
            "`orgtree_work` takes the item's readable name as `slug` now, not "
            "`id` — items have one identity and it is the readable one. Drop "
            "the `id` argument. If what you are holding is an old "
            "`w########`, it will not resolve either: run `list` and use the "
            "name shown")
    return str(a.get("slug") or "")


def _work_list_arg(a: dict[str, Any], key: str) -> list[Any] | None:
    """A list argument off the free-form wire; a scalar is refused (a
    docket list is individual entries, never a paragraph)."""
    v = a.get(key)
    if v is None:
        return None
    if isinstance(v, list):
        return cast("list[Any]", v)
    raise LedgerError(f"{key} must be a list")


def _work_read_call(body: AgentCall, a: dict[str, Any]) -> dict[str, Any]:
    """`orgtree_work` list|get|verify — the read-shaped actions, outside the
    doc lock like every other read tool. `verify` is the one that talks to
    git: capture under the lock, evaluate outside it, write back only if the
    item's rev is unchanged (docs/work-items.md §locking)."""
    act = str(a.get("action") or "")
    try:
        if act == "verify":
            from . import desktop_policy
            if desktop_policy.enabled():
                raise LedgerError('Git verification is not available in desktop MVP')
            with store.DOC_LOCK:
                org = store.load_org(body.org)
                cap = org.work_verify_capture(body.node, _work_ref(a),
                                              str(a.get("stage") or ""))
            res = workitems.evaluate(cap["stage"], cap["sha"])
            with store.DOC_LOCK:
                org = store.load_org(body.org)
                r = org.work_verify_commit(cap["wid"], cap["stage"], cap["rev"], res)
                if not r.get("stale"):
                    store.save_org(org)
            return r
        org = store.load_org(body.org)
        org._require_live(body.node)
        _work_identity_guard(org)
        # ⚠ THESE RETURN EARLY, outside the lock and outside `_attach_ref`, so
        # they have to stamp their own. An agent reading the docket is the
        # caller most likely to need a reference it can paste.
        if act == "list":
            return _work_refs(body.org, org.work_list(
                body.node,
                include_archived=_arg_flag(a, "include_archived"),
                include_backlogged=_arg_flag(a, "include_backlogged")))
        it = org.work_get(body.node, _work_ref(a))
        it["ref"] = refs.item(body.org, str(it["slug"]))
        return {"item": it}
    except LedgerError as e:
        raise HTTPException(422, str(e))


def _work_mutate(org: Org, nid: str, a: dict[str, Any]) -> dict[str, Any]:
    """`orgtree_work` mutating actions, under the caller's DOC_LOCK.

    Every successful mutation carries `item`: the name of the item it acted
    on. The per-action keys (`created`, `updated`, `superseded`…) each say
    what HAPPENED and are all shaped differently; one field that always says
    WHICH lets a reader of the result — the desk's tool chip, which offers to
    open the item — take the identity from the result instead of inferring it
    from the arguments or from prose (user request 2026-09-05, Astra: use the
    structured identity, never text)."""
    act = str(a.get("action") or "")
    wid = _work_ref(a)
    r = _work_mutate_action(org, nid, a, act, wid)
    if isinstance(r, dict) and "item" not in r:
        # `create` mints the name; every other action was GIVEN one, and since
        # only an exact name resolves, the reference the caller passed IS the
        # canonical name — there is nothing to normalise.
        name = str(r.get("created") or wid or "")
        if name:
            r["item"] = name
    if isinstance(r, dict) and r.get("item"):
        # the ready-to-paste reference. Agents must never COMPOSE one of
        # these: an org segment assembled by hand is exactly the mistake the
        # org segment exists to prevent.
        r["ref"] = refs.item(org.d["slug"], str(r["item"]))
    return r


def _work_mutate_action(org: Org, nid: str, a: dict[str, Any],
                        act: str, wid: str) -> dict[str, Any]:

    def _s(key: str) -> str | None:
        v = a.get(key)
        return None if v is None else str(v)
    if act == "create":
        return org.work_create(
            nid, str(a.get("title") or ""), str(a.get("objective") or ""),
            kind=str(a.get("kind") or "code"), owner=_s("owner"),
            participants=_work_list_arg(a, "participants"),
            acceptance=_work_list_arg(a, "acceptance"),
            dependencies=_work_list_arg(a, "dependencies"),
            done_so_far=a.get("done_so_far"),
            working_on_next=a.get("working_on_next"),
            status=str(a.get("status") or "open"),
            parent=_s("parent"),
            blocked_reason=_s("blocked_reason"),
            waiting_reason=_s("waiting_reason"))
    if act == "update":
        return org.work_update(
            nid, wid, a.get("done_so_far"), a.get("working_on_next"),
            status=_s("status"),
            attention=(True if _arg_flag(a, "attention") else None),
            attention_reason=_s("attention_reason"),
            blocked_reason=_s("blocked_reason"),
            waiting_reason=_s("waiting_reason"),
            dropped_reason=_s("dropped_reason"),
            title=_s("title"), objective=_s("objective"),
            reopen=_arg_flag(a, "reopen"),
            # the explicit assignment target. Absent, the update claims the
            # item for its author (ledger.work_update); present, it WINS —
            # there is no transient assign-to-author in between.
            owner=_s("owner"),
            # named by the update that ENTERS review, and required there
            reviewer=_s("reviewer"))
    if act == "assign":
        return org.work_assign(nid, wid, str(a.get("owner") or ""))
    if act == "review":
        return org.work_review_decide(nid, wid, str(a.get("decision") or ""),
                                      _s("note"))
    if act == "participants":
        return org.work_participants(nid, wid, add=_work_list_arg(a, "add"),
                                     remove=_work_list_arg(a, "remove"))
    if act == "evidence":
        return org.work_evidence(nid, wid, str(a.get("kind") or "note"),
                                 str(a.get("ref") or ""), _s("note"))
    if act == "claim":
        try:
            return org.work_claim(nid, wid, str(a.get("stage") or ""),
                                  _s("ref"), _s("note"))
        except workitems.ShaError as e:
            raise LedgerError(str(e))
    if act == "check":
        return org.work_check(nid, wid, _arg_int(a, "index", -1),
                              str(a.get("evidence_ref") or ""), _s("note"))
    if act == "accept":
        return org.work_accept(nid, wid, _s("note"))
    if act == "archive":
        return org.work_archive_now(nid, wid)
    if act == "move":
        # ⚠ ABSENT AND EMPTY MEAN DIFFERENT THINGS HERE. `parent: ""` (or null)
        # is an explicit "put this at the top"; omitting the argument entirely
        # is a caller that forgot to say where, and silently promoting an item
        # to the top because a field was missing would be a data change nobody
        # asked for.
        if "parent" not in a:
            raise LedgerError(
                "move needs `parent`: the name of the item to nest under, or "
                "an empty string to move this item back to the top level")
        return org.work_move(nid, wid, _s("parent"))
    if act == "supersede":
        return org.work_supersede(nid, wid, str(a.get("by") or ""))
    if act == "delete":
        # PERMANENT (user 2026-09-07): the record goes, active or archived.
        # Authority and refusals live in the ledger (`work_delete`).
        return org.work_delete(nid, wid, _s("note"))
    raise LedgerError(
        "action must be list|get|create|update|assign|review|participants|"
        "evidence|claim|verify|check|accept|archive|supersede|move|delete")


class AskAnswer(Body):
    # single card: the picked labels. FR-04 batch card: ONE item per tab,
    # positionally — a string, or a list for a multi tab's picks
    selected: list[str | list[str]] | None = None
    text: str | None = None
    # the card revision the answer was composed against (redteam CAS —
    # answers are positional, so an amend mid-render must refuse the stale
    # submission rather than attach it to questions the user never saw)
    rev: int | None = None
    # the card's ✕ — close without answering (mirrors AskUserQuestion's Esc)
    dismiss: bool = False


@app.post("/api/orgs/{slug}/asks/{aid}/answer")
async def ask_answer(slug: str, aid: str, body: AskAnswer) -> dict[str, Any]:
    """Answer an agent's question (F-04) — from the desk card or the inbox
    card, whichever the user reached first. Marking happens before the mail
    is posted, under one doc lock; every other rendering of the card nulls
    to grey "answered" on the next payload. (The wake-void this ordering
    once guarded against was retired 2026-08-06 — see withdraw_ask.)"""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            r = (org.ask_dismiss(aid) if body.dismiss
                 else org.ask_answer(aid, selected=body.selected,
                                     text=body.text, rev=body.rev))
            drive = not org.post_mail(USER, r["node"], "", ev=r["ev"]).get("deferred")
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if drive:
        mail_notify(slug, USER, r["node"])
        supervisor.send_message(
            slug, r["node"],
            "(orgtree) The mail above answers the question you asked the "
            "user — act on it now." if not body.dismiss else
            "(orgtree) The mail above reports that the user dismissed your "
            "question — proceed accordingly.", mail_ping=True,
            ping_reason="ask_answer")
    await hub.changed(slug)
    return {"answered": aid, "node": r["node"]}


class BatchResolve(Body):
    # FR-14: the user's ONE submit over a node's whole request batch. Every
    # open component must be echoed in `revs` (per-store CAS stamps from the
    # rendered card) and must carry its decision payload — a skipped tab is
    # an EXPLICIT null/skip, never a hole.
    revs: dict[str, int]
    # question tabs, positional; null = explicitly skipped
    answers: list[str | list[str] | None] | None = None
    # the credits tab: {"granted": N} | {"deny": true} | {"skip": true}
    credits: dict[str, Any] | None = None
    # scope items, positional: "approve" | "deny" | "skip"
    scope: list[str] | None = None


@app.post("/api/orgs/{slug}/nodes/{nid}/batch")
async def batch_resolve(slug: str, nid: str, body: BatchResolve) -> dict[str, Any]:
    """FR-14: resolve a node's whole request batch — question answers, the
    credit decision and per-item scope grants — in one submit, one lock, one
    composed answer mail. The desk card and the inbox card both land here."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            r = org.resolve_batch(nid, body.revs, answers=body.answers,
                                  credits=body.credits, scope=body.scope)
            _kiosk_cap_check(org)
            drive = not org.post_mail(USER, r["node"], "", ev=r["ev"]).get("deferred")
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if drive:
        mail_notify(slug, USER, r["node"])
        supervisor.send_message(
            slug, r["node"],
            "(orgtree) The mail above resolves your request batch — act on "
            "it now. A skipped tab returned unanswered; re-ask it later if "
            "it still matters.", mail_ping=True, ping_reason="batch")
    await hub.changed(slug)
    return {"resolved": nid}


class WatchdogAction(Body):
    id: str
    action: str          # pause | resume | remove


@app.post("/api/orgs/{slug}/watchdogs")
async def watchdog_action(slug: str, body: WatchdogAction) -> dict[str, Any]:
    """FR-18: the user manages any dog from the canvas detail panel."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            r = org.watchdog_action(USER, body.id, body.action)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    await hub.changed(slug)
    return r


@app.post("/api/orgs/{slug}/nodes/{nid}/unstick")
async def node_unstick(slug: str, nid: str) -> dict[str, Any]:
    """⭐ The user's per-node override (ruling 2026-08-06): release EVERY
    lock holding this agent — freeze of any kind, limit_locked, and the org
    fable_lock if this was its last holder — then drive the node with its
    kept replay texts (or a nudge), exactly as ▶ resume would have. This
    endpoint is loopback-admin like every other user control; there is
    deliberately NO agent verb for it."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            r = org.unstick(USER, nid)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    if r.get("released"):
        texts = cast("list[str]", r.get("resume_texts") or []) or [
            "(orgtree) The user manually UNSTUCK you (override) — handle "
            "any mail above and continue from where you left off."]
        views = cast("list[str]", r.get("resume_views") or [])
        for i, t in enumerate(texts):
            supervisor.send_message(slug, nid, t,
                                    view=views[i] if i < len(views) else t)
        supervisor.notify(slug, nid, "turn_started")
    await hub.changed(slug)
    return r


@app.get("/api/orgs/{slug}/inbox")
def user_inbox(slug: str, request: Request = cast(Request, None)) -> dict[str, Any]:
    """Same shape as a node's inbox (user ruling — the two interfaces function
    identically): unread mail + the read archive + the Sent folder (every user
    message is mail and gets recorded)."""
    try:
        d = store.load_org_snapshot(
            slug, ("user_mail_log", "user_outbox")).d
    except LedgerError as e:
        raise HTTPException(404, str(e))
    pub = _public_slug(request) is not None
    return {"pending": _mail_refs(slug, "user", d.get("user_inbox", []), public=pub),
            "delivered": _mail_refs(slug, "user",
                                    d.get("user_mail_log", [])[-50:], public=pub),
            "sent": _sent_refs(slug, d.get("user_outbox", [])[-50:], public=pub)}


class InboxRead(Body):
    ids: list[str]


@app.post("/api/orgs/{slug}/inbox/read")
async def user_inbox_read(slug: str, body: InboxRead) -> dict[str, Any]:
    """Per-mail read: a viewed mail is marked read when the user clicks off it
    (user ruling) — it moves from unread into the read archive."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        ids = set(body.ids)
        keep: list[UserMailEntry] = []
        read: list[UserMailEntry] = []
        for m in org.d.get("user_inbox", []):
            (read if m.get("id") in ids else keep).append(m)
        if read:
            org.d["user_inbox"] = keep
            log = org.d.setdefault("user_mail_log", [])
            log.extend(read)
            # the archive is CHRONOLOGICAL, never read-order. extend() appends
            # in whatever order the user happened to CLICK, and the reader
            # renders by list position — so without this sort a mail read
            # second outranks one sent later (user bug 2026-08-02). `at` is
            # ISO-8601 Z, so a string sort is a time sort.
            log.sort(key=lambda m: m.get("at") or "")

            store.save_org(org)
    await hub.changed(slug)
    return {"read": len(read)}


# ------------------------------------------------ external chats (no chatq)
# The extern MCP server (externtool.py) gives any outside Claude Code session
# a peer identity (@mcp:<id>) and three verbs against org inboxes: send, read
# what's addressed to me, and wait for a response — a full Q&A loop with an
# org, no chatq required. chatq stays relevant only when the ORG must wake an
# external chat unprompted.
_PEER_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")


class ExternSend(Body):
    org: str
    body: str
    attachments: list[str] = []   # absolute local paths (extern peers are local)


def _extern_peer(peer: str) -> str:
    if not _PEER_RE.fullmatch(peer):
        raise HTTPException(422, "peer id must be 1-64 chars of [A-Za-z0-9._-]")
    return f"@mcp:{peer}"


@app.post("/api/extern/{peer}/send")
def extern_send(peer: str, body: ExternSend) -> dict[str, Any]:
    addr = _extern_peer(peer)
    store.extern_seen(addr)          # D-166: reaching in is evidence of life
    if not body.body.strip():
        raise HTTPException(422, "empty message")
    # attachments (user spec 2026-07-31): absolute paths on this machine —
    # extern peers are local sessions. Validated here; copied into every
    # recipient's uploads/ by deliver_org_inbox.
    atts: list[str] = []
    for p in (body.attachments or [])[:10]:
        p = str(p)
        if not os.path.isfile(p):
            raise HTTPException(422, f"attachment not found: {p}")
        if os.path.getsize(p) > 25 * 1048576:
            raise HTTPException(413, f"attachment over the 25 MB cap: {p}")
        atts.append(p)
    with store.DOC_LOCK:
        try:
            org = store.load_org(body.org)
        except LedgerError:
            org = None
        # sealed kiosks must be INDISTINGUISHABLE from nonexistent orgs out
        # here (review finding: a 403 vs 404 split let an outside peer
        # enumerate the kiosk roster the org listing deliberately withholds)
        if org is None or org.is_kiosk:
            raise HTTPException(404, f"no organization named {body.org!r}")
    delivered = supervisor.deliver_org_inbox(body.org, addr, body.body,
                                             attachments=atts or None)
    return {"delivered": delivered or ["(user inbox — no live agents)"]}


def _extern_scan(addr: str, org_slug: str | None, after: str | None,
                 fresh_only: bool = False) -> list[dict[str, Any]]:
    """Replies addressed to `addr`. `fresh_only` (the wait path, №5): with no
    explicit cursor, only replies newer than the peer's own LAST message to
    that org count — a wait for question ② must never be satisfied by the
    answer to question ①. The read path stays full-history (freeform flow:
    the org may reply any time, any number of times)."""
    out: list[dict[str, Any]] = []
    with store.DOC_LOCK:
        for o in store.list_orgs():
            if org_slug and o["slug"] != org_slug:
                continue
            try:
                org = store.load_org(o["slug"])
            except LedgerError:
                continue
            if org.is_kiosk:
                # unreachable today (kiosk inboxes can hold no "out" entries —
                # the ledger seals every inbound/outbound path), but the seal
                # belongs on THIS path too, locally, not as a 3-file argument
                continue
            entries = org.d.get("org_inbox", [])
            floor = after
            if not floor and fresh_only:
                # timestamps are millisecond-resolution now (user ruling), so
                # the floor is simply the peer's own latest message to the org
                mine = [e.get("at", "") for e in entries
                        if e.get("peer") == addr and e.get("dir") == "in"]
                if not mine:
                    # the peer's own inbound was trimmed (the 200-entry log
                    # cap) or never existed — nothing is provably fresh, and
                    # a collapsed floor would hand back the whole history:
                    # exactly what fresh_only exists to prevent (review P1)
                    continue
                floor = max(mine)
            for e in entries:
                if e.get("peer") == addr and e.get("dir") == "out" \
                        and (not floor or e.get("at", "") > floor):
                    # org-voice mail stays anonymous (§8 pins that `by` never
                    # leaks) — but a held-handle send (external_handles) spoke
                    # to its OWN channel and carries the sender's name for the
                    # panel to render
                    by = e.get("by") if e.get("attributed") else None
                    out.append({"org": o["slug"], "id": e["id"],
                                "at": e["at"], "body": e["body"],
                                **({"by": by} if by else {})})
    out.sort(key=lambda x: x["at"])
    return out


@app.get("/api/extern/{peer}/messages")
def extern_messages(peer: str, org: str | None = None,
                    after: str | None = None) -> dict[str, Any]:
    addr = _extern_peer(peer)
    store.extern_seen(addr)          # D-166: a READ is a sighting too — it is
    # the only heartbeat a peer that never sends anything ever produces
    msgs = _extern_scan(addr, org, after)
    # the cursor rides every reply (review P1): pass it back as `after` and a
    # repeat wait/read can never re-deliver what this call already handed over
    return {"messages": msgs, **({"cursor": msgs[-1]["at"]} if msgs else {})}


@app.get("/api/extern/{peer}/wait")
async def extern_wait(peer: str, org: str | None = None,
                      after: str | None = None, timeout: int = 25) -> dict[str, Any]:
    """Long-poll: block until an org replies to this peer (or timeout).
    Rescans (DOC_LOCK + org-doc reads) only when store.REVISION moved —
    review finding: parked waiters were paying a full scan every second
    under the same lock the turn machinery serialises on."""
    addr = _extern_peer(peer)
    store.extern_seen(addr)          # D-166: the listener's own heartbeat —
    # recorded on ARRIVAL, not on return, so a peer that waits the full window
    # and gets nothing still counts as alive
    deadline = time.monotonic() + min(max(timeout, 1), 55)
    rev = None
    while True:
        if rev != store.REVISION:
            rev = store.REVISION
            msgs = _extern_scan(addr, org, after, fresh_only=True)
            if msgs:
                return {"messages": msgs, "cursor": msgs[-1]["at"]}
        if time.monotonic() >= deadline:
            return {"messages": []}
        await asyncio.sleep(1.0)


@app.get("/api/orgs/{slug}/org_inbox")
def org_inbox_entries(slug: str, request: Request = cast(Request, None)) -> dict[str, Any]:
    """The org mailbox itself — fetched when the modal OPENS, not on every poll.

    The tree payload carries only `ORG_INBOX_PREVIEW` rows (the canvas renders
    exactly one, the newest) plus `total`. The full log was 105,310 B of an
    844 KB tree refetched every 6 s and on every save, for a panel that is
    usually closed. MEASURED 2026-09-03.

    ⚠ `total` IS RETURNED HERE TOO, and it must be the length of the log, not
    of the slice. The desk's unread boundary is `total - unread`, so a `total`
    that meant "rows in this response" would silently move that line every
    time the cap changed.
    """
    try:
        org = store.load_org_snapshot(slug, ("org_inbox",))
    except LedgerError as e:
        raise HTTPException(404, str(e))
    log = cast("list[dict[str, Any]]", org.d.get("org_inbox") or [])
    # the rows carry their own references, like every other box: without this
    # the org inbox is the one mailbox whose mail cannot be linked to
    return {"entries": _mail_refs(slug, "org", log[-100:],
                                  public=_public_slug(request) is not None),
            "total": len(log),
            "unread": max(0, len(log) - int(org.d.get("org_inbox_read", 0)))}


@app.get("/api/orgs/{slug}/mail/{box}/{mid}")
def mail_one(slug: str, box: str, mid: str, request: Request = cast(Request, None),
             node: str = "") -> dict[str, Any]:
    """ONE message, by id, from the box that actually holds it.

    Every mailbox route returns a WINDOW, so "not in the window" is not "not
    there" — a retained message outside it is still there. This is the exact
    question a panel asks instead of inferring absence from its slice.

    ⚠ NOT A WIDER POLL: one id, asked once, only when a reference lands outside
    the loaded window. ⚠ AND NO EXTRA REACH: each box is searched through the
    same route that already serves it wholesale, and an unknown box or node is
    a 404 rather than a search.
    """
    try:
        org = store.load_org_snapshot(
            slug, ("mail_log", "user_mail_log", "user_outbox", "org_inbox"))
    except LedgerError as e:
        raise HTTPException(404, str(e))
    mid = str(mid or "")
    pub = _public_slug(request) is not None
    rows: list[Any] = []
    if box == "user":
        rows = (list(org.d.get("user_inbox") or [])
                + list(org.d.get("user_mail_log") or []))
        rows = _mail_refs(slug, "user", rows, public=pub)
    elif box == "org":
        rows = list(org.d.get("org_inbox") or [])
        rows = _mail_refs(slug, "org", rows, public=pub)
    elif box == "node":
        nid = str(node or "")
        try:
            org.node(nid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        rows = (list((org.d.get("mail") or {}).get(nid, []))
                + list((org.d.get("mail_log") or {}).get(nid, [])))
        rows = _mail_refs(slug, "node", rows, nid, public=pub)
    else:
        raise HTTPException(404, f"no mailbox family named {box!r}")
    for r in rows:
        if isinstance(r, dict) and str(r.get("id") or "") == mid:
            return {"found": True, "mail": r}
    # ⚠ A NEGATIVE ANSWER IS AN ANSWER, and it is a different one from "not in
    # the window". This box was searched whole; the message is not in it.
    return {"found": False, "mail": None}


@app.post("/api/orgs/{slug}/org_inbox/read")
async def org_inbox_read(slug: str) -> dict[str, Any]:
    """The user opened the org-inbox panel: clear its unread count."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        org.org_inbox_mark_read()
        store.save_org(org)
    await hub.changed(slug)
    return {"ok": True}


# ---- F-06 E: the user composes extern mail from the mailbox UI ----
# The user bypasses the audience gate (they outrank it) and this grants
# nobody anything. Attachments stage first (browser body upload, same caps),
# then ride the same transport as agent sends. Stage hygiene (redteam):
# per-ORG ids, startup sweep (in-memory ids die with the process, so files
# on disk at boot are unreachable), and a 24 h age-out for abandoned drafts;
# successfully drained files are deleted by net._spool_done.
_COMPOSE_STAGE: dict[str, tuple[str, str]] = {}   # stage-id → (slug, path)
_COMPOSE_DIR = "net_stage"


def _prune_stage(max_age_s: float = 86400.0) -> None:
    stage = os.path.join(store.DATA_ROOT, _COMPOSE_DIR)
    try:
        cutoff = time.time() - max_age_s
        for f in os.listdir(stage):
            p = os.path.join(stage, f)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
                    _COMPOSE_STAGE.pop(f.split("-", 1)[0], None)
            except OSError:
                pass
    except OSError:
        pass


class OrgInboxSend(Body):
    to: str                                  # @ext:/@org:/@mcp:/@net: address
    body: str
    attachments: list[str] = []              # stage ids from /org_inbox/upload


@app.post("/api/orgs/{slug}/org_inbox/upload")
async def org_inbox_upload(slug: str, request: Request,
                           name: str = "file") -> dict[str, Any]:
    if _public_slug(request):
        raise HTTPException(404, "not found")
    # refuse oversize BEFORE buffering when the client says how big it is
    try:
        clen = int(request.headers.get("content-length") or 0)
    except ValueError:
        clen = 0
    if clen > _NET_ATT_MAX:
        raise HTTPException(413, "attachment exceeds 25 MB")
    data = await request.body()
    if len(data) > _NET_ATT_MAX:
        raise HTTPException(413, "attachment exceeds 25 MB")
    _prune_stage()
    stage = os.path.join(store.DATA_ROOT, _COMPOSE_DIR)
    os.makedirs(stage, exist_ok=True)
    sid = uuid.uuid4().hex
    safe = re.sub(r"[^\w .()+\-]", "_",
                  os.path.basename(name)).strip(" .")[:120] or "file.bin"
    path = os.path.join(stage, f"{sid}-{safe}")
    with open(path, "wb") as f:
        f.write(data)
    _COMPOSE_STAGE[sid] = (slug, path)
    return {"id": sid, "name": safe, "bytes": len(data)}


@app.post("/api/orgs/{slug}/org_inbox/send")
def org_inbox_send(slug: str, body: OrgInboxSend,
                   request: Request) -> dict[str, Any]:
    if _public_slug(request):
        raise HTTPException(404, "not found")
    to = body.to.strip()
    if to.startswith("@ext:"):
        # user ruling 2026-08-05: @ext: retired with chatq — refuse loudly
        raise HTTPException(422, "the @ext: address form is retired — reach "
                                 "chats through the mail hub (@net:<slug>)")
    if not to.startswith(("@org:", "@mcp:", "@net:")):
        raise HTTPException(422, "recipient must be an outside address "
                                 "(@org:/@mcp:/@net:)")
    paths: list[str] = []
    for sid in body.attachments[:10]:
        staged = _COMPOSE_STAGE.get(sid)
        if not staged or staged[0] != slug or not os.path.isfile(staged[1]):
            raise HTTPException(422, f"staged attachment {sid!r} not found — "
                                     f"re-upload and retry")
        paths.append(staged[1])
    if paths and to.startswith("@mcp:"):
        # ruled 2026-08-05: that transport is text-only
        raise HTTPException(422, "attachments ride @net: and @org: mail "
                                 "only — @mcp: is a text-only transport")
    warnings: list[str] = []
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        if org.d.get("kiosk") is not None:
            raise HTTPException(422, "a sealed kiosk org has no outside face")
        if to.startswith("@net:") and to[5:] == (
                (org.d.get("net_identity") or {}).get("slug")):
            raise HTTPException(422, "that address is this organization")
        if to.startswith("@net:") and not any(
                h.get("enabled") for h in org.d.get("net_hubs") or []):
            raise HTTPException(422, "no mailserver is configured — enable a "
                                     "hub in settings → mailserver first")
        if to.startswith("@net:"):
            # user ruling 2026-08-12: same door as the agent path — an
            # unknown hub recipient refuses before anything is recorded
            try:
                _require_net_peer(to[5:])
            except LedgerError as e:
                raise HTTPException(422, str(e))
        oid = org._org_inbox_log("out", to, body.body, by="user")
        if to.startswith("@net:"):
            net.spool_append(org, to[5:], body.body, oid=oid,
                             attachments=paths)
        store.save_org(org)
    # spark on the wire (user spec 2026-08-05): a user compose leaves the
    # eye for the mailbox like an agent's outbound leaves its node
    mail_notify(slug, USER, "org_inbox")
    if to.startswith("@net:"):
        net.kick()
    elif to.startswith("@org:"):
        dst = to[5:]
        try:
            dst_org = store.load_org(dst)
            sealed = dst_org.d.get("kiosk") is not None
        except LedgerError:
            sealed = True
        if sealed:
            # same anti-enumeration answer as interorg_send
            warnings.append(f"not delivered: no organization named {dst!r} "
                            f"is reachable")
        else:
            supervisor.deliver_org_inbox(dst, f"@org:{slug}", body.body,
                                         attachments=paths or None)
        for p in paths:
            try:
                os.remove(p)
            except OSError:
                pass
    # @mcp: — the org-inbox entry IS the delivery; the peer polls
    hub_changed(slug)
    return {"id": oid, "warnings": warnings}


@app.post("/api/orgs/{slug}/inbox/clear")
async def user_inbox_clear(slug: str) -> dict[str, Any]:
    """Mark-all-read: archives into the read log (mirror of a node's mail_log)
    rather than deleting."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        log = org.d.setdefault("user_mail_log", [])
        log.extend(org.d.get("user_inbox", []))

        org.d["user_inbox"] = []
        store.save_org(org)
    await hub.changed(slug)
    return {"ok": True}


# ------------------------------------------------------------ crash reports
# The frontend's own crash reporter (frontend/src/crashReporter.ts) posts
# here from window.onerror / unhandledrejection / the top-level React error
# boundary — including from inside an already-broken app, via
# navigator.sendBeacon. That is why this endpoint is unauthenticated beyond
# whatever already gates the whole /api/ surface, and asks for nothing the
# browser might not still have: `org` is best-effort (may be null if the
# crash happened before any org loaded) and every field of `report` is
# optional from this endpoint's point of view — a half-formed report is still
# saved rather than 422ed, because a rejected crash report is a lost one.
_CRASH_STACK_MAX = 20_000
_CRASH_STR_MAX = 2_000
_CRASH_BREADCRUMBS_MAX = 50


class CrashReportBody(Body):
    org: str | None = None
    report: dict[str, Any]


def _clip(s: Any, n: int) -> str:
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[:n] + "…(truncated)"


@app.post("/api/crash-report")
def crash_report(body: CrashReportBody, request: Request) -> dict[str, Any]:
    r = body.report
    report: dict[str, Any] = {
        "id": _clip(r.get("id") or uuid.uuid4().hex[:12], 64),
        "at": r.get("at"),
        "kind": _clip(r.get("kind") or "unknown", 64),
        "message": _clip(r.get("message"), _CRASH_STR_MAX),
        "stack": crashreports.resolve_stack(_clip(r.get("stack"), _CRASH_STACK_MAX)),
        "url": _clip(r.get("url"), 1000),
        "userAgent": _clip(r.get("userAgent"), 500),
    }
    if r.get("componentStack"):
        report["componentStack"] = _clip(r["componentStack"], _CRASH_STACK_MAX)
    bc = r.get("breadcrumbs")
    if isinstance(bc, list):
        report["breadcrumbs"] = [
            {"at": b.get("at"), "kind": _clip(b.get("kind"), 32),
             "detail": _clip(b.get("detail"), 300)}
            for b in cast("list[Any]", bc)[-_CRASH_BREADCRUMBS_MAX:]
            if isinstance(b, dict)
        ]
    org_slug = (body.org or "").strip() or None
    path = crashreports.save_report(org_slug, report)
    # Delivery is a bonus on top of the save above, never a condition of it —
    # any failure here (bad org, node missing, node not live, mail refused)
    # must not turn an already-durable report into a 500. Kiosk/public
    # visitors are save-only: their crash is still real and still recorded,
    # but a public link is not a channel that should be able to page an
    # internal agent on demand.
    delivered = False
    if org_slug and not _public_slug(request):
        try:
            with store.DOC_LOCK:
                org = store.load_org(org_slug)
                target = org.nodes.get("crash-reporting")
                if target is not None and target.get("state") == "live":
                    org.post_mail(USER, "crash-reporting",
                                  crashreports.format_mail_body(report))
                    store.save_org(org)
                    delivered = True
            if delivered:
                mail_notify(org_slug, USER, "crash-reporting")
                supervisor.send_message(
                    org_slug, "crash-reporting",
                    "(orgtree) A UI crash report just arrived — act on it "
                    "now.", mail_ping=True)
        except (LedgerError, OSError):
            pass
    return {"id": report["id"], "saved": True, "delivered": delivered,
            "path": os.path.basename(path)}


@app.get("/api/crash-reports")
def crash_reports_list(request: Request, org: str | None = None,
                       limit: int = 50) -> dict[str, Any]:
    """Retrieval after the fact — "the UI died ten minutes ago, get me that
    report" answered without needing the tab that crashed."""
    if _public_slug(request):
        raise HTTPException(404, "not found")
    reports = crashreports.list_reports(limit=min(max(limit, 1), 200))
    if org:
        reports = [rep for rep in reports if rep.get("org") == org]
    return {"reports": reports}


# --------------------------------------------------------- inspector + admin
@app.get("/api/orgs/{slug}/nodes/{nid}/history")
def node_history(slug: str, nid: str, request: Request,
                 last: int = 80) -> dict[str, Any]:
    """Message history with attribution + delivered notices + ops touching the node."""
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    items: list[dict[str, Any]] = []
    for ev in org.d.get("events", []):
        det: dict[str, Any] = ev.get("detail", {})
        touches = (det.get("node") == nid or det.get("to") == nid
                   or ev.get("actor") == nid or det.get("grantee") == nid
                   or det.get("from") == nid)
        if touches:
            # №10: keep warning LISTS too — the scalar filter silently dropped
            # the §4.6 cascade warnings from the only log that had them
            items.append({"at": ev["at"], "kind": ev["op"], "actor": ev["actor"],
                          "detail": {k: (v if isinstance(v, (str, int, float))
                                         else [str(x) for x in cast("list[Any]", v)])
                                     for k, v in det.items()
                                     if isinstance(v, (str, int, float, list))},
                          "warnings": [str(w) for w
                                       in cast("list[Any]", ev.get("warnings") or [])]})
    _pub = _public_slug(request) is not None
    for n in org.d.get("notice_log", []):
        if n["node"] == nid:
            row = _row_out(n, public=_pub)
            items.append({"at": n["at"], "kind": "notice", "actor": "system",
                          "detail": {"text": n["text"]},
                          **{k: row[k] for k in ("ev", "ev_public", "ev_raw", "ev_error")
                             if k in row}})
    items.sort(key=lambda x: x["at"])
    # clamped like /chat's `last`: `?last=0` is `items[-0:]`, i.e. the WHOLE
    # log — the one value of `last` that means "no limit"
    out = items[-max(1, min(last, 1000)):]
    if _public_slug(request):
        out = _scrub_events(out)     # e.g. revoke_dir carries the host path
    return {"items": out}


@app.get("/api/orgs/{slug}/nodes/{nid}/scratch")
def node_scratch(slug: str, nid: str, path: str = "") -> dict[str, Any]:
    # ☠ The node MUST be resolved before `nid` reaches the filesystem. This
    # was the only /nodes/{nid}/… endpoint that skipped it, and `nid` is
    # joined straight into a path by supervisor.scratch_dir: `nid` =
    # `..\..\..\..\Users` walked out of the data root, mkdir'd the target,
    # and then anchored the containment check TO THE ESCAPED BASE — so the
    # listing and the 60 KB file read both succeeded. Reachable through the
    # kiosk gateway (the path is org-scoped, so the public matrix allows it),
    # which made it an internet-facing read of the operator's filesystem.
    try:
        store.load_org(slug).node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    base = os.path.realpath(supervisor.scratch_dir(slug, nid))
    full = os.path.realpath(os.path.join(base, _no_nul(path).lstrip("/\\")))
    # separator-anchored: a bare prefix test admits sibling dirs (<base>-x)
    if full != base and not full.startswith(base + os.sep):
        raise HTTPException(422, "path escapes the scratch space")
    if os.path.isdir(full):
        out: list[dict[str, Any]] = []
        for e in sorted(os.listdir(full))[:300]:
            p = os.path.join(full, e)
            out.append({"name": e, "dir": os.path.isdir(p),
                        "size": None if os.path.isdir(p) else os.path.getsize(p)})
        return {"dir": path or ".", "entries": out}
    if os.path.isfile(full):
        return {"file": path,
                "content": open(full, encoding="utf-8", errors="replace").read()[:60000]}
    raise HTTPException(404, f"no such path: {path!r}")


#: How much of org.md the EDITOR is handed. A bound, because this reads an
#: arbitrary file off disk — but a declared one, and the UI must refuse to SAVE
#: a truncated read. ☠ A short read plus one ordinary save rewrites the file
#: short and the operator's text is gone for real; App.tsx already carries the
#: scar of the sibling version of this bug (a failed read that armed an empty
#: write). `read_truncated` is what lets the client disarm the save.
ORGMD_EDIT_MAX = 60_000


@app.get("/api/orgs/{slug}/orgmd")
def orgmd_get(slug: str, request: Request) -> dict[str, Any]:
    """The org.md editor's read.

    Reports `chars` (the file's TRUE length) and `read_truncated`, plus
    `prompt_max` — how much of it actually reaches an agent. A file can be
    saved whole and still be delivered short; the editor says so, because the
    operator is the only person who can shorten it and was the one person
    never told."""
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    ws = org.d.get("workspace")
    p = os.path.join(ws, "CLAUDE.md") if ws else None
    content = ""
    chars = 0
    read_cut = False
    if p and os.path.isfile(p):
        raw = open(p, encoding="utf-8", errors="replace").read()
        chars = len(raw)
        read_cut = chars > ORGMD_EDIT_MAX
        content = raw[:ORGMD_EDIT_MAX]
    if _public_slug(request) and p:
        p = os.path.basename(p)      # the host path is the operator's, not the org's
    return {"path": p, "content": content, "chars": chars,
            "read_truncated": read_cut, "edit_max": ORGMD_EDIT_MAX,
            "prompt_max": supervisor.ORG_CHARTER_MAX}


class OrgMd(Body):
    content: str


@app.put("/api/orgs/{slug}/orgmd")
async def orgmd_put(slug: str, body: OrgMd) -> dict[str, Any]:
    """org.md — THE ORG CHARTER. Stored as the workspace `CLAUDE.md`, but
    delivered through `supervisor._org_charter_block` into the MANAGED SYSTEM
    PROMPT of every agent in the org, on every provider (user ruling
    2026-09-04). It used to be delivered only by whichever project-doc loader
    happened to pick the file up, which reached workspace-GRANT HOLDERS on the
    claude lane and nobody else — most seats hold no grants, and codex reads
    AGENTS.md, never CLAUDE.md.

    A save therefore RESTARTS EVERY AGENT IN THE ORG, on every lane: the text
    is part of their startup identity. That cost is disclosed in the editor's
    hint and was accepted by the user; it is the price of the field applying
    at all. The file is still written and still readable/editable by hand —
    it is the storage and the operator's editing surface."""
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    ws = org.d.get("workspace")
    if not ws:
        raise HTTPException(422, "org has no workspace")
    os.makedirs(ws, exist_ok=True)
    p = os.path.join(ws, "CLAUDE.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(body.content)
    await hub.changed(slug)
    # ⚠ THE FILE IS ALWAYS SAVED WHOLE. What is bounded is DELIVERY: only the
    # first ORG_CHARTER_MAX chars reach an agent's system prompt. That cut
    # announced itself inline in the prompt — to the AGENT, which cannot act on
    # it — and said nothing to the operator, the one person who can shorten the
    # file. This is that missing half. It never refuses: it is the operator's
    # own file and their own org.
    n = len(body.content)
    over = n - supervisor.ORG_CHARTER_MAX
    res: dict[str, Any] = {"path": p, "bytes": n, "chars": n,
                           "prompt_max": supervisor.ORG_CHARTER_MAX,
                           "prompt_truncated": over > 0}
    if over > 0:
        res["warnings"] = [
            f"Saved WHOLE to disk ({n} chars), but only the first "
            f"{supervisor.ORG_CHARTER_MAX} reach an agent: the last {over} "
            f"chars are delivered to NO agent, on any provider. Agents are "
            f"told their copy was cut, but they cannot shorten it — you are "
            f"the only one who can. Trim the file below "
            f"{supervisor.ORG_CHARTER_MAX} chars so the whole directive "
            f"arrives."]
    return res


class AudienceAction(Body):
    action: str            # grant | deny | revoke
    node: str              # the grantee / requester
    target: str | None = None


@app.post("/api/orgs/{slug}/audiences")
async def user_audience(slug: str, body: AudienceAction) -> dict[str, Any]:
    """User-side audience management: grant/deny requests that reached you, and
    one-click rescind of any audience (your authority is unconditional)."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            if body.action == "grant":
                result = org.audience_grant(USER, body.node, body.target)
            elif body.action == "deny":
                result = org.audience_deny(USER, body.node, body.target or USER)
            elif body.action == "revoke":
                result = org.audience_revoke(USER, body.node, body.target)
            else:
                raise LedgerError("action must be grant|deny|revoke")
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    for t in result.pop("drive", []):
        supervisor.send_message(slug, t, "(orgtree) You have new mail above.",
                                mail_ping=True, ping_reason="audience")
    await hub.changed(slug)
    return result


@app.get("/api/orgs/{slug}/audiences")
def audiences_list(slug: str) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    return {"audiences": org.d.get("audiences", []),
            "requests": org.d.get("audience_requests", [])}


# ---------------------------------------------- proxied-subscription upstream
# The sandbox's CLI points ANTHROPIC_BASE_URL here (secret in the path, via
# the bridge); the HOST attaches the subscription OAuth token — the sandbox
# never holds a credential (user spec). Streaming passthrough.
_hx: httpx.AsyncClient | None = None


def _upstream() -> httpx.AsyncClient:
    global _hx
    if _hx is None:
        import httpx
        _hx = httpx.AsyncClient(base_url="https://api.anthropic.com",
                                timeout=httpx.Timeout(600.0, connect=30.0))
    return _hx


def _anthropic_operation_allowed(method: str, path: str) -> bool:
    """Whether this deployment may relay one Anthropic API operation.

    Standard mode keeps the historical transparent passthrough. Frozen mode
    has one measured CLI requirement: message creation. Unknown methods and
    paths are refused before credentials are read or an upstream is opened.
    """
    policy = deployment.current_policy()
    return (policy.allow_broad_anthropic_proxy
            or (method == "POST" and path == "v1/messages"))


@app.api_route("/anthropic/{path:path}",
               methods=["GET", "POST", "HEAD", "PUT", "DELETE"])
async def anthropic_proxy(path: str, request: Request) -> StreamingResponse:
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import StreamingResponse
    from starlette.background import BackgroundTask
    bslug = getattr(request.state, "bridge_slug", None)
    if not bslug:
        raise HTTPException(403, "bridge only")
    if not _anthropic_operation_allowed(request.method, path):
        raise HTTPException(403, "operation not allowed by deployment policy")
    # api_fallback (user feature 2026-08-17): while the org's fallback window
    # is open, this passthrough re-auths with the org's KEY instead of the
    # host OAuth token — same container, same proxy, no recreate; reverting
    # is the window expiring. (A sandboxed fallback org is kept in proxied
    # mode by sandbox.ensure_container for exactly this reason.)
    upstream_key = ""
    try:
        _fo = await run_in_threadpool(store.load_org, bslug)
        upstream_key = sandbox.anthropic_proxy_api_key(
            _fo, fallback_active=supervisor.api_fallback_active(_fo))
    except LedgerError:
        pass
    headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in ("host", "x-api-key", "authorization", "content-length",
                         "connection", "accept-encoding", "x-orgtree-bridge"):
            continue
        headers[k] = v
    if upstream_key:
        headers["x-api-key"] = upstream_key
    else:
        try:
            token = await run_in_threadpool(subproxy.get_access_token)
        except RuntimeError as e:
            raise HTTPException(502, str(e))
        betas = headers.get("anthropic-beta", "")
        if "oauth-2025-04-20" not in betas:
            headers["anthropic-beta"] = (betas + "," if betas else "") + "oauth-2025-04-20"
        headers["Authorization"] = "Bearer " + token
    # identity only: we stream the body RAW — a gzip upstream response with
    # the content-encoding header stripped reads as garbage at the CLI
    headers["Accept-Encoding"] = "identity"
    body = await request.body()
    url = "/" + path + (f"?{request.url.query}" if request.url.query else "")
    req = _upstream().build_request(request.method, url,
                                    headers=headers, content=body)
    up = await _upstream().send(req, stream=True)
    resp_headers = {k: v for k, v in up.headers.items()
                    if k.lower() not in ("content-length", "transfer-encoding",
                                         "content-encoding", "connection")}
    return StreamingResponse(up.aiter_raw(), status_code=up.status_code,
                             headers=resp_headers,
                             background=BackgroundTask(up.aclose))


# ------------------------------------------------------------- agent gateway
class AgentCall(Body):
    org: str
    node: str
    tool: str
    args: dict[str, Any] = {}
    # ---- durable operation receipts (opreceipts.py) ----------------------
    # Minted by our own MCP client, one per tools/call; no tool card exposes a
    # key, so a model never invents one. It reaches this field only through
    # `orgtree_op_call` (see `_op_unwrap`) — a request that SPELLS it on the
    # envelope is refused, because that spelling is the one an older backend
    # silently drops while executing the operation anyway.
    op_key: str = ""
    # The epoch `orgtree_op_epoch` issued the client before it minted that
    # key. Same field rule, same reason: it reaches here only through the
    # wrapper, never off the envelope.
    op_epoch: str = ""


# every `args` key the tool schema documents as text: an identifier, a tier
# name, a body, a status. Containers were never legal in any of them.
_ARG_STRS = ("node", "to", "from", "target", "grantee", "parent", "new_parent",
             "name", "tier", "kind", "body", "action", "status", "summary",
             "reason", "charter", "team_charter", "org_visibility", "effort",
             "path",
             # D-160: the one-call hire's own text arguments. `permission_mode`
             # joins them at the same time — it has always been text-only, and
             # retool simply never had it normalised, so a container landed in
             # the clamp instead of 422ing at the door like every sibling.
             # `audiences` is deliberately ABSENT: it is a list (see
             # _seat_finish, which type-checks it itself).
             "permission_mode", "kickoff", "kickoff_kind",
             # D-224's topology verbs. `moves` is deliberately ABSENT for the
             # same reason as `audiences` — it is a list, and the move branch
             # type-checks it itself.
             "a", "b", "hire_type")


def _norm_args(a: dict[str, Any]) -> dict[str, Any]:
    """Normalise the free-form `args` dict an LLM fills in.

    Two 500 families came out of trusting it verbatim. A container in a text
    argument reached `self.nodes[nid]` as an unhashable dict key (every
    node-taking tool) and `delivered.startswith(...)` as a list (message). An
    explicit `null` was worse than a missing key: `a.get("to", "")` returns
    None when the key is PRESENT and null, so the "" default never applied.

    So: drop nulls (restoring the defaults), coerce scalars to text, refuse
    containers with the same 422 shape as any other bad argument."""
    out = dict(a)
    for k in _ARG_STRS:
        if k not in out:
            continue
        v = out[k]
        if v is None:
            del out[k]                       # let the `.get(k, default)` win
        elif isinstance(v, (dict, list, tuple, set)):
            raise LedgerError(
                f"{k} must be text, not {type(cast('object', v)).__name__}")
        elif not isinstance(v, str):
            out[k] = str(v)                  # a bare number reads as its text
    return out


def _arg_opt_int(a: dict[str, Any], key: str) -> int | None:
    """An OPTIONAL integer off the same free-form wire: None when the caller
    did not ask for it at all.

    ⚠ Deliberately not `_arg_int(a, key, 0)`. FR-32's `deadline_minutes` has
    to distinguish "absent" from every number, because absent is what keeps
    an armed prime behaving exactly as it did before deadlines existed. A
    zero default collapses that distinction, and the collapse is silent —
    every prime would carry a deadline of some sort and the only question
    would be whether the code downstream happened to treat 0 as falsy. A
    non-numeric value is REFUSED rather than read as absent: an LLM that
    wrote "thirty" meant to set a deadline, and quietly arming a prime
    without one would be the wrong half of its intent."""
    v = a.get(key)
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return int(str(v).strip())
    except (TypeError, ValueError, OverflowError):
        raise LedgerError(
            f"{key} must be a whole number of minutes (got {v!r})") from None


def _arg_int(a: dict[str, Any], key: str, default: int) -> int:
    """`args` is a free-form dict off the wire — an LLM fills it, so a string
    or a float lands there routinely. A bare `int(a.get(k) or d)` turned
    `{"delta": "x"}` and `{"last": "abc"}` into an uncaught ValueError, i.e. a
    500 from the gateway an agent is holding a tool result open on. Coerce
    what is coercible; refuse the rest the way every other bad argument is."""
    v = a.get(key)
    if v is None or v == "":
        return default
    # ⚠ OverflowError as well as TypeError/ValueError: `int(float("Infinity"))`
    # and `float("1e400")` raise it, not ValueError, so "Infinity", "-Infinity"
    # and "1e400" walked past the guard and 500ed the gateway an agent is
    # holding a tool result open on. Found 2026-08-04 by the mcptool suite,
    # which builds these args itself — and an LLM writes "Infinity" far more
    # readily than a human does.
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        try:
            return int(float(v))
        except (TypeError, ValueError, OverflowError):
            raise LedgerError(f"{key} must be a number (got {v!r})")


def _arg_num(a: dict[str, Any], key: str, default: float) -> float:
    """`_arg_int` for a CREDIT QUANTITY: identical coercion and identical
    refusals, but it does not truncate.

    ⚠ THE DIFFERENCE IS NOT THE LOST FRACTION, IT IS THE SILENT SUCCESS.
    `_arg_int` truncates toward zero, so an agent calling
    `orgtree_reallocate {"delta": 0.5}` had its ask rounded to 0 BEFORE the
    ledger saw it: `reallocate` was handed a no-op, wrote nothing, and
    answered 200. The caller was told its credits had moved. Measured
    2026-09-04. The same line shaved `{"grant": 5.7}` to 5 on hire and rehire,
    where it also stepped in front of `hire`'s own "grant must be a
    non-negative integer" refusal — the guard could never fire because the
    argument was always whole by the time it arrived.

    So credit arguments come through here intact and the LEDGER decides:
    `reallocate` snaps the target up to a whole credit, `hire` refuses a
    fractional grant outright, `rehire` rounds up. Round up or refuse — never
    truncate down, and never report success for work that did not happen.
    Counts (`last`) still use `_arg_int`; they are not money."""
    v = a.get(key)
    if v is None or v == "":
        return default
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        raise LedgerError(f"{key} must be a number (got {v!r})")
    # the same OverflowError class `_arg_int` documents: "Infinity" and
    # "1e400" parse as floats and would poison every credit total downstream
    if not math.isfinite(f):
        raise LedgerError(f"{key} must be a finite number (got {v!r})")
    return f


def _arg_flag(a: dict[str, Any], key: str) -> bool:
    """A boolean off the same free-form wire (D-178). The schema says boolean
    and the CLI usually honours it, but an LLM writes `"true"` often enough
    that treating the STRING "false" as true — which plain truthiness does —
    would turn a deliberate opt-out into an opt-in. Absent/null/empty is
    False; the four textual falsehoods are False; anything else takes its
    ordinary truth value."""
    v = a.get(key)
    if isinstance(v, str):
        return v.strip().lower() not in ("", "false", "0", "no", "null", "none")
    return bool(v)


# the @net: attachment cap — same value as the user-upload per-file cap
# (deliberately its own name; see the anchor note at the use site)
_NET_ATT_MAX = 25 * 1048576


# The scope fields each composite forwards to set_scope. `orgtree_hire`
# already takes dirs/tools/visibility/charter as hire arguments, so it carries
# only the three that used to be retool's alone; `orgtree_rehire` takes none of
# them, so it carries the lot — which is what collapses the five-call wake
# (rehire, rename, retool, audience grant, message) into one.
_SEAT_SCOPE_HIRE = ("permission_mode", "effort", "team_charter",
                    "prefer_reserve")
_SEAT_SCOPE_REHIRE = _SEAT_SCOPE_HIRE + ("charter", "org_visibility", "tools",
                                         "add_dirs")


def _seat_finish(org: Org, slug: str, actor: str, nid: str, a: dict[str, Any],
                 result: dict[str, Any], drive: list[str],
                 fields: tuple[str, ...] = _SEAT_SCOPE_HIRE) -> None:
    """D-160 — the one-call hire, and the one-call rehire. Everything an agent
    used to do in the calls AFTER `orgtree_hire` / `orgtree_rehire`: the
    retool-only scope fields, the audience grants, and the kickoff that
    actually starts the seat.

    User request 2026-08-27: hiring one agent took four calls (hire, retool,
    audience grant, kickoff message), and between them the seat exists but is
    not yet the agent that was described — a hire left at the org's default
    permission mode cannot act at all in a headless turn. Rehiring one took
    five, the extra being a rename.

    THREE PROPERTIES, in the order they matter.

    1. KICKOFF IS LAST, structurally rather than by convention. Nothing here
       starts a turn: `_notify` only queues (it never wakes, §7.4) and
       `mail_notify` is a UI animation signal with no state on it. The ONE
       wake path is `drive`, which `agent_call` consumes AFTER `store.save_org`
       and outside DOC_LOCK. So the seat's mode, scope and audiences are all
       persisted before its first turn can possibly begin. `audience_grant`
       wants to drive the grantee itself; we collect that instead of letting
       it through, and append the seat to `drive` exactly ONCE, here, at the
       tail — which also spares a fresh hire the pointless "Audience granted"
       wake the four-call version gave it.

    2. ALL-OR-NOTHING on partial failure. The caller is never told "hired"
       while quietly getting less than it asked for. This needs no new
       machinery: the whole dispatch already runs inside DOC_LOCK on an org
       freshly parsed from disk by `store.load_org`, and `store.save_org` is
       reached only if nothing raised. A bad audience target or an unknown
       folder in a later step therefore 422s with the failed step NAMED, and
       the node that `org.hire` created moments earlier is discarded with the
       unsaved doc — it never existed. Preferred over validating up front,
       which would mean a SECOND copy of each check sitting beside the real
       one, free to drift out of agreement with it.

    3. NO NEW AUTHORITY. Every step calls the same ledger method the
       standalone tool calls, with the same `actor` — `set_scope` for the
       scope fields (its own strict `_actor_cap` clamp caps permission_mode at
       the caller's own and refuses granting what the caller lacks),
       `audience_grant` for every target (which is also what makes 'user',
       a live peer and 'extern' the vocabulary here — it is that method's,
       not a second one invented for the shortcut), and `post_mail` for the
       kickoff. A shortcut that granted something the long way refuses would
       be a privilege escalation wearing a convenience's clothes.
    """
    applied: list[str] = []
    kw = {f: a[f] for f in fields if a.get(f) is not None}
    if "add_dirs" in kw:
        # the same sandbox path translation the standalone calls do — a
        # container path means nothing to the host ledger
        kw["add_dirs"], ddw = supervisor.sandbox_dirs_to_host(org, kw["add_dirs"])
        result.setdefault("warnings", []).extend(ddw)
    if kw:
        sres = org.set_scope(actor, nid, **kw)
        result.setdefault("warnings", []).extend(sres.get("warnings") or [])
        applied.extend(sorted(kw))
    # `audiences` mirrors orgtree_audience's target vocabulary exactly: 'user',
    # a named live agent, or 'extern' for the org inbox. A plain string is
    # accepted as the one-element case — an LLM writes that far more readily
    # than a one-element array, and refusing it teaches nothing.
    raw_aud = a.get("audiences")
    if raw_aud is None or raw_aud == "":
        targets: list[str] = []
    elif isinstance(raw_aud, str):
        targets = [raw_aud]
    elif isinstance(raw_aud, (list, tuple)):
        # a container of containers would reach audience_grant as an
        # unhashable key; every element has to be a plain scalar
        for t in cast("list[Any]", raw_aud):
            if isinstance(t, (dict, list, tuple, set)):
                raise LedgerError(
                    f"each audiences entry must be text, not "
                    f"{type(cast('object', t)).__name__}")
        targets = [str(t) for t in cast("list[Any]", raw_aud)]
    else:
        raise LedgerError(
            "audiences must be a list of targets ('user', a live agent's id, "
            "or 'extern' for the org inbox), or a single one as text")
    seat_drive = False
    for tgt in targets:
        if not str(tgt).strip():
            raise LedgerError("audiences entries must each name a target: "
                              "'user', a live agent's id, or 'extern' "
                              "(the org inbox)")
        ares = org.audience_grant(actor, nid, str(tgt).strip())
        for d in ares.pop("drive", []):
            # the grantee's own wake is folded into the single tail drive
            # below; anyone ELSE the grant woke is driven normally
            if d == nid:
                seat_drive = True
            elif d not in drive:
                drive.append(d)
        result.setdefault("warnings", []).extend(ares.get("warnings") or [])
        applied.append(f"audience:{tgt}")
    # THE DOCKET ASSIGNMENT, between the audiences and the kickoff (user
    # request 2026-09-05: a hire or rehire may take responsibility for an item
    # in the same call). It is a mutation like the others, so it rides this
    # transaction and is PERSISTED BEFORE THE SEAT CAN RUN — `drive` is
    # consumed after `store.save_org`, so the agent's first turn always finds
    # itself already assigned.
    #
    # ⚠ THE NOTIFICATION MAY REPLACE THE KICKOFF. An assignment mail is a
    # request like any other, so it starts the seat by itself: a hire that
    # carries `work_item` and no `kickoff` is hired, assigned, told so, and
    # RUNNING — and one that carries both still runs exactly ONE first turn,
    # because `seat_drive` is a flag and the tail below appends the seat once.
    wi = a.get("work_item")
    if wi is not None and str(wi).strip():
        _work_identity_ready(org, slug)
        ares = org.work_assign(actor, str(wi).strip(), nid)
        if ares.get("notified"):
            mail_notify(slug, actor, nid)
            if not ares.get("deferred"):
                seat_drive = True
        result["assigned_item"] = ares.get("assigned")
        applied.append(f"work_item:{ares.get('assigned')}")
    kickoff = a.get("kickoff")
    if kickoff is not None and str(kickoff).strip():
        kkind = str(a.get("kickoff_kind") or "request")
        if kkind == "notice":
            # the same refusal orgtree_message makes, for the same reason and
            # then some: 'notice' is the marker every no-wake rule keys on, so
            # a kickoff wearing it would be driven here yet skipped by every
            # rehire and reconcile — a first turn that fires once and can
            # never be re-delivered. A kickoff exists to wake; the two are
            # contradictory, so say so rather than quietly rewriting it.
            raise LedgerError(
                "kickoff_kind 'notice' contradicts a kickoff — a notice is "
                "mail that deliberately never wakes anyone, and the whole "
                "point of kickoff is to start the hire's first turn. Use "
                "'request' (the default), or drop kickoff and send an "
                "orgtree_send_notice afterwards")
        # identical in effect to the orgtree_message the caller used to send
        # by hand, and deliberately the LAST mutation in the composite.
        # Typed (family lifecycle): lifecycle.kickoff on the hire's NodeRef —
        # the body is the caller's text verbatim (the renderer passes it through)
        reason = ("rehire" if fields is _SEAT_SCOPE_REHIRE else
                  "staff" if a.get("work_item") else "hire")
        m = org.post_mail(
            actor, nid, "", kkind,
            ev=events.mint("lifecycle.kickoff", actor_of(actor), org.node_ref(nid),
                           body=str(kickoff), hired_by=actor, reason=reason,
                           tier=str(org.node(nid).get("model") or ""),
                           grant=float(org.node(nid).get("grant") or 0)))
        result.setdefault("warnings", []).extend(m.get("warnings") or [])
        mail_notify(slug, actor, nid)
        seat_drive = True
        applied.append("kickoff")
    if seat_drive and nid not in drive:
        drive.append(nid)
    if applied:
        result["applied"] = applied
    result["started"] = seat_drive
    return None


def _hire_seat(org: Org, slug: str, actor: str, a: dict[str, Any],
               drive: list[str]) -> dict[str, Any]:
    """`orgtree_hire`, lifted out of the dispatch WHOLE (2026-09-05) so that
    `orgtree_staff` runs the same hire rather than a second one written to
    look like it. Not a line of it changed in the move: a shortcut whose seat
    is created by a private copy of the hire path is a shortcut that drifts
    out of agreement with it, quietly, at the first fix to either."""
    result: dict[str, Any] = {}
    provider_hire_gate(org, a.get("tier"))
    hdirs, dwarns = supervisor.sandbox_dirs_to_host(
        org, a.get("add_dirs"))
    # D-224 ④: the destination pair. `target` (default: the
    # caller) says WHERE, `hire_type` says on WHICH SIDE of it.
    # `parent` is the pre-D-224 spelling of `target` and still
    # works; both omitted = exactly today's behaviour.
    _dest = str(a.get("target") or a.get("parent") or actor)
    _htype = str(a.get("hire_type") or "subordinate")
    # validated BEFORE the hire, so a bad destination creates
    # nothing (the seat would otherwise be discarded with the
    # unsaved doc — correct, but the refusal reads better here)
    org.check_placement(actor, _dest, _htype)
    if _htype == "superior":
        # THE SEAT'S SCOPE IS NOT THE CALLER'S TO CHOOSE HERE, and
        # accepting the fields anyway produced a response that
        # contradicted itself: a caller asking for `plan` was
        # answered `applied: ["permission_mode"]` while the seat
        # came out at `bypassPermissions` (redteam 2026-09-02).
        # An inserted superior must hold exactly what the branch
        # beneath it holds, so the four clamped sets are taken
        # from the target — say that at the door instead of
        # overwriting the caller behind its back. Refusing is
        # free here (nothing is created yet) and asks for LESS
        # typing than the ordinary form, not more.
        _conflict = [f for f in ("add_dirs", "tools",
                                 "org_visibility",
                                 "permission_mode")
                     if a.get(f) is not None]
        if _conflict:
            raise LedgerError(
                f"hire_type='superior' seats the new agent in "
                f'"{_dest}"\'s own position, so it takes that '
                f"seat's folders, tools, visibility and "
                f"permission mode — it cannot also take yours. "
                f"Omit {', '.join(_conflict)} (retool it after "
                f"the insertion if it should hold less)")
        _tsc = org.node(_dest)["scope"]
        hdirs = [dict(d) for d in _tsc["add_dirs"]]
        a = dict(a, tools={**_tsc["tools"],
                           "mcp": list(_tsc["tools"].get("mcp") or [])},
                 org_visibility=_tsc.get("org_visibility", "full"))
    elif actor != USER:
        # THE OTHER HALF OF THE SAME RULE (Astra audit 2026-09-04
        # §11): the schema no longer lists add_dirs / tools /
        # org_visibility as required, because the superior branch
        # above refuses them and a flat `required` cannot say
        # "required in one mode, forbidden in the other". So the
        # ordinary mode's no-defaults rule is stated HERE, at the
        # door, naming the mode — the ledger's own §4.2 refusal
        # still stands behind it (and still checks every tool
        # switch), but its wording predates the second mode and
        # cannot tell a caller which of the two it got wrong.
        _missing = [f for f in ("add_dirs", "tools",
                                "org_visibility")
                    if a.get(f) is None]
        if _missing:
            raise LedgerError(
                f"an ordinary hire (hire_type='subordinate', the "
                f"default) has no defaults — state "
                f"{', '.join(_missing)} explicitly ([] is a "
                f"valid add_dirs). Only hire_type='superior' "
                f"takes them from the target instead")
    result = org.hire(actor, _dest,
                      a.get("tier"), _arg_num(a, "grant", 0),  # type: ignore[arg-type]  # ledger 422s a missing tier; _arg_num so hire's own whole-grant refusal can still fire
                      a.get("name") or "", add_dirs=hdirs,
                      tools=a.get("tools"),
                      org_visibility=a.get("org_visibility"),
                      charter=a.get("charter"))
    if dwarns:
        result.setdefault("warnings", []).extend(dwarns)
    if result.get("node"):
        # D-160: the scope fields, the audience grants and the
        # kickoff — all of it inside this same transaction, with
        # the kickoff strictly last. See _seat_finish.
        #
        # ⚠ `permission_mode` is refused up front in `superior`
        # mode (the seat's is the target's), so it must not be in
        # the field list either — `applied: ["permission_mode"]`
        # beside a seat holding a different mode is a response
        # contradicting itself, and `applied` is the
        # machine-readable half (redteam 2026-09-02).
        _fields = tuple(f for f in _SEAT_SCOPE_HIRE
                        if not (_htype == "superior"
                                and f == "permission_mode"))
        _seat_finish(org, slug, actor,
                     str(result["node"]), a, result, drive,
                     fields=_fields)
    if result.get("node") and _htype == "superior":
        # …and the topology LAST of all: the seat is fully the
        # agent that was described before it is spliced in, and
        # `drive` is consumed after the save, so its first turn
        # can only ever see the final tree (_seat_finish ①).
        _ins = org.insert_parent(actor, str(result["node"]),
                                 _dest)
        result["inserted_above"] = _dest
        result["reports_to"] = _ins["under"] or "the top level"
        result["grant"] = _ins["grant"]
        result.setdefault("warnings", []).extend(
            _ins.get("warnings") or [])
    # observed on another install (user report 2026-08-02): an
    # agent hires, writes a thorough charter, and considers the
    # delegation DONE — the hire then sits idle forever, because
    # nothing in the tree self-starts. The charter is identity;
    # mail is what runs a turn. Said in the RESULT because that is
    # what the hiring agent reads next, not the tool description
    # it read once. D-160: a hire that carried a `kickoff` HAS
    # been started, so the nag would now be a lie — it says what
    # actually happened instead.
    if result.get("node"):
        result["next_step"] = (
            f'"{result["node"]}" is hired and RUNNING — its first '
            f'turn starts on your kickoff. Nothing further needed.'
            if result.get("started") else
            f'"{result["node"]}" is hired and IDLE. Hiring does not '
            f'start it — send it an orgtree_message now saying what '
            f'to do (or pass `kickoff` to this tool next time), or '
            f'it will never run.')
    return result


def _rehire_seat(org: Org, slug: str, actor: str, a: dict[str, Any],
                 drive: list[str], renamed_to: str | None,
                 rename_warnings: list[str]) -> dict[str, Any]:
    """`orgtree_rehire`, lifted out of the dispatch whole — same reason as
    `_hire_seat`. The RENAME is not in here: it takes DOC_LOCK itself and so
    runs before the lock, in the dispatch, and hands its outcome in as
    `renamed_to` / `rename_warnings`."""
    result: dict[str, Any] = {}
    _renamed_to, _rename_warnings = renamed_to, rename_warnings
    # D-203: plain agent rehire is an admission on the archived
    # node's stored provider. Check the durable user choice, but
    # deliberately not transient sign-in/install state (D-197
    # keeps recovery possible while a provider is signed out).
    _rehire_node = a.get("node")
    _rehire_tier = str(
        org.node(_rehire_node).get("model") or "")  # type: ignore[arg-type]
    provider_hire_gate(
        org, _rehire_tier, user_choice_only=True)
    # `grant` now goes through _arg_int like every other int
    # argument. It was the ONE that did not, so {"grant": "abc"}
    # reached `int(grant)` in the ledger and 500ed (mcptool suite,
    # 2026-08-04). None/"" stays None — rehire's "no explicit grant".
    _g = a.get("grant")
    # D-224 ④: rehire takes the same destination pair as hire —
    # both omitted restores the seat exactly where it was
    _dest = str(a.get("target") or "")
    _htype = str(a.get("hire_type") or "subordinate")
    if _dest or _htype != "subordinate":
        _dest = _dest or actor
        org.check_placement(actor, _dest, _htype)
        if _htype == "superior":
            # same rule as the hire door: an inserted superior
            # takes the target seat's scope, so the caller may
            # not also dictate it (redteam 2026-09-02)
            _conflict = [f for f in ("add_dirs", "tools",
                                     "org_visibility",
                                     "permission_mode")
                         if a.get(f) is not None]
            if _conflict:
                raise LedgerError(
                    f"hire_type='superior' restores the agent "
                    f'into "{_dest}"\'s own position, so it takes '
                    f"that seat's folders, tools, visibility and "
                    f"permission mode. Omit "
                    f"{', '.join(_conflict)} (retool it after the "
                    f"insertion if it should hold less)")
    result = org.rehire(actor, a.get("node"),  # type: ignore[arg-type]  # node() 422s on None
                        None if _g is None or _g == ""
                        else _arg_num(a, "grant", 0))
    drive.extend(result.pop("drive", []))
    # D-160: the other four calls. The rename already happened
    # above (it cannot share this lock); the scope, the audiences
    # and the kickoff all ride this transaction, kickoff last. A
    # woken node is already in `drive` from the rehire itself —
    # _seat_finish appends only if absent, so a rehire that had
    # queued mail AND a kickoff still runs exactly one turn.
    #
    # ⚠ the id comes from `a`, NOT from `result`: rehire returns
    # {cost, warnings, drive} and has never carried a `node` key.
    # Keying the composite off result["node"] would have made
    # every one of these steps silently skip. `a["node"]` is
    # already the post-rename id (rebound above).
    _rid = str(a.get("node") or "")
    result["node"] = _rid
    _seat_finish(org, slug, actor, _rid, a, result, drive,
                 fields=_SEAT_SCOPE_REHIRE)
    if _dest:
        # topology last, exactly as the hire path: the restored
        # seat is whole before it is placed. A rehire lands the
        # node where it was archived, so reach the destination
        # with an ordinary move first (budget-neutral, §4.5) —
        # `move` is also what refuses a cycle here.
        if org.node(_rid)["parent"] != _dest:
            _mv = org.move(actor, _rid, _dest)
            result.setdefault("warnings", []).extend(
                _mv.get("warnings") or [])
        if _htype == "superior":
            _ins = org.insert_parent(actor, _rid, _dest)
            result["inserted_above"] = _dest
            result["reports_to"] = _ins["under"] or "the top level"
            result.setdefault("warnings", []).extend(
                _ins.get("warnings") or [])
        else:
            result["reports_to"] = _dest
    if _renamed_to:
        result["renamed_to"] = _renamed_to
        result.setdefault("warnings", []).extend(_rename_warnings)
    # the drive list, not `started`: a rehire wakes the node by
    # itself when mail was waiting for it, and saying "IDLE" over
    # a turn that is about to run would be the same lie in the
    # other direction
    _woke = str(result.get("node") or "") in drive
    result["started"] = _woke
    result["next_step"] = (
        f'"{result.get("node")}" is back and RUNNING — nothing '
        f'further needed.' if _woke else
        f'"{result.get("node")}" is back and IDLE. Send it an '
        f'orgtree_message, or pass `kickoff` to this tool next '
        f'time, or it will sit there.')
    return result


def _staff_mode(a: dict[str, Any]) -> str:
    """hire or rehire, decided ONCE and read everywhere — the pre-lock rename
    step and the dispatch must agree about which one this call is.

    A `node` names an agent that already exists, so it can only be a rehire;
    without one there is nobody to bring back. An explicit `staff_mode` says it
    outright and is checked against that, rather than quietly winning: a call
    that says "hire" while naming an existing seat means one of the two, and
    guessing which would create or restore the wrong agent."""
    m = str(a.get("staff_mode") or "").strip().lower()
    has_node = bool(str(a.get("node") or "").strip())
    if not m:
        return "rehire" if has_node else "hire"
    if m not in ("hire", "rehire"):
        raise LedgerError("staff_mode must be hire or rehire — to assign an "
                          "item to an agent that is already live, use "
                          "orgtree_work with action 'assign'")
    if m == "rehire" and not has_node:
        raise LedgerError("staff_mode 'rehire' needs `node`: the archived "
                          "agent to bring back")
    if m == "hire" and has_node:
        raise LedgerError("staff_mode 'hire' does not take `node` — that names "
                          "an agent that already exists. Use 'rehire' to bring "
                          "it back, or drop `node` to seat somebody new")
    return m


def _staff_is_rehire(a: dict[str, Any]) -> bool:
    """The same question, asked from OUTSIDE the lock and unable to refuse.

    The pre-lock rename step needs to know which mode this call is, and it runs
    where a raised refusal would be a 500 rather than a 422. A malformed
    staff_mode therefore answers "not a rehire" here — nothing is renamed, and
    `_staff_mode` states the real refusal a moment later, inside the lock,
    where it turns into an ordinary 422 with nothing done."""
    try:
        return _staff_mode(a) == "rehire"
    except LedgerError:
        return False


#: staff arguments that belong to the DOCKET half and must never reach the
#: seat helpers. `parent` is the dangerous one: on a hire it is the pre-D-224
#: spelling of `target` (where the seat goes) and on a work item it is the
#: parent ITEM, so a caller nesting an item under another would otherwise
#: silently reparent the agent instead. Stripped rather than refused — the
#: argument has an unambiguous meaning here, it is only the OTHER reading that
#: has to be made impossible.
_STAFF_WORK_ONLY: tuple[str, ...] = ("action", "slug", "title", "objective", "kind",
                           "owner", "participants", "acceptance",
                           "dependencies", "done_so_far", "working_on_next",
                           "status", "blocked_reason", "attention",
                           "attention_reason", "reopen", "parent")


def _staff_call(org: Org, slug: str, actor: str, a: dict[str, Any],
                drive: list[str], renamed_to: str | None,
                rename_warnings: list[str]) -> dict[str, Any]:
    """`orgtree_staff` — the docket item, the seat, and the assignment that
    ties them together, in ONE call (user request 2026-09-05 20:46).

    THE SEAT IS CREATED FIRST, THEN THE ITEM IS WRITTEN WITH THAT SEAT AS ITS
    OWNER, and that order is the point. Creating the item first would have to
    give it an owner before the agent it is for exists — which means assigning
    it to its author and moving it a moment later, exactly the transient
    assign-to-author the user ruled against. This way the item's history
    contains ONE assignment, to the agent that actually holds it, and the
    notification names one recipient.

    Everything else is inherited rather than reimplemented: the seat comes from
    `_hire_seat` / `_rehire_seat` (the same code the standalone tools run,
    including their permission checks, `_seat_finish` and its all-or-nothing
    save), and the item comes from `work_create` / `work_update` (the same
    validation, the same assignment notification). Nothing here has authority
    of its own.

    ONE FIRST TURN. The seat is appended to `drive` at most once, whether it
    was started by a kickoff, by the assignment notification, or by both."""
    mode = _staff_mode(a)
    act = str(a.get("action") or "").strip().lower() \
        or ("update" if str(a.get("slug") or "").strip() else "create")
    if act not in ("create", "update"):
        raise LedgerError("orgtree_staff writes the docket with action "
                          "'create' or 'update' — every other docket action "
                          "is orgtree_work's")
    if act == "update" and not str(a.get("slug") or "").strip():
        raise LedgerError("action 'update' needs `slug`: the item to update "
                          "and hand to this agent")
    # the item is written INSIDE this transaction, so the identity conversion
    # has to be settled before it, exactly as the orgtree_work branch does
    _work_identity_ready(org, slug)
    seat_args = {k: v for k, v in a.items() if k not in _STAFF_WORK_ONLY}
    # ⚠ and never `work_item` either: in staff the assignment is made BY the
    # docket write below, so letting _seat_finish assign as well would file two
    # assignments and mail the seat twice for one call.
    seat_args.pop("work_item", None)
    if mode == "hire":
        result = _hire_seat(org, slug, actor, seat_args, drive)
    else:
        result = _rehire_seat(org, slug, actor, seat_args, drive,
                              renamed_to, rename_warnings)
    nid = str(result.get("node") or "")
    if not nid:                     # defensive: neither helper returns without one
        raise LedgerError("the seat was not created, so nothing was assigned")
    if act == "create":
        w = org.work_create(
            actor, str(a.get("title") or ""), str(a.get("objective") or ""),
            kind=str(a.get("kind") or "code"), owner=nid,
            participants=_work_list_arg(a, "participants"),
            acceptance=_work_list_arg(a, "acceptance"),
            dependencies=_work_list_arg(a, "dependencies"),
            done_so_far=a.get("done_so_far"),
            working_on_next=a.get("working_on_next"),
            status=str(a.get("status") or "open"),
            parent=(str(a["parent"]) if a.get("parent") else None))
        item = str(w.get("created") or "")
    else:
        w = org.work_update(
            actor, str(a.get("slug") or ""), a.get("done_so_far"),
            a.get("working_on_next"), status=(str(a["status"])
                                              if a.get("status") is not None
                                              else None),
            attention=(True if _arg_flag(a, "attention") else None),
            attention_reason=(str(a["attention_reason"])
                              if a.get("attention_reason") is not None else None),
            blocked_reason=(str(a["blocked_reason"])
                            if a.get("blocked_reason") is not None else None),
            title=(str(a["title"]) if a.get("title") is not None else None),
            objective=(str(a["objective"])
                       if a.get("objective") is not None else None),
            reopen=_arg_flag(a, "reopen"), owner=nid)
        item = str(a.get("slug") or "")
    result["item"] = item
    result["ref"] = refs.item(org.d["slug"], item)
    result["assigned_to"] = nid
    result[act + "d"] = item                 # created / updated, as the tools do
    if w.get("notified"):
        mail_notify(slug, actor, nid)
        if not w.get("deferred") and nid not in drive:
            drive.append(nid)
    # participants named on a staffed create were told (passively) by the
    # ledger; the keys ride out so agent_call nudges them like any notice
    for k in ("noticed", "noticed_deferred", "notice_refused"):
        if w.get(k):
            result[k] = w[k]
    result["started"] = nid in drive
    result["next_step"] = (
        f'"{nid}" holds {item} and is RUNNING — its first turn starts on the '
        f'assignment (and your kickoff, if you sent one). Nothing further '
        f'needed.' if result["started"] else
        f'"{nid}" holds {item} but is IDLE — the assignment mail is waiting in '
        f'its inbox (it is archived, or the notification was deferred). Rehire '
        f'it or send it an orgtree_message to start it.')
    return result


def _forced_self_restart(body: AgentCall, a: dict[str, Any]) -> dict[str, Any]:
    """FR-31 (user request 2026-09-04): `orgtree_self_restart` with force.

    ⚠ ITS OWN BRANCH, RETURNING EARLY, AND THAT IS THE POINT. The ordinary
    self-restart keeps running through the big dispatch below with not one
    line changed — the default cannot regress because the default was not
    touched. Force is a separate, longer, noisier road to the same deploy,
    which is what the user asked for after watching a hand-rolled version of
    it lose a race: "a force switch is a loaded weapon, and its danger is
    exactly proportional to how easy it is to reach by accident".

    ⚠ AND IT HAS TO BE ITS OWN BRANCH FOR A MECHANICAL REASON TOO. The
    quiesce WAITS for other agents' turns to finish, and those turns need
    `store.DOC_LOCK` to book their cost — the same constraint written on
    `supervisor.interrupt_before_archive`. Run inside the dispatch's
    `with store.DOC_LOCK:` block, every wait would time out and the quiesce
    would report that nobody settled while in fact nobody could: a guard that
    runs, reports, and means nothing. So the order here is deliberate:

      1. AUTHORITY AND THE REASON, under the lock, and SAVED. The decision is
         on disk before a single turn is stopped, so a forced restart that
         kills this very process still leaves a record of who ordered it.
      2. THE QUIESCE, with no lock held — stop everyone, wait for them to
         settle. It takes the deploy hold first, so nobody woken in the
         meantime can get running behind us.
      3. THE LAUNCH, which owns that hold from here on either way.
      4. THE COST, recorded after, naming who was actually cut.

    Steps 2 and 3 are adjacent with nothing between them that can raise, so
    the hold cannot be orphaned in the gap."""
    slug, nid = body.org, body.node
    target = str(a.get("target") or "org")
    reason = str(a.get("reason") or "")
    if target not in ("org", "mailhub", "both"):
        raise HTTPException(422, "target must be org|mailhub|both")
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            org.node(nid)
            org.self_restart_gate(nid, force=True, reason=reason)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        store.save_org(org)
    # ⚠ the mailhub leg never had a mid-turn precondition — it rebuilds a
    # container and no agent turn runs through it — so there is nothing for
    # force to force. Stopping the machine for it would be pure damage.
    q: dict[str, Any] | None = None
    if target in ("org", "both"):
        q = supervisor.force_quiesce_for_restart(exclude=(slug, nid))
        if not q.get("ok"):
            raise HTTPException(409, str(q.get("why") or "force refused"))
    r = supervisor.launch_self_restart(slug, nid, target,
                                       force=True, quiesced=q)
    if q:
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.log_forced_restart(
                nid, cast("list[str]", q.get("cut") or []),
                cast("list[str]", q.get("not_settled") or []))
            store.save_org(org)
    hub_changed(slug)
    return r


# ------------------------------------------------- operation receipts (§w71)
#
# ⚠ PROCESS-LOCAL AND NOT DURABLE, deliberately. It records the keyed calls
# THIS process currently has in flight, so a lookup can say "running" instead
# of fencing a call that is still going. It only ever ADDS certainty: its
# absence is never evidence, because a request that died with the process
# leaves nothing here either. The durable answers all come from the receipt
# log and its watermark, which survive a restart; this table is why a live
# call is not mistaken for a dead one.
_OP_INFLIGHT: dict[tuple[str, str, str], float] = {}
_OP_INFLIGHT_LOCK = threading.Lock()


def _op_scope(body: AgentCall) -> tuple[str, str, str]:
    return (body.org, body.node, body.op_key)


def _op_generation(org: Org, nid: str) -> int:
    return int(org.node(nid).get("generation") or 0)


def _op_ev_baseline(org: Org) -> int | None:
    """A JSON document loads everything, so the pre-dispatch event count is
    free there. A SQLite document must NOT be made to materialise its
    unbounded events log merely to number a receipt — for that backend the
    count comes from `store.appended_since_load` afterwards, and only if the
    dispatch materialised the section itself."""
    if store.STORE_BACKEND != "sqlite":
        return len(cast("list[Any]", org.d.get("events") or []))
    return None


def _op_ev_range(org: Org, pre: int | None) -> tuple[int | None, int | None]:
    """The DOCUMENT events this call produced — never post-commit effects."""
    if not dict.__contains__(cast("dict[str, Any]", org.d), "events"):
        return (pre, pre) if pre is not None else (None, None)
    log = dict.__getitem__(cast("dict[str, Any]", org.d), "events")
    n = len(cast("list[Any]", log))
    added = store.appended_since_load(log)
    if added is None:
        added = (n - pre) if pre is not None else None
    return (n - added, n) if added is not None else (None, None)


def _op_post_expected(tool: str, a: dict[str, Any]) -> list[str]:
    """What the dispatch will ATTEMPT after `save_org` — recorded so the
    receipt names what it is not proving, rather than staying silent."""
    out: list[str] = []
    cls = opreceipts.coverage(tool, a)
    if cls == opreceipts.TX_POST:
        out.append("drive")
    if tool in ("orgtree_retire", "orgtree_dissolve", "orgtree_cheap_compact"):
        out.append("remote_reap")
    return out


def _op_custody(org: Org, body: AgentCall) -> tuple[str, str]:
    """This process's current epoch for this document, and whether the call's
    own epoch still matches it. Must run inside DOC_LOCK, on the document as
    loaded — the seq it reads is the one the rewind check compares."""
    epoch, why = opreceipts.custody(cast("dict[str, Any]", org.d),
                                    store.DATA_ROOT, body.org)
    return epoch, why


def _op_admit(org: Org, body: AgentCall, a: dict[str, Any]
              ) -> dict[str, Any] | None:
    """Admission, inside the caller's DOC_LOCK. Returns the receipt context
    for a call that may proceed, or None when no receipt rides this call.
    Raises the refusal itself for replay/conflict/refuse."""
    if not body.op_key or not opreceipts.receipted(body.tool, a):
        return None
    gen = _op_generation(org, body.node)
    d = cast("dict[str, Any]", org.d)
    # custody FIRST: a rewind detected here rotates the epoch, which is what
    # makes this very call's epoch stale and refuses it.
    epoch, _why = _op_custody(org, body)
    decision, info = opreceipts.admit(d, body.node, gen, body.op_key,
                                      body.tool, a,
                                      epoch_ok=(body.op_epoch == epoch))
    if decision == opreceipts.REPLAY:
        row = cast("dict[str, Any]", info["row"])
        return {"replay": {
            "replayed": True, "op_id": row.get("id"), "at": row.get("at"),
            "tool": row.get("tool"), "outcome": row.get("outcome"),
            "receipt": row,
            "status": "This operation ALREADY APPLIED — nothing was done "
                      "again. This is its receipt, not a fresh result: the "
                      "original result was not kept, and the receipt covers "
                      "the document transaction only.",
        }}
    if decision == opreceipts.CONFLICT:
        raise HTTPException(409, f"op_key conflict: {info.get('detail')}. "
                                 f"Nothing was done. Use a fresh key.")
    if decision == opreceipts.REFUSE:
        raise HTTPException(
            422, f"op_key refused ({info.get('reason')}): "
                 f"{info.get('detail')}. Nothing was done, and whether the "
                 f"original call applied is UNKNOWN — do not treat this as a "
                 f"refusal of the operation itself.")
    return {"gen": gen, "mint_ms": int(cast("int", info["mint_ms"])),
            "ev_pre": _op_ev_baseline(org)}


def _op_file(org: Org, body: AgentCall, a: dict[str, Any],
             ctx: dict[str, Any], result: Any) -> None:
    """Append the receipt — the LAST thing before `save_org`, so it rides the
    same transaction as the effect it describes."""
    ev = _op_ev_range(org, cast("int | None", ctx.get("ev_pre")))
    opreceipts.append(cast("dict[str, Any]", org.d), opreceipts.row(
        op_id=opreceipts.new_id(), node=body.node,
        generation=int(cast("int", ctx["gen"])), key=body.op_key,
        mint_ms=int(cast("int", ctx["mint_ms"])), tool=body.tool, args=a,
        cls=opreceipts.coverage(body.tool, a), outcome="applied", at=ledger_mod.now(),
        result=result, ev=ev,
        post_expected=_op_post_expected(body.tool, a)))


class _op_inflight:
    """Marks a keyed call as IN FLIGHT in this process for as long as it holds
    (or waits for) the document lock — see `_OP_INFLIGHT`. Written as a
    context manager so it can ride the existing `with store.DOC_LOCK:` line
    without re-indenting the dispatch: entered first, so the mark covers the
    lock WAIT too, and left last."""

    def __init__(self, body: AgentCall) -> None:
        self._k: tuple[str, str, str] | None = (
            _op_scope(body) if body.op_key else None)

    def __enter__(self) -> None:
        if self._k is not None:
            with _OP_INFLIGHT_LOCK:
                _OP_INFLIGHT[self._k] = time.time()

    def __exit__(self, *exc: object) -> None:
        if self._k is not None:
            with _OP_INFLIGHT_LOCK:
                _OP_INFLIGHT.pop(self._k, None)


OP_CALL, OP_LOOKUP = opreceipts.OP_CALL, opreceipts.OP_LOOKUP
OP_EPOCH = opreceipts.OP_EPOCH


def _op_unwrap(body: AgentCall) -> AgentCall:
    """THE COVERAGE PROOF. A keyed call arrives as `orgtree_op_call`, carrying
    the real call in its arguments; this substitutes it back before any gate
    runs.

    Why a wrapping VERB rather than the plain `op_key` field it started as
    (2026-09-05, Astra's review of d3cd3fe, reproduced in
    `probe_old_build.py` against the real a0fac2f build):

        an older backend IGNORES an unknown envelope field. It executed the
        operation, filed no receipt, and returned nothing the caller ever
        saw. Replace that backend with this one, look the key up, find no
        receipt — and the honest-looking answer "not applied, safe to
        reissue" was a licence to do it twice.

    A recent mint time cannot rule that out; nothing the client can observe
    afterwards can. So the request itself is shaped so that a backend without
    receipts CANNOT execute it: the old dispatch answers `422 unknown orgtree
    tool 'orgtree_op_call'` and applies nothing (measured — mail rows 0 → 0).
    That is what makes the absence of a receipt evidence, and it is why this
    file no longer has a bootstrap grace to get wrong."""
    if body.tool != OP_CALL:
        if body.op_key or body.op_epoch:
            # the spelling an old build would have executed blind. Refuse it
            # HERE rather than honour it, or the guarantee above holds only
            # for clients that happen to use the wrapper.
            raise HTTPException(
                422, f"an `op_key`/`op_epoch` on the request envelope is not "
                     f"accepted: a keyed operation is issued as `{OP_CALL}` "
                     f"with `{{tool, args, op_key, op_epoch}}`. Nothing was "
                     f"done.")
        return body
    a = body.args if isinstance(body.args, dict) else {}
    tool, key, inner = (str(a.get("tool") or ""), str(a.get("op_key") or ""),
                        a.get("args"))
    epoch = str(a.get("op_epoch") or "")
    # ⚠ every refusal below is a CLIENT bug, and none of them may read like
    # the old build's "unknown orgtree tool" — that string is what the client
    # falls back on, and a fallback here would silently drop the receipt.
    if tool in opreceipts.VERBS:
        # ⚠ NOT left to the dispatch's own unknown-tool refusal: that message
        # would name `orgtree_op_call`, which is precisely the string the
        # client reads as "this backend has no receipts".
        raise HTTPException(422, f"`{OP_CALL}` cannot carry `{tool}`.")
    if not key or not isinstance(inner, dict):
        raise HTTPException(
            422, f"`{OP_CALL}` needs `tool` (the verb being keyed), `args` (an "
                 f"object) and `op_key`. Nothing was done.")
    if not epoch:
        # ⚠ REFUSED, NOT DEMOTED (Astra, 2026-09-05). The tempting reading is
        # "no epoch, so run it unprotected" — but this request ASKED for a
        # receipt, and answering it with an unrecorded execution is exactly
        # the silent loss of coverage the wrapper exists to prevent. Only a
        # bare, unwrapped call is unprotected; a wrapper without an epoch is
        # a client that skipped its preflight, and it is told so.
        raise HTTPException(
            422, f"`{OP_CALL}` needs the `op_epoch` this backend issued "
                 f"through `{OP_EPOCH}` before the key was minted. Nothing "
                 f"was done, and nothing was executed unprotected.")
    # an EMPTY or unknown `tool` is deliberately left to the dispatch, whose
    # "unknown orgtree tool '<name>'" names the inner verb and so still reads
    # correctly to a client
    return body.model_copy(update={"tool": tool, "args": inner, "op_key": key,
                                   "op_epoch": epoch})


def _op_absent(key: str, cls: str, at: str = "") -> dict[str, Any]:
    """The answer for a fenced key: not applied when the coverage class makes
    absence provable, and `unknown` when the verb also works outside the
    transaction the fence protects. One place, so the fresh fence and a fence
    an earlier lookup wrote can never answer differently."""
    base: dict[str, Any] = {"op_key": key, "fenced": True, "coverage": cls}
    if at:
        base["at"] = at
    if opreceipts.provable_absence(cls):
        return {**base, "state": "not_applied",
                "status": "no document transaction for this key committed, "
                          "and the key is now fenced so it can never apply — "
                          "safe to reissue the operation under a NEW key"}
    return {**base, "state": "unknown", "reason": "pre_transaction_step",
            "status": "no document transaction committed and the key is now "
                      "fenced, but this verb also does work OUTSIDE that "
                      "transaction (a folder move, a file copy, a process "
                      "signal, a wait for a turn boundary) which may already "
                      "have happened — the outcome is unknown; do not reissue"}


def _op_lookup_call(body: AgentCall, a: dict[str, Any]) -> dict[str, Any]:
    """"Did the call carrying this key apply?" — five answers, and `unknown`
    whenever the truth is not provable.

    It takes the document lock and may WRITE, because a truthful
    `not_applied` needs more than a look: the original request may still be
    on the wire, unadmitted, and would then apply after the caller was told
    it had not. So a lookup that finds nothing FENCES the key — a durable row
    that admission refuses — and only then reports it as not applied. The
    fence and the check are one transaction, so the original either committed
    first (and is found) or is refused forever after."""
    key = str(a.get("op_key") or "")
    if not key:
        raise HTTPException(422, "a lookup needs the `op_key` it is asking "
                                 "about")
    tool = str(a.get("for_tool") or "")
    if not tool:
        raise HTTPException(422, "a lookup needs `for_tool` — the verb the "
                                 "lost call was making. Without it the "
                                 "coverage class and the fingerprint of that "
                                 "call cannot be established, and the answer "
                                 "would be a guess.")
    raw_for = a.get("for_args")
    try:
        # the SAME normalisation admission ran, or the two fingerprints of one
        # call would disagree
        for_args = _norm_args(cast("dict[str, Any]", raw_for)
                              if isinstance(raw_for, dict) else {})
    except LedgerError as e:
        raise HTTPException(422, str(e))
    cls = opreceipts.coverage(tool, for_args)
    with store.DOC_LOCK:
        try:
            org = store.load_org(body.org)
            org.node(body.node)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        gen = _op_generation(org, body.node)
        d = cast("dict[str, Any]", org.d)
        epoch, _why = opreceipts.custody(d, store.DATA_ROOT, body.org)
        row = opreceipts.find(d, body.node, key)
        # what the row under this key IS — before ANY claim about it, and
        # regardless of the epoch: a row's existence says nothing about which
        # call it records (tool + full fingerprint at the row's own subject
        # and generation, `opreceipts.classify`)
        state = opreceipts.classify(row, tool, for_args)
        if state == "conflict":
            return {"state": "conflict", "op_key": key, "receipt": row,
                    "status": "that key already identifies a DIFFERENT "
                              "operation; this one was never done"}
        if str(a.get("op_epoch") or "") != epoch:
            # the key's epoch was rotated (restart or rewind): the log's
            # silence means nothing. A matching applied row is durable
            # positive evidence and reporting it executes nothing; a fence is
            # reported as a fence, not as an absence proof; no fence is
            # written (admission already refuses a stale epoch).
            if state == "applied":
                return {"state": "applied", "op_key": key, "receipt": row,
                        "status": "the document transaction committed (its "
                                  "receipt survived, and is being read under "
                                  "a later operation epoch); post-commit "
                                  "effects are not covered"}
            return {"state": "unknown", "reason": "epoch_rotated",
                    "op_key": key, "coverage": cls, "fenced": state == "fenced",
                    "status": "the operation epoch this key was issued under "
                              "is no longer current — the backend restarted, "
                              "or this document was restored — so the absence "
                              "of a receipt proves nothing about whether the "
                              "call applied. Do NOT reissue it; check the org."
                              + (" (A lookup had fenced this key, so no "
                                 "document transaction under it can commit "
                                 "from here on.)" if state == "fenced" else "")}
        if state == "applied":
            return {"state": "applied", "op_key": key, "receipt": row,
                    "status": "the document transaction committed; "
                              "post-commit effects are not covered"}
        if state == "fenced":
            # an earlier lookup already fenced it — the SAME answer as fencing
            # it here, including the coverage caveat: a fence stops the
            # document effect, and cannot speak for work done outside it.
            # The class comes from the ROW, not from the asker's verb, which
            # by now is known to be the same call.
            return _op_absent(key, str(cast("dict[str, Any]", row).get("cls")
                                       or cls),
                              at=str(cast("dict[str, Any]", row).get("at")
                                     or ""))
        with _OP_INFLIGHT_LOCK:
            running = (body.org, body.node, key) in _OP_INFLIGHT
        if running:
            return {"state": "running", "op_key": key,
                    "status": "a call with this key is executing in THIS "
                              "backend process right now; its outcome is not "
                              "decided yet — do not reissue"}
        if not opreceipts.receipted(tool, for_args):
            return {"state": "unknown", "reason": "unsupported_operation",
                    "op_key": key, "coverage": cls,
                    "status": "this verb never reaches the document "
                              "transaction, so no receipt can exist either "
                              "way — the outcome is unknown"}
        # nothing recorded, nothing running: FENCE the key, then answer.
        decision, info = opreceipts.admit(d, body.node, gen, key, tool,
                                          for_args, epoch_ok=True)
        if decision == opreceipts.REFUSE:
            return {"state": "unknown", "reason": info.get("reason"),
                    "op_key": key, "coverage": cls,
                    "status": str(info.get("detail") or "")}
        opreceipts.append(d, opreceipts.row(
            op_id=opreceipts.new_id(), node=body.node, generation=gen,
            key=key, mint_ms=int(cast("int", info["mint_ms"])),
            tool=tool, args=for_args, cls=cls, outcome="fenced",
            at=ledger_mod.now(),
            summary="fenced by a lookup: not recorded as applied"))
        store.save_org(org)
        # the fence is a committed append too: witness it (see agent_call)
        opreceipts.witness(store.DATA_ROOT, body.org, opreceipts.seq(d))
    return _op_absent(key, cls)


_chat_read_limiters: Any = weakref.WeakKeyDictionary()


async def _run_chat_read(function: Any, *args: Any) -> Any:
    # Wait on the event loop BEFORE borrowing a worker. A slow transcript
    # must not fill the shared 40-worker pool with projection-lock waiters,
    # starving mail, status, and stop controls. Each request still reads fresh
    # identity/state after admission; no stale response or cross-agent reuse.
    loop = asyncio.get_running_loop()
    limiter = _chat_read_limiters.setdefault(loop, anyio.CapacityLimiter(4))
    return await anyio.to_thread.run_sync(partial(function, *args), limiter=limiter)


@app.post("/api/agent")
async def _agent_call_route(body: AgentCall, request: Request) -> dict[str, Any]:
    if body.tool == 'orgtree_read_transcript':
        return await _run_chat_read(agent_call, body, request)
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(agent_call, body, request)


def agent_call(body: AgentCall, request: Request) -> dict[str, Any]:
    """Backend for the orgtree MCP server every node loads. The calling NODE is the
    actor — the ledger enforces authority, budgets, capability subsets, addressing,
    and the no-defaults hire rule.

    №22: plain `def` (threadpooled) — this endpoint parses transcripts and
    walks scratch dirs, and as `async def` it did that ON the event loop
    while holding DOC_LOCK. The read-only tools also run outside the lock
    entirely: they read the filesystem, not the doc."""
    # a sandboxed container's secret pins it to its OWN org — a compromised
    # sandbox cannot act as another org's agents
    identity = getattr(request.state, "agent_identity", None)
    if identity is not None:
        if (body.org, body.node) != tuple(identity[:2]):
            raise HTTPException(403, "agent credential identity mismatch")
        with store.DOC_LOCK:
            try:
                caller = store.load_org(body.org).node(body.node)
                valid = caller.get("state") == "live" and int(caller.get("generation", 0)) == identity[2]
            except LedgerError:
                valid = False
        if not valid:
            raise HTTPException(403, "agent credential is stale")
    bridge_slug = getattr(request.state, "bridge_slug", None)
    if bridge_slug and body.org != bridge_slug:
        raise HTTPException(403, "bridge secret is scoped to its own org")
    # ⚠ BEFORE EVERY GATE BELOW, because unwrapping only substitutes the call
    # this request was always making: after it, `body.tool` is the real verb
    # and every authority, capability and policy check below sees THAT.
    body = _op_unwrap(body)
    try:
        a = _norm_args(body.args)
    except LedgerError as e:
        raise HTTPException(422, str(e))
    if body.tool == OP_EPOCH:
        # THE PREFLIGHT. The client asks for the operation epoch before it
        # mints a key, and binds the key to the answer. A VERB, for the same
        # reason as the other two: an old build refuses it as unknown, and
        # that refusal is the client's signal that this backend cannot
        # protect it — arriving BEFORE any mutation has been attempted
        # rather than after one has already applied.
        #
        # It mutates nothing. It does take DOC_LOCK, because the seq it reads
        # is what the rewind check compares and reading it beside a
        # half-written transaction would be a false rewind.
        with store.DOC_LOCK:
            try:
                org = store.load_org(body.org)
                org.node(body.node)
            except LedgerError as e:
                raise HTTPException(422, str(e))
            epoch, why = opreceipts.custody(cast("dict[str, Any]", org.d),
                                            store.DATA_ROOT, body.org)
        return {"epoch": epoch, "org": body.org,
                # named so a reader can see WHY a fresh epoch appeared; the
                # client does not branch on it
                "minted": why or "",
                "status": "bind the next operation key to this epoch; a call "
                          "carrying any other one is refused before dispatch"}
    if body.tool == OP_LOOKUP:
        # asking, not acting — see `_op_lookup_call`. A VERB rather than a
        # flag on the envelope, and that is a safety property, not a taste:
        # a backend that predates receipts ignores unknown envelope fields,
        # so a `lookup` flag would have made an OLD build EXECUTE the very
        # operation the client was only asking about. An unknown verb refuses
        # instead, which is how the client learns the build cannot answer.
        # It runs before the gates below because a lookup performs none of
        # those operations.
        return _op_lookup_call(body, a)
    if body.tool in ("orgtree_self_restart", "orgtree_self_update",
                     "orgtree_prime_restart") \
            and not deployment.current_policy().allow_agent_restart:
        raise HTTPException(
            403, "the frozen deployment profile disables agent-triggered "
                 "self-update, self-restart, and primed restart; deploy this "
                 "installation through an operator-controlled path")
    if body.tool in ("orgtree_self_restart", "orgtree_self_update") \
            and _arg_flag(a, "force"):
        if os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1':
            raise HTTPException(422, 'Desktop maintenance waits for idle; force is unavailable')
        return _forced_self_restart(body, a)
    if body.tool in ("orgtree_read_transcript", "orgtree_read_scratch",
                     "orgtree_chart", "orgtree_send_file",
                     "orgtree_list_tiers"):
        try:
            org = store.load_org(body.org)
            org.node(body.node)
            if body.tool == "orgtree_list_tiers":
                # Provider discovery may probe a CLI or API behind its own
                # short cache. Keep that I/O outside the global document lock.
                org._require_live(body.node)
                try:
                    return _tier_discovery_payload()
                except RuntimeError as e:
                    raise HTTPException(503, str(e)) from e
            if body.tool == "orgtree_chart":
                # D-178: archived nodes are hidden from the default chart (it
                # is rebuilt into every turn of every agent); this flag is the
                # explicit ask that lists them. A PARAMETER rather than a
                # second tool on purpose — `identity_prompt` already derives
                # what a caller may see from its org_visibility, and a
                # separate listing tool would have to re-derive that. Two
                # implementations of "what may this agent see" agree the day
                # they are written and nothing makes them agree afterwards.
                # ⚠ D-181 SPLIT THE PROMPT, SO THIS TOOL TAKES BOTH HALVES.
                # The chart, the credit balance and the roster moved OUT of
                # `identity_prompt` into `org_state_block` (they are live org
                # state and were busting every agent's prompt cache). This
                # tool's whole job is to answer "what does the org look like
                # from here", so calling only the stable half would return a
                # chart tool that renders no chart. Both halves, concatenated,
                # is exactly what this tool returned before the split.
                _ia = _arg_flag(a, "include_archived")
                return {"chart": supervisor.identity_prompt(
                    org, body.node, include_archived=_ia)
                    + "\n\n" + supervisor.org_state_block(
                        org, body.node, include_archived=_ia)}
            if body.tool == "orgtree_send_file":
                # filesystem-only (org doc untouched) — runs outside DOC_LOCK
                # with the other read-shaped tools
                return _agent_send_file(org, body.node, a)
            if body.tool == "orgtree_read_transcript":
                target = a.get("node", "")
                if target != body.node and not org.is_ancestor(body.node, target):
                    raise LedgerError("read access is strictly DOWNWARD (§7.6) — you "
                                      "may read yourself and your descendants only")
                # no pending bubble in THIS payload, so read_chat must not
                # hold a fresh unprojected event back for one — an agent
                # reading its report inside the grace would get the newest
                # message zero times (D-229, review round 2); raw is honest
                last = max(1, min(_arg_int(a, "last", 30), 80))
                # Feed the already-bounded page into the projection cache;
                # retain the OUTER slice because preserving-bearer oracle rows
                # are appended after read_chat's durable slice by contract.
                # The established reader mode remains
                # `read_chat(org, target, hold_back=False)`; only its already-
                # bounded `last` argument is now supplied too.
                chat = supervisor.read_chat(org, target, last=last,
                                            hold_back=False)
                msgs = chat["messages"][-last:]
                return {"node": target, "busy": chat["busy"],
                        "occupancy": chat["occupancy"],
                        # an agent reading its report's fill deserves to know
                        # when the number is a post-compaction estimate rather
                        # than something a turn measured
                        "occupancy_estimated": bool(chat.get("occupancy_estimated")),
                        "messages": [{"role": m["role"],
                                      "text": (m.get("text") or "")[:1200],
                                      "tools": m.get("tools", [])} for m in msgs]}
            target = a.get("node", "")
            if target != body.node and not org.is_ancestor(body.node, target):
                raise LedgerError("read access is strictly DOWNWARD (§7.6)")
            base = os.path.realpath(supervisor.scratch_dir(body.org, target))
            rel = _no_nul(str(a.get("path") or "")).strip().lstrip("/\\")
            full = os.path.realpath(os.path.join(base, rel))
            # separator-anchored: a bare prefix test admits sibling dirs
            if full != base and not full.startswith(base + os.sep):
                raise LedgerError("path escapes the scratch space")
            if os.path.isdir(full):
                return {"dir": rel or ".", "entries": sorted(os.listdir(full))[:200]}
            if os.path.isfile(full):
                return {"file": rel,
                        "content": open(full, encoding="utf-8",
                                        errors="replace").read()[:20000]}
            return {"error": f"no such path in {target}'s scratch: {rel!r}"}
        except LedgerError as e:
            raise HTTPException(422, str(e))
    if body.tool == "orgtree_work" \
            and str(a.get("action") or "") in ("list", "get", "verify"):
        # list/get read the doc; verify sequences lock -> git -> lock itself
        return _work_read_call(body, a)
    result: dict[str, Any]
    # rename orchestrates its own DOC_LOCK + filesystem moves — it must run
    # OUTSIDE the block below (the lock is not reentrant)
    if body.tool == "orgtree_rename":
        try:
            return supervisor.rename_node(
                body.org, a.get("node") or "", a.get("name") or "",
                actor=body.node)
        except LedgerError as e:
            raise HTTPException(422, str(e))
    drive: list[str] = []      # nodes whose turn should run after we release the lock
    stale_freeze_resumed: list[str] = []  # switch_model cleared their freeze
    unstick_resume: tuple[str, list[str], list[str]] | None = None
    org_send: tuple[str, str] | None = None   # (dst-slug, body) outbound to another org's inbox
    net_send = False                          # @net: — staged to the spool; kick after the lock
    notice_to: str | None = None              # send_notice recipient — nudged wake=False after the lock
    # participants a docket `participants add` just told (passively) — each
    # is nudged wake=False after the lock, exactly like a send_notice
    noticed_nodes: list[str] = []
    # D-236: the orgtree_message recipient, so the drive below can report what
    # actually happened to the send instead of throwing that answer away
    mail_to: str | None = None
    # (owner, kind, target, pattern, shell) of a watchdog just armed — its
    # target is run ONCE, outside the lock, and the result rides back on the
    # create
    smoke_req: tuple[str, str, str, Any, Any] | None = None
    # D-160: a rehire that also RENAMES does the rename FIRST, here, before the
    # lock — and the ordering is forced from both ends, not chosen.
    #
    # It cannot go later: `rename_node` takes DOC_LOCK itself and the lock is
    # not reentrant, and it REFUSES a node that is mid-turn — so a rename
    # after the kickoff would refuse exactly when the kickoff worked.
    # It cannot go inside: same lock.
    # So it goes first, which is also where it does least harm. The user
    # ruled (2026-08-27) that rename joins this call despite being the one
    # step that cannot be rolled back — moving folders on disk is outside any
    # transaction. Putting it first shrinks the irreversible window to its
    # minimum: if a LATER step refuses, the only residue is a still-archived
    # node under its new name, and the refusal says so in those words rather
    # than leaving the caller to discover it. Nothing else has happened, and
    # the seat has certainly not woken.
    # ⚠ AND THE SAME FOR `orgtree_staff` IN REHIRE MODE, which is the same
    # rehire wearing a different name: it takes `name` for the same purpose and
    # would otherwise reach the ledger with the OLD id while the caller was
    # told it had been renamed.
    if str(a.get("name") or "").strip() \
            and (body.tool == "orgtree_rehire"
                 or (body.tool == "orgtree_staff" and _staff_is_rehire(a))):
        try:
            rn = supervisor.rename_node(body.org, str(a.get("node") or ""),
                                        str(a.get("name") or ""),
                                        actor=body.node)
        except LedgerError as e:
            raise HTTPException(422, f"rename refused, so nothing was "
                                     f"rehired: {e}")
        _new = str(rn.get("node") or a.get("node") or "")
        # a `name` that slugs to the id it already has is a no-op the ledger
        # returns early on — nothing moved, so it must not arm the
        # "the rename already happened" warning below
        _renamed_to: str | None = _new if _new != str(a.get("node") or "") else None
        _rename_warnings: list[str] = list(rn.get("warnings") or [])
        a = dict(a, node=_new)
    else:
        _renamed_to, _rename_warnings = None, []
    # retire/dissolve interrupt the node's in-flight turn (and every live
    # descendant's) and wait for the turn boundary to settle BEFORE the
    # archive commits (user report 2026-09-03: a retired-but-still-running
    # agent kept editing the repo and raced its own replacement). This runs
    # OUTSIDE the lock below — the wait needs DOC_LOCK free so the
    # interrupted turn's own `finally` can acquire it (see
    # interrupt_before_archive's docstring for why holding it here would
    # deadlock). The authority check here is a pre-guard only, so a caller
    # with no business over the target cannot interrupt it; org.retire /
    # org.dissolve repeat the real check under the lock once the archive runs.
    _archive_warnings: list[str] = []
    if body.tool in ("orgtree_retire", "orgtree_dissolve"):
        _arch_node = str(a.get("node") or "")
        try:
            _pre_org = store.load_org(body.org)
            _pre_org._require_authority(
                body.node, _arch_node,
                allow_self=(body.tool == "orgtree_retire"))
        except LedgerError as e:
            raise HTTPException(422, str(e))
        _archive_warnings = supervisor.interrupt_before_archive(
            body.org, _pre_org, _arch_node)
    with _op_inflight(body), store.DOC_LOCK:
        try:
            org = store.load_org(body.org)
            org.node(body.node)
            # ADMISSION (w71d69aac). Inside this lock acquisition on purpose:
            # the same one that mutates the document and saves it. A check
            # before the lock would be a time-of-check/time-of-use hole, and
            # two concurrent duplicates would both pass it.
            _rcpt = _op_admit(org, body, a)
            if _rcpt is not None and "replay" in _rcpt:
                return cast("dict[str, Any]", _rcpt["replay"])
            if body.tool == "orgtree_message":
                # the "notice" kind is minted ONLY by orgtree_send_notice —
                # it is the marker every no-wake rule keys on (waking_mail),
                # so a message wearing it would be a mail that DID wake its
                # recipient yet stops being re-driven across restarts
                if str(a.get("kind") or "") == "notice":
                    raise LedgerError(
                        "kind 'notice' is minted by orgtree_send_notice (a "
                        "send that never wakes the recipient) — use that "
                        "tool instead")
                # F-06 D: outbound attachments — @net: recipients only in v1
                # (ruled; @mcp: is a text-only transport, @org: local
                # mail has its own path). Validated BEFORE post_mail so a
                # refused send records nothing.
                if str(a.get("to", "")).startswith("@net:") \
                        and not any(h.get("enabled")
                                    for h in org.d.get("net_hubs") or []):
                    # redteam ①: refuse at the door — the old fallback spooled
                    # under an id no drain visits ("queued" forever)
                    raise LedgerError(
                        "no mailserver is configured for this org — ask the "
                        "user to enable a hub (settings → mailserver) before "
                        "addressing @net: mail")
                # resolve ONCE, before anything records (a refused send
                # writes nothing): 'user' is a sentinel, bare names
                # auto-resolve, and the resolution raises exactly what
                # post_mail would
                dest = org._resolve_recipient(str(a.get("to", "")),
                                              outward=True)
                if dest.startswith("@net:"):
                    # user ruling 2026-08-12: an unknown hub recipient
                    # refuses at the door, never spools into a void
                    _require_net_peer(dest[5:])
                net_atts: list[str] = []
                user_atts: list[dict[str, Any]] = []
                raw_atts = [str(x) for x in
                            cast("list[Any]", a.get("attachments") or [])]
                if raw_atts:
                    # FR-21 (user request 2026-08-09): branch on the RESOLVED
                    # recipient, not the raw string
                    if len(raw_atts) > 10:
                        raise LedgerError("at most 10 attachments")
                    if dest == USER:
                        # agent → user: ONE mechanism, two entry points — each
                        # path goes through the exact _agent_send_file
                        # validate-and-copy that the standalone card uses, so
                        # this inherits its capability-root enforcement,
                        # traversal guard, 25 MB cap, storage block and
                        # sandbox path translation. The metas it returns are
                        # already the shape MailList renders. (If post_mail
                        # refuses below, the outbox copies remain without a
                        # card — the same residue as a send_file the agent
                        # never announced, counted by storage metering.)
                        for rel in raw_atts:
                            user_atts.append(_agent_send_file(
                                org, body.node, {"path": rel})["sent"])
                    elif dest.startswith("@net:"):
                        ab = os.path.realpath(
                            supervisor.scratch_dir(body.org, body.node))
                        for rel in raw_atts:
                            rel = _no_nul(rel).strip().lstrip("/\\")
                            full = os.path.realpath(os.path.join(ab, rel))
                            # separator-anchored containment (send_file pattern)
                            if full != ab and not full.startswith(ab + os.sep):
                                raise LedgerError(f"attachment escapes your "
                                                  f"scratch space: {rel}")
                            if not os.path.isfile(full):
                                raise LedgerError(f"attachment not found: {rel}")
                            # cap under its own name: the user-upload cap's
                            # identifier is test_mcptool's source-slice END
                            # ANCHOR for the dispatch-verb extraction — writing
                            # that token here (even in a comment) truncates the
                            # slice and the drift guard fires
                            if os.path.getsize(full) > _NET_ATT_MAX:
                                raise LedgerError(
                                    f"attachment over 25 MB: {rel}")
                            net_atts.append(full)
                    else:
                        raise LedgerError(
                            "attachments ride mail to the user or @net: "
                            "peers — for local agent recipients use "
                            "orgtree_send_file or paths")
                # D-169: coerced, never trusted. This dispatch is fuzzed with
                # junk arguments for every card, and an argument that reaches
                # the ledger as the wrong TYPE would raise AttributeError
                # there — a 500, which fails unrelated fuzz checks. bool() and
                # str() are total over JSON, so a bad value becomes a refusal
                # with a sentence (422), not a stack trace.
                result = org.post_mail(body.node, a.get("to", ""), a.get("body", ""),
                                       a.get("kind", "message"),
                                       attachments=user_atts or None,
                                       urgent=bool(a.get("urgent")),
                                       urgent_reason=str(
                                           a.get("urgent_reason") or ""))
                delivered = result.get("delivered")
                if delivered and delivered.startswith("@"):
                    # spark on the wire (user spec 2026-08-05): outbound
                    # org mail rides the sender→mailbox line, whatever the
                    # transport branch below does with it
                    mail_notify(body.org, body.node, "org_inbox")
                if delivered and delivered.startswith("@org:"):
                    # outbound to ANOTHER ORG's inbox — direct
                    org_send = (delivered[5:], a.get("body", ""))
                elif delivered and delivered.startswith("@mcp:"):
                    # a polling external chat: the org-inbox entry IS the
                    # delivery — the peer reads it via the extern MCP server.
                    #
                    # D-166: so "delivered" was never true here, and the agent
                    # acted on it. @mcp: is a PULL transport — the row is
                    # FILED and a peer may or may not ever collect it; a send
                    # into a handle whose panel closed returned exactly the
                    # same cheerful 200 as one into a live channel, and the
                    # agent had nothing it could ever act on. Say what really
                    # happened instead, and — when we have a sighting to go on
                    # — say how long the silence has run.
                    #
                    # ⚠ Rewritten HERE, after the branch above has already
                    # routed, and never in post_mail: the elif chain below
                    # tests `delivered is not None`, so a False from the
                    # ledger would fall through it into mail_notify() and
                    # drive.append(False).
                    seen = store.extern_last_seen(delivered)
                    silent_h = ((time.time() - store._epoch(seen)) / 3600
                                if seen else 0.0)
                    result["filed"] = delivered
                    result["delivered"] = False
                    if seen is None:
                        result["status"] = (
                            f"filed for {delivered} — but that peer has NEVER "
                            f"polled this machine, so nothing is known to be "
                            f"listening. It is a pull transport: nobody is "
                            f"pushed to. Do not treat this as an answer "
                            f"delivered.")
                    elif silent_h >= 1:
                        result["status"] = (
                            f"filed for {delivered} — last heard from it "
                            f"{silent_h:.1f}h ago (at {seen}). It collects on "
                            f"its own schedule; if that silence looks wrong, "
                            f"the channel may be gone.")
                    else:
                        result["status"] = (
                            f"filed for {delivered} — it was polling recently "
                            f"(last seen {seen}), so it should collect this. "
                            f"Delivery is still its choice, not ours.")
                elif delivered and delivered.startswith("@net:"):
                    # F-06: stage the spool entry on the SAME loaded org — it
                    # rides this block's save, so the org-inbox row and the
                    # spool entry land atomically (no crash window). The
                    # daemon ships it; the agent's call returns instantly.
                    net.spool_append(org, delivered[5:], a.get("body", ""),
                                     oid=str(result.get("id") or ""),
                                     kind=a.get("kind", "message"),
                                     attachments=net_atts)
                    net_send = True
                elif delivered is not None:
                    mail_notify(body.org, body.node,
                                USER if delivered == "user_inbox" else delivered)
                    # a deferred delivery (archived recipient) queues only —
                    # the mail is driven when the node is rehired
                    if delivered != "user_inbox" and not result.get("deferred"):
                        drive.append(delivered)
                        mail_to = delivered
            elif body.tool == "orgtree_send_notice":
                # a NOTICE is mail minus the wake (user spec 2026-08-19):
                # same §7.2 addressing and mailbox, delivered by the next
                # turn's envelope — but it never STARTS a turn (no drive
                # here; rehire and reconcile skip notice-only boxes too).
                # In-org recipients only: the user inbox and outside
                # addresses are already passive, so the distinction is
                # meaningless there — orgtree_message covers them.
                nto = org._resolve_recipient(str(a.get("to", "")))
                if nto == USER or nto.startswith("@"):
                    raise LedgerError(
                        "notices are for agents in this org — the user "
                        "inbox and outside addresses never wake anyone "
                        "anyway; send those an orgtree_message")
                result = org.post_mail(body.node, nto, a.get("body", ""),
                                       "notice")
                mail_notify(body.org, body.node, nto)
                if not result.get("deferred"):
                    notice_to = nto
            elif body.tool == "orgtree_request_credits":
                result = org.request_credits(body.node, a.get("new_limit"),
                                             a.get("reason"))
            elif body.tool == "orgtree_watchdog":
                act = str(a.get("action") or "")
                if act == "create":
                    kind = str(a.get("kind") or "")
                    tgt = str(a.get("target") or "").strip()
                    if kind == "file":
                        # capability containment (the send_file rule): only
                        # trees the OWNER holds are watchable. Sandboxed
                        # agents watch files with an in-container stream dog
                        # instead (`tail -f` runs with their own hands) —
                        # host-path translation has no honest answer for a
                        # path the container cannot even name.
                        if sandbox.is_sandboxed(org):
                            raise LedgerError(
                                "sandboxed agents watch files with a STREAM "
                                "watchdog instead (e.g. target: tail -n0 -f "
                                "<path>) — it runs inside your container "
                                "with your own hands")
                        # ⚠ ONE containment rule, shared with the tick loop's
                        # re-check (`supervisor.wd_file_contained`). This used
                        # to be checked only here, at create time — so
                        # revoking the folder grant afterwards left the dog
                        # reading it and mailing its contents to the owner.
                        # Two copies of a rule are two chances to drift; the
                        # roots are computed in one place now.
                        wroot = os.path.realpath(
                            supervisor.scratch_dir(body.org, body.node))
                        full = os.path.realpath(
                            tgt if os.path.isabs(tgt)
                            else os.path.join(wroot, tgt))
                        if not supervisor.wd_file_contained(
                                org, body.node, full):
                            raise LedgerError(
                                f"cannot watch {tgt} — only files in your "
                                f"working folder, the workspace, or a "
                                f"folder you hold are watchable "
                                f"(orgtree_request_scope can ask for more)")
                        tgt = full
                    shell = str(a.get("shell") or "native").strip().lower()
                    if shell == "bash" and kind in ("command", "stream"):
                        # ☠ REFUSE, NEVER FALL BACK (2026-08-22). Handing a
                        # bash-idiom target to cmd.exe because bash was
                        # missing is the defect this field exists to fix,
                        # rebuilt one level up and made worse: the agent
                        # asked for bash and was told yes, so it has no
                        # reason to doubt its target, and the dog matches
                        # nothing forever. A refusal costs one message.
                        if sandbox.is_sandboxed(org):
                            raise LedgerError(
                                "shell='bash' is for host orgs — your dogs "
                                "already run in a POSIX shell (`sh -lc`) "
                                "inside your container, so the full idiom "
                                "works without it. Omit `shell`.")
                        if supervisor.wd_bash_exe() is None:
                            raise LedgerError(
                                "shell='bash' was asked for but no bash can "
                                "be found on this machine (looked on PATH, "
                                "in the Git for Windows install locations, "
                                "and in the registry; a WSL "
                                "System32\\bash.exe is deliberately NOT "
                                "used — it would run your command in a "
                                "different filesystem entirely). REFUSING "
                                "rather than quietly running your target in "
                                "cmd.exe, where a bash idiom matches nothing "
                                "and the dog looks healthy forever. Install "
                                "Git for Windows, or write a cmd target "
                                "(findstr, dir /b, %VAR%) and omit `shell`.")
                    result = org.watchdog_create(
                        body.node, a.get("name"), kind, tgt,
                        a.get("pattern"), a.get("interval_s") or 60,
                        a.get("notice"), a.get("shell"), a.get("once"))
                    # ☞ the smoke run happens AFTER the lock (see below): it
                    # spawns a real process and waits seconds for it, and
                    # DOC_LOCK is the whole machine's doc lock. Staged, not
                    # run here.
                    smoke_req = (body.node, kind, tgt, a.get("pattern"),
                                 a.get("shell"))
                elif act == "list":
                    # `notice` is listed because a flag you cannot SEE is a
                    # flag you cannot verify — an owner reading its own dogs
                    # must be able to tell which of them will wake it.
                    #
                    # `last_check` / `checks_run` / `last_output` / `health`
                    # are listed for the harder version of the same rule
                    # (2026-08-22): this projection used to report
                    # `state: armed, fired: 0` for BOTH a dog armed thirty
                    # seconds ago and one that had run 700 checks over nine
                    # days and matched nothing, and the only way to tell them
                    # apart was reading orgs/<slug>.json by hand. Three dogs
                    # on this machine died that way, silently, for up to nine
                    # days. An abstention that reads exactly like a pass is
                    # this codebase's standing failure shape; hiding the
                    # evidence in the doc is what made it one here.
                    result = {"watchdogs": [
                        supervisor.wd_list_row(w)
                        for w in org.d.get("watchdogs") or []
                        if w["owner"] == body.node
                        or org.is_ancestor(body.node, str(w["owner"]))]}
                else:
                    result = org.watchdog_action(
                        body.node, str(a.get("id") or ""), act)
            elif body.tool == "orgtree_request_scope":
                # FR-13: user-only grantor; the ledger routes deep agents
                # without a user audience to their superior as mail
                result = org.request_scope(
                    body.node,
                    cast("list[Any]", a.get("items") or []),
                    a.get("reason"))
            elif body.tool == "orgtree_ask":
                result = org.ask_user(body.node, a.get("question") or "",
                                      options=a.get("options"),
                                      multi=bool(a.get("multi")),
                                      header=a.get("header"),
                                      questions=a.get("questions"),
                                      # docket linkage (per tab; this is the
                                      # single form's)
                                      work_item=(str(a["work_item"])
                                                 if a.get("work_item") else None))
            elif body.tool == "orgtree_work":
                # the docket's mutating actions; list/get/verify returned
                # above, outside the lock.
                #
                # The identity conversion rides THIS request's lock and THIS
                # request's save, so an agent's first docket write after the
                # upgrade converts the document as part of its own atomic
                # write — and a failure in either half leaves the stored
                # document untouched, because neither has been saved.
                _work_identity_ready(org, body.org)
                result = _work_mutate(org, body.node, a)
                # AN ASSIGNMENT NOW MAILS THE AGENT THAT ACQUIRED THE ITEM, so
                # this branch has a post-commit effect it never had: the
                # notification is posted inside the transaction and the
                # recipient is woken from `drive`, which agent_call consumes
                # after the save. A deferred (archived) recipient reads it on
                # rehire and is not driven — the same rule ordinary mail
                # follows.
                #
                # ⚠ EVERY AGENT THE CALL MAILED, not just the first: one
                # update can hand the item over AND ask somebody else to review
                # it, and driving one of the two leaves the other with mail it
                # will not read until something unrelated wakes it.
                _told = [str(x) for x in (result.get("notified_nodes")
                                          or [result.get("notified")]) if x]
                for _n in _told:
                    mail_notify(body.org, body.node, _n)
                    # a deferred (archived) recipient reads it on rehire
                    if not result.get("deferred") and _n not in drive:
                        drive.append(_n)
            elif body.tool == "orgtree_withdraw_ask":
                result = org.withdraw_ask(body.node)
            elif body.tool in ("orgtree_self_restart", "orgtree_self_update"):
                # gate + org-log first (raises on refusal, and the log rides
                # this request's save); the launch itself is detached.
                #
                # "orgtree_self_update" is the DEPRECATED ALIAS (rename
                # 2026-08-21) and is deliberately NOT in mcptool.TOOLS, so no
                # new session is ever taught it. It stays dispatchable because
                # the old name outlives the rename in two places we do not
                # control: a LIVE agent session fetched tools/list at startup
                # and holds the old catalogue until it ends, and stored
                # charters/team-charters contain the literal string. Both
                # would emit orgtree_self_update at an install that no longer
                # answers it, and the failure lands mid-flight on an agent
                # that did nothing wrong. Costs one branch; delete it once no
                # stored charter names it.
                org.self_restart_gate(body.node)
                result = supervisor.launch_self_restart(
                    body.org, body.node, str(a.get("target") or "org"),
                    **({'action':'update'} if body.tool == 'orgtree_self_update'
                       and os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1' else {}))
            elif body.tool == "orgtree_prime_restart":
                # FR-27: arm a restart that fires by itself once the machine
                # is quiet. The gate + org-log ride this request's save, the
                # same shape self_restart uses; the FIRING is a background
                # loop that never comes back through here (that is the point
                # — it outlives this agent's session entirely).
                act = str(a.get("action") or "arm")
                if act not in ("arm", "cancel", "status"):
                    raise HTTPException(
                        422, "action must be arm|cancel|status")
                if act == "status":
                    # read-only: no authority act, so no gate and no org-log
                    # entry. `_require_live` still applies — a retired node
                    # is not answered.
                    org._require_live(body.node)
                    pr = supervisor.primed_restart()
                    result = {
                        "primed": pr,
                        "status": (
                            "restart in progress..."
                            if pr and pr.get("state") == "executing" else
                            f"a restart is primed by {pr.get('by_org')}/"
                            f"{pr.get('by_node')} (target="
                            f"{pr.get('target')!r}, armed {pr.get('at')}) — "
                            "it fires when this machine goes quiet"
                            # FR-32: a deadline you cannot SEE is a forced
                            # deploy nobody knows is scheduled
                            + (f", and if it has not by {pr.get('deadline')} "
                               f"({pr.get('deadline_minutes')} min from "
                               f"arming) it ESCALATES — stopping whoever is "
                               f"working and deploying anyway"
                               if pr.get("deadline_ts") else
                               " — no deadline, so it waits however long "
                               "that takes")
                            if pr else
                            "no restart is primed on this machine")}
                elif act == "cancel":
                    org.prime_restart_gate(body.node, "cancel")
                    result = supervisor.cancel_prime_restart(
                        body.org, body.node)
                else:
                    _tgt = str(a.get("target") or "org")
                    # FR-32: absent stays absent all the way down — a missing
                    # deadline must reach `arm_prime_restart` as None, not as
                    # a 0 that some later `or` turns into a default.
                    _dl = _arg_opt_int(a, "deadline_minutes")
                    org.prime_restart_gate(body.node, "arm", target=_tgt,
                                           reason=a.get("reason"),
                                           deadline_minutes=_dl)
                    result = supervisor.arm_prime_restart(
                        body.org, body.node, _tgt, a.get("reason"),
                        deadline_minutes=_dl)
            elif body.tool == "orgtree_restart_wake":
                act = str(a.get("action") or "arm")
                if act not in ("arm", "cancel", "status"):
                    raise HTTPException(422, "action must be arm|cancel|status")
                target = str(a.get("target") or body.node)
                org._require_live(body.node)
                if target != body.node:
                    if not org.is_ancestor(body.node, target):
                        raise HTTPException(
                            403,
                            f"you can only manage restart wake for yourself or "
                            f"your subordinates ({target!r} is not your subordinate)")
                    org._require_live(target)
                if act == "status":
                    result = restart_wake.status_restart_wake(body.org, target)
                elif act == "cancel":
                    result = restart_wake.cancel_restart_wake(body.org, target)
                else:
                    if a.get("mode") and a.get("mode") != "one_shot":
                        raise HTTPException(
                            422,
                            "only one-shot restart wakes are supported (re-arm after waking if needed)")
                    reason = a.get("reason")
                    if reason is not None:
                        reason = str(reason)[:200]
                    result = restart_wake.arm_restart_wake(
                        body.org, target, body.node, reason=reason)
            elif body.tool == "orgtree_present":
                # FR-03: a reading card beside the node — non-blocking
                result = _agent_present(org, body.node, a)
            elif body.tool == "orgtree_hire":
                result = _hire_seat(org, body.org, body.node, a, drive)
            elif body.tool == "orgtree_retool":
                # effort joins retool (ceiling spec §6): a cost dial, so a
                # superior may set it on REPORTS — never on itself (set_scope's
                # authority check refuses self). raise_ceiling is deliberately
                # NOT plumbed: an agent can never raise a kiosk ceiling.
                rdirs, dwarns = supervisor.sandbox_dirs_to_host(
                    org, a.get("add_dirs"))
                result = org.set_scope(body.node, a.get("node", ""),
                                       add_dirs=rdirs,
                                       tools=a.get("tools"),
                                       org_visibility=a.get("org_visibility"),
                                       # D-102: capped at the actor's own by
                                       # set_scope's strict parent clamp —
                                       # nobody grants above themselves
                                       permission_mode=a.get("permission_mode"),
                                       charter=a.get("charter"),
                                       team_charter=a.get("team_charter"),
                                       effort=a.get("effort"),
                                       prefer_reserve=a.get("prefer_reserve"))
                if dwarns:
                    result.setdefault("warnings", []).extend(dwarns)
            elif body.tool == "orgtree_retire":
                result = org.retire(body.node, a.get("node"))  # type: ignore[arg-type]  # node() 422s on None
                if _archive_warnings:
                    result.setdefault("warnings", []).extend(_archive_warnings)
            elif body.tool == "orgtree_cheap_compact":
                # FR-24: superior-only by _require_authority; the transcript
                # copy rides the same locked save window as the ledger change
                result = org.cheap_compact(body.node, a.get("node"))  # type: ignore[arg-type]
                supervisor.export_predecessor_transcript(
                    org, str(a.get("node") or ""),
                    old_sid=cast(str, result.get("old_session")),
                    reason="cheap_compact")
            elif body.tool == "orgtree_rehire":
                result = _rehire_seat(org, body.org, body.node, a, drive,
                                      _renamed_to, _rename_warnings)
            elif body.tool == "orgtree_staff":
                # the docket item + the seat + the assignment, in one call
                result = _staff_call(org, body.org, body.node, a, drive,
                                     _renamed_to, _rename_warnings)
            elif body.tool == "orgtree_move":
                _batch = a.get("moves")
                if _batch:
                    # D-224 ③: several moves as one transaction — the whole
                    # list rides this handler's load-mutate-save window, and
                    # the ledger restores its own doc on a mid-batch refusal
                    if not isinstance(_batch, list):
                        raise LedgerError("`moves` must be a list of "
                                          "{node, new_parent}")
                    # …and so must every ELEMENT (redteam 2026-09-02): the
                    # list check alone let `["abc"]`, `[5]`, `[True]` reach
                    # `.get` on a str/int/bool → AttributeError → a 500 out of
                    # the gateway an agent is holding a tool result open on.
                    # An LLM writes ["a","b"] for this shape readily; D-169's
                    # rule is that a bad argument 422s with a reason.
                    _mv: list[tuple[str, str | None]] = []
                    for i, m in enumerate(cast("list[Any]", _batch)):
                        if not isinstance(m, dict):
                            raise LedgerError(
                                f"moves[{i}] must be an object "
                                f"{{node, new_parent}}, not "
                                f"{type(cast('object', m)).__name__}")
                        _m = cast("dict[str, Any]", m)
                        if "new_parent" not in _m:
                            # the schema marks it required, and its absence
                            # silently meant THE TOP LEVEL — a promotion the
                            # caller never typed (and one only the user may
                            # make). Say so instead of guessing.
                            raise LedgerError(
                                f"moves[{i}] has no `new_parent` — name the "
                                f'new superior, or pass "" for the top level '
                                f"(user only)")
                        _mv.append((str(_m.get("node") or ""),
                                    _m.get("new_parent") or None))
                    result = org.move_batch(body.node, _mv)
                else:
                    result = org.move(body.node, a.get("node", ""),
                                      a.get("new_parent") or None)
            elif body.tool == "orgtree_swap":
                result = org.swap_seats(body.node, a.get("a", ""),
                                        a.get("b", ""))
            elif body.tool == "orgtree_self_subjugate":
                result = org.subjugate(body.node, body.node,
                                       a.get("target", ""))
            elif body.tool == "orgtree_list_orgs":
                # №43 (user-approved): the @org: channel was advertised but
                # undiscoverable from inside — agents had no org listing.
                # F-06 (§6 presence): remote peers from the hub roster ride
                # the same listing, addressed @net:<slug>, with online /
                # last_seen so an agent can route around a dark peer.
                # Transport sets (user spec 2026-08-05): every entry names
                # WHICH transports resolve it, derived from the same data
                # the bare-name resolver consults — the list and the send
                # agree by construction.
                locs = [o for o in store.list_orgs() if not o.get("kiosk")]
                local_net = {str(o.get("net_slug")): o["slug"]
                             for o in locs if o.get("net_slug")}
                peers = net.remote_peers()
                roster = {str(p.get("slug") or "")[5:] for p in peers}
                for p in peers:
                    s = str(p.get("slug") or "")[5:]
                    p["transports"] = (["org", "net"] if s in local_net
                                       else ["net"])
                result = {"orgs": [
                    {"slug": o["slug"], "name": o.get("name", o["slug"]),
                     "you": o["slug"] == body.org,
                     "transports": ["org"] + (
                         ["net"] if o.get("net_slug") in roster else [])}
                    for o in locs] + peers}
            elif body.tool == "orgtree_dissolve":
                result = org.dissolve(body.node, a.get("node"))  # type: ignore[arg-type]  # node() 422s on None
                if _archive_warnings:
                    result.setdefault("warnings", []).extend(_archive_warnings)
            elif body.tool == "orgtree_reallocate":
                result = org.reallocate(body.node, a.get("node"), _arg_num(a, "delta", 0))  # type: ignore[arg-type]  # node() 422s on None; _arg_num: an int here turned {"delta": 0.5} into a silent no-op
            elif body.tool == "orgtree_switch_model":
                provider_hire_gate(org, a.get("tier"))
                # D-234: the supervisor's live answer rides in — the ledger
                # also reads the seat's durable inflight marker; either says
                # "mid-turn" and the switch QUEUES instead of applying
                result = org.switch_model(
                    body.node, a.get("node", ""), a.get("tier", ""),
                    busy=bool(a.get("node") and supervisor.state(
                        body.org, str(a.get("node")))["busy"]))
                if result.get("old_session"):
                    # a crossing archived the old session as a bearer — the
                    # transcript copy into the seat's scratch rides the same
                    # locked save window, exactly as for cheap_compact (it
                    # is the same split)
                    supervisor.export_predecessor_transcript(
                        org, str(a.get("node") or ""),
                        old_sid=cast(str, result.get("old_session")),
                        reason="switch_model")
                # a crossing that cleared a stale provider freeze (see
                # switch_model) leaves the node LIVE but idle — wake it. Not
                # `drive`: that list's consumer below sends a generic "mail
                # above" ping, and an unfrozen node needs the accurate one.
                stale_freeze_resumed.extend(
                    result.pop("resume_stale_freeze", []))
            elif body.tool == "orgtree_status":
                status = a.get("status", "working")
                summary = a.get("summary", "")
                # persisted on the node (survives restarts); a new turn moves
                # it to prev_status, so a stale "done" never shows over live
                # work but the history is not erased (gap audit №13)
                # user ruling 2026-08-02: `done` and `idle` are not functionally
                # distinct — an agent that finished IS idle. The DONE report
                # still goes to the superior below; the node then simply sits
                # idle, carrying the summary so the chip still says what it did.
                # `blocked` is NOT collapsed: it means "stuck, needs a human or
                # a superior", which idle does not.
                stored = "idle" if status == "done" else status
                status_at = supervisor.now_iso()
                org.node(body.node)["last_status"] = {
                    "status": stored, "summary": summary,
                    "at": status_at}
                if stored == "working":
                    # The report itself is observable agent activity and the
                    # first durable anchor for the 20-minute checkup clock.
                    org.node(body.node)["working_activity_at"] = status_at
                else:
                    org.node(body.node).pop("working_activity_at", None)
                result = {"recorded": status}
                if status in ("done", "blocked"):
                    parent = org.node(body.node)["parent"]
                    if parent:
                        # typed (family status): status.report on the reporter's
                        # NodeRef; the body is its rendering, "[DONE] summary"
                        # byte for byte (test_events_producers §S)
                        r = org.post_mail(
                            body.node, parent, "", kind="status",
                            ev=events.mint("status.report", actor_of(body.node),
                                           org.node_ref(body.node),
                                           state=str(status), summary=str(summary)))
                        mail_notify(body.org, body.node, parent)
                        drive.append(parent)
                        result["reported_to"] = parent
                        # id + delivered: the chat chip's inline mailbox link
                        # (user spec — ALL agent mail sends carry it)
                        result["delivered"] = parent
                        result["id"] = r.get("id")
                        result["warnings"] = r.get("warnings", [])
                    else:
                        # top-level: the user already gets the agent's own reply
                        # mail — a second [DONE] digest was pure duplication
                        # (user ruling). The status chip is the record.
                        result["reported_to"] = ("status chip only — report your "
                                                 "actual results to the user via "
                                                 "orgtree_message")
            elif body.tool == "orgtree_audience":
                action = a.get("action", "")
                if action == "request":
                    result = org.request_audience(body.node, a.get("target", ""),
                                                  a.get("reason", ""))
                elif action == "forward":
                    result = org.audience_forward(body.node, a.get("from", ""),
                                                  a.get("target", ""))
                elif action == "grant":
                    result = org.audience_grant(body.node, a.get("from", ""),
                                                a.get("target") or None)
                elif action == "deny":
                    result = org.audience_deny(body.node, a.get("from", ""),
                                               a.get("target", "") or body.node)
                elif action == "revoke":
                    result = org.audience_revoke(body.node, a.get("grantee", ""))
                else:
                    raise LedgerError("action must be request|forward|grant|deny|revoke")
                drive.extend(result.pop("drive", []))
            elif body.tool == "orgtree_interrupt":
                # ⏸ in isolation — the agent stays live and is not archived,
                # so (unlike retire/dissolve above) this fires and returns:
                # no wait for the turn boundary to settle, matching the
                # existing UI ⏸ control's own behavior exactly. Any queued
                # D-234 model switch, or queued mail, applies/delivers at the
                # boundary the interrupted turn's own `finally` reaches
                # right after this call returns — that boundary is
                # unconditional (interrupt_turn.__doc__), so this is never a
                # second, competing way to end a turn.
                _int_node = str(a.get("node") or "")
                org.node(_int_node)     # 422s a bogus target before it acts
                org._require_authority(body.node, _int_node)
                result = supervisor.interrupt_turn(body.org, _int_node)
            elif body.tool == "orgtree_unstick":
                _unstick_node = str(a.get("node") or "")
                org.node(_unstick_node)
                org._require_authority(body.node, _unstick_node)
                result = org.unstick(body.node, _unstick_node)
                if result.get("released"):
                    unstick_resume = (
                        _unstick_node,
                        [str(x) for x in result.get("resume_texts") or []],
                        [str(x) for x in result.get("resume_views") or []],
                    )
            else:
                raise LedgerError(f"unknown orgtree tool {body.tool!r}")
            # a verb whose result ROUTED to a superior as mail (an ask or a
            # scope request without a user audience) drives them like any
            # other delivery. ⚠ This block used to sit INSIDE the
            # orgtree_present branch — present_document never returns
            # `routed`, so a routed QUESTION never drove its superior: the
            # mail sat until something else woke them (found 2026-08-12
            # while wiring request_scope; moved to the chain tail so every
            # routed verb, present and future, gets the same drive).
            if isinstance(result, dict):
                routed = result.get("routed")
                if routed and not result.get("deferred"):
                    drive.append(str(routed))
            _kiosk_cap_check(org)
        except LedgerError as e:
            # D-160: everything inside this block is discarded with the
            # unsaved doc, so "refused" normally means "nothing happened".
            # The ONE exception is a rehire's rename, which already ran above
            # and outside any transaction — say so plainly, and name the id to
            # retry against, rather than letting the caller retry under a name
            # that no longer exists and meet a baffling "no such node".
            if _renamed_to:
                raise HTTPException(
                    422, f'{e}  ⚠ The RENAME already happened and cannot be '
                         f'undone here: the node is still archived, now named '
                         f'"{_renamed_to}". Nothing else was applied and it '
                         f'was not started — retry against "{_renamed_to}", '
                         f'without `name`.')
            raise HTTPException(422, str(e))
        if _rcpt is not None:
            # the LAST thing before the save, so the receipt and the effect it
            # describes are ONE transaction: both commit or neither does
            _op_file(org, body, a, _rcpt, result)
        store.save_org(org)
        if _rcpt is not None:
            # AFTER the save returned, still under the lock: this process has
            # now committed this seq, and a document that later comes back
            # below it is a rewind (opreceipts.witness)
            opreceipts.witness(store.DATA_ROOT, body.org,
                               opreceipts.seq(cast("dict[str, Any]", org.d)))
    if unstick_resume is not None:
        _target, _texts, _views = unstick_resume
        _texts = _texts or [
            "(orgtree) Your superior manually UNSTUCK you. Handle any mail "
            "above and continue."
        ]
        for i, _text in enumerate(_texts):
            supervisor.send_message(
                body.org, _target, _text, mail_ping=True, sender=body.node,
                ping_reason="unstuck",
                view=_views[i] if i < len(_views) else _text)
        supervisor.notify(body.org, _target, "turn_started")
    if smoke_req is not None:
        # FAIL LOUDLY AT CREATE TIME (2026-08-22). Arming a dog used to tell
        # the agent nothing about whether its target actually works, so a
        # command that never even STARTED — cmd.exe answering "'grep' is not
        # recognized", every 60s, for nine days — was indistinguishable from
        # a condition that had not happened yet. Three dogs on this machine
        # died that way. Running the target once, here, through the SAME
        # `_wd_popen` the engine uses, would have made every one of them
        # obvious in five seconds; that is the cheapest diagnostic in the
        # subsystem, so we spend the five seconds.
        #
        # It runs outside DOC_LOCK on purpose: it waits seconds on a real
        # child, and that lock is every org's doc.
        try:
            # named, not *unpacked: `wd_smoke`'s 6th positional is `timeout`,
            # and passing the shell into it would silently give every smoke
            # run a nonsense deadline
            s_owner, s_kind, s_tgt, s_pat, s_shell = smoke_req
            smoke = supervisor.wd_smoke(org, s_owner, s_kind, s_tgt, s_pat,
                                        shell_pref=s_shell)
            result["smoke"] = smoke
            if smoke.get("broken"):
                result["status"] = (
                    "⚠ ARMED BUT ITS TARGET DOES NOT WORK — see `smoke`. "
                    "This dog will sit `armed, fired: 0` forever, which "
                    "looks exactly like the condition never happening. Fix "
                    "the target and re-create it. " + str(result.get("status") or ""))
        except Exception as e:                                   # noqa: BLE001
            # a create must not fail because its smoke run did — but say so,
            # rather than return a silent absence of evidence
            result["smoke"] = {"error": f"smoke run failed: {e}"}
    if body.tool in ("orgtree_retire", "orgtree_dissolve", "orgtree_rename",
                     "orgtree_cheap_compact"):
        # FR-01 (redteam): agents removing/re-keying seats must not orphan a
        # running remote-control server either
        supervisor.remote_reap(body.org)
    for target in drive:
        r = supervisor.send_message(
            body.org, target,
            "(orgtree) You have new mail above — handle it as appropriate, and use "
            "orgtree_status when your own task state changes.", mail_ping=True,
            sender=body.node,
            # the one target this loop can NAME the reason for: the recipient
            # of an orgtree_message. Every other tool's drive is unstated (null)
            ping_reason="agent_mail" if target == mail_to else None)
        # ⭐ D-236: SAY WHICH CARRIER THE MESSAGE IS ON. This loop used to
        # discard `r` entirely, so `orgtree_message` answered
        # {"delivered": …, "deferred": false} whether the recipient read it in
        # 200 ms or would not read it for five minutes — and `deferred` only
        # ever meant "the recipient is archived", so nothing in that answer
        # was a receipt. The `orgtree_send_notice` branch below has reported
        # its carrier since it was written; a message is the send that ACTS on
        # the answer, and it was the one flying blind.
        if target == mail_to and isinstance(result, dict):
            result["delivery"] = supervisor.delivery_note(body.org, target, r)
    for target in stale_freeze_resumed:
        # a provider crossing cleared this node's freeze (it described the
        # provider it just left) — wake it now, rather than leaving it
        # "live" but idle until something else happens to message it. If
        # the new provider is ALSO out of capacity, this turn simply
        # re-freezes it for that provider's own reason.
        supervisor.send_message(
            body.org, target,
            "(orgtree) You were frozen by a usage limit, connection problem, "
            "or rejected credential on your PREVIOUS provider — a model "
            "switch has moved you to a different provider, so that freeze "
            "no longer describes anything and has been cleared. Handle any "
            "mail above and continue.", mail_ping=True,
            ping_reason="unfrozen_by_switch")
    # A NEW PARTICIPANT IS TOLD, NOT WOKEN (user 2026-09-06): whichever tool
    # added it (orgtree_work create/participants, orgtree_staff create),
    # the ledger posted a notice and named the member in `noticed`.
    # Membership is not assignment, so it rides the send_notice path
    # below — a running recipient is steered, an idle one stays idle —
    # and never the drive. An archived member (noticed_deferred) is not
    # nudged at all.
    if isinstance(result, dict) and result.get("noticed"):
        _deferred = set(result.get("noticed_deferred") or [])
        for _n in [str(x) for x in result["noticed"] if x]:
            mail_notify(body.org, body.node, _n)
            if _n not in noticed_nodes and _n not in _deferred:
                noticed_nodes.append(_n)
    if notice_to is not None:
        # wake=False: steer a running recipient so the notice arrives
        # mid-task like any mail would, but an idle one stays idle — the
        # notice waits in the mailbox for whatever turn comes next
        r = supervisor.send_message(
            body.org, notice_to,
            "(orgtree) A notice arrived in your mail above — informational, "
            "no reply expected. Note it and continue your current task.",
            wake=False, mail_ping=True, sender=body.node, ping_reason="notice")
        if isinstance(result, dict):
            # D-236: one wording for every send. This branch has always named
            # its carrier; what it could not say was that "steered into the
            # recipient's running turn" is an ACCEPTANCE, not a read — and how
            # long the recipient has been without an injection point.
            result["delivery"] = supervisor.delivery_note(
                body.org, notice_to, r)
    for _n in noticed_nodes:
        # same wake=False steer as a send_notice: the participation notice
        # reaches a running recipient mid-task and waits for an idle one
        r = supervisor.send_message(
            body.org, _n,
            "(orgtree) A notice arrived in your mail above — you were added "
            "as a participant on a docket item. Informational, no reply "
            "expected. Note it and continue your current task.",
            wake=False, mail_ping=True, sender=body.node,
            ping_reason="participation")
        if isinstance(result, dict):
            result.setdefault("notice_delivery", {})[_n] = \
                supervisor.delivery_note(body.org, _n, r)
    if org_send is not None:
        err = supervisor.interorg_send(body.org, org_send[0], org_send[1])
        if err:
            result.setdefault("warnings", []).append(f"not delivered: {err}")
    if net_send:
        # F-06: the spool entry is persisted — wake the sender daemon; the
        # agent's result already reflects "queued", never a network wait
        net.kick()
        if isinstance(result, dict):
            result.setdefault("warnings", []).append(
                "queued for the mail hub — delivery states (sent/delivered/"
                "read) appear on the org inbox entry")
    if isinstance(result, dict):
        # the bridge is an ADMIN affordance (ceiling spec §1) — an agent has
        # no path to raise the ceiling, so the offer never reaches one
        result.pop("bridge", None)
        _attach_ref(body.org, body.tool, result)
    hub_changed(body.org)
    return result


_UPLOAD_MAX = 25 * 1048576          # per file
_UPLOAD_KIOSK_TOTAL = 256 * 1048576  # per node uploads dir, kiosk orgs


@app.post("/api/orgs/{slug}/nodes/{nid}/upload")
async def node_upload(slug: str, nid: str, request: Request,
                      name: str = "") -> dict[str, Any]:
    """Attach a file to a chat (user spec 2026-07-31): the raw request body
    lands in the node's scratch under uploads/ — the one folder every agent,
    sandboxed or not, reaches at the same RELATIVE path (its cwd). Reachable
    through the public kiosk gateway too: outside-internet visitors can hand
    files to a kiosk org's agents. No multipart dependency — body is the file."""
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    if org.d.get("storage_blocked"):
        raise HTTPException(413, "the org is over its storage limit — uploads "
                                 "are paused until files are deleted (the "
                                 "block lifts automatically)")
    safe = re.sub(r"[^\w .()+\-]", "_",
                  os.path.basename(name or "upload.bin")).strip(" .") or "upload.bin"
    data = await request.body()
    if not data:
        raise HTTPException(422, "empty upload")
    if len(data) > _UPLOAD_MAX:
        raise HTTPException(413, f"file exceeds the {_UPLOAD_MAX // 1048576} MB "
                                 f"upload cap")
    updir = os.path.join(supervisor.scratch_dir(slug, nid), "uploads")
    os.makedirs(updir, exist_ok=True)
    if supervisor.kiosk_cfg(org):
        total = 0
        for f in os.listdir(updir):
            try:
                total += os.path.getsize(os.path.join(updir, f))
            except OSError:
                pass
        if total + len(data) > _UPLOAD_KIOSK_TOTAL:
            raise HTTPException(413, "this agent's upload space is full — ask "
                                     "it to clean up uploads/ first")
    stem, ext = os.path.splitext(safe)
    # a filename the host refuses is an OSError from the write below, i.e. a
    # 500: Windows caps one path COMPONENT at 255 chars, and `?name=` is
    # attacker-supplied. Bound it here, leaving room for the `-2` de-dupe.
    stem, ext = (stem[:120] or "upload"), ext[:20]
    safe = stem + ext
    final, i = safe, 2
    while os.path.exists(os.path.join(updir, final)):
        final, i = f"{stem}-{i}{ext}", i + 1
    try:
        with open(os.path.join(updir, final), "wb") as f:
            f.write(data)
    except OSError as e:
        # ENOSPC on a full org disk, or a name the filesystem still refuses
        raise HTTPException(422, f"could not store the upload: {e}")
    return {"path": f"uploads/{final}", "bytes": len(data)}


# the return direction (user spec 2026-07-31): uploads/ is user→agent,
# outbox/ is agent→user — orgtree_send_file snapshots a file there and the
# chat renders a download card pointing at the /file endpoint below.
_SENDFILE_MAX = 256 * 1048576


def _require_net_peer(target: str) -> None:
    """User ruling 2026-08-12: a @net: send REFUSES when the recipient does
    not exist on any connected hub's roster — a spool entry addressed to
    nobody sits 'queued' forever, which is the @ext: black-hole class the
    2026-08-05 ruling killed. The check reads the net daemon's local roster
    cache (offline-cheap, no hub round trip); an empty cache — hub down
    since boot — refuses too, and says so."""
    if not net.probe_peer(target):
        peers = {str(p.get("slug") or "").removeprefix("@net:")
                 for p in net.remote_peers()}
        peers.discard("")
        hint = ", ".join(sorted(peers)[:8])             or "none known (is the hub reachable?)"
        raise LedgerError(
            f"no such recipient on the mail hub: {target!r} — nothing would "
            f"ever deliver it. Known peers: {hint}.")


def _outbox_snapshot(org: Org, nid: str, raw: str, *,
                     max_bytes: int = _SENDFILE_MAX,
                     always_copy: bool = False,
                     html_bundle: bool = False) -> tuple[str, int]:
    """Resolve `raw` as the NODE sees it, prove the node may reach it, and
    copy it into the node's outbox/ — the orgtree_send_file rule, shared with
    present-by-path (HTML mockups, 2026-09-06) so both verbs have ONE
    containment boundary. Returns (outbox-relative posix name, byte size).
    Copy, not reference: the card keeps working after the agent edits or
    deletes the original (re-sending an updated file yields report-2.pdf —
    both cards stay honest). Outbox lives in scratch, so kiosk storage
    metering already counts it and org deletion sweeps it.

    A source ALREADY in outbox/ is referenced as-is for send_file (its
    download card names the file the agent put there). `always_copy` is
    present-by-path's opt-in: a mockup card promises a snapshot, so even an
    outbox/ source gets its own dedupe-named copy — otherwise editing
    outbox/x.html after presenting it would silently change a published
    card (feature-astra review, 2026-09-06)."""
    slug = org.d["slug"]
    scratch = os.path.realpath(supervisor.scratch_dir(slug, nid))
    p = raw.replace("\\", "/").rstrip("/")
    if sandbox.is_sandboxed(org):
        # sandboxed agents know only container paths — translate the three
        # bind-mounted trees (workspace, scratch, the container home);
        # anything else genuinely does not exist on the host
        cw = sandbox.cpath_workspace(slug)
        cs = f"{sandbox.cpath_data()}/scratch/{slug}"
        ch = "/home/agent"
        host_ws = org.d.get("workspace") or store.workspace_dir(slug)
        if p == cw or p.startswith(cw + "/"):
            src = os.path.normpath(host_ws + p[len(cw):])
        elif p == cs or p.startswith(cs + "/"):
            src = os.path.normpath(store.scratch_root(slug) + p[len(cs):])
        elif p == ch or p.startswith(ch + "/"):
            src = os.path.normpath(sandbox.sandbox_home(slug) + p[len(ch):])
        elif not p.startswith("/"):
            src = os.path.normpath(os.path.join(scratch, p))
        else:
            raise LedgerError(
                f"{raw} exists only inside the container — copy it into your "
                f"working folder or the workspace first, then send that path")
    else:
        src = os.path.normpath(p if os.path.isabs(p)
                               else os.path.join(scratch, p))
    src = os.path.realpath(src)
    # capability honesty (№30's sibling): only trees the node holds are
    # sendable — its own scratch, the org workspace, its granted folders.
    # realpath first, so a symlink cannot smuggle an outside file in.
    roots = [scratch]
    if org.d.get("workspace"):
        roots.append(os.path.realpath(org.d["workspace"]))  # type: ignore[arg-type]  # guard above proves non-None
    for d in org.node(nid)["scope"]["add_dirs"]:
        roots.append(os.path.realpath(d["path"]))
    if sandbox.is_sandboxed(org):
        roots.append(os.path.realpath(sandbox.sandbox_home(slug)))
    # rstrip: a drive-root grant realpaths to "C:\" and the naive
    # `r + os.sep` doubled the separator, refusing everything under it;
    # normcase: Windows trees differing only in case are the same tree
    src_key = os.path.normcase(src)
    if not any(src_key == (b := os.path.normcase(r).rstrip("\\/"))
               or src_key.startswith(b + os.sep) for r in roots):
        raise LedgerError(
            f"cannot send {raw} — only files in your working folder, the "
            f"workspace, or a folder you hold are sendable")
    if not os.path.isfile(src):
        raise LedgerError(f"no such file: {raw}")
    size = os.path.getsize(src)
    if size == 0:
        raise LedgerError(f"{raw} is empty — nothing to send")
    if size > max_bytes:
        raise LedgerError(f"{raw} is {size // 1048576} MB — over the "
                          f"{max_bytes // 1048576} MB cap")
    if org.d.get("storage_blocked"):
        raise LedgerError("the org is over its storage limit — the outbox "
                          "copy is paused; delete files to lift the block, "
                          "then re-send")
    outdir = os.path.join(scratch, "outbox")
    new_outdir = not os.path.isdir(outdir)
    try:
        os.makedirs(outdir, exist_ok=True)
        if html_bundle:
            from .artifact_downloads import snapshot_html_bundle, ArtifactDownloadError
            permitted = [r for r in roots if src_key == os.path.normcase(r).rstrip("\\/")
                         or src_key.startswith(os.path.normcase(r).rstrip("\\/") + os.sep)]
            grant_root = max(permitted, key=len)
            destination = os.path.join(outdir, "presentation-" + uuid.uuid4().hex)
            try:
                snapshot = snapshot_html_bundle(src, destination, grant_root,
                                                destination_root=scratch, max_bytes=_SENDFILE_MAX)
            except ArtifactDownloadError as exc:
                raise LedgerError(str(exc)) from exc
            return snapshot.file.removeprefix("outbox/"), snapshot.bytes
        if new_outdir:
            # backend-minted = root-owned inside a sandbox — the agent is then
            # TOLD its file is in outbox/ and finds a dir it cannot write
            # (live bug 2026-08-04, kiosk `vnuser`)
            sandbox.chown_agent(org, nid)
        if not always_copy and src.startswith(os.path.realpath(outdir) + os.sep):
            final = os.path.relpath(src, outdir).replace("\\", "/")
        else:
            safe = re.sub(r"[^\w .()+\-]", "_",
                          os.path.basename(src)).strip(" .") or "file.bin"
            stem, ext = os.path.splitext(safe)
            final, i = safe, 2
            while os.path.exists(os.path.join(outdir, final)):
                final, i = f"{stem}-{i}{ext}", i + 1
            shutil.copy2(src, os.path.join(outdir, final))
    except OSError as e:
        # e.g. the storage block's deny-ACE landing between check and copy
        raise LedgerError(f"outbox copy failed: {e}")
    return final, size


#: present-html-mockups-in-a-new-browser-tab (2026-09-06): a self-contained
#: page with inline CSS/JS and base64 images is the point, so the cap is well
#: above the 64 KB markdown reading cap — and well below the send cap, because
#: the whole file is inlined into one wrapper response on every open.
_MOCKUP_MAX = 4 * 1048576
_MOCKUP_EXT = re.compile(r"\.html?$", re.I)


def _agent_present(org: Org, nid: str, a: dict[str, Any]) -> dict[str, Any]:
    """orgtree_present. `body` = markdown, read in-page (FR-03). `path` = a
    self-contained HTML mockup (2026-09-06): the file is snapshotted into the
    node's outbox/ by the orgtree_send_file rule — same containment, same
    copy-not-reference — and the ledger records the snapshot's name, never
    the bytes. Exactly one of the two. The bytes reach the user only through
    the mockup wrapper route (document_mockup), sandboxed."""
    raw = _no_nul(str(a.get("path") or "")).strip()
    title = a.get("title") or ""
    md = a.get("body") or ""
    if not raw:
        return org.present_document(nid, title, md, a.get("replaces"))
    if str(md).strip():
        raise LedgerError("an HTML mockup takes `path` OR `body`, not both")
    if not _MOCKUP_EXT.search(raw):
        raise LedgerError(
            f"only a .html/.htm file may be presented by path — {raw} is "
            f"not one. Markdown goes in `body`; any other file is a "
            f"download (orgtree_send_file)")
    # the ledger gate (live node, audience, headless, title) runs BEFORE the
    # copy, so a refused present leaves no outbox residue behind
    org.present_gate(nid, title)
    final, size = _outbox_snapshot(org, nid, raw, max_bytes=_MOCKUP_MAX,
                                   always_copy=True, html_bundle=True)
    return org.present_document(nid, title, "", a.get("replaces"),
                                html_file=f"outbox/{final}", html_bytes=size)


def _agent_send_file(org: Org, nid: str, a: dict[str, Any]) -> dict[str, Any]:
    """orgtree_send_file: snapshot the file into outbox/ (see
    _outbox_snapshot) and describe the card the chat will render."""
    raw = _no_nul(str(a.get("path") or "")).strip()
    if not raw:
        raise LedgerError("path is required — the file to deliver")
    final, size = _outbox_snapshot(org, nid, raw)
    sent = {"name": os.path.basename(final), "path": f"outbox/{final}",
            "bytes": size}
    note = " ".join(str(a.get("note") or "").split())[:300]
    if note:
        sent["note"] = note
    # image files render inline in the chat card (user spec 2026-08-25) — the
    # hint says which of the two things the user is actually looking at
    if re.search(r"\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$", final, re.I):
        return {"sent": sent,
                "hint": "delivered — the image renders viewable in your "
                        "chat (the user can click it full-size or download "
                        "it); announce it in your reply or report"}
    return {"sent": sent,
            "hint": "delivered — the user sees a download card in your chat; "
                    "announce the file in your reply or report"}


@app.get("/api/orgs/{slug}/nodes/{nid}/file")
def node_file(slug: str, nid: str, path: str = "") -> FileResponse:
    """Raw download of a file in the node's scratch — outbox/ cards, uploads/,
    anything the files tab lists. Org-scoped GET, so the kiosk public gateway
    passes it through: visitors download what agents send back."""
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    base = os.path.realpath(supervisor.scratch_dir(slug, nid))
    full = os.path.realpath(os.path.join(base, _no_nul(path).lstrip("/\\")))
    if not full.startswith(base + os.sep):
        raise HTTPException(422, "path escapes the scratch space")
    if not os.path.isfile(full):
        raise HTTPException(404, f"no such file: {path!r}")
    return FileResponse(full, filename=os.path.basename(full))


# ------------------------------------------------ the org disk (recovery browser)
# The user verdict's built-in file browser over the org's virtual disk — its
# OWN surface, deliberately NOT /api/fs (that is the HOST browser and stays in
# the public deny list). Org-scoped routes, so the kiosk gateway's slug check
# scopes visitors to their own org's disk for free. Reads and deletes go over
# \\wsl.localhost and work with the container STOPPED and the disk 100% FULL
# (drilled, not assumed); enumeration runs INSIDE the distro (9p is too slow).

# engine credential/state files on the disk (subscription auth copies the
# HOST's OAuth credentials into the sandbox home) — never served to visitors
# ⚠ `.bridge` is not an engine file — orgtree writes it itself
# (sandbox.py: `{home}/orgtree/.bridge` = {"url", "secret"}), and it holds the
# org's SANDBOX BRIDGE SECRET. The bridge listener binds 0.0.0.0, so a visitor
# who downloads this file gets: the /api/agent gateway this very matrix
# freezes for the public (acting as ANY node of the org), the node steer
# fetch, and the /anthropic proxy — which attaches the HOST's subscription
# token. Verified reachable at GET …/disk/file?path=home/orgtree/.bridge.
_PUBLIC_DISK_DENY = (".credentials.json", ".claude.json", ".bridge")
#: how much of a file a visitor download scans for this org's bridge secret.
#: 256 KiB covers any plausible copy of a credential file while costing one
#: read; see disk_file for why the name check alone is not a boundary.
_SECRET_SCAN_BYTES = 262144
_SID_FILE = re.compile(r"^home/\.claude/projects/[^/]+/([0-9a-f-]{36})\.jsonl$")


def _disk_org(slug: str) -> Org:
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    if not org.d.get("disk"):
        raise HTTPException(409, "this org has no virtual disk (not sandboxed, "
                                 "or not yet migrated)")
    return org


def _disk_rel(slug: str, path: str) -> tuple[str, str]:
    """(relative posix path, absolute windows path) — canonicalized, with
    containment ASSERTED before any read/download/unlink. A traversal here
    would reach the host filesystem from a kiosk URL: the worst outcome
    available in this feature, so both a lexical and a realpath check."""
    rel = posixpath.normpath(_no_nul(path or "").replace("\\", "/").strip("/"))
    if not rel or rel == "." or rel == ".." or rel.startswith("../") \
            or rel.startswith("/") or ":" in rel:
        raise HTTPException(422, "path escapes the org disk")
    from . import disk as dsk
    root = dsk.windows_path(slug)
    full = os.path.join(root, *rel.split("/"))
    if os.path.realpath(full) != full and not os.path.realpath(full).startswith(
            os.path.realpath(root) + os.sep):
        raise HTTPException(422, "path escapes the org disk")
    return rel, full


_SEED_ROOTS = ("usr", "var", "etc", "opt", "root", "srv")


def _disk_classify(org: Org, rel: str, public: bool) -> tuple[str, str | None]:
    """The verdict's deletion policy. reclaimable = freely deletable and
    POSITIVELY dead weight; blocked = shown, delete refused, with the reason;
    content = ordinary agent output. System-seed paths are blocked in BOTH
    modes (explorer follow-up): deleting /usr content bricks the container —
    but they are SHOWN, because '4 GB cap, 1.2 GB of it /usr' answers "where
    did my space go" better than any text."""
    if rel.split("/", 1)[0] in _SEED_ROOTS:
        return "blocked", "system seed — the image's own files"
    m = _SID_FILE.match(rel)
    if m:
        sid = m.group(1)
        for nid, n in org.nodes.items():
            if n.get("session_id") == sid:
                if n.get("bearer_state") == "lost":
                    return "reclaimable", (f"lost generation {nid} — never "
                                           f"consultable or rehirable again")
                if n["state"] == "live":
                    return "blocked", (f"live session of {nid} — deleting "
                                       f"breaks its resume")
                if n.get("bearer_state"):
                    return "blocked", (f"knowledge bearer {nid} — deleting "
                                       f"kills its oracle")
                return "blocked", (f"archived node {nid} — deleting breaks "
                                   f"its rehire")
        return "reclaimable", "no node owns this session"
    if rel.rsplit("/", 1)[-1] in _PUBLIC_DISK_DENY:
        if public:
            return "blocked", "credential/secret file"
        return "content", "credential/secret file — admin-side only"
    return "content", None


@app.get("/api/orgs/{slug}/disk")
def disk_list(slug: str, request: Request, offset: int = 0,
              limit: int = 200) -> dict[str, Any]:
    """Files by size DESCENDING (the sort that matters when freeing space
    fast) + the live usage readout. Paginated — never the whole tree."""
    org = _disk_org(slug)
    public = bool(_public_slug(request))
    from . import disk as dsk
    try:
        du = dsk.usage(slug, max_age=5.0)
        files = dsk.enumerate_by_size(slug, limit=max(1, min(limit, 500)),
                                      offset=max(0, offset))
    except dsk.DiskError as e:
        raise HTTPException(503, str(e))
    for f in files:
        cls, why = _disk_classify(org, str(f["path"]), public)
        f["class"] = cls
        if why:
            f["reason"] = why
    return {"used": du[0] if du else None, "total": du[1] if du else None,
            "blocked": bool(org.d.get("storage_blocked")),
            "full": bool(org.d.get("storage_full")),
            # admin-only nudge: org disks are SPARSE, the VM cap is the
            # aggregate wall — None = unset on the host
            **({} if public else {
                "vm_cap_mib": sandbox.vm_disk_cap_mib(),
                "size_mb": int((org.d.get("disk") or {}).get("size_mb") or 0),
                "pending_mb": (org.d.get("disk") or {}).get("pending_size_mb"),
            }),
            "files": files, "offset": max(0, offset),
            "limit": max(1, min(limit, 500))}


def _disk_classify_dir(org: Org, rel: str, public: bool,
                       protected: list[str]) -> tuple[str, str | None]:
    """Directory classes for the explorer: seed dirs blocked; a dir whose
    subtree holds protected transcripts is blocked WHOLE (half-deleting a
    tree because a protected file sat in it is the worst outcome here)."""
    if rel.split("/", 1)[0] in _SEED_ROOTS:
        return "blocked", "system seed — the image's own files"
    hits = sum(1 for p in protected if p.startswith(rel + "/"))
    if hits:
        return "blocked", f"contains {hits} protected session transcript(s)"
    return "content", None


def _protected_transcripts(org: Org, slug: str, public: bool) -> list[str]:
    """Transcript files whose deletion is refused — from the cached walk, so
    this costs nothing beyond the walk both views already share."""
    from . import disk as dsk
    return [p for p, _sz in dsk.subtree_files(slug, "home")
            if _SID_FILE.match(p)
            and _disk_classify(org, p, public)[0] == "blocked"]


@app.get("/api/orgs/{slug}/disk/dir")
def disk_dir(slug: str, request: Request, path: str = "") -> dict[str, Any]:
    """Explorer mode: ONE directory level, entries intermixed by size
    descending (deliberate deviation from folders-first — the view exists
    for size triage). Served from the cached single walk; works with the
    container stopped, same as everything on this surface."""
    org = _disk_org(slug)
    public = bool(_public_slug(request))
    rel = ""
    if path.strip("/"):
        rel, _full = _disk_rel(slug, path)
    from . import disk as dsk
    try:
        entries = dsk.list_dir(slug, rel)
        protected = _protected_transcripts(org, slug, public)
        du = dsk.usage(slug, max_age=5.0)
    except dsk.DiskError as e:
        raise HTTPException(503, str(e))
    for e in entries:
        p = str(e["path"])
        cls, why = (_disk_classify_dir(org, p, public, protected)
                    if e["dir"] else _disk_classify(org, p, public))
        e["class"] = cls
        if why:
            e["reason"] = why
    return {"path": rel, "entries": entries,
            "used": du[0] if du else None, "total": du[1] if du else None,
            "blocked": bool(org.d.get("storage_blocked")),
            "full": bool(org.d.get("storage_full")),
            **({} if public else {
                "vm_cap_mib": sandbox.vm_disk_cap_mib(),
                "size_mb": int((org.d.get("disk") or {}).get("size_mb") or 0),
                "pending_mb": (org.d.get("disk") or {}).get("pending_size_mb"),
            })}


@app.get("/api/orgs/{slug}/disk/file")
def disk_file(slug: str, request: Request, path: str = "") -> FileResponse:
    """Streaming download (FileResponse streams — a multi-GB file is never
    buffered). Visitors get everything except the engine credential files."""
    org = _disk_org(slug)
    rel, full = _disk_rel(slug, path)
    public = bool(_public_slug(request))
    cls, why = _disk_classify(org, rel, public)
    if cls == "blocked" and rel.rsplit("/", 1)[-1] in _PUBLIC_DISK_DENY:
        raise HTTPException(403, why or "not served publicly")
    if not os.path.isfile(full):
        raise HTTPException(404, f"no such file: {rel!r}")
    # ☠ A FILENAME denylist is not a boundary here, and the sandbox suite
    # proved it end to end: every sandboxed agent has passwordless root on the
    # org disk, so `cp ~/orgtree/.bridge workspace/notes.txt` renames the
    # secret out of the deny tuple and a kiosk visitor downloads it with a 200.
    # That secret opens /api/agent as ANY node of the org and the /anthropic
    # proxy, which attaches the HOST's subscription OAuth token — so this is
    # the whole sandbox boundary, defeated by a copy.
    #
    # Content is therefore checked as well as name, for visitors only: any file
    # carrying this org's bridge secret is refused whatever it is called. The
    # scan is bounded and cheap (both the 32-hex legacy root and the longer
    # frozen org token are small; a copied credential file is what this defends
    # against, not a token buried beyond 256 KiB in a multi-GB artifact).
    if public:
        credentials = bridgeauth.accepted_credentials(org)
        if credentials:
            try:
                with open(full, "rb") as f:
                    head = f.read(_SECRET_SCAN_BYTES)
                if any(secret.encode() in head for secret in credentials):
                    raise HTTPException(403, "credential/secret file")
            except OSError:
                pass          # unreadable: the FileResponse below reports it
    return FileResponse(full, filename=os.path.basename(full))


class DiskDelete(Body):
    paths: list[str]


@app.post("/api/orgs/{slug}/disk/delete")
def disk_delete(slug: str, body: DiskDelete, request: Request) -> dict[str, Any]:
    """Multi-select delete. Classification is enforced HERE, server-side —
    the UI's greying is presentation. Works at 100% full (unlink needs no
    free space on ext4 — drilled). Ends with the recovery loop: re-measure,
    and the existing storage_check clear path lifts the block/alert."""
    org = _disk_org(slug)
    public = bool(_public_slug(request))
    from . import disk as dsk
    results: list[dict[str, Any]] = []
    for p in body.paths[:500]:
        try:
            rel, full = _disk_rel(slug, p)
        except HTTPException as e:
            results.append({"path": p, "ok": False, "error": e.detail})
            continue
        if os.path.isdir(full):
            # directory delete (explorer mode): the class rules apply to the
            # WHOLE subtree and the operation is all-or-nothing — a protected
            # file anywhere in it refuses everything, never a partial delete
            seed_cls, seed_why = _disk_classify_dir(org, rel, public, [])
            if seed_cls == "blocked":
                results.append({"path": rel, "ok": False, "error": seed_why})
                continue
            subs = dsk.subtree_files(slug, rel, max_age=0.0)
            bad = [(sp, _disk_classify(org, sp, public)[1]) for sp, _s in subs
                   if _disk_classify(org, sp, public)[0] == "blocked"]
            if bad:
                results.append({"path": rel, "ok": False,
                                "error": f"subtree holds {len(bad)} protected "
                                         f"file(s) — first: {bad[0][1]}"})
                continue
            n_files, n_bytes, err = 0, 0, None
            try:
                for base, dirs, files in os.walk(full, topdown=False):
                    for f in files:
                        fp = os.path.join(base, f)
                        n_bytes += os.path.getsize(fp)
                        os.unlink(fp)
                        n_files += 1
                    for d in dirs:
                        os.rmdir(os.path.join(base, d))
                os.rmdir(full)
            except OSError as e:
                err = str(e)
            results.append({"path": rel, "ok": err is None,
                            "files": n_files, "bytes": n_bytes,
                            **({"error": err} if err else {})})
            continue
        cls, why = _disk_classify(org, rel, public)
        if cls == "blocked":
            results.append({"path": rel, "ok": False, "error": why})
            continue
        try:
            os.unlink(full)
            results.append({"path": rel, "ok": True})
        except OSError as e:
            results.append({"path": rel, "ok": False, "error": str(e)})
    dsk.invalidate(slug)
    supervisor.storage_check(slug)          # may auto-clear blocked/full
    du = dsk.usage(slug, max_age=0.0)
    org = store.load_org(slug)
    return {"results": results,
            "used": du[0] if du else None, "total": du[1] if du else None,
            "blocked": bool(org.d.get("storage_blocked")),
            "full": bool(org.d.get("storage_full"))}


class DiskResize(Body):
    size_mb: int | None = None
    cancel: bool = False       # one-click cancel of a pending shrink (ruled)


def _disk_doc_update(slug: str, **kv: Any) -> None:
    with store.DOC_LOCK:
        o2 = store.load_org(slug)
        d = dict(o2.d.get("disk") or {})
        for k, v in kv.items():
            if v is None:
                d.pop(k, None)
            else:
                d[k] = v
        o2.d["disk"] = d
        store.save_org(o2)


@app.post("/api/orgs/{slug}/disk/resize")
def disk_resize(slug: str, body: DiskResize, request: Request) -> dict[str, Any]:
    """Resize, ADMIN only (it spends/reshapes host disk). GROW applies
    online, immediately, and CLEARS any pending shrink outright (ruled — a
    grow can always apply now). SHRINK becomes a PENDING request persisted
    in the org doc: it applies at the next moment this org's container is
    down (or via /disk/resize/apply), and the UI shows requested vs actual
    until then. A shrink below current usage is refused HERE with the MB to
    free — the same refuse-not-guess rule the apply path enforces."""
    if _public_slug(request):
        raise HTTPException(403, "admin side only")
    org = _disk_org(slug)
    from . import disk as dsk
    d = dict(org.d.get("disk") or {})
    cur = int(d.get("size_mb") or 0)
    if body.cancel:
        _disk_doc_update(slug, pending_size_mb=None)
        return {"size_mb": cur, "pending_mb": None}
    if body.size_mb is None:
        raise HTTPException(422, "size_mb required (or cancel: true)")
    want = int(body.size_mb)
    if want == cur:
        _disk_doc_update(slug, pending_size_mb=None)   # replace/no-op clears
        return {"size_mb": cur, "pending_mb": None}
    if want > cur:
        try:
            dsk.grow(slug, want)
        except dsk.DiskError as e:
            raise HTTPException(503, str(e))
        _disk_doc_update(slug, size_mb=want, pending_size_mb=None)
        supervisor.storage_check(slug)      # a grow may clear blocked/full
        du = dsk.usage(slug, max_age=0.0)
        return {"size_mb": want, "pending_mb": None,
                "used": du[0] if du else None, "total": du[1] if du else None}
    # shrink request: floor + live usage refusal, then stage it
    if want < 4096:
        raise HTTPException(422, "org disks have a 4096 MB minimum (the "
                                 "system seed and transcripts live inside "
                                 "the cap)")
    du = dsk.usage(slug, max_age=0.0)
    if du and du[0] > want * 1048576 * 0.9:
        need = int((du[0] - want * 1048576 * 0.9) / 1048576) + 1
        raise HTTPException(422, f"usage is {du[0] // 1048576} MB — free "
                                 f"about {need} MB before shrinking to "
                                 f"{want} MB")
    # a new request supersedes any earlier one (ruled: replaceable)
    _disk_doc_update(slug, pending_size_mb=want)
    return {"size_mb": cur, "pending_mb": want}


@app.post("/api/orgs/{slug}/disk/resize/apply")
def disk_resize_apply(slug: str, request: Request) -> dict[str, Any]:
    """The BRIDGE (ruled — a pending shrink the operator cannot trigger is a
    wall with a legal sequence behind it): briefly stops THIS org's agents,
    applies the pending shrink, and lets the container restart on the next
    turn. Never touches the backend or other orgs."""
    if _public_slug(request):
        raise HTTPException(403, "admin side only")
    org = _disk_org(slug)
    if not int((org.d.get("disk") or {}).get("pending_size_mb") or 0):
        raise HTTPException(422, "no pending resize")
    from . import disk as dsk
    sandbox.stop_container(slug)
    try:
        note = sandbox.try_apply_pending_resize(org)
    except (dsk.DiskError, RuntimeError) as e:
        raise HTTPException(503, str(e))
    if note:
        raise HTTPException(422, note)     # kept pending — says what to free
    org = store.load_org(slug)
    d = dict(org.d.get("disk") or {})
    du = dsk.usage(slug, max_age=0.0)
    return {"size_mb": int(d.get("size_mb") or 0), "pending_mb": None,
            "used": du[0] if du else None, "total": du[1] if du else None}


# ------------------------------------------- pre-migration backup sweep
def _du_native(path: str) -> int:
    """Host-dir size (native paths only — never point this at UNC)."""
    total = 0
    stack = [path]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return total


def _legacy_targets(slug: str) -> tuple[list[str], list[str]]:
    """(existing legacy volume names, existing host-dir copies) — the state
    the disk migration copied FROM and kept for rollback."""
    vols = [sandbox.sys_volume(slug, d)
            for d in ("usr", "var", "etc", "opt", "root", "srv")
            if subprocess.run(["docker", "volume", "inspect",
                               sandbox.sys_volume(slug, d)],
                              capture_output=True,
                              creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                                             if os.name == "nt" else 0)
                              ).returncode == 0]
    dirs = [p for p in (sandbox.sandbox_root(slug),
                        store.workspace_dir(slug), store.scratch_root(slug))
            if os.path.isdir(p)]
    return vols, dirs


@app.get("/api/orgs/{slug}/sweep-legacy")
def sweep_legacy_preview(slug: str, request: Request) -> dict[str, Any]:
    """What the pre-migration backup still costs — admin decides whether to
    drop the rollback. Refuses unless the org's disk is mounted and healthy
    (never delete the backup of a disk that can't prove it's alive)."""
    if _public_slug(request):
        raise HTTPException(403, "admin side only")
    org = _disk_org(slug)
    from . import disk as dsk
    if not dsk.is_mounted(org.d["slug"]):
        raise HTTPException(503, "the org disk is not mounted — not touching "
                                 "its rollback backup")
    vols, dirs = _legacy_targets(slug)
    vol_bytes = sandbox.sandbox_volumes_bytes(slug, max_age=0.0) or 0
    host_bytes = sum(_du_native(p) for p in dirs)
    return {"volumes": vols, "volumes_bytes": vol_bytes,
            "host_dirs": dirs, "host_bytes": host_bytes,
            "total_bytes": vol_bytes + host_bytes}


@app.post("/api/orgs/{slug}/sweep-legacy")
def sweep_legacy(slug: str, request: Request) -> dict[str, Any]:
    """Drop the rollback: legacy volumes + host-dir copies. Explicit admin
    action behind a preview + armed click in the UI — the data lives ON the
    org disk now; this deletes only the pre-migration copies."""
    if _public_slug(request):
        raise HTTPException(403, "admin side only")
    org = _disk_org(slug)
    from . import disk as dsk
    if not dsk.is_mounted(org.d["slug"]):
        raise HTTPException(503, "the org disk is not mounted — not touching "
                                 "its rollback backup")
    vols, dirs = _legacy_targets(slug)
    failures: list[str] = []
    if vols:
        r = subprocess.run(["docker", "volume", "rm", "-f", *vols],
                           capture_output=True, text=True, timeout=120,
                           creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                                          if os.name == "nt" else 0))
        if r.returncode != 0:
            failures.append((r.stderr or r.stdout)[-200:])
    for p in dirs:
        try:
            shutil.rmtree(p)
        except OSError as e:
            failures.append(f"{p}: {e}")
    return {"removed_volumes": vols, "removed_dirs": dirs,
            "failures": failures}


@app.get("/api/orgs/{slug}/nodes/{nid}/chat")
async def _node_chat_route(slug: str, nid: str, request: Request,
                           last: int = 300) -> dict[str, Any]:
    return await _run_chat_read(node_chat, slug, nid, request, last)


def node_chat(slug: str, nid: str, request: Request = cast(Request, None),
              last: int = 300) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    out = supervisor.read_chat(org, nid, last=max(1, min(last, 1000)))
    # queued = the mail box PLUS the delivery journal's in-flight batches —
    # a message steered mid-task drains the box instantly, and during a long
    # tool call it showed NOWHERE (user bug 2026-07-31)
    #
    # A batch drained INTO a turn is the same story one step later: the
    # mailbox no longer has it and the CLI has not echoed it into the
    # transcript yet, so it is surfaced until the transcript does. This is the
    # one place both halves are in hand, so the handover is decided here and
    # lands in ONE payload — the pending bubble goes and the durable @user
    # bubble arrives together, never a frame with neither (D-54).
    _seen_user = [(m.get("text") or "") for m in out["messages"]
                  if m.get("role") == "user"]

    def _in_transcript(m: Mapping[str, Any]) -> bool:
        """Is THIS mail entry already on screen as a transcript bubble?

        Identity, not resemblance. The transcript text is the `_mail_block`
        envelope wrapped around the body, and that envelope carries the
        entry's own `at` immediately before it —

            FROM @user (…) · message · 2026-08-04T04:27:08.545Z
            <body>

        — so the timestamp+body junction names one specific mail. Matching on
        the body alone would repeat D-52's mistake one layer down: re-send
        "continue" and the new entry would match the OLD bubble and be hidden
        while still in flight. No clock is compared, only a string this
        process itself wrote.

        ⚠ The body is used RAW. `_mail_block` writes `f"…· {at}\\n{m['body']}"`
        with no normalisation, so a stripped copy of a body that begins with
        whitespace does not occur in the transcript at all — the test then said
        "not on screen" forever and the pending bubble stayed up ALONGSIDE the
        durable one for the whole of the turn's first response (measured
        2026-08-04 on a real transcript sample: median 2.4 s, max 137 s). The
        composer trims, but nothing else does: the API takes `body.text` as
        sent, and agent mail routinely opens with a newline. Only the emptiness
        guard strips — and only where it must. With an `at` the marker is
        unique whatever the body is, so a whitespace-only message (nothing
        forbids one; only the composer trims) is identified like any other. It
        is only the legacy `at`-less entry that falls back to a bare body, and
        THAT needle must not be empty or it would match every bubble."""
        # the marker itself lives in `supervisor.mail_marker_in`, shared with
        # read_chat's `_covered_by_pending` (D-229): the stamp `· {at}` and
        # the head of the raw body, matched SEPARATELY, because a reply
        # snapshot or a notice header sits between them (review round 2 —
        # the adjacent needle missed both shapes and the bubble stayed up
        # beside the transcript row)
        return any(supervisor.mail_marker_in(t, m) for t in _seen_user)

    # ⚠ The same evidence test applies to the MAILBOX rows, not only the
    # journal's. `_fold_back_undelivered` re-queues a batch whose delivery was
    # never confirmed — correctly: it is the only thing that puts a
    # consumed-but-unanswered message back where the next envelope re-presents
    # it, so weakening the fold-back itself would buy one clean render at the
    # cost of the agent never being asked again. But when the CLI died AFTER
    # echoing the message into its transcript and BEFORE its first stdout
    # event, the returned row is one the transcript already shows, and the desk
    # rendered both — measured 2026-08-04, 22 of 32 samples, indefinitely.
    # Hiding it HERE removes the duplicate at the display layer and leaves
    # delivery untouched: the marker names one specific entry, so only a row
    # the transcript genuinely carries is dropped from the payload.
    pending = sorted(supervisor.delivering_mail(org, nid, _in_transcript)
                     + [m for m in (org.d.get("mail") or {}).get(nid, [])
                        if not _in_transcript(m)],
                     key=lambda m: m.get("at") or "")
    out["mail_pending"] = len(pending)
    # D-229: the impossible state, counted where the reader can see it. A
    # drained batch that no turn owns — not in flight in a turn's text, not
    # in the steer store of a responding turn, not queued behind a busy one,
    # and the node idle — is a message that will not move until something
    # unrelated happens. `delivering_mail` labels each row's `stage`; this
    # is the roll-up the tests and the desk read.
    out["mail_stranded"] = sum(1 for m in pending
                               if m.get("stage") == "stranded")
    # ⚠ NOT `pending[-20:]`. A fixed row cap on a list that only GROWS while
    # the agent cannot run is the same bug as everything else in this family:
    # the 21st queued message pushed the 1st off the payload, its ghost had
    # long since graduated against the very row that just vanished, and the
    # message was on screen nowhere (measured 2026-08-04: message #0 gone at
    # send #21, and it never comes back until a turn drains it). Every queued
    # message keeps a row; the payload is bounded by SHRINKING BODIES instead,
    # which costs a truncated preview rather than a missing message.
    #
    # Bodies shrink in tiers as the queue grows, so the payload stays bounded
    # (worst case ~200 KB at the 800-row backstop) without any message losing
    # its row. The floor must stay well above the client's graduation needle
    # (`serverCopies` compares the first 200 characters) or a shrunk body would
    # stop matching its own ghost and strand it — a duplicate.
    #
    # ⚠ Residual: past 800 undelivered mails the oldest do fall off. The live
    # mailbox is uncapped (`ledger.post_mail` caps `mail_log`, not `mail`), so
    # SOME backstop has to exist; 800 is far outside anything a user can type
    # and the tier floor keeps the payload survivable if an agent ever spams a
    # frozen node.
    n_pending = len(pending)
    body_cap = 2000 if n_pending <= 20 else 800 if n_pending <= 100 else 250
    pending = pending[-800:]
    _pub = _public_slug(request) is not None
    for msg in out.get("messages") or []:
        if isinstance(msg, dict) and msg.get("segments") is not None:
            msg["segments"] = events.wire_segments(msg["segments"], public=_pub)
    out["pending_mail"] = [{"id": m.get("id"), "from": m["from"],
                            "kind": m.get("kind") or "message",
                            **({"reply_to": m["reply_to"]} if m.get("reply_to") else {}),
                            **({"relationship": m["relationship"]}
                               if m.get("relationship") else {}),
                            "body": m["body"][:body_cap], "at": m["at"],
                            **{k: v for k, v in _row_out(m, public=_pub).items()
                               if k in ("ev", "ev_public", "ev_raw", "ev_error")},
                            **({"delivery": m["delivery"]} if m.get("delivery")
                               else {}),
                            **({"delivering": True} if m.get("delivering")
                               else {}),
                            # the two in-flight carriers read differently to a
                            # human: "mid-task" is only true of a steer
                            **({"via": "turn"} if m.get("via") == "turn"
                               else {}),
                            # D-229: the delivery receipt — WHERE the drained
                            # message is right now (turn / steer / queued),
                            # or `stranded` when no turn owns it
                            **({"stage": m["stage"]} if m.get("stage")
                               else {}),
                            **({"attachments": m["attachments"]}  # type: ignore[typeddict-item]  # guard proves the key
                               if m.get("attachments") else {})}
                           for m in pending]
    for _pending_row in out["pending_mail"]:
        _pending_row["event_id"] = (
            f"mail:{slug}:{nid}:{_pending_row.get('id') or 'unknown'}")
    return out


@app.delete("/api/orgs/{slug}/nodes/{nid}/reply-events")
def clear_reply_events(slug: str, nid: str) -> dict[str, Any]:
    """Explicit operator removal of retained reply quotes for one agent."""
    from . import reply_events
    with store.DOC_LOCK:
        org = store.load_org(slug)
        org.node(nid)
        count = reply_events.clear(org, nid)
    return {'removed':count}


@app.delete("/api/orgs/{slug}/nodes/{nid}/mail/{mid}")
async def node_mail_retract(slug: str, nid: str, mid: str) -> dict[str, Any]:
    """Parity №17: retract one UNDRAINED mail entry — the only correction
    channel for a wrong send, since delivery deliberately never interrupts."""
    with store.DOC_LOCK:
        try:
            org = store.load_org(slug)
            org.node(nid)
        except LedgerError as e:
            raise HTTPException(404, str(e))
        box = (org.d.get("mail") or {}).get(nid) or []
        kept = [m for m in box if m.get("id") != mid]
        if len(kept) == len(box):
            raise HTTPException(404, "no such pending mail — it may already "
                                     "have been delivered")
        org.d["mail"][nid] = kept  # type: ignore[typeddict-item]  # box non-empty ⇒ the key exists
        # mirror the retraction into the archive so the record stays honest
        log = (org.d.get("mail_log") or {}).get(nid) or []
        for m in log:
            if m.get("id") == mid:
                m["retracted"] = True
        store.save_org(org)
    await hub.changed(slug)
    return {"retracted": mid}


@app.get("/api/orgs/{slug}/nodes/{nid}/toolimg/{tool_use_id}")
def node_tool_image(slug: str, nid: str, tool_use_id: str, idx: int = 0) -> Response:
    """Parity №9 (image clause): serve a tool result's image by tool_use_id —
    a separate bounded fetch, never base64 inlined into the 5 s chat poll."""
    try:
        org = store.load_org(slug)
        n = org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    tpath = supervisor.transcript_path(n["session_id"],
                                       supervisor._transcript_root(org))
    if not tpath:
        raise HTTPException(404, "no transcript")
    import base64
    for line in open(tpath, encoding="utf-8", errors="replace"):
        if tool_use_id not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg: dict[str, Any] = rec.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for b in cast("list[Any]", content):
            blk = cast("dict[str, Any]", b)   # identity — typing only
            if not (isinstance(blk, dict) and blk.get("type") == "tool_result"
                    and blk.get("tool_use_id") == tool_use_id):
                continue
            imgs: list[dict[str, Any]] = [
                x for x in cast("list[Any]", blk.get("content") or [])
                if isinstance(x, dict)
                and cast("dict[str, Any]", x).get("type") == "image"]
            if idx < len(imgs):
                src: dict[str, Any] = imgs[idx].get("source") or {}
                if src.get("type") == "base64" and src.get("data"):
                    from fastapi.responses import Response
                    return Response(
                        content=base64.b64decode(src["data"]),
                        media_type=src.get("media_type", "image/png"))
    raise HTTPException(404, "no image on that tool result")


@app.get("/api/orgs/{slug}/nodes/{nid}/inbox")
def node_inbox(slug: str, nid: str, request: Request = cast(Request, None)) -> dict[str, Any]:
    """The node's OWN mailbox (user ruling: separate from the events/history
    view): mail still waiting for its next turn, plus recently delivered mail
    with full bodies (the event log keeps only a gist)."""
    try:
        org = store.load_org_snapshot(
            slug, ("mail_log", "user_mail_log"))
        org.node(nid)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    waiting = sorted(supervisor.delivering_mail(org, nid)
                     + list((org.d.get("mail") or {}).get(nid, [])),
                     key=lambda m: m.get("at") or "")
    keys = {(m["at"], m["from"], m["body"]) for m in waiting}
    delivered = [m for m in (org.d.get("mail_log") or {}).get(nid, [])
                 if (m["at"], m["from"], m["body"]) not in keys]
    # the node's Sent folder, mirrored from the recipients' archives
    sent: list[dict[str, Any]] = []
    logs: dict[str, list[MailEntry]] = org.d.get("mail_log") or {}
    for to, lst in logs.items():
        sent += [{**m, "to": to} for m in lst if m["from"] == nid]
    for m in org.d.get("user_inbox", []) + org.d.get("user_mail_log", []):
        if m["from"] == nid:
            sent.append({**m, "to": USER})
    sent.sort(key=lambda m: m["at"])
    # ⚠ `sent` IS MIRRORED FROM THE RECIPIENTS' ARCHIVES, so each row lives in
    # the RECIPIENT's box, not this node's — a reference built from `nid` here
    # would name a mail that is not there. Each sent row carries its own `to`,
    # so it addresses its own box.
    pub = _public_slug(request) is not None
    sent = _sent_refs(slug, sent, public=pub)
    return {"pending": _mail_refs(slug, "node", waiting, nid, public=pub),
            "delivered": _mail_refs(slug, "node", delivered[-50:], nid, public=pub),
            "sent": sent[-50:]}


@app.get("/api/orgs/{slug}/events")
def org_events(slug: str, request: Request, since: int = 0) -> dict[str, Any]:
    try:
        events = store.load_org(slug).d["events"]
    except LedgerError as e:
        raise HTTPException(404, str(e))
    out = list(events[since:])
    if _public_slug(request):
        out = _scrub_events(out)     # host paths ride event details/warnings
    return {"total": len(events), "events": out}


# ----------------------------------------------------------------------- ops
class Op(Body):
    op: str                       # hire|retire|rehire|dissolve|reallocate|promote|demote|revoke_dir
    actor: str = USER
    node: str | None = None       # target node (all but hire)
    parent: str | None = None     # hire target parent (None = top level)
    tier: str | None = None       # hire
    grant: int | None = None      # hire / rehire / reallocate delta via `delta`
    name: str | None = None       # hire
    charter: str | None = None    # hire — short standing role card
    add_dirs: list[Any] | None = None  # hire — [{path, mode}] or bare paths
    tools: dict[str, Any] | None = None  # hire — {bash, web, edit, subagents, mcp: []}
    # hire — @mcp:<peer> addresses the hire may answer directly from any depth
    # (per-address post_mail bypass, by=sender attribution); Prompt Wizard panels
    external_handles: list[str] | None = None
    # FR-25 insert-superior: hire + splice as ONE op — the fresh node takes
    # this anchor's slot among its siblings and the anchor is reparented
    # beneath it, all inside the same lock and save (a refusal anywhere rolls
    # the whole thing back). `parent` must be the anchor's own parent.
    above: str | None = None
    org_visibility: str | None = None
    effort: str | None = None     # hire — thinking effort, applied WITH the hire
    # hire — item 12: a luna's pool order (True = reserve first, the default;
    # False = plan first). Applied WITH the hire like effort; omitted = default.
    prefer_reserve: bool | None = None
    # reallocate. ⚠ FLOAT, not int, and the difference is a user-visible
    # outage: the credit bar rounds its TARGET to a whole number and sends
    # `target - grant`, so against a grant that is fractional for ANY reason
    # (a switch_model melt still makes one, by design — the node's holding
    # must not move) every delta it can compute is fractional and pydantic
    # refused the whole request with `int_from_float`. Measured 2026-09-04 on
    # the operator's 104.2 coordinator: 422 in BOTH directions, no dialog,
    # nothing in the event log — "it just fails outright". `reallocate`
    # itself has always been fraction-correct (it quantises every write), so
    # the int was the only thing standing in the way. This widens what the
    # door ACCEPTS, not what the ledger ALLOWS: the free-credit check, the
    # §4.6 chain acquire and the D-014 top-level cap all still run.
    delta: float | None = None
    new_parent: str | None = None  # promote / demote
    dir: str | None = None        # revoke_dir
    # ceiling spec §1: the one-action bridge — re-send the same op with this
    # set and an over-ceiling admin grant raises the ceiling to fit (logged,
    # named, never silent). Ignored for visitors: no legal raise path exists.
    raise_ceiling: bool = False


def provider_hire_gate(
    org: Org, tier: str | None, *, user_choice_only: bool = False,
) -> None:
    """FR-15 M4, the vision made checkable: a tier is hireable exactly while
    its provider's CLI is CONNECTED on this machine. Raises LedgerError (the
    ops/agent layers both turn that into a clean 422) NAMING the provider and
    the next step, in the order the user would take them.

    One gate for every provider-admission entry point, named so completeness
    is checkable instead of hidden behind a count:

      · user hire (`/api/orgs/{slug}/ops`),
      · agent hire (`orgtree_hire`),
      · user model switch (`switch_model` op),
      · agent model switch (`orgtree_switch_model`),
      · user rehire WITH a tier override,
      · user plain rehire on the archived node's stored tier, and
      · agent plain rehire (`orgtree_rehire`) on its stored tier.

    The two PLAIN rehire paths pass ``user_choice_only=True``. D-197 requires
    recovery to remain possible when an installed provider is merely signed
    out, so those paths skip transient install/connect checks. D-203 adds only
    the user's durable machine-wide admission choice to that recovery door.

    ⚠ CLAUDE IS GATED TOO SINCE D-199, and the note that used to sit here said
    the opposite: "Claude is ungated — its absence already fails loudly at
    spawn". Failing at spawn is not the same as refusing at the door. The user
    reported hire buttons for harnesses they had not set up, and the server was
    the other half of it: it ACCEPTED a Claude hire on a machine with no Claude
    (measured), spent the seat, created the node, and only then failed when the
    turn tried to run. The old note's fear — bricking every existing org on a
    transient detection bug — is answered by WHAT is detected: the CLI file
    this machine would actually spawn, plus a signed-in account, re-probed
    behind a 60s cache and never a network call.

    This list replaces the old load-bearing count. That count said "four"
    while rehire-with-a-tier was ungated, then said "five" while both plain
    rehire paths remained open. A named list makes the next missing call site
    visible without trusting arithmetic prose.

    Two provider-specific rulings ride along (user, 2026-08-28):
      · kiosks hold codex out until its sandbox story is settled;
      · a HEADLESS org may only hire tiers from KEYED providers — a
        subscription login is a person's plan, and headless means nobody is
        present to answer for it.
    """
    if not tier:
        return
    from . import openrouter                   # noqa: PLC0415 — one lane
    provider_id = (
        "google" if tier in providers.ANTIGRAVITY_TIERS
        else "openai" if tier in providers.CODEX_TIERS
        else "claude" if tier in providers.CLAUDE_TIERS
        else openrouter.PROVIDER_ID if openrouter.is_tier(tier)
        else None)
    # the refusal names the tier the way the UI names it: an OpenRouter tier
    # by its display label (`claude-sonnet-5`), never `or-anthropic-…`
    shown = openrouter.tier_label(tier, org.d.get("models"))
    if provider_id and not appsettings.provider_enabled(provider_id):
        label = providers.PROVIDER_LABEL[provider_id]
        raise LedgerError(
            f"tier '{shown}' is a {label} tier and {label} is turned off "
            "in App settings → Providers")
    if user_choice_only:
        return
    if openrouter.is_tier(tier):
        # the API-backed lane (2026-09-02): "installed" is a stored key,
        # "connected" is openrouter.ai having accepted it (60s cache, one
        # small GET — never a spawn). A favorite that was DESELECTED stays
        # a valid tier in any org doc that carries it (add-only tables, so
        # the plain-rehire door above still recovers such a node) but is no
        # longer OFFERED here: deselecting means "stop offering", not evict.
        ost = openrouter.status()
        if not ost.get("key_set"):
            raise LedgerError(
                f"tier '{shown}' is an OpenRouter tier and no OpenRouter API "
                f"key is set — {providers.install_hint(openrouter.PROVIDER_ID)}")
        if not ost.get("connected"):
            raise LedgerError(
                f"tier '{shown}' is an OpenRouter tier and openrouter.ai did "
                f"not accept the stored key — {ost.get('reason')}")
        if openrouter.favorite_for_tier(tier) is None:
            raise LedgerError(
                f"tier '{shown}' is not among the OpenRouter favorites — "
                "select the model in App settings → Providers first")
        if org.d.get("kiosk"):
            raise LedgerError(
                "kiosk orgs cannot hire OpenRouter tiers yet — the lane is "
                "held out of kiosks until its sandboxing is settled (the "
                "same holdout as codex and antigravity, user ruling "
                "2026-08-28)")
        # headless orgs may hire: an API key IS a keyed provider (user
        # ruling 2026-08-28), and this lane has no other login kind
        return
    if tier in providers.ANTIGRAVITY_TIERS:
        ast = providers.antigravity_status()
        if not ast.get("installed"):
            # ⚠ D-202: DO NOT point at "the accounts panel's Antigravity
            # section" here. That section does not exist on a machine
            # without the CLI — the user ruled an uninstalled provider
            # absent from the entire UI, accounts page included, so a
            # pointer at it would send people looking for a panel that was
            # deliberately removed. A refusal must name a place that
            # exists; when the UI is not that place, the message carries
            # the instruction itself.
            raise LedgerError(
                f"tier '{tier}' is an Antigravity tier and the Antigravity "
                f"CLI is not installed on this machine — "
                f"{providers.install_hint('google')}")
        if not ast.get("connected"):
            raise LedgerError(
                f"tier '{tier}' is an Antigravity tier and Antigravity is "
                f"not signed in — run `agy` once on this machine and sign in "
                f"with your Google account (accounts panel → Antigravity)")
        if org.d.get("kiosk"):
            raise LedgerError(
                "kiosk orgs cannot hire Antigravity tiers yet — antigravity "
                "is held out of kiosks until its sandboxing is settled (the "
                "same holdout as codex, user ruling 2026-08-28)")
        if org.d.get("headless"):
            # the CLI's ONLY login is a Google account (OAuth, OS keyring);
            # it offers no API-key lane at all (measured, 1.1.24), so there
            # is no keyed login for a headless org to stand on
            raise LedgerError(
                "a headless org may only hire tiers from KEYED providers "
                "(user ruling 2026-08-28) — the Antigravity CLI signs in "
                "with a Google account only and offers no API-key login")
        return
    if tier not in providers.CODEX_TIERS:
        # D-199: the CLAUDE branch, and it is the last one because Claude is
        # the fallback lane — `provider_of` answers "claude" for an unknown
        # tier, so anything unrecognised lands here and must not be refused by
        # a Claude-shaped message. Gate only tiers Claude actually owns.
        if tier in providers.CLAUDE_TIERS:
            inst = supervisor.claude_install_state()
            if not inst.get("installed"):
                raise LedgerError(
                    # D-202: the Claude section DOES survive on the accounts
                    # page (Claude is the ruled exception), but it carries one
                    # small line and no install command of its own, so the
                    # old pointer was aimed at something that was never there.
                    f"tier '{tier}' is a Claude tier and the Claude Code CLI "
                    f"is not installed on this machine — "
                    f"{providers.install_hint('claude')}")
            if not accounts.live_identity().get("uuid"):
                raise LedgerError(
                    f"tier '{tier}' is a Claude tier and Claude is not signed "
                    f"in — run `claude` once on this machine and complete the "
                    f"login (accounts panel → Claude)")
        return
    st = providers.codex_status()
    if not st.get("installed"):
        raise LedgerError(
            # D-202: was "the accounts panel's Codex section has the install
            # command" — a section that no longer exists when Codex is absent.
            # See the Antigravity branch above.
            f"tier '{tier}' is a Codex tier and the Codex CLI is not "
            f"installed on this machine — {providers.install_hint('openai')}")
    if not st.get("connected"):
        raise LedgerError(
            f"tier '{tier}' is a Codex tier and Codex is not signed in — "
            f"run `codex login` on this machine (accounts panel → Codex)")
    if org.d.get("kiosk"):
        raise LedgerError(
            "kiosk orgs cannot hire Codex tiers yet — codex is held out of "
            "kiosks until its sandboxing is settled (user ruling 2026-08-28)")
    if org.d.get("headless") and st.get("kind") != "api-key":
        raise LedgerError(
            "a headless org may only hire tiers from KEYED providers (user "
            "ruling 2026-08-28) — Codex here is signed in with a "
            "subscription login, not an API key")
    # ⚠ NO USAGE-WINDOW CHECK HERE — user ruling 2026-09-02, and 65273fa had
    # one. Hiring prepares an agent; the TURN is what needs capacity, and the
    # Codex CLI already refuses that loudly. See the note above
    # `providers.RESERVE_TIER` for the reasoning and the tests that pin it.
    if tier in providers.CONDITIONAL_CODEX_TIERS:
        # A rollout token is admitted only on fresh, account-scoped provider
        # evidence. The UI's short cache avoids picker churn, but it is not an
        # authority: re-query HERE, immediately before the caller mutates the
        # ledger. Missing, malformed, failed, or stale evidence all refuse.
        # This is intentionally stricter than gpt-reserve below. Reserve's
        # unreadable-evidence fail-open behavior is an older explicit ruling;
        # do not "harmonize" these two gates.
        availability = providers.conditional_codex_availability(
            tier, force=True, status=st)
        if not availability["enabled"]:
            raise LedgerError(
                f"tier '{tier}' is a conditional Codex tier and is not "
                f"available to this account right now: {availability['reason']}")
    if tier in providers.LEGACY_CODEX_TIERS:
        # `gpt-reserve` is a LEGACY token (user ruling 2026-09-04, item 12):
        # reserve is the pool a `luna` hire spends first, not a tier to pick.
        # A NEW hire, a switch, or a rehire that OVERRIDES the tier onto it is
        # refused and pointed at luna. The plain-rehire door
        # (`user_choice_only=True`) returned above, so a node that already
        # wears the token restarts exactly as it was — nothing rewrites it.
        # ⚠ NO CAPACITY CHECK rides here or on luna (the ruling above
        # `providers.RESERVE_TIER`): a luna whose reserve AND direct pools
        # are both spent is still hireable; the turn answers for capacity.
        raise LedgerError(
            f"tier '{tier}' is no longer hireable — hire 'luna' instead: it "
            f"runs on reserve capacity first and falls back to the direct "
            f"Luna lane when reserve is spent or withdrawn (existing "
            f"'{tier}' agents keep running as they are)")


@app.post("/api/orgs/{slug}/ops")
def org_op(slug: str, body: Op, request: Request) -> dict[str, Any]:
    pub = bool(_public_slug(request))
    # Visitor delete is deliberately OPEN (user ruling 2026-08-01, twice
    # confirmed): visitors act as @user for everything inside the ceiling,
    # permanent deletion included — the ceiling is the only wall, and a
    # kiosk org is disposable by design. See DECISIONS.md D-001 (incl. why
    # the cost-is-history tombstone makes this budget-safe). An interim 403
    # lived here for ~25 min while the ruling was pending (2c5af3e).
    if body.op == "rename":
        if not body.node or not body.name:
            raise HTTPException(422, "rename needs node and name")
        try:
            result = supervisor.rename_node(slug, body.node, body.name,
                                            actor=body.actor)
        except LedgerError as e:
            raise HTTPException(422, str(e))
        supervisor.remote_reap(slug)     # FR-01: a rename re-keys the seat
        hub_changed(slug)
        return result
    # retire/dissolve/rescind interrupt the target's in-flight turn (and
    # every live descendant's) and wait for the turn boundary to settle
    # BEFORE the archive commits — same fix and same reasoning as the
    # mcptool door above (see interrupt_before_archive's docstring). Runs
    # OUTSIDE the lock: the wait needs DOC_LOCK free for the interrupted
    # turn's own `finally` to acquire it. The authority check here is a
    # pre-guard only; the real op re-validates under the lock below.
    _archive_warnings: list[str] = []
    if body.op in ("retire", "dissolve", "rescind") and body.node:
        try:
            _pre_org = store.load_org(slug)
            _pre_org._require_authority(
                body.actor, body.node, allow_self=(body.op != "dissolve"))
        except LedgerError as e:
            raise HTTPException(422, str(e))
        _archive_warnings = supervisor.interrupt_before_archive(
            slug, _pre_org, body.node)
    with store.DOC_LOCK:
        result = _org_op_locked(slug, body, allow_raise=not pub)
        if _archive_warnings and isinstance(result, dict):
            result.setdefault("warnings", []).extend(_archive_warnings)
    # FR-01 (redteam): retire/dissolve/delete must not orphan a running
    # remote-control server — reap any whose seat is gone or no longer live
    if body.op in ("retire", "dissolve", "delete", "rescind", "cheap_compact"):
        supervisor.remote_reap(slug)
    if pub and isinstance(result, dict):
        # the bridge is the ADMIN affordance — a visitor has no legal path to
        # raise the ceiling, so the offer must not dangle
        result.pop("bridge", None)
    # rehire with a waiting mailbox: the mail queued while archived finally
    # gets acted on (user ruling) — drive outside the doc lock
    drive: list[str] = result.pop("drive", []) if isinstance(result, dict) else []
    for t in drive:
        supervisor.send_message(
            slug, t,
            "(orgtree) Mail above arrived while you were archived and waited "
            "for you — you are live again; handle it as appropriate.",
            mail_ping=True, ping_reason="rehire_waited")
    # a crossing switch_model cleared a stale provider freeze (see
    # switch_model) — this node was never archived, so it must not get the
    # message above. Wake it with the accurate one instead.
    stale_freeze_resumed: list[str] = (
        result.pop("resume_stale_freeze", []) if isinstance(result, dict) else [])
    for t in stale_freeze_resumed:
        supervisor.send_message(
            slug, t,
            "(orgtree) You were frozen by a usage limit, connection problem, "
            "or rejected credential on your PREVIOUS provider — a model "
            "switch has moved you to a different provider, so that freeze "
            "no longer describes anything and has been cleared. Handle any "
            "mail above and continue.", mail_ping=True,
            ping_reason="unfrozen_by_switch")
    return result


def _org_op_locked(slug: str, body: Op, allow_raise: bool = False) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
    except LedgerError as e:
        raise HTTPException(404, str(e))
    # ceiling spec §1, computed in exactly one place:
    # raise_ceiling = not public and (kiosk.auto_raise or the explicit ask)
    rc = allow_raise and (bool((org.d.get("kiosk") or {}).get("auto_raise"))
                          or body.raise_ceiling)
    try:
        if body.op == "hire":
            if body.tier is None or body.name is None:
                raise LedgerError("hire needs tier and name")
            provider_hire_gate(org, body.tier)
            if body.above is not None \
                    and org.node(body.above)["parent"] != body.parent:
                raise LedgerError(
                    f"insert-superior: {body.above} does not report to "
                    f"{body.parent or 'the top level'}")
            result = org.hire(body.actor, body.parent, body.tier,
                              body.grant or 0, body.name, body.add_dirs,
                              tools=body.tools, org_visibility=body.org_visibility,
                              charter=body.charter,
                              external_handles=body.external_handles,
                              raise_ceiling=rc)
            if body.effort:
                # applied WITH the hire, atomically (same save): the draft
                # gear's effort used to ride a separate /scope call that the
                # kiosk gateway 403s — a control that could never succeed
                org.set_scope(body.actor, result["node"], effort=body.effort)
            if body.prefer_reserve is not None:
                # same atomic application for the pool order (item 12)
                org.set_scope(body.actor, result["node"],
                              prefer_reserve=body.prefer_reserve)
            if body.above is not None:
                # FR-25 rework (2026-08-19): the splice is atomic with the
                # hire. Pin the fresh node at the anchor's slot FIRST — they
                # are siblings for exactly this moment, so reorder can use the
                # anchor itself — then reparent the anchor beneath it. One
                # save ⇒ one broadcast: the tree lands in its final shape,
                # and a refused move can no longer strand a hired-but-
                # unspliced sibling (the old client-chained failure mode).
                org.reorder(body.actor, result["node"], before=body.above)
                mv = org.move(body.actor, body.above, result["node"])
                result["warnings"] = [*result.get("warnings", []),
                                      *mv.get("warnings", [])]
                result["spliced"] = body.above
        # body.node is Optional on the wire (hire has none); the target ops
        # take str because Org.node(None) already raises LedgerError → 422,
        # hence the arg-type ignores below rather than a behavior-changing check
        elif body.op == "retire":
            result = org.retire(body.actor, body.node)  # type: ignore[arg-type]
        elif body.op == "rescind":
            # FR-22: user-only in the LEDGER (agents have no mcptool verb and
            # the actor field is honest for them); visitors act as @user
            # inside the ceiling per D-001, same as delete
            result = org.rescind(body.actor, body.node)  # type: ignore[arg-type]
        elif body.op == "cheap_compact":
            # FR-24 (opt-in ruling 2026-08-11): retire + fresh hire instead
            # of a cache-cold /compact fork; the transcript copy into the
            # predecessor's scratch rides the same save window
            result = org.cheap_compact(body.actor, body.node)  # type: ignore[arg-type]
            supervisor.export_predecessor_transcript(
                org, cast(str, body.node),
                old_sid=cast(str, result.get("old_session")),
                reason="cheap_compact")
        elif body.op == "rehire":
            # D-197: rehire-with-a-tier is a door onto the provider axis like
            # any other, and it was the one the gate's own docstring named
            # four of and missed. Gated only when a tier is actually
            # OVERRIDDEN: a plain rehire restores the node as it was, and
            # refusing that because a provider is signed out would strand an
            # agent nobody can retire or read.
            if body.tier is not None:
                provider_hire_gate(org, body.tier)
            else:
                stored_tier = str(
                    org.node(body.node).get("model") or "")  # type: ignore[arg-type]
                provider_hire_gate(
                    org, stored_tier, user_choice_only=True)
            result = org.rehire(body.actor, body.node, body.grant, tier=body.tier,  # type: ignore[arg-type]
                                raise_ceiling=rc)
        elif body.op == "dissolve":
            result = org.dissolve(body.actor, body.node)  # type: ignore[arg-type]
        elif body.op == "delete":
            result = org.delete(body.actor, body.node)  # type: ignore[arg-type]
            supervisor.forget(slug, result["deleted"])
        elif body.op == "reallocate":
            if body.delta is None:
                raise LedgerError("reallocate needs delta")
            result = org.reallocate(body.actor, body.node, body.delta)  # type: ignore[arg-type]
        elif body.op == "switch_model":
            if body.tier is None:
                raise LedgerError("switch_model needs tier")
            provider_hire_gate(org, body.tier)
            # D-234: mid-turn → queued (see the agent door)
            result = org.switch_model(
                body.actor, body.node, body.tier,  # type: ignore[arg-type]
                busy=bool(body.node
                          and supervisor.state(slug, body.node)["busy"]))
            if result.get("old_session"):
                # a crossing archived the old session as a bearer — the
                # transcript copy rides the same save window as for
                # cheap_compact (the same split)
                supervisor.export_predecessor_transcript(
                    org, cast(str, body.node),
                    old_sid=cast(str, result.get("old_session")),
                    reason="switch_model")
        elif body.op == "promote":
            result = org.promote(body.actor, body.node, body.new_parent)  # type: ignore[arg-type]
        elif body.op == "demote":
            if body.new_parent is None:
                raise LedgerError("demote needs new_parent")
            result = org.demote(body.actor, body.node, body.new_parent)  # type: ignore[arg-type]
        elif body.op == "move":
            result = org.move(body.actor, body.node, body.new_parent)  # type: ignore[arg-type]
        elif body.op == "reseed":
            result = org.reseed(body.actor, body.node, str(uuid.uuid4()))  # type: ignore[arg-type]
        elif body.op == "revoke_dir":
            if body.dir is None:
                raise LedgerError("revoke_dir needs dir")
            result = org.revoke_dir(body.actor, body.node, body.dir)  # type: ignore[arg-type]
        else:
            raise LedgerError(f"unknown op {body.op!r}")
        _kiosk_cap_check(org)
    except LedgerError as e:
        raise HTTPException(422, str(e))
    store.save_org(org)
    hub_changed(slug)
    return result


@app.websocket("/api/orgs/{slug}/ws")
async def org_ws(ws: WebSocket, slug: str) -> None:
    # a socket that arrived through the PublicGateway carries the kiosk slug in its
    # scope state — that is what marks it a visitor for live-payload projection
    await hub.join(slug, ws, public=bool((ws.scope.get("state") or {}).get("public_slug")))
    try:
        while True:
            await ws.receive_text()   # client pings keep it alive; content ignored
    except WebSocketDisconnect:
        hub.leave(slug, ws)


# ------------------------------------------------------------------- static
from . import gitapi, gitworkspace  # Git workspace owns its isolated router/jobs.
app.include_router(gitapi.router)
app.router.add_event_handler("shutdown", gitworkspace.scheduler.stop)

if os.path.isdir(FRONTEND_DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")),
              name="assets")

    @app.get("/{path:path}")
    def spa(path: str) -> FileResponse:
        full = os.path.normpath(os.path.join(FRONTEND_DIST, path))
        if path and full.startswith(FRONTEND_DIST + os.sep) \
                and os.path.isfile(full):
            return FileResponse(full)
        # ⚠ never cached. Asset filenames are content-hashed, so /assets/* may
        # be held forever — but index.html is the file that NAMES them, and a
        # browser that reuses a stale copy pulls the previous bundle straight
        # back after the reload the instance change just triggered. That would
        # make the refresh look like it did nothing.
        return FileResponse(os.path.join(FRONTEND_DIST, "index.html"),
                            headers={"Cache-Control": "no-store"})


EXPOSE_ENV = "ORGTREE_EXPOSE_ADMIN"
_TRUTHY = {"1", "true", "yes", "on"}


def _admin_host() -> str:
    """Where the ADMIN listener binds.

    Loopback by design — the admin app has no authentication of any kind,
    because "you can reach 127.0.0.1" has always been the whole credential.
    Exposing it hands anyone who finds the port the same powers the owner has:
    read and write every org, grant any folder on this machine to an agent,
    and run turns that execute commands on it.

    The override is an ENV VAR (user ruling 2026-08-04, superseding the
    argv-only ruling of 2026-08-03 recorded in D-39). The reason it moved: a
    service definition — Task Scheduler, a systemd unit — sets environment
    naturally and threading an argv flag through the deploy scripts to a
    detached process is the awkward path. Unattended hosts are the case that
    needs this, so the mechanism should suit them.

    ⚠ What the old ruling was protecting against is still true and is now
    handled elsewhere: env vars are INHERITED by child processes, so every
    agent CLI would see this one through `supervisor.clean_env()`. It is
    stripped there (it is not the agent's business whether the host is
    exposed) — see that function.

    Still deliberately NOT a setting in the org doc: a setting can be flipped
    by anything that can write the doc, including an agent.
    """
    exposed = os.environ.get(EXPOSE_ENV, "").strip().lower() in _TRUTHY
    if exposed and not deployment.current_policy().allow_admin_exposure:
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile forbids ORGTREE_EXPOSE_ADMIN; "
            "unset it so the unauthenticated admin API remains loopback-only")
    return "0.0.0.0" if exposed else "127.0.0.1"


def _deployment_preflight() -> deployment.DeploymentPolicy:
    """Validate the official backend launch against the install-wide policy.

    Frozen mode never converts existing state or silently ignores a
    contradictory exposure setting. Startup refusal keeps the weaker state
    offline until the operator explicitly inventories and migrates it.
    """

    policy = deployment.current_policy()
    # A conflicting exposure request is a configuration error, not an option
    # to silently ignore.
    _admin_host()
    if not policy.allow_public_listener and PUBLIC_PORT:
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile forbids the public kiosk listener; "
            "unset ORGTREE_PUBLIC_PORT (or set it to 0)")
    sandbox.validate_deployment_network(policy=policy)
    legacy_auth = os.environ.get("ORGTREE_SANDBOX_API_KEY", "").strip().lower()
    if not policy.allow_legacy_sandbox_credentials \
            and legacy_auth == "subscription":
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile disables legacy sandbox credential "
            "copying; ORGTREE_SANDBOX_API_KEY='subscription' is forbidden — "
            "use proxied auth or an explicit API key")
    defaults = load_org_defaults()
    default_kiosk = (defaults.get("kiosk")
                      if isinstance(defaults.get("kiosk"), dict) else {})
    if not policy.allow_legacy_sandbox_credentials and (
            str(defaults.get("api_key") or "").strip().lower()
            == "subscription"
            or str(default_kiosk.get("api_key") or "").strip().lower()
            == "subscription"):
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile disables legacy sandbox credential "
            "copying; defaults.json contains forbidden 'subscription' auth -- "
            "remove it and use proxied auth or an explicit API key")
    if not policy.require_sandboxed_orgs:
        return policy

    unsandboxed: list[str] = []
    legacy_credentials: list[str] = []
    for row in store.list_orgs():
        slug = str(row.get("slug") or "<unknown>")
        try:
            org = store.load_org(slug)
        except (LedgerError, OSError) as e:
            # Could not prove the security property, so frozen mode does not
            # start. Keep the slug and a compact reason for inventory work.
            unsandboxed.append(f"{slug} (could not verify: {e})")
            continue
        if not sandbox.is_sandboxed(org):
            unsandboxed.append(slug)
        kiosk = org.d.get("kiosk") or {}
        persisted_subscription = (
            str(org.d.get("api_key") or "").strip().lower() == "subscription"
            or str(kiosk.get("api_key") or "").strip().lower()
            == "subscription")
        try:
            effective_subscription = sandbox.uses_legacy_credential_copy(org)
            copied_credentials = sandbox.copied_subscription_credentials(org)
        except deployment.DeploymentConfigError as e:
            legacy_credentials.append(f"{slug} (could not verify: {e})")
            continue
        if persisted_subscription or effective_subscription:
            legacy_credentials.append(f"{slug} ('subscription' auth)")
        if copied_credentials:
            legacy_credentials.append(f"{slug} (copied credential file)")
    if unsandboxed:
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile requires every org to be "
            "sandboxed; refusing startup because these orgs are not "
            f"sandboxed: {', '.join(unsandboxed)}. While running the standard "
            "profile, back up each org, recreate it with sandboxing enabled, "
            "verify the replacement, and remove the unsandboxed original "
            "before enabling frozen mode.")
    if legacy_credentials:
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile disables legacy sandbox credential "
            "copying; refusing startup because forbidden state exists in: "
            f"{', '.join(legacy_credentials)}. Remove stored 'subscription' "
            "selectors and any sandbox .claude/.credentials.json copies, then "
            "use proxied auth or an explicit API key.")
    # This is deliberately last: policy/profile selection and persisted-state
    # inventory have their own precise refusals, then the approved-install
    # verifier proves the code/dependency/provider/image/launch configuration.
    frozen_install.require_approved_install(policy=policy)
    return policy


def _ws_impl() -> str | None:
    """Which WebSocket implementation uvicorn will find, if any.

    Plain `uvicorn` has none, and the resulting failure is SILENT: an upgrade
    request falls through to the SPA catch-all and answers 200 OK with HTML, so
    the browser's socket simply never opens and reconnect-loops forever. Every
    HTTP route keeps working, the UI falls back to its polling heartbeats, and
    the only symptom is that everything feels slightly slow — which is exactly
    how a user lost time to it on a second machine (2026-08-03). A dependency
    nothing imports, whose absence produces no error, has to be checked for
    explicitly or it is undiscoverable.
    """
    for mod in ("websockets", "wsproto"):
        if importlib.util.find_spec(mod) is not None:
            return mod
    return None


def main() -> None:
    import uvicorn

    # ⚠ ONE BACKEND PER DATA ROOT — enforced here because this is the only
    # moment it is cheap and safe. MEASURED (test_compaction.py "xproc"): two
    # processes running the canonical load → mutate → save cycle against one
    # org doc lose 44–50 % of their COMPLETED writes, four processes 62–82 %,
    # with zero exceptions, zero torn reads and zero orphaned temp files. Both
    # existing guards are per-process and `os.replace` is atomic, which is
    # exactly why the loss is silent: every writer is told it succeeded.
    #
    # A lock around save_org would not help — the race is the read-modify-write
    # CYCLE, so a correct lock would have to span load → save, i.e. regions
    # that spawn CLI children and stay held for a 600 s compaction fork. That
    # is a deadlock surface. Claiming the root at startup is the whole fix.
    try:
        store.claim_data_root()
    except store.DataRootBusy as e:
        bar = "!" * 74
        print(f"\n{bar}\n"
              f"  ANOTHER ORGTREE BACKEND ALREADY OWNS THIS DATA ROOT\n"
              f"\n"
              f"  {e}\n"
              f"\n"
              f"  Two backends on one data root silently DISCARD each other's\n"
              f"  writes — measured at 44-82% of completed saves lost, with no\n"
              f"  error on either side. Stop the other one, or point this one\n"
              f"  at a different ORGTREE_DATA.\n"
              f"{bar}\n", flush=True)
        raise SystemExit(1)
    except store.MigrationError as e:
        # the JSON→SQLite migration was withheld (no ORGTREE_MIGRATE=1) or
        # did not verify: the message is already the wall, and a refusal is
        # not a crash — no traceback, exit 1, say why
        print(f"\n{e}\n", file=sys.stderr, flush=True)
        raise SystemExit(1)

    host: str | None = None
    try:
        selected_policy = deployment.current_policy()
        if selected_policy.name == "frozen":
            # Only this module entry point can truthfully register the Uvicorn
            # listener plan. A direct ``uvicorn orgtree.api:app`` launch never
            # reaches this call and is refused at ASGI startup.
            host = _admin_host()
            raw_public_port = os.environ.get("ORGTREE_PUBLIC_PORT")
            frozen_install.register_official_launch(
                admin_host=host,
                public_port=(0 if raw_public_port == "0"
                             else raw_public_port),
                expose_admin=os.environ.get(EXPOSE_ENV),
                admin_port=PORT,
                bridge_port=sandbox.BRIDGE_PORT,
            )
        policy = _deployment_preflight()
    except deployment.DeploymentConfigError as e:
        bar = "!" * 74
        print(f"\n{bar}\n"
              "  DEPLOYMENT POLICY REFUSED STARTUP\n\n"
              f"  {e}\n\n"
              "  Fix the configuration/state above, then start orgtree again.\n"
              f"{bar}\n", flush=True)
        raise SystemExit(2) from e

    if _ws_impl() is None:
        bar = "!" * 74
        print(f"\n{bar}\n"
              "  NO WEBSOCKET LIBRARY — the live UI will be DEGRADED, not broken.\n"
              "\n"
              "  uvicorn has no WebSocket implementation installed, so pushed\n"
              "  updates cannot reach the browser. Everything still works; it\n"
              "  falls back to polling, so every action lags by up to one poll.\n"
              "\n"
              "  Fix:  pip install -r requirements.txt      (or: pip install websockets)\n"
              f"{bar}\n", flush=True)

    if host is None:
        host = _admin_host()
    if host != "127.0.0.1":
        # not a log line — a wall. Whoever typed the flag should see exactly
        # what they turned off, and anyone reading the console later should be
        # able to tell at a glance that this process is wide open.
        bar = "!" * 74
        print(f"\n{bar}\n"
              f"  {EXPOSE_ENV}=1: THE ADMIN API IS BOUND TO {host}:{PORT}\n"
              f"\n"
              f"  It has NO password, NO token and NO login. Anyone who can\n"
              f"  reach this port has full control of every org and can make\n"
              f"  agents run commands on this machine.\n"
              f"\n"
              f"  Only do this behind a VPN, an SSH tunnel or an authenticating\n"
              f"  reverse proxy. To share an org with someone instead, make it\n"
              f"  a kiosk: that serves one org over a secret URL with limits.\n"
              f"{bar}\n", flush=True)

    # ⚠ The CLI this backend resolved, announced ONCE at startup — and LOUDLY
    # when it is too old. Nothing printed this before, so a vanished pin
    # produced a backend that came up clean and then failed every turn with
    # `unknown option --effort`, which reads like an orgtree bug.
    # It ANNOUNCES; it does NOT refuse to boot (user ruling 2026-08-21).
    # Refusing would remove the only surface through which this message could
    # be read or the pin reinstalled — and since the deploy tool restarts this
    # process, a boot-time refusal would turn any deploy into a bricked
    # machine with no UI left to diagnose it.
    _cli_problem = supervisor.cli_diagnosis()
    if _cli_problem:
        cbar = "!" * 74
        print(f"\n{cbar}\n  CLAUDE CLI PROBLEM — turns on this machine will "
              f"fail\n\n  {_cli_problem}\n\n  The backend is starting anyway "
              f"so you can read this and fix it.\n{cbar}\n", flush=True)
    else:
        _r = supervisor.cli_resolution()
        print(f"cli: {_r['version']} at {_r['path']}"
              f"{' (pinned)' if _r['is_pin'] else ' (NOT the pin)'}",
              flush=True)

    # three listeners, three trust levels: the admin app is LOOPBACK-ONLY
    # unless the operator typed the flag above (user vision: root access never
    # reaches the wider web); the public listener serves nothing but
    # preauthenticated /k/<token> URLs; the bridge listener serves nothing but
    # secret-gated sandbox traffic
    servers = [uvicorn.Server(uvicorn.Config(app, host=host, port=PORT))]
    if PUBLIC_PORT and policy.allow_public_listener:
        servers.append(uvicorn.Server(uvicorn.Config(
            PublicGateway(app), host="0.0.0.0", port=PUBLIC_PORT)))
    if sandbox.BRIDGE_PORT:
        # The frozen org credential rides in the Anthropic URL because the
        # CLI cannot attach a private header. Uvicorn logs request paths by
        # default, so suppress only this listener's access log in frozen mode.
        # The relay also logs no paths. Standard logging stays unchanged.
        bridge_log = ({"access_log": False}
                      if not policy.allow_sandbox_internet else {})
        servers.append(uvicorn.Server(uvicorn.Config(
            BridgeGateway(app), host=sandbox.bridge_bind_host(),
            port=sandbox.BRIDGE_PORT, **bridge_log)))
    if len(servers) == 1:
        uvicorn.run(app, host=host, port=PORT)
        return

    async def serve_all() -> None:
        await asyncio.gather(*(s.serve() for s in servers))

    asyncio.run(serve_all())


if __name__ == "__main__":
    main()
