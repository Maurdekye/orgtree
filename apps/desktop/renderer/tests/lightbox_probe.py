"""lightbox_probe.py — user report: a presented document's image shows the
zoom-in cursor but clicking it does not open the lightbox viewer.

THE SUSPECTED MECHANISM (Astra's read of the source, verified below by
actually running it):

  * canvas/lightbox.ts opens the full-size viewer from ONE document-level,
    BUBBLE-phase `click` listener matching `.md img` (there are no per-image
    React handlers — markdown bodies are raw innerHTML). For this listener
    to ever fire, a click on an eligible image has to bubble all the way up
    the DOM to `document` uninterrupted.

  * canvas/docs.tsx's `DocReader` wraps its whole panel — including the
    `.doc-reader-body.md` markdown body the image lives in — in a div whose
    own `onClick` calls `e.stopPropagation()`:

        <div className="settings doc-reader" onClick={(e) => e.stopPropagation()}>

    That div exists so a click ANYWHERE inside the reader (buttons, text,
    whitespace) does not bubble out to the surrounding `.overlay`'s own
    `onClick={close}` and close the whole reader — the standard
    click-inside-a-modal-must-not-close-it pattern. But it stops ALL clicks
    unconditionally, including ones on an image that should reach
    lightbox.ts's document listener. The image never gets there, so
    `openLightbox` never runs, and nothing appears to happen.

  * Ordinary chat messages (desk.tsx's `.msgtext.md`) have no such wrapper
    between them and `document` — chat images are NOT expected to be
    affected. This file's "positive control" proves that directly, so a
    failure to reproduce the doc-reader case can't be blamed on the shared
    mechanism being broken everywhere.

THE FIX THIS PROBE VERIFIES (narrow, in docs.tsx only): the doc-reader div's
onClick now recognises an eligible lightbox image specifically and, for that
one case, opens the lightbox itself (calling the same `openLightbox` the
document listener would have called) while STILL stopping propagation —
so the click never reaches `.overlay`'s close handler either. Everything
else about the div's behaviour (blocking every other click from closing the
reader) is untouched. lightbox.ts's own document listener, its backdrop/Esc
close behaviour, and the "an image wrapped in a link keeps the link" rule
are all untouched by this fix and are exercised here as controls.

WHY A REAL BROWSER AGAINST A REAL (DISPOSABLE) BACKEND. The defect is in
DOM/React event bubbling order, which a component-level unit test (mounting
`DocReader` in isolation, no real `.overlay` ancestor, no real `document`
listener registered) cannot reproduce by construction — it would be
measuring a tree the app never assembles. This drives the real app's real
DOM against a disposable org, never the operator's live backend on :7360 or
any real org.

WHY THE DOCUMENT AND THE CHAT REPLY ARE SEEDED DIRECTLY VIA THE STORE, NOT
OVER HTTP. `present_document`/documents have no POST endpoint of their own
(they're reached through the `orgtree_present` MCP tool during a live
agent turn) — but ledger.Org exposes the exact same method directly, and
the org/node/document are created and SAVED before the disposable backend
is ever started, so there is no concurrent read-modify-write race with a
live server touching the same file (see api.py's own "ONE BACKEND PER DATA
ROOT" comment on `store.claim_data_root` for why that race is real). The
one thing that DOES need a live turn — an assistant chat reply containing
an image, for the positive control — goes through the normal message POST
and a scripted fake CLI (no real model call), exactly like live_probe.py's
D-56c section next door.

WHAT IS MEASURED
  1. POSITIVE CONTROL: an ordinary assistant chat message containing an
     image. Clicking it must open `.lb-overlay` with the right image. If
     this fails, the shared lightbox mechanism itself is broken and
     nothing about the doc-reader case below would mean anything.
  2. REPRODUCTION: the presented document's image. Clicking it is checked
     against BOTH of the user's two symptoms at once — does `.lb-overlay`
     appear, AND does `.doc-reader` stay open (a fix that only reopens the
     bubble path without also blocking `.overlay`'s close would trade one
     bug for another: the lightbox would open by closing the document out
     from under it).
  3. LIGHTBOX CLOSE PATHS, from the doc-reader-opened lightbox: Escape, and
     a backdrop click — both must close ONLY the lightbox, never the
     underlying `.doc-reader`.
  4. LINK-WRAPPED IMAGE: an image inside an `<a>` in the SAME document must
     NOT open the lightbox (lightbox.ts's own rule) — checked by seeding a
     second document whose image is link-wrapped.
  5. REGRESSION GUARD: a plain (non-image) click inside the reader — on
     ordinary text — must still NOT close the reader, exactly as before
     this fix. A fix that broadened the exemption past images specifically
     would show up here.

USAGE
    python frontend/tests/lightbox_probe.py
    python frontend/tests/lightbox_probe.py --shot out.png

Requires playwright (msedge channel), fastapi, uvicorn, websockets, psutil.
Starts its own backend on a dedicated port with a throwaway ORGTREE_DATA/
HOME; the same OS-level ownership guard as hoverbridge_probe.py next door
(actual LISTEN-socket PID match, not an HTTP response) gates every mutation;
deletes the org it creates; kills its own backend child on every exit path.
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
_BACKEND = os.path.join(_REPO, "backend")

from playwright.sync_api import sync_playwright  # noqa: E402

# --------------------------------------------------------------------- rig
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7420
BASE = f"http://127.0.0.1:{PORT}"

TMP = tempfile.mkdtemp(prefix="orgtree-lightbox-probe-")
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

# D-199 fixture (same as hoverbridge_probe.py / live_probe.py): an isolated
# HOME has no detected Claude, and the hire gate refuses a Claude tier hire
# on a machine with none.
with open(os.path.join(HOME, ".claude.json"), "w", encoding="utf-8") as _f:
    json.dump({"oauthAccount": {
        "accountUuid": "lightbox-probe-uuid",
        "emailAddress": "lightbox-probe@example.test",
    }}, _f)

# the mail-hub isolation warning from backend/tests/test_present.py §0: a
# throwaway ORGTREE_DATA does not isolate net._default_address, which falls
# back to the operator's real hub when this root has no defaults.json.
with open(os.path.join(DATA, "defaults.json"), "w", encoding="utf-8") as _f:
    _f.write('{"net_hub_address": "http://127.0.0.1:9"}')

# ⚠ own throwaway ORGTREE_DATA, SET then ASSERTED before any orgtree import.
# store.DATA_ROOT binds at import time — importing store (or anything that
# imports it) before this would bind the rest of THIS PROCESS to whatever
# ORGTREE_DATA happened to be in the inherited environment, which on this
# machine is the operator's live root.
os.environ["ORGTREE_DATA"] = DATA
os.environ["USERPROFILE"] = HOME
os.environ["HOME"] = HOME
sys.path.insert(0, _BACKEND)

from orgtree import store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

assert store.DATA_ROOT == DATA, (
    f"store.DATA_ROOT resolved to {store.DATA_ROOT!r}, not our throwaway "
    f"{DATA!r} — refusing to run any store call. Something set ORGTREE_DATA "
    f"differently, or store was imported earlier than this line.")

# a tiny (1x1) transparent PNG, inline — no network fetch, no relative-path
# resolution, loads instantly and deterministically so `naturalWidth` is
# real by the time a test clicks it.
TINY_PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1"
            "HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")

PROC: subprocess.Popen | None = None
_ORGS: list[str] = []
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# --------------------------------------------------------- seeding (no HTTP)
def seed_org(label: str) -> str:
    """A fresh org via the same store.create_org every real org goes
    through. Tracked for cleanup via the normal DELETE endpoint once the
    backend is up (store.delete_org is not used here — going through the
    real API exercises the same teardown path a user's client would)."""
    org = store.create_org(f"zz lightbox-probe {label}"[:60])
    slug = org.d["slug"]
    _ORGS.append(slug)
    return slug


def seed_node(slug: str, name: str) -> str:
    org = store.load_org(slug)
    r = org.hire(USER, None, "haiku", 2, name)
    store.save_org(org)
    return r["node"]


def seed_document(slug: str, node: str, title: str, body: str) -> str:
    org = store.load_org(slug)
    r = org.present_document(node, title, body)
    store.save_org(org)
    return r["presented"]


# -------------------------------------------------------------- ownership
# Identical mechanism to hoverbridge_probe.py's (reviewed and landed
# 2026-09-05): an HTTP response alone is never ownership proof — the OS's
# own report of who holds the LISTEN socket is.
def _port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _listener_pid(port: int) -> int | None:
    for c in psutil.net_connections(kind="tcp"):
        if (c.status == psutil.CONN_LISTEN and c.laddr
                and c.laddr.port == port
                and c.laddr.ip in ("127.0.0.1", "0.0.0.0", "::1", "::")):
            return c.pid
    return None


class _NotReady(Exception):
    pass


class _OwnershipViolation(RuntimeError):
    pass


def _check_ownership(port: int, expected_pid: int) -> None:
    pid = _listener_pid(port)
    if pid is None:
        raise _NotReady(f"nothing listening on {port} yet")
    if pid != expected_pid:
        raise _OwnershipViolation(
            f"port {port}'s actual LISTEN owner is pid {pid}, not the "
            f"expected {expected_pid}")
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
            f"pid {pid} answered /api/orgs with a non-list payload {data!r}")
    # unlike hoverbridge_probe.py, THIS run seeds an org directly via the
    # store before the backend starts — a non-empty list here is EXPECTED
    # (it is our own seeded org), so ownership does not require emptiness,
    # only that the answering pid is ours and the shape is the real one.


def _free_ephemeral_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _serve_json(port: int, payload):
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
    """Same self-test as hoverbridge_probe.py: proves the ownership check
    discriminates a genuinely-owned server from an impostor answering the
    same shape, before it is trusted for the real run."""
    all_ok = True
    port_a = _free_ephemeral_port()
    srv_a, t_a = _serve_json(port_a, [])
    try:
        try:
            _check_ownership(port_a, os.getpid())
            check("[identity-guard] ACCEPTS a genuinely owned, "
                  "correctly-shaped server", True)
        except Exception as e:                                    # noqa: BLE001
            check("[identity-guard] ACCEPTS a genuinely owned, "
                  "correctly-shaped server", False, str(e))
            all_ok = False
        bogus_pid = os.getpid() + 1
        try:
            _check_ownership(port_a, bogus_pid)
            check("[identity-guard] REJECTS the same server when the "
                  "expected owner PID does not match",
                  False, "did not raise — accepted an impostor")
            all_ok = False
        except RuntimeError:
            check("[identity-guard] REJECTS the same server when the "
                  "expected owner PID does not match", True)
    finally:
        srv_a.shutdown()
        t_a.join(timeout=2)

    port_b = _free_ephemeral_port()
    srv_b, t_b = _serve_json(port_b, {})
    try:
        try:
            _check_ownership(port_b, os.getpid())
            check("[identity-guard] REJECTS a genuinely owned server whose "
                  "response is the wrong SHAPE ({} instead of a list)",
                  False, "did not raise")
            all_ok = False
        except RuntimeError:
            check("[identity-guard] REJECTS a genuinely owned server whose "
                  "response is the wrong SHAPE ({} instead of a list)", True)
    finally:
        srv_b.shutdown()
        t_b.join(timeout=2)
    return all_ok


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


def start_backend() -> None:
    global PROC
    if not _port_free(PORT):
        raise RuntimeError(
            f"port {PORT} is already bound by another process — refusing "
            f"to start. Pass --port with a free one.")
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": DATA, "USERPROFILE": HOME, "HOME": HOME,
        "ORGTREE_PORT": str(PORT),
        "FAKECLI_CONFIG": CFG,
        "ORGTREE_MAX_TURNS": "16",
        "ORGTREE_STEER_HOOK": "0",
        "ORGTREE_TURN_TIMEOUT": "60",
        "PYTHONPATH": _BACKEND,
        "PYTHONIOENCODING": "utf-8",
        "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_CLAUDE": os.path.join(_BACKEND, "tests", "fakecli.js"),
        "ORGTREE_CLAUDE_CLI": os.path.join(_BACKEND, "tests", "fakecli.js"),
    })
    env.pop("ORGTREE_PUBLIC_PORT", None)
    env.pop("ORGTREE_EXPOSE_ADMIN", None)
    # the CALLER sets fakecli's config before calling this, not here: a node
    # already exists on disk (seeded before this function ever runs), and
    # the backend warms a CLI session for it as part of ITS OWN startup —
    # which reads FAKECLI_CONFIG at THAT moment. Setting it here, after
    # spawning, would be too late for that already-warmed session (measured:
    # a config write after start_backend() returned was silently ignored by
    # the first turn, which answered with CFG_DEFAULT's own 'ack.' instead).
    if not os.path.exists(CFG):
        raise RuntimeError(
            "start_backend() called before the caller set up FAKECLI_CONFIG "
            "— the node this org already has would warm with no config file "
            "to read at all")
    log = open(LOG, "a", encoding="utf-8")
    PROC = subprocess.Popen(
        [sys.executable, "-m", "orgtree.api"], cwd=_BACKEND,
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
            print(f"backend up on :{PORT}  pid={PROC.pid}  (data={DATA}  "
                  f"home={HOME}) — ownership confirmed: OS reports our "
                  f"spawned pid as the port's actual listener")
            return
        raise RuntimeError(f"backend did not come up on {PORT}:\n" + _log_tail())
    except Exception:
        stop_backend()
        raise


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


def drop_orgs() -> None:
    for slug in list(_ORGS):
        try:
            api("DELETE", f"/api/orgs/{slug}")
        except Exception as e:                                    # noqa: BLE001
            print(f"  (cleanup) failed to delete {slug}: {e}")


# ------------------------------------------------------------- the browser
LB = """
() => {
  const ov = document.querySelector('.lb-overlay');
  if (!ov) return null;
  const img = ov.querySelector('.lb-img');
  return { present: true, src: img ? img.src : null };
}
"""


def gesture_click(pg, loc) -> None:
    """A raw mouse click at the element's bounding-box centre, not
    `loc.click()`. The seeded test images are tiny (their real content
    doesn't matter, only that the browser considers them loaded), and once
    scaled down inside the world-transformed desk view their on-screen
    footprint can be under 1 CSS pixel — which Playwright's own
    actionability check reports as "outside of the viewport" even though
    the coordinates are well inside it (measured: bbox {'width': 0.87,
    'height': 0.88} at x=428,y=590 in a 1600x950 viewport, timing out
    forever). A plain coordinate click has no such heuristic."""
    loc.scroll_into_view_if_needed()
    box = loc.bounding_box()
    if box is None:
        raise RuntimeError("element has no bounding box — not rendered")
    pg.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.wait_for_timeout(150)


def run(shot: str | None) -> int:
    print("== identity-guard self-test (before any backend is spawned) ==")
    if not verify_identity_guard():
        print("\n  ABORT: the ownership guard does not discriminate real "
              "from impostor — nothing that depends on it would mean "
              "anything.")
        return 1

    # ---- seed BEFORE the backend starts: no concurrent writer exists yet
    slug = seed_org("lb")
    node = seed_node(slug, "presenter")
    doc_id = seed_document(
        slug, node, "Work docket — visual concept v1",
        "# a plan\n\nhere is a figure:\n\n"
        f"![a tiny test image]({TINY_PNG})\n")
    link_doc_id = seed_document(
        slug, node, "linked figure",
        f"[![linked test image]({TINY_PNG})](#)\n")
    print(f"  seeded org={slug} node={node} doc={doc_id} link_doc={link_doc_id}")
    # ⚠ store's SQLite connection pool (store._POOL) keeps connections IDLE
    # for reuse rather than closing them after each call — so the seeding
    # above left an open, pooled connection to this org's .db file in THIS
    # process. On Windows a file with an open handle cannot be renamed, and
    # the backend subprocess's own delete_org does exactly that (a rename
    # into deleted/); its own close_all only reaches ITS OWN pool, never a
    # different process's. Measured: DELETE hung ~7.8s then 500'd every run
    # until this was added. Using the private pool directly (no public
    # wrapper exists) because this is a test releasing ITS OWN handle, not
    # production code reaching into another process's state.
    store._POOL.close_all(slug)

    # set BEFORE start_backend(): the node already exists on disk, and the
    # backend warms a CLI session for it as part of its own startup — which
    # reads this file at that moment, not when a message later arrives.
    set_cfg(replyText="a chat reply with a figure:\n\n"
                       f"![chat test image]({TINY_PNG})\n",
            echoMs=5, firstEventMs=10, resultMs=5, thinkMs=0, deltaMs=0,
            tools=0)

    start_backend()
    try:
        _check_ownership(PORT, PROC.pid)   # recheck immediately before the
                                            # first mutating HTTP call below

        # ---- get an assistant chat reply containing an image, for the
        # positive control — the one thing that needs a real (fake) turn
        api("POST", f"/api/orgs/{slug}/nodes/{node}/message",
            {"text": "send me a figure"})
        for _ in range(300):
            c = api("GET", f"/api/orgs/{slug}/nodes/{node}/chat")
            if not c["busy"] and c["queued"] == 0:
                break
            time.sleep(0.2)
        else:
            raise SystemExit("the seeded turn never finished draining")

        with sync_playwright() as p:
            br = p.chromium.launch(channel="msedge", headless=True)
            pg = br.new_page(viewport={"width": 1600, "height": 950})
            pg.goto(f"{BASE}/o/{slug}")
            pg.wait_for_selector(".sq", timeout=10000)
            pg.wait_for_timeout(800)

            # ============================================== 1. positive control
            print("\n  == positive control: ordinary chat image ==")
            pg.locator(f'.sq:has(.name:text-is("{node}"))').first.click()
            pg.wait_for_timeout(1500)   # let the focus/zoom spring settle
            pg.wait_for_selector(".msgtext.md img", timeout=10000)
            chat_img = pg.locator(".msgtext.md img").first
            gesture_click(pg, chat_img)
            lb = pg.evaluate(LB)
            check("CONTROL: clicking an ordinary chat image opens the "
                  "lightbox — proves the shared mechanism works at all",
                  bool(lb and lb["present"]), f"lb={lb}")
            if lb and lb["present"]:
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(150)
                lb2 = pg.evaluate(LB)
                check("CONTROL: Escape closes the chat-image lightbox",
                      lb2 is None, f"lb after Escape={lb2}")
            if not (lb and lb["present"]):
                print("  ABORT: the positive control itself failed — the "
                      "shared lightbox mechanism cannot be trusted here, so "
                      "the doc-reader checks below would prove nothing.")
                return 1

            # ============================================ 2. reproduction
            print("\n  == reproduction: presented-document image ==")
            # DocChips only render on the OVERVIEW card, not the focused
            # desk we zoomed into for the chat control above — a fresh
            # navigation resets the camera to the overview fit-on-load,
            # which is simpler and more reliable than reverse-engineering
            # whatever gesture zooms back out.
            pg.goto(f"{BASE}/o/{slug}")
            pg.wait_for_selector(".sq", timeout=10000)
            pg.wait_for_timeout(800)
            chip = pg.locator(f'.doc-chip[title*="Work docket"]').first
            gesture_click(pg, chip)
            pg.wait_for_selector(".doc-reader", timeout=10000)
            pg.wait_for_selector(".doc-reader-body.md img", timeout=10000)
            doc_img = pg.locator(".doc-reader-body.md img").first
            gesture_click(pg, doc_img)
            lb = pg.evaluate(LB)
            reader_open = pg.locator(".doc-reader").count() > 0
            check("REPRO: clicking the presented document's image opens "
                  "the lightbox", bool(lb and lb["present"]), f"lb={lb}")
            check("REPRO: the underlying document reader is still open "
                  "(the click did not ALSO close it via the backdrop)",
                  reader_open, f".doc-reader count="
                  f"{pg.locator('.doc-reader').count()}")
            if lb and lb["present"] and doc_img.get_attribute("src"):
                src_ok = lb["src"] == doc_img.evaluate("el => el.currentSrc || el.src")
                check("REPRO: the lightbox shows the SAME image that was "
                      "clicked", src_ok, f"lb src={lb['src']!r}")

            # =================================== 3. lightbox close paths
            if lb and lb["present"]:
                print("\n  == close path: Escape closes lightbox, not reader ==")
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(150)
                check("Escape closes the lightbox", pg.evaluate(LB) is None)
                check("...without closing the document reader",
                      pg.locator(".doc-reader").count() > 0)

                print("\n  == close path: backdrop click closes lightbox, "
                      "not reader ==")
                gesture_click(pg, doc_img)
                check("re-opened for the backdrop test",
                      bool(pg.evaluate(LB)))
                # click the overlay itself, well away from the image/bar —
                # .lb-overlay fills the viewport, so a corner is backdrop
                pg.mouse.click(20, 20)
                pg.wait_for_timeout(150)
                check("backdrop click closes the lightbox",
                      pg.evaluate(LB) is None)
                check("...without closing the document reader",
                      pg.locator(".doc-reader").count() > 0)

            # ============================ 4. regression: non-image click
            print("\n  == regression: a plain (non-image) click inside the "
                  "reader still does not close it ==")
            head = pg.locator(".doc-reader-head b").first
            gesture_click(pg, head)
            check("clicking the document's own title text does not close "
                  "the reader (unchanged pre-fix behaviour)",
                  pg.locator(".doc-reader").count() > 0)

            # close the reader normally (X button) before moving to the
            # link-wrapped case, to start that one from a clean state
            pg.locator(".doc-reader .chip-x").first.click()
            pg.wait_for_timeout(150)
            check("the reader's own close (X) button still closes it "
                  "normally", pg.locator(".doc-reader").count() == 0)

            # ==================================== 5. link-wrapped image
            print("\n  == link-wrapped image: no lightbox, link wins ==")
            link_chip = pg.locator('.doc-chip[title*="linked figure"]').first
            gesture_click(pg, link_chip)
            pg.wait_for_selector(".doc-reader-body.md img", timeout=10000)
            link_img = pg.locator(".doc-reader-body.md img").first
            gesture_click(pg, link_img)
            check("clicking an image WRAPPED IN A LINK does not open the "
                  "lightbox (the link keeps precedence, per lightbox.ts's "
                  "own rule)", pg.evaluate(LB) is None)
            check("...and the reader itself is unaffected either way",
                  pg.locator(".doc-reader").count() > 0)
            pg.locator(".doc-reader .chip-x").first.click()
            pg.wait_for_timeout(150)

            # ============================== 6. gallery: the SAME fix site,
            # a DIFFERENT surface (gallery.tsx's DocPane, not docs.tsx's
            # DocReader) — same stopPropagation-around-.md pattern, same fix
            print("\n  == gallery: the same document's image, via the "
                  "toolbar gallery instead of the canvas doc chip ==")
            pg.locator(".doc-bell").first.click()
            pg.wait_for_selector(".gallery-modal", timeout=10000)
            pg.locator('.doc-gallery-row[title*="Work docket"]').first.click()
            pg.wait_for_selector(".mailer-body.md img", timeout=10000)
            gallery_img = pg.locator(".mailer-body.md img").first
            gesture_click(pg, gallery_img)
            lb = pg.evaluate(LB)
            check("GALLERY: clicking the document's image in the gallery "
                  "reading pane opens the lightbox", bool(lb and lb["present"]),
                  f"lb={lb}")
            check("GALLERY: the gallery modal is still open (the click did "
                  "not ALSO close it via its own backdrop)",
                  pg.locator(".gallery-modal").count() > 0)
            if lb and lb["present"]:
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(150)
                check("GALLERY: Escape closes the lightbox, not the gallery",
                      pg.evaluate(LB) is None
                      and pg.locator(".gallery-modal").count() > 0)

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
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot")
    argv = list(sys.argv[1:])
    if "--port" in argv:
        i = argv.index("--port")
        del argv[i:i + 2]
    a = ap.parse_args(argv)
    return run(a.shot)


if __name__ == "__main__":
    raise SystemExit(main())
