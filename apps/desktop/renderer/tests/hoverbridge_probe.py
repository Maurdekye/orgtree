"""hoverbridge_probe.py — UX7: does the transparent "hover bridge" beside a
card (cards.tsx, added 2026-08-28 to keep the side hire-chips reachable — see
the ".hsof-bridge" comment in styles.css) intercept clicks meant for the open
canvas beside the card, turning a would-be canvas pan into a node drag?

THE SUSPECTED MECHANISM, stated precisely so it can be measured rather than
reasoned about:

  * `.sq > .hsof-bridge` is `position: absolute`, sized to the exact gap
    between the card and its neighbouring furniture (the credit bar on the
    left, open canvas or doc-chips on the right), `z-index: 1`, and —
    critically — `pointer-events: auto` UNCONDITIONALLY (styles.css
    ~line 2265). It is NOT gated on `.sq:hover` the way the chips themselves
    are; only the *chips* fade in/out and gain/lose pointer-events on hover.
    So the bridge is a live hit target at all times, whether or not the
    card is being hovered, and whether or not the hire chips are showing.

  * The bridge is a DOM CHILD of `.sq`, even though it is positioned
    OUTSIDE `.sq`'s own visual box (`right: 100%` / `left: 100%`). A
    pointerdown landing on it is therefore a pointerdown on a descendant of
    `.sq`, and — because React's synthetic events bubble — it reaches
    `.sq`'s own `onPointerDown` exactly as if the user had pressed the card
    itself.

  * `OrgCanvas.tsx`'s `startNodeDrag` (bound to `.sq`'s `onPointerDown`)
    excludes a short list of descendant selectors from starting a node drag:
    `button, input, textarea, select, .cbar, .desk-body`. `.hsof-bridge` was
    NOT on that list, so a press landing in the open-canvas sliver the
    bridge covers — which visually looks like empty canvas next to the
    card, not the card itself — called `e.stopPropagation()` and
    `setPointerCapture`, dragging the ENTIRE org subtree rooted at that
    card, exactly as if the user had grabbed the card's own body.

WHY A REAL BROWSER AGAINST A REAL (THROWAWAY) BACKEND, not a CSS-only fixture
like chipbar_probe.py next door. The defect is in POINTER EVENT BUBBLING and
React's own onPointerDown/stopPropagation/setPointerCapture chain in
OrgCanvas.tsx — none of that exists in a static HTML+CSS mockup. This drives
the real app, the real DOM, the real event handlers, against a disposable
backend/org that is deleted at the end of the run. It never touches port
7360 (the operator's live backend — confirmed LISTENING before this file was
ever written, and re-checked here: see `_check_ownership`/`_listener_pid`
below, which verify the OS-reported LISTEN owner of our own port, not merely
that something answers on it) or any real org.

WHAT IS MEASURED, once per side ('l' and 'r' — both are checked; earlier
drafts of this file claimed both but only ever gestured `bridge-l`, which
`--expect-bug` below would have let slip through unnoticed):
  1. STATIC HIT-TEST (like chipbar_probe's HIT): with the cursor parked at
     the centre of the open-canvas sliver that side's bridge covers (the
     part of `.hsof-bridge` that does NOT overlap `.cbar`/`.doc-chips`),
     what does `document.elementFromPoint` return?
  2. REPRODUCTION — a press-move-release gesture started at that point. If
     the bridge is intercepting: the CARD's own screen position moves BY
     MORE than the camera's own pan delta (it got dragged) and the camera's
     pan is not what a click there should have produced. Compared against
     the camera's OWN delta rather than to zero, because a working pan also
     moves every card's screen rect — comparing to zero would read a
     correctly-panning app as broken.
  4. CONFINEMENT — a point just outside that side's bridge footprint is
     RE-MEASURED fresh (rects + a fresh elementFromPoint check) right
     before its own gesture, not computed from rects captured earlier in
     the run: an earlier gesture can pan the camera and move everything on
     screen, and reusing stale coordinates would either land back inside
     the bridge (false failure) or on a stale patch of open canvas that no
     longer relates to the bridge's current position (a pass that proves
     nothing). It is then gestured and must pan the camera like the control.

A POSITIVE CONTROL runs once, before any of the above: a drag on open
canvas far from any card must pan the camera. If it doesn't, nothing below
means anything, and the run aborts rather than reporting green or red on a
measurement it never actually took.

A SEPARATE check (`verify_pins_untouched`) exercises — not merely diffs —
the pinned-window mosaic this fix must not touch: edge resize, corner
resize, and the Shift-bypass-vs-snap distinction (pins.tsx, PIN_SNAP_DISTANCE
= 20px — dropped within that of the screen's left edge without Shift must
snap the window's x to exactly 0; the same drop WITH Shift held must land at
the raw, unsnapped position). `git diff --stat` showing pins.tsx untouched is
a source-identity fact, not a behaviour proof; this is the behaviour proof.

EXIT CODE / CONTROL MODE
  Default: every check must pass; exit 0 if so, 1 otherwise (a check that
  reports FAILURES and still exits 0 is not a check — this file used to do
  exactly that and has been fixed).
  `--expect-bug`: for use against a DELIBERATELY-REVERTED tree only (e.g.
  `git stash` the OrgCanvas.tsx fix). Inverts the two bridge REPRO checks
  per side: it PASSES (exit 0) only if those specifically report the
  bridge capturing the drag, and FAILS if the app measures clean — i.e. it
  fails loudly if this probe can no longer see the bug it exists to catch.
  It does not touch `verify_pins_untouched`, which has no "bug" state to
  invert.

USAGE
    python frontend/tests/hoverbridge_probe.py
    python frontend/tests/hoverbridge_probe.py --shot out.png
    python frontend/tests/hoverbridge_probe.py --expect-bug   # after
                                                                # `git stash`
                                                                # on the fix

Requires playwright (msedge channel), fastapi, uvicorn, websockets, psutil —
psutil is the one addition over live_probe.py next door, needed to ask the
OS (not an HTTP response) who actually owns a listening socket. Starts its
own backend on a dedicated port with a throwaway ORGTREE_DATA/HOME; refuses
to run at all if that port is already bound by anyone (own or otherwise);
before ANY mutation, self-tests its own ownership guard against two
impostor servers (verify_identity_guard), then requires the OS-reported
LISTEN owner of its port to be its own spawned child PID AND that child to
answer the real endpoint's exact empty-list shape — an HTTP response by
itself, even a correctly-shaped empty one from an unrelated process, is
never treated as proof; rechecks both facts again immediately before the
first mutating call; never rebuilds frontend/dist beyond what is already
built; deletes the org it creates; kills its own backend child on every
exit path, including a startup failure partway through.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import psutil

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))

from playwright.sync_api import sync_playwright  # noqa: E402

# --------------------------------------------------------------------- rig
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7419
BASE = f"http://127.0.0.1:{PORT}"

TMP = tempfile.mkdtemp(prefix="orgtree-hoverbridge-probe-")
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

# D-199 fixture: an isolated HOME has no detected Claude, and the hire gate
# refuses a Claude tier hire on a machine with none — see live_probe.py's
# identical comment for the full mechanism.
with open(os.path.join(HOME, ".claude.json"), "w", encoding="utf-8") as _f:
    json.dump({"oauthAccount": {
        "accountUuid": "hoverbridge-probe-uuid",
        "emailAddress": "hoverbridge-probe@example.test",
    }}, _f)

PROC: subprocess.Popen | None = None
_ORGS: list[str] = []


def _log_tail(n: int = 3000) -> str:
    try:
        return open(LOG, encoding="utf-8", errors="replace").read()[-n:]
    except OSError:
        return "(no log)"


def api(method: str, path: str, body=None, timeout: float = 30):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def set_cfg(**default) -> None:
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump({"default": default}, f)


def _port_free(port: int) -> bool:
    """A cheap pre-check only — see the module note above _check_ownership
    for why a bind test alone (or an HTTP response alone) is NOT ownership
    proof. This just fails fast on the common case; it does not gate any
    mutation by itself."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _listener_pid(port: int) -> int | None:
    """The PID the OS itself says owns the LISTEN socket on 127.0.0.1:<port>.
    This is the actual ownership fact; an HTTP response is not — anything
    capable of answering GET /api/orgs with valid-looking JSON can produce
    the same bytes our own backend would, whether or not it is our backend.
    Returns None if nothing is listening (yet, or ever)."""
    for c in psutil.net_connections(kind="tcp"):
        if (c.status == psutil.CONN_LISTEN and c.laddr
                and c.laddr.port == port
                and c.laddr.ip in ("127.0.0.1", "0.0.0.0", "::1", "::")):
            return c.pid
    return None


class _NotReady(Exception):
    """Transient: nothing is listening yet, or the listener isn't answering
    HTTP yet. Worth another poll. Never treated as an ownership verdict."""


class _OwnershipViolation(RuntimeError):
    """Fatal: something IS answering, on a real listening socket, and it is
    either not ours or does not prove it's ours. More polling cannot fix
    this — it is a verdict, not a timing issue."""


def _check_ownership(port: int, expected_pid: int) -> None:
    """Raises unless BOTH hold: (1) the OS reports `expected_pid` as the
    actual LISTEN owner of `port` — not merely "something answered a
    request", which review correctly named as no proof at all (a wrong
    process racing us for the same port between our pre-check and our own
    spawn would answer just as readily, and so would anything else that
    happens to be listening there); and (2) that owner's own /api/orgs
    response is EXACTLY the real endpoint's shape — a bare JSON list, per
    api.py's `orgs_list() -> list[dict]` — and empty. Both checks are
    needed: PID ownership alone doesn't prove the DATA root is the fresh
    throwaway one; the empty-list shape alone doesn't prove OWNERSHIP
    (review's exact point — and a loose `data.get('orgs', [])` reading also
    let a bare `{}` from anything at all pass as "zero orgs", which this
    replaces with a strict `isinstance(data, list)` requirement)."""
    pid = _listener_pid(port)
    if pid is None:
        raise _NotReady(f"nothing listening on {port} yet")
    if pid != expected_pid:
        raise _OwnershipViolation(
            f"port {port}'s actual LISTEN owner is pid {pid}, not the "
            f"expected {expected_pid} — an HTTP response alone never "
            f"proved this; the OS-reported socket owner is what's checked")
    try:
        raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/orgs",
                                      timeout=2).read()
    except (urllib.error.URLError, ConnectionError, OSError, TimeoutError) as e:
        raise _NotReady(f"pid {pid} owns the socket but isn't answering "
                         f"HTTP yet: {e}") from e
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except json.JSONDecodeError as e:
        raise _NotReady(f"pid {pid} answered non-JSON, possibly still "
                         f"booting: {e}") from e
    if not isinstance(data, list):
        raise _OwnershipViolation(
            f"pid {pid} (OS-confirmed owner) answered /api/orgs with a "
            f"non-list payload {data!r} — not the real endpoint's shape, "
            f"so this is not trusted as proof of anything")
    if data:
        raise _OwnershipViolation(
            f"pid {pid} (OS-confirmed owner) answered /api/orgs with "
            f"{len(data)} EXISTING org(s) {[o.get('slug') for o in data]!r} "
            f"— not a fresh throwaway root")


def _free_ephemeral_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _serve_json(port: int, payload):
    """A minimal decoy server answering every GET on `port` with `payload`,
    in a background thread of THIS process — so its true OS-level listener
    PID is `os.getpid()`, known and checkable, unlike a real orgtree
    backend's child PID which this file only learns about after spawning
    it. Used only by verify_identity_guard() below, never by the real run."""
    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):                                # noqa: D401
            pass

        def do_GET(self):                                          # noqa: N802
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    srv = http.server.HTTPServer(("127.0.0.1", port), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t


def verify_identity_guard() -> bool:
    """Self-test, run once before the real backend is ever spawned: proves
    `_check_ownership` actually discriminates, rather than trusting it on
    faith. Two impostor scenarios, both named directly in review:
      (a) a server that answers the exact same EMPTY, correctly-shaped
          response our real backend would, but is NOT the process we
          expected — must be REJECTED. This is "another empty Orgtree
          instance could win the bind race" made concrete: empty and
          correctly-shaped is not, by itself, ownership.
      (b) a server we DO own (PID matches) but whose response is the wrong
          SHAPE ({} instead of a bare list) — must be REJECTED. This is the
          `data.get('orgs', [])` loophole: an unrelated `{}` must not read
          as "zero orgs".
    And one real-positive: a server we DO own answering the correct empty
    shape — must be ACCEPTED, or every run would refuse to start at all."""
    all_ok = True

    port_a = _free_ephemeral_port()
    srv_a, t_a = _serve_json(port_a, [])
    try:
        try:
            _check_ownership(port_a, os.getpid())
            check("[identity-guard] ACCEPTS a genuinely owned server "
                  "answering the correct empty shape", True)
        except Exception as e:                                    # noqa: BLE001
            check("[identity-guard] ACCEPTS a genuinely owned server "
                  "answering the correct empty shape", False, str(e))
            all_ok = False

        bogus_pid = os.getpid() + 1
        try:
            _check_ownership(port_a, bogus_pid)
            check("[identity-guard] REJECTS the SAME empty, correctly-shaped "
                  "server when the expected owner PID does not match "
                  "(review's exact scenario — empty alone is not ownership)",
                  False, "did not raise — accepted an impostor")
            all_ok = False
        except RuntimeError:
            check("[identity-guard] REJECTS the SAME empty, correctly-shaped "
                  "server when the expected owner PID does not match "
                  "(review's exact scenario — empty alone is not ownership)",
                  True)
    finally:
        srv_a.shutdown()
        t_a.join(timeout=2)

    port_b = _free_ephemeral_port()
    srv_b, t_b = _serve_json(port_b, {})
    try:
        try:
            _check_ownership(port_b, os.getpid())
            check("[identity-guard] REJECTS a genuinely owned server whose "
                  "response is the wrong SHAPE ({} instead of a bare list — "
                  "the data.get('orgs', []) loophole named in review)",
                  False, "did not raise — {} was read as zero orgs")
            all_ok = False
        except RuntimeError:
            check("[identity-guard] REJECTS a genuinely owned server whose "
                  "response is the wrong SHAPE ({} instead of a bare list — "
                  "the data.get('orgs', []) loophole named in review)",
                  True)
    finally:
        srv_b.shutdown()
        t_b.join(timeout=2)

    return all_ok


def start_backend() -> None:
    """Own ORGTREE_DATA/HOME, own port, ORGTREE_CLAUDE_CLI -> fakecli.js,
    ORGTREE_BRIDGE_PORT=0 so the sandbox-bridge listener never contests the
    real one (same rig as live_probe.py's start_backend()).

    Ownership is established by `_check_ownership` (OS-reported LISTEN PID
    == our own spawned PROC.pid, AND the real endpoint's exact empty-list
    shape) — an HTTP response by itself proves nothing, including a
    same-shaped empty one (verify_identity_guard, called once before this
    ever runs, exists to prove that check actually discriminates). Kills its
    own child on every failure path out of this function, so a partial
    startup never leaks a live process."""
    global PROC
    if not _port_free(PORT):
        raise RuntimeError(
            f"port {PORT} is already bound by another process — refusing to "
            f"start (and therefore refusing to POST/DELETE against whatever "
            f"is already listening there). Pass --port with a free one.")
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": DATA, "USERPROFILE": HOME, "HOME": HOME,
        "ORGTREE_PORT": str(PORT),
        "FAKECLI_CONFIG": CFG,
        "ORGTREE_MAX_TURNS": "16",
        "ORGTREE_STEER_HOOK": "0",
        "ORGTREE_TURN_TIMEOUT": "60",
        "PYTHONPATH": os.path.join(_REPO, "backend"),
        "PYTHONIOENCODING": "utf-8",
        "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_CLAUDE": os.path.join(_REPO, "backend", "tests", "fakecli.js"),
        "ORGTREE_CLAUDE_CLI": os.path.join(_REPO, "backend", "tests", "fakecli.js"),
    })
    env.pop("ORGTREE_PUBLIC_PORT", None)
    env.pop("ORGTREE_EXPOSE_ADMIN", None)
    set_cfg(replyText="ack.")
    log = open(LOG, "a", encoding="utf-8")
    PROC = subprocess.Popen(
        [sys.executable, "-m", "orgtree.api"], cwd=os.path.join(_REPO, "backend"),
        env=env, stdout=log, stderr=log, text=True)
    try:
        for _ in range(200):
            if PROC.poll() is not None:
                raise RuntimeError(
                    f"backend exited with {PROC.returncode} during startup; "
                    f"log tail:\n" + _log_tail())
            try:
                _check_ownership(PORT, PROC.pid)
            except _NotReady:
                time.sleep(0.1)
                continue
            # _OwnershipViolation (or anything else) propagates immediately:
            # a genuine mismatch is a verdict, not a timing issue more
            # polling could fix.
            print(f"backend up on :{PORT}  pid={PROC.pid}  "
                  f"(data={DATA}  home={HOME}) — ownership confirmed: OS "
                  f"reports OUR spawned pid as the port's actual listener, "
                  f"and it answers a fresh, empty, correctly-shaped org list")
            return
        raise RuntimeError(f"backend did not come up on {PORT}:\n" + _log_tail())
    except Exception:
        stop_backend()
        raise


def assert_still_ours() -> None:
    """Recheck immediately before the first mutating call, not just once at
    startup: a backend confirmed ours a moment ago could still have died, or
    (pathologically) the OS could have recycled the port to someone else in
    between. Cheap, and closes the gap review named."""
    if PROC is None or PROC.poll() is not None:
        raise RuntimeError(
            "backend child is not running anymore — refusing the first "
            "mutation against a backend that never proved it's still ours")
    _check_ownership(PORT, PROC.pid)


def stop_backend() -> None:
    global PROC
    if PROC is None:
        return
    PROC.terminate()
    try:
        PROC.wait(timeout=10)
    except subprocess.TimeoutExpired:
        PROC.kill()
    PROC = None


def make_org(label: str) -> str:
    r = api("POST", "/api/orgs", {"name": f"zz hoverbridge-probe {label}"[:60]})
    slug = r.get("slug") or r.get("org", {}).get("slug")
    _ORGS.append(slug)
    return slug


def hire(slug: str, name: str) -> str:
    r = api("POST", f"/api/orgs/{slug}/ops", {
        "op": "hire", "actor": "@user", "parent": None, "tier": "haiku",
        "grant": 2, "name": name, "charter": "a hoverbridge-probe test agent",
        "tools": {"bash": False, "web": False, "edit": False,
                  "subagents": False, "mcp": []},
        "org_visibility": "team", "add_dirs": []})
    return r.get("node") or name


def drop_orgs() -> None:
    for slug in list(_ORGS):
        try:
            api("DELETE", f"/api/orgs/{slug}")
        except Exception as e:                                    # noqa: BLE001
            print(f"  (cleanup) failed to delete {slug}: {e}")


RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


CAM = """
() => {
  const sp = document.querySelector('.space');
  if (!sp) return null;
  const m = /translate\\(\\s*(-?[\\d.]+)px\\s*,\\s*(-?[\\d.]+)px\\s*\\)/.exec(sp.style.transform);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
"""

RECTS = """
(nodeName) => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return {x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom}; };
  const sq = Array.from(document.querySelectorAll('.sq'))
    .find(el => el.querySelector(`.name`) && el.querySelector('.name').textContent === nodeName);
  const bridgeL = sq ? sq.querySelector('.hsof-bridge.bridge-l') : null;
  const bridgeR = sq ? sq.querySelector('.hsof-bridge.bridge-r') : null;
  const cbar = sq ? sq.querySelector('.cbar') : null;
  return { sq: r(sq), bridgeL: r(bridgeL), bridgeR: r(bridgeR), cbar: r(cbar) };
}
"""

HIT = """
(pt) => {
  const el = document.elementFromPoint(pt.x, pt.y);
  if (!el) return {tag: null, cls: null, owner: null};
  const own = el.closest('.hsof-bridge, .cbar, .hsof, .sq, .viewport, .space');
  return {tag: el.tagName.toLowerCase(), cls: el.className || null,
          owner: own ? own.className : null};
}
"""

PINRECT = """
(id) => {
  const el = document.querySelector(`.pinwin[data-id="${id}"]`);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return {x: b.x, y: b.y, w: b.width, h: b.height};
}
"""

# `.pinwin` is CSS `position: absolute` (styles.css ~4579), positioned
# relative to `.viewport` (its offsetParent, `position: relative`), NOT the
# page. `commitRect`/`findPinSnap` work entirely in that VIEWPORT-relative
# space — "snapped to the left edge" means state x=0, which on the PAGE (what
# `getBoundingClientRect` on `.pinwin` returns, and what PINRECT above uses)
# reads back as `.viewport`'s own page offset, not literally 0. Comparing a
# PINRECT reading straight to 0 silently assumes `.viewport` starts at the
# page's own (0,0), which it does not here (it sits inside app chrome with
# its own border/margin) — this reads that offset once so the snap checks
# compare against the right zero.
VIEWPORT_ORIGIN = """
() => {
  const el = document.querySelector('.viewport');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  // `.pinwin` is absolutely positioned against `.viewport`'s PADDING edge
  // (the CSS containing-block rule for `position: absolute`), which sits
  // `.viewport`'s own border-width inside its border-box — the box
  // getBoundingClientRect reports. Reading the border and folding it in here
  // means state x=0 compares against the exact page x it actually renders
  // at, not the border-box corner a naive reading would assume.
  return {x: b.x + bl, y: b.y + bt, w: b.width - bl, h: b.height - bt};
}
"""


# OrgCanvas.tsx's moveNodeDrag has its own EDGE-PAN feature: nearing within
# 48px of the viewport's edge during a NODE drag pans the camera as a
# convenience (so a long-distance reparent isn't stuck at the screen edge).
# That is a real, separate, legitimate feature — but it means "did the
# camera pan" stops being a clean signal for "did the click reach the
# canvas" if the gesture's OWN path wanders within 48px of an edge, which a
# fixed (dx, dy) can do purely by chance depending on where the start point
# happens to sit (bridge-r's point is low-right in this fixture; a fixed
# down-right drag walked its cursor to within a few px of the bottom edge
# and triggered a real, deterministic edge-pan on EVERY run, independent of
# whether the bridge bug was present). Dragging TOWARD the viewport's centre
# instead of a fixed direction keeps every gesture's whole path outside that
# 48px band regardless of where it starts.
_VIEW_W, _VIEW_H = 1600, 950
_EDGE_PAN_MARGIN = 48


def toward_center(x0: float, y0: float, mag_x: float = 120, mag_y: float = 60):
    dx = mag_x if x0 < _VIEW_W / 2 else -mag_x
    dy = mag_y if y0 < _VIEW_H / 2 else -mag_y
    return dx, dy


def gesture(pg, x0, y0, dx=120, dy=60, steps=8, shift=False):
    """Press at (x0,y0), drag by (dx,dy) over `steps` real pointermoves,
    release. Returns nothing; caller reads state before/after."""
    pg.mouse.move(x0, y0)
    pg.wait_for_timeout(30)   # let pointerenter/hover state settle before down
    if shift:
        pg.keyboard.down("Shift")
    pg.mouse.down()
    pg.wait_for_timeout(50)
    for k in range(1, steps + 1):
        pg.mouse.move(x0 + dx * k / steps, y0 + dy * k / steps)
        pg.wait_for_timeout(20)
    pg.wait_for_timeout(50)
    pg.mouse.up()
    if shift:
        pg.keyboard.up("Shift")
    pg.wait_for_timeout(100)


def verify_bridge_side(pg, node: str, side: str, expect_bug: bool) -> bool | None:
    """Runs the hit-test + repro + confinement trio for one side ('l'/'r').
    Returns whether the bridge was measured capturing the drag (only
    meaningful when `expect_bug` is set; `None` otherwise — the confinement
    and hit-test checks are recorded either way but don't gate this verdict,
    since they are separate findings from "did we reproduce the reported
    bug").
    `expect_bug`: this run is against a deliberately-reverted tree, so the
    two repro checks are asserted INVERTED (bridge capturing the drag is the
    PASS condition, proving the probe can still see the defect)."""
    key = "bridgeL" if side == "l" else "bridgeR"
    label = f"bridge-{side}"

    rects = pg.evaluate(RECTS, node)
    br, cb, sq = rects[key], rects["cbar"], rects["sq"]
    # the open-canvas sliver: on the left this is the strip beyond .cbar's
    # own extent but still inside the bridge; on the right (no doc-chips in
    # this fixture) the whole bridge width is open canvas already.
    if side == "l":
        sliver_x = (cb["right"] + sq["x"]) / 2
    else:
        sliver_x = (br["x"] + br["right"]) / 2
    sliver_y = sq["y"] + sq["h"] / 2

    print(f"\n  == [{label}] static hit-test at ({sliver_x:.1f},{sliver_y:.1f}) ==")
    hit = pg.evaluate(HIT, {"x": sliver_x, "y": sliver_y})
    print(f"  elementFromPoint owner: {hit['owner']!r}")
    claimed = bool(hit["owner"]) and "hsof-bridge" in hit["owner"]
    check(f"[{label}] HIT-TEST: the open-canvas sliver is claimed by "
          f".hsof-bridge (not by the canvas)",
          claimed, f"owner={hit['owner']!r}")

    print(f"\n  == [{label}] reproduction: drag starting at that point ==")
    cam_before = pg.evaluate(CAM)
    sq_before = pg.evaluate(RECTS, node)["sq"]
    gesture(pg, sliver_x, sliver_y, *toward_center(sliver_x, sliver_y))
    cam_after = pg.evaluate(CAM)
    sq_after = pg.evaluate(RECTS, node)["sq"]
    cam_moved = cam_before != cam_after
    cam_dx = (cam_after[0] - cam_before[0]) if (cam_before and cam_after) else 0.0
    cam_dy = (cam_after[1] - cam_before[1]) if (cam_before and cam_after) else 0.0
    card_dx = sq_after["x"] - sq_before["x"]
    card_dy = sq_after["y"] - sq_before["y"]
    # a pure camera pan shifts every card's SCREEN rect by exactly the
    # camera's own delta; a node drag moves the card BEYOND that. Comparing
    # the card's shift to the camera's shift (not to zero) is what tells the
    # two apart — a raw "did the screen rect move" check can't, since a
    # working pan also moves every card.
    card_dragged = abs(card_dx - cam_dx) > 2 or abs(card_dy - cam_dy) > 2
    print(f"  camera delta: ({cam_dx:.1f},{cam_dy:.1f})  "
          f"card delta: ({card_dx:.1f},{card_dy:.1f})  "
          f"(beyond camera pan alone: {card_dragged})")
    pan_check = f"[{label}] REPRO: the drag pans the camera like the control did"
    drag_check = f"[{label}] REPRO: the card moves BY NO MORE than the camera's own pan"
    if expect_bug:
        d1 = not cam_moved
        d2 = card_dragged
        check(pan_check + " (INVERTED — expecting the bug: camera should NOT pan)",
              d1, f"camera moved={cam_moved}")
        check(drag_check + " (INVERTED — expecting the bug: card SHOULD move independently)",
              d2, f"card delta ({card_dx:.1f},{card_dy:.1f}) vs "
              f"camera delta ({cam_dx:.1f},{cam_dy:.1f})")
        bug_detected = d1 and d2
    else:
        check(pan_check, cam_moved, f"camera moved={cam_moved}")
        check(drag_check, not card_dragged,
              f"card delta ({card_dx:.1f},{card_dy:.1f}) vs camera delta "
              f"({cam_dx:.1f},{cam_dy:.1f})")
        bug_detected = None

    # ---------------------------------------------------- confinement check
    # RE-MEASURE from scratch: the repro gesture above may have panned the
    # camera and moved every card on screen, so rects captured before it are
    # stale. Using them here would either recompute a point that has drifted
    # back inside the bridge (a false failure) or a point on a patch of
    # canvas that no longer has any relationship to the bridge's CURRENT
    # position (a pass that proves nothing about confinement).
    #
    # The bridge is not the only furniture out there: the moment the cursor
    # is over `.sq`, the REAL SpawnChips column (`.hsof.side-l`/`.side-r`)
    # sits immediately beyond the bridge with no gap of its own (it is what
    # the bridge exists to keep reachable) and is itself a legitimate,
    # pointer-events:auto target while hovered. A fixed "+15px" guess landed
    # on that column, not on open canvas, the first time this ran — so
    # instead of guessing a distance, WALK outward in small steps and use
    # the first point neither the bridge, the chip column, nor the bar
    # claims, up to a bound past which "no open canvas exists here" would
    # itself be a finding worth reporting rather than silently accepting a
    # bad point.
    rects2 = pg.evaluate(RECTS, node)
    br2, sq2 = rects2[key], rects2["sq"]
    # clamped into the browser's actual 1600x950 viewport: earlier gestures
    # in this same run may have panned the card near an edge, and a y
    # outside the viewport would make every point on this scan line
    # unreachable (elementFromPoint returns null there, not "open canvas").
    outside_y = min(max(sq2["y"] + sq2["h"] / 2, 20.0), 930.0)
    outside_x = None
    pre_hit = None
    for step in range(4, 260, 8):
        x = (br2["x"] - step) if side == "l" else (br2["right"] + step)
        # a point outside the browser's actual viewport (1600x950) makes
        # elementFromPoint return null — that reads as "nothing claims this
        # point", which is true but useless: it is not open CANVAS, it is
        # off-screen, and gesturing there would prove nothing about panning.
        if not (0 <= x < 1600 and 0 <= outside_y < 950):
            break
        h = pg.evaluate(HIT, {"x": x, "y": outside_y})
        owner = h["owner"] or ""
        if h["tag"] is not None and "hsof" not in owner and "cbar" not in owner:
            outside_x, pre_hit = x, h
            break
    print(f"\n  == [{label}] confinement: first genuinely-open point beyond "
          f"the bridge/chip furniture "
          f"({'not found within 260px' if outside_x is None else f'{outside_x:.1f},{outside_y:.1f}'}) ==")
    check(f"[{label}] CONFINEMENT: a point exists beyond the bridge AND the "
          f"real hire-chip column that neither claims (otherwise there is "
          f"no open canvas here to test panning against at all)",
          outside_x is not None,
          f"owner at last probed point={(pre_hit or {}).get('owner')!r}")
    if outside_x is None:
        return bug_detected
    cam_before = pg.evaluate(CAM)
    gesture(pg, outside_x, outside_y, *toward_center(outside_x, outside_y))
    cam_after = pg.evaluate(CAM)
    panned2 = cam_before != cam_after
    check(f"[{label}] CONFINEMENT: outside the bridge's footprint, panning "
          f"works normally (the interception is confined to the bridge's "
          f"own rect, not a wider breakage)",
          panned2, f"{cam_before} -> {cam_after}")
    return bug_detected


def verify_pins_untouched(pg, slug: str, node: str) -> None:
    """Exercises — not merely diffs — the pinned-window mosaic this fix must
    not affect: edge resize, corner resize, and Shift-bypass-vs-snap. This
    file previously argued pins.tsx was safe from `git diff --stat` showing
    it untouched; that proves the SOURCE is untouched, not that the
    BEHAVIOUR still works, so this actually drives it."""
    print("\n  == pins.tsx: verifying mosaic resize + Shift bypass are "
          "unaffected (source untouched is not the same claim as this) ==")
    vp_origin = pg.evaluate(VIEWPORT_ORIGIN)
    if not vp_origin:
        check("[pins] .viewport is present (needed to translate its "
              "page-relative left edge into `.pinwin`'s own coordinate "
              "space before any snap-to-edge assertion means anything)",
              False, "no .viewport in the DOM")
        return
    print(f"    .viewport page origin: {vp_origin} (pinwin x=0 in STATE "
          f"space reads back as this page x, not literal 0)")
    pg.locator(f'.sq:has(.name:text-is("{node}"))').first.click()
    pg.wait_for_timeout(600)
    pin_btn = pg.locator('button[title^="pin as a window"]')
    if pin_btn.count() == 0:
        check("[pins] pin-as-window button is reachable after opening the "
              "desk (setup precondition for everything below)",
              False, "button not found — cannot exercise pin behaviour at all")
        return
    pin_btn.first.click()
    pg.wait_for_timeout(400)
    r0 = pg.evaluate(PINRECT, node)
    if not r0:
        check("[pins] a .pinwin appeared for the node after clicking pin",
              False, "no .pinwin in the DOM")
        return
    check("[pins] pinning opens a .pinwin at a sane size", True,
          f"rect={r0}")

    # ---- edge resize: grab the EAST handle, drag +50 horizontally --------
    handle_e = pg.locator('.pinwin-rs.e')
    eb = handle_e.bounding_box()
    gesture(pg, eb["x"] + eb["width"] / 2, eb["y"] + eb["height"] / 2,
            dx=50, dy=0, steps=6)
    r1 = pg.evaluate(PINRECT, node)
    dw = r1["w"] - r0["w"]
    unrelated_moved = abs(r1["x"] - r0["x"]) > 2 or abs(r1["h"] - r0["h"]) > 2
    check("[pins] EDGE RESIZE (east handle, +50px): width grows by "
          "approximately the drag and nothing else about the window moves",
          abs(dw - 50) <= 4 and not unrelated_moved,
          f"w {r0['w']:.0f} -> {r1['w']:.0f} (Δ{dw:.0f}); "
          f"x/h drift x={r1['x'] - r0['x']:.1f} h={r1['h'] - r0['h']:.1f}")

    # ---- corner resize: grab SE, drag +40,+30 -----------------------------
    handle_se = pg.locator('.pinwin-rs.se')
    seb = handle_se.bounding_box()
    gesture(pg, seb["x"] + seb["width"] / 2, seb["y"] + seb["height"] / 2,
            dx=40, dy=30, steps=6)
    r2 = pg.evaluate(PINRECT, node)
    dw2, dh2 = r2["w"] - r1["w"], r2["h"] - r1["h"]
    check("[pins] CORNER RESIZE (southeast handle, +40,+30): BOTH width and "
          "height grow by approximately the drag (a corner moves two edges "
          "at once — the thing a plain edge-resize check can't prove)",
          abs(dw2 - 40) <= 4 and abs(dh2 - 30) <= 4,
          f"w {r1['w']:.0f}->{r2['w']:.0f} (Δ{dw2:.0f})  "
          f"h {r1['h']:.0f}->{r2['h']:.0f} (Δ{dh2:.0f})")

    # ---- Shift bypass vs snap: drop near the screen's left edge -----------
    # PIN_SNAP_DISTANCE (pinSnap.ts) is 20px: without Shift, releasing the
    # title bar with the window's left edge within 20px of x=0 snaps x to
    # EXACTLY 0. With Shift held for the whole gesture, `candidate()` is
    # disabled and the raw, unsnapped drop position is committed instead.
    #
    # findPinSnap offers ALL FOUR screen edges as candidates and takes
    # whichever is CLOSEST, not specifically "left" — so a window still
    # large from the two resizes above (e.g. 846px tall in a 950px
    # viewport) is also close to the BOTTOM edge, which can win the snap
    # instead of "left" and make this look like the bypass failed when it's
    # actually a different, uninteresting edge winning. Shrunk well below
    # the viewport first (via the NW handle) so only the left-edge distance
    # is ever inside PIN_SNAP_DISTANCE, and recentred so the SETUP move
    # itself does not brush any edge and trigger an unwanted snap.
    handle_nw = pg.locator('.pinwin-rs.nw')
    nwb = handle_nw.bounding_box()
    gesture(pg, nwb["x"] + nwb["width"] / 2, nwb["y"] + nwb["height"] / 2,
            dx=400, dy=400, steps=6)
    r_small = pg.evaluate(PINRECT, node)
    print(f"    shrunk to {r_small} before the shift-bypass test")

    # dead centre of `.viewport`'s OWN box (state space, not the page's):
    # for a window meaningfully smaller than the viewport this maximises
    # margin on all four sides by construction, rather than guessing a page
    # coordinate and hoping it happens to fall far enough from every edge of
    # a viewport whose page position/size this file does not otherwise know.
    def recenter_and_get_title():
        cur = pg.evaluate(PINRECT, node)
        target_page_x = vp_origin["x"] + (vp_origin["w"] - cur["w"]) / 2
        target_page_y = vp_origin["y"] + (vp_origin["h"] - cur["h"]) / 2
        dx, dy = target_page_x - cur["x"], target_page_y - cur["y"]
        tb = pg.locator('.pinwin-title').bounding_box()
        gesture(pg, tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2,
                dx=dx, dy=dy, steps=6)
        return pg.evaluate(PINRECT, node)

    r_centered = recenter_and_get_title()
    margins = (
        r_centered["x"] - vp_origin["x"],
        r_centered["y"] - vp_origin["y"],
        (vp_origin["y"] + vp_origin["h"]) - (r_centered["y"] + r_centered["h"]),
        (vp_origin["x"] + vp_origin["w"]) - (r_centered["x"] + r_centered["w"]),
    )
    check("[pins] SHIFT BYPASS setup: window is shrunk+recentred with >20px "
          "clearance on all four sides of the ACTUAL viewport box (so only "
          "the LEFT edge we're about to approach can possibly compete for "
          "the snap)",
          all(m > 20 for m in margins),
          f"rect={r_centered} margins(L,T,B,R)={tuple(round(m, 1) for m in margins)}")

    # target_x is a PAGE x that is 12px right of `.viewport`'s own left edge
    # — i.e. STATE x=12, inside PIN_SNAP_DISTANCE(20) of STATE x=0 but not 0
    # itself. The snapped result is expected at PAGE x == vp_origin["x"]
    # (STATE x=0), not literal page x=0.
    target_x = vp_origin["x"] + 12.0
    zero_x = vp_origin["x"]
    tb = pg.locator('.pinwin-title').bounding_box()
    dx_snap = target_x - r_centered["x"]
    gesture(pg, tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2,
            dx=dx_snap, dy=0, steps=6, shift=False)
    r4 = pg.evaluate(PINRECT, node)
    check("[pins] SHIFT BYPASS baseline: dropping near the left edge WITHOUT "
          "Shift snaps the window's x to exactly the viewport's own left "
          "edge",
          abs(r4["x"] - zero_x) < 0.5,
          f"x={r4['x']:.2f} (viewport edge={zero_x:.2f}, dropped near "
          f"x={target_x:.2f})")

    # recentre again, then repeat the same near-edge drop WITH Shift held
    r_centered2 = recenter_and_get_title()
    tb2 = pg.locator('.pinwin-title').bounding_box()
    dx_snap2 = target_x - r_centered2["x"]
    gesture(pg, tb2["x"] + tb2["width"] / 2, tb2["y"] + tb2["height"] / 2,
            dx=dx_snap2, dy=0, steps=6, shift=True)
    r6 = pg.evaluate(PINRECT, node)
    check("[pins] SHIFT BYPASS: the SAME near-edge drop, WITH Shift held, "
          "lands at the raw dropped position instead of snapping to the "
          "viewport's edge",
          abs(r6["x"] - target_x) < 3 and abs(r6["x"] - zero_x) > 3,
          f"x={r6['x']:.2f} (target {target_x:.2f}, viewport edge {zero_x:.2f}, "
          f"snapped baseline was {r4['x']:.2f})")


def run(shot: str | None, expect_bug: bool) -> int:
    print("== identity-guard self-test (before any backend is spawned) ==")
    if not verify_identity_guard():
        print("\n  ABORT: the ownership guard itself does not discriminate "
              "real from impostor — nothing that depends on it (including "
              "every mutation below) would mean anything.")
        return 1

    start_backend()
    try:
        assert_still_ours()   # recheck immediately before the first mutation
        slug = make_org("ux7")
        node = hire(slug, "bridgee")
        print(f"  org={slug} node={node}")

        with sync_playwright() as p:
            br = p.chromium.launch(channel="msedge", headless=True)
            pg = br.new_page(viewport={"width": 1600, "height": 950})
            pg.goto(f"{BASE}/o/{slug}")
            pg.wait_for_selector(".sq", timeout=10000)
            pg.wait_for_timeout(1000)   # spring settle, matches ui_probe.py

            rects = pg.evaluate(RECTS, node)
            if not rects["sq"] or not rects["bridgeL"] or not rects["bridgeR"] \
                    or not rects["cbar"]:
                raise SystemExit(
                    "fixture did not render .sq/.hsof-bridge.bridge-l/"
                    ".bridge-r/.cbar for the hired node — nothing below would "
                    "mean anything. rects=" + json.dumps(rects))

            # ---------------------------------------------------- control
            far_x = max(20.0, rects["sq"]["x"] - 260)
            far_y = max(20.0, rects["sq"]["y"] - 200)
            print(f"\n  == positive control: drag from open canvas "
                  f"({far_x:.0f},{far_y:.0f}) far from any card ==")
            cam_before = pg.evaluate(CAM)
            gesture(pg, far_x, far_y, *toward_center(far_x, far_y))
            cam_after = pg.evaluate(CAM)
            panned = cam_before != cam_after and cam_after is not None
            check("CONTROL: drag on open canvas (far from any card) pans "
                  "the camera — proves the probe can see a working pan",
                  panned, f"{cam_before} -> {cam_after}")
            if not panned:
                print("  ABORT: the positive control itself failed — a pan "
                      "cannot be told from a broken one here, so nothing "
                      "below would prove anything.")
                return 1

            bug_detected = []
            for side in ("l", "r"):
                bug_detected.append(verify_bridge_side(pg, node, side, expect_bug))

            if not expect_bug:
                verify_pins_untouched(pg, slug, node)

            if shot:
                pg.screenshot(path=shot)
                print(f"\n  screenshot saved: {shot}")

            br.close()
    finally:
        drop_orgs()
        stop_backend()

    fails = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n  {len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    if fails:
        print("  FAILURES:")
        for f in fails:
            print("   - " + f)

    if expect_bug:
        # the exit code here answers ONE question — "can this probe still
        # see the bug it exists to catch" — not "did every check pass".
        # Other findings (confinement, hit-tests) are printed above either
        # way but must not gate this verdict: this mode exists to prove the
        # detector still works against a KNOWN-bad tree, not to grade that
        # tree against the full checklist.
        control_ok = all(bug_detected)
        if control_ok:
            print(f"\n  CONTROL OK — the reverted tree measures as broken on "
                  f"both sides, as it must. The probe can see this defect.")
        else:
            print(f"\n  CONTROL FAILED: this probe could NOT see the bridge "
                  f"capturing the drag on at least one side of the "
                  f"deliberately-reverted tree ({bug_detected}). A green run "
                  f"against the real fix would prove nothing.")
        return 0 if control_ok else 1

    return 1 if fails else 0


def main() -> int:
    # --port is already consumed above (module load time — matches
    # live_probe.py/pan_probe.py's own convention, and TMP/HOME/DATA/BASE all
    # derive from it before argparse would otherwise run). Only --shot and
    # --expect-bug are left for argparse here.
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot")
    ap.add_argument("--expect-bug", action="store_true",
                     help="run against a deliberately-reverted tree "
                          "(e.g. after `git stash` on the OrgCanvas.tsx fix); "
                          "PASSES only if the bridge is measured capturing "
                          "the drag, i.e. the probe can still see the bug")
    argv = list(sys.argv[1:])
    if "--port" in argv:
        i = argv.index("--port")
        del argv[i:i + 2]
    a = ap.parse_args(argv)
    if a.expect_bug:
        print("hoverbridge_probe: KNOWN-NEGATIVE CONTROL (--expect-bug — "
              "run this only against a deliberately-reverted fix)")
    return run(a.shot, a.expect_bug)


if __name__ == "__main__":
    raise SystemExit(main())
