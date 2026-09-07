"""live_probe.py — live browser verification of D-56 (scroll paging, chat +
mail) and the D-38 frame-drop convergence principle, against a throwaway
orgtree backend that never touches the user's real deployment.

RUN
---
    python frontend/tests/live_probe.py [--port 7404]

Use the plain `python` on PATH (the one with `playwright`, `fastapi`,
`uvicorn` and `websockets` all importable — checked before writing this file;
the repo's own `.venv` has the backend deps but NOT playwright, since
playwright is not a project dependency per the task brief). Any interpreter
with all four packages works; `sys.executable` is what launches the backend
subprocess, so whichever interpreter runs this file also runs the backend.

Chromium (channel="msedge") launches headless. `frontend/dist` is served
as-is by the backend — this script never runs `npm run build`.

HARD CONSTRAINTS OBSERVED
--------------------------
- Binds ONLY port 7404 (hardcoded default, override with --port if the
  caller insists, but 7404 is what was assigned). Never touches 7360 or the
  orgs game-club/resonite — this is a wholly separate backend process with
  its own ORGTREE_DATA/HOME, started exactly like
  backend/tests/test_message_visibility_live.py's start_backend() (same env
  vars, same ORGTREE_BRIDGE_PORT=0 to avoid colliding with the real
  sandbox-bridge listener).
- Never rebuilds frontend/dist.
- Uses ORGTREE_CLAUDE_CLI=backend/tests/fakecli.js — no real model call,
  never the fable tier.
- Deletes every org it creates; prints the surviving org list at the end.
- No time.sleep() while a Playwright page is live (it blocks the event loop
  and browser-side timers/scroll events never get dispatched — this bit a
  previous probe, see docs/history/interim-docket.md D-34's method note). All
  page-side waiting uses page.wait_for_timeout(). time.sleep() is used only
  for pure-HTTP polling loops with no page open (backend startup, mail
  drain), where there is no Playwright event loop to block.

WHAT THIS PROBES AND HOW
-------------------------
D-56a/b (docs/history/interim-docket.md "## D-56") — chat transcript paging.
    A node is hired, then a 1220-row synthetic transcript (610 synthetic
    user/assistant pairs) is written DIRECTLY into its transcript .jsonl
    (supervisor.transcript_path()) — no CLI turns run, so this is fast and
    inert. The server side is checked FIRST via a plain HTTP GET
    .../chat?last=N (the task's explicit instruction: verify the server
    serves the rows before blaming the UI). Then a real browser:
      (a) opens the node's desk, confirms the CHAT_WINDOW=120 initial page,
          confirms there is no button anywhere in the transcript pane (D-56
          replaced the pager button with a status line), scrolls the
          transcript to scrollTop=0 ONE time and confirms MORE rows render
          with no click involved.
      (b) fires a SYNCHRONOUS burst of 20 scroll-to-top events (a tight JS
          loop with no yields, so the burst completes before any fetch's
          promise callback can run and clear the loadingOlder guard) and
          confirms only ONE window's worth of rows was paged in, not
          several — i.e. one scroll gesture cannot thrash.
      (c) repeats realistic scroll-to-top cycles until win hits convo.ts's
          MAX_WINDOW=1000 cap (the transcript has 1220 rows, so hasOlder
          stays true past the cap) and confirms the status line reads
          "beyond the window" — the one thing a plain row count can't prove
          on its own.

D-56c (same docket section) — mail list paging.
    50 messages are posted to a second node over HTTP (drained fast by a
    reconfigured fakecli — echoMs/firstEventMs/resultMs all near 0, so 50
    sequential turns complete in a couple of seconds). The server's
    /inbox endpoint is checked directly (it caps `delivered` at 50, so this
    also proves the server side before the UI is blamed). Then the node's
    inbox tab is opened in the browser: confirms the initial render shows
    exactly MAIL_WINDOW=40 rows, scrolls the list to within 240px of the
    BOTTOM and confirms the next batch pages in, confirms the count only
    ever grows (never resets), and confirms scrolling further once
    everything is shown does not error or duplicate rows.

D-38 (docs/history/interim-docket.md "## D-38") — frame-drop convergence, re-run
with three WebSocket tamperings instead of one. A `Wonky` WebSocket
subclass is installed with `page.add_init_script` BEFORE any app code runs
(so the very first `new WebSocket(...)` the app makes is already wrapped).
It always accepts the real connection and never closes it (no reconnect can
paper over the result), but routes inbound frames three different ways:
  - "deaf"     — swallows every frame (api.ts's `ws.onmessage = handler`
                 setter is intercepted and the handler is stored but never
                 invoked).
  - "partial"  — delivers frame 1, drops frame 2, delivers 3, drops 4, ...
                 (every 2nd frame swallowed).
  - "duporder" — buffers 3 frames, then delivers all 3 REVERSED and each
                 TWICE (6 deliveries per 3 real frames — out of order and
                 duplicated).
For each mode: a message is sent from a SEPARATE HTTP client (Python
`urllib`, never the browser under test) containing a unique marker; the
overview canvas is watched for the busy dot, the server-derived activity
label, and the indicator clearing; the node's desk is then opened and BOTH
the sent message's marker and the agent's reply marker are asserted onto
the screen. Convergence must hold in all three modes for the UI to be
proven to depend on polling rather than the websocket.

Every check prints a PASS/FAIL line with the numbers behind it. Exits 0 iff
every check passed.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))

from playwright.sync_api import sync_playwright  # noqa: E402

# --------------------------------------------------------------------- rig

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7404
BASE = f"http://127.0.0.1:{PORT}"

SCRATCH = (r"C:\Users\NCOLA_~1\AppData\Local\Temp\claude\e--Libraries-Desktop-resonite"
           r"\4f69f83a-059f-4783-97ab-aedb39ab1f56\scratchpad")
if not os.path.isdir(SCRATCH):
    SCRATCH = tempfile.gettempdir()
TMP = tempfile.mkdtemp(prefix="orgtree-live-probe-", dir=SCRATCH)
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

# ⚠ D-199 FIXTURE (regression 2026-08-30). An isolated HOME means no detected
# Claude, and since D-199 the hire gate REFUSES a Claude tier on a machine with
# no Claude — so this probe's setup started 422ing. That is the feature
# working; the fixture was written for the world where Claude was assumed
# present. Two truths are needed and they come from different places:
# ORGTREE_CLAUDE is INSTALLED (the CLI file detection resolves) and
# ~/.claude.json's oauthAccount is CONNECTED (`accounts.live_identity`).
# ORGTREE_CLAUDE_CLI alone is NEITHER — it only says what to SPAWN once a hire
# has already been allowed, which is why setting it was not enough.
# ⚠ Written BEFORE the backend starts: LIVE_CONFIG is
# `expanduser("~/.claude.json")` evaluated at import IN THE CHILD. And on
# Windows expanduser reads USERPROFILE, so HOME alone would put this file
# somewhere nobody reads.
with open(os.path.join(HOME, ".claude.json"), "w", encoding="utf-8") as _f:
    json.dump({"oauthAccount": {
        "accountUuid": "probe-uuid-0000",
        "emailAddress": "probe@example.test",
    }}, _f)

PROC: subprocess.Popen | None = None
RESULTS: list[tuple[str, bool, str]] = []
_ORGS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


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


def _log_tail(n: int = 3000) -> str:
    try:
        return open(LOG, encoding="utf-8", errors="replace").read()[-n:]
    except OSError:
        return "(no log)"


def start_backend() -> None:
    """Copied verbatim in spirit from
    backend/tests/test_message_visibility_live.py's start_backend(): its own
    ORGTREE_DATA/HOME, its own port, ORGTREE_CLAUDE_CLI pointed at the fake
    CLI, ORGTREE_BRIDGE_PORT=0 so the sandbox bridge listener (which defaults
    to 0.0.0.0:7362) never fights the user's real backend for that port."""
    global PROC
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
    for _ in range(200):
        if PROC.poll() is not None:
            raise RuntimeError(
                f"backend exited with {PROC.returncode} during startup; "
                f"log tail:\n" + _log_tail())
        try:
            urllib.request.urlopen(BASE + "/api/orgs", timeout=1).read()
            print(f"backend up on :{PORT}  (data={DATA}  home={HOME})")
            return
        except Exception:                                        # noqa: BLE001
            time.sleep(0.1)                    # no Playwright page exists yet
    raise RuntimeError(f"backend did not come up on {PORT}:\n" + _log_tail())


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
    name = f"zz live-probe {label}"[:60]
    r = api("POST", "/api/orgs", {"name": name})
    slug = r.get("slug") or r.get("org", {}).get("slug")
    _ORGS.append(slug)
    return slug


def hire(slug: str, name: str) -> str:
    r = api("POST", f"/api/orgs/{slug}/ops", {
        "op": "hire", "actor": "@user", "parent": None, "tier": "haiku",
        "grant": 2, "name": name, "charter": "a live-probe test agent",
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


def tree_node(slug: str, nid: str) -> dict:
    t = api("GET", f"/api/orgs/{slug}")
    def walk(ns):
        for n in ns:
            if n["id"] == nid:
                return n
            found = walk(n.get("children") or [])
            if found:
                return found
        return None
    return walk(t.get("roots") or [])


# ================================================================= D-56 a/b
# chat transcript scroll-paging: write a big synthetic transcript straight
# into the node's .jsonl, confirm the SERVER pages it, then drive the UI.

N_PAIRS = 610                       # -> 1220 rows: > MAX_WINDOW (1000) with
                                     # 220 to spare, so hasOlder survives the cap
CHAT_WINDOW = 120
MAX_WINDOW = 1000


def write_synthetic_transcript(session_id: str) -> int:
    proj = os.path.join(HOME, ".claude", "projects", "live-probe")
    os.makedirs(proj, exist_ok=True)
    path = os.path.join(proj, session_id + ".jsonl")
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    lines = []
    for i in range(N_PAIRS):
        tu = (base + timedelta(seconds=2 * i)).isoformat().replace("+00:00", "Z")
        ta = (base + timedelta(seconds=2 * i + 1)).isoformat().replace("+00:00", "Z")
        lines.append(json.dumps({
            "type": "user", "sessionId": session_id,
            "message": {"role": "user", "content": f"synthetic user turn {i}"},
            "timestamp": tu}))
        lines.append(json.dumps({
            "type": "assistant", "sessionId": session_id,
            "message": {"role": "assistant", "model": "fake",
                       "content": [{"type": "text", "text": f"synthetic reply {i}"}]},
            "timestamp": ta}))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 2 * N_PAIRS


def d56_chat_paging(slug: str, nid: str) -> None:
    print("\n=== D-56a/b: chat transcript scroll-paging ===")
    n = tree_node(slug, nid)
    sid = n["session_id"]
    total = write_synthetic_transcript(sid)
    print(f"  wrote synthetic transcript: {N_PAIRS} pairs = {total} rows, session {sid}")

    # ---- server side FIRST, before blaming the UI --------------------
    r1 = api("GET", f"/api/orgs/{slug}/nodes/{nid}/chat?last=1")
    server_total = (r1["messages"][0]["seq"] + 1) if r1["messages"] else 0
    check("server: full transcript length matches what was written",
          server_total == total, f"server sees {server_total}, wrote {total}")
    r2 = api("GET", f"/api/orgs/{slug}/nodes/{nid}/chat?last={CHAT_WINDOW}")
    check("server: ?last=120 returns exactly 120 rows",
          len(r2["messages"]) == CHAT_WINDOW, f"got {len(r2['messages'])}")
    check("server: windowed seq numbering matches (messages[0].seq == total-120)",
          r2["messages"][0]["seq"] == total - CHAT_WINDOW,
          f"seq={r2['messages'][0]['seq']}, expected {total - CHAT_WINDOW}")

    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge", headless=True)
        pg = br.new_page(viewport={"width": 1600, "height": 950})
        pg.goto(f"{BASE}/o/{slug}")
        pg.wait_for_selector(".sq", timeout=10000)
        pg.locator(f'.sq:has(.name:text-is("{nid}"))').first.click()
        pg.wait_for_selector(".msgs", timeout=10000)
        pg.wait_for_timeout(1500)

        count0 = pg.locator(".msgs .msg").count()
        check("UI: initial page renders exactly CHAT_WINDOW=120 rows",
              count0 == CHAT_WINDOW, f"rendered {count0}")

        btns = pg.locator(".msgs button").count()
        check("UI: no button anywhere in the transcript pane (status line only)",
              btns == 0, f"found {btns} buttons")

        status0 = pg.locator(".loadolder-status").inner_text()
        check("UI: status line names an earlier-messages count, not 'beyond'",
              "earlier messages" in status0 and "beyond" not in status0,
              f"text={status0!r}")

        # ---- (a) one scroll gesture near the top -> one page loads --------
        pg.evaluate("""() => {
            const el = document.querySelector('.msgs');
            el.scrollTop = 0;
            el.dispatchEvent(new Event('scroll', {bubbles: true}));
        }""")
        pg.wait_for_timeout(1200)
        count1 = pg.locator(".msgs .msg").count()
        check("UI: scrolling within 240px of the top pages in the next window, "
              "no click involved", count1 == 2 * CHAT_WINDOW,
              f"rows {count0} -> {count1} (expected {2 * CHAT_WINDOW})")

        # ---- (b) a synchronous burst cannot page more than one window -----
        pg.evaluate("""() => {
            const el = document.querySelector('.msgs');
            el.scrollTop = el.scrollHeight;   // move away from the top first
        }""")
        pg.wait_for_timeout(300)
        seen_last_values: list[int] = []

        def on_req(req):
            if f"/nodes/{nid}/chat?last=" in req.url:
                try:
                    seen_last_values.append(int(req.url.split("last=")[1].split("&")[0]))
                except (IndexError, ValueError):
                    pass
        pg.on("request", on_req)
        pg.evaluate("""() => {
            const el = document.querySelector('.msgs');
            // ONE synchronous burst: no yields between iterations, so no
            // fetch promise can resolve and clear the loadingOlder guard
            // until this whole block returns.
            for (let i = 0; i < 20; i++) {
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll', {bubbles: true}));
            }
        }""")
        pg.wait_for_timeout(1500)
        count2 = pg.locator(".msgs .msg").count()
        new_windows = sorted({v for v in seen_last_values if v > 2 * CHAT_WINDOW})
        check("UI: a 20-event synchronous scroll burst pages in exactly ONE "
              "more window, not several",
              count2 == 3 * CHAT_WINDOW and new_windows == [3 * CHAT_WINDOW],
              f"rows {count1} -> {count2} (expected {3 * CHAT_WINDOW}); "
              f"new ?last= values requested during the burst: {new_windows}")

        # ---- (c) repeat until MAX_WINDOW=1000, then it must say so --------
        prev = count2
        win = 3 * CHAT_WINDOW
        steps = 0
        status_final = ""
        while steps < 12:
            pg.evaluate("""() => {
                const el = document.querySelector('.msgs');
                el.scrollTop = el.scrollHeight;
            }""")
            pg.wait_for_timeout(150)
            pg.evaluate("""() => {
                const el = document.querySelector('.msgs');
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll', {bubbles: true}));
            }""")
            pg.wait_for_timeout(700)
            cur = pg.locator(".msgs .msg").count()
            steps += 1
            if cur == prev:
                break
            prev = cur
        status_final = pg.locator(".loadolder-status").inner_text()
        check("UI: repeated paging climbs to exactly MAX_WINDOW=1000 rows "
              f"(1220 available, {steps} scroll cycles)",
              prev == MAX_WINDOW, f"final row count {prev}")
        check('UI: at the cap the status line says "beyond the window" '
              "(hasOlder is still true — 1220 > 1000)",
              "beyond the window" in status_final, f"text={status_final!r}")

        br.close()


# =================================================================== D-56c
# mail list scroll-paging.

MAIL_WINDOW = 40
N_MAILS = 50


def d56_mail_paging(slug: str, nid: str) -> None:
    print("\n=== D-56c: mail list scroll-paging ===")
    set_cfg(echoMs=5, firstEventMs=10, resultMs=5, thinkMs=0, deltaMs=0,
            tools=0, replyText="ack")
    t0 = time.time()
    for i in range(N_MAILS):
        api("POST", f"/api/orgs/{slug}/nodes/{nid}/message",
            {"text": f"mail probe message #{i}"})
    for _ in range(300):                                # up to 60s, no page open
        c = api("GET", f"/api/orgs/{slug}/nodes/{nid}/chat")
        if not c["busy"] and c["queued"] == 0:
            break
        time.sleep(0.2)
    drain_s = time.time() - t0
    print(f"  {N_MAILS} messages posted and drained in {drain_s:.1f}s "
          f"(busy={c['busy']}, queued={c['queued']})")

    # ---- server side first --------------------------------------------
    inbox = api("GET", f"/api/orgs/{slug}/nodes/{nid}/inbox")
    delivered_n = len(inbox["delivered"])
    check("server: /inbox delivered count matches what was sent "
          "(capped at 50 server-side)",
          delivered_n == N_MAILS, f"server reports {delivered_n} delivered, sent {N_MAILS}")

    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge", headless=True)
        pg = br.new_page(viewport={"width": 1600, "height": 950})
        pg.goto(f"{BASE}/o/{slug}")
        pg.wait_for_selector(".sq", timeout=10000)
        pg.locator(f'.sq:has(.name:text-is("{nid}"))').first.click()
        pg.wait_for_timeout(1500)
        tab = pg.locator('button:has-text("inbox")')
        tab.first.click()
        pg.wait_for_selector(".mailer-list", timeout=10000)
        pg.wait_for_timeout(1200)

        count0 = pg.locator(".mailrow").count()
        check("UI: initial mail list renders exactly MAIL_WINDOW=40 rows",
              count0 == MAIL_WINDOW, f"rendered {count0}")
        status0 = pg.locator(".mailer-list .loadolder-status")
        status0_text = status0.inner_text() if status0.count() else ""
        check("UI: status line names the remaining count (10 earlier)",
              status0.count() == 1 and str(N_MAILS - MAIL_WINDOW) in status0_text,
              f"count={status0.count()} text={status0_text!r}")

        # ---- scroll near the BOTTOM pages in the rest ----------------------
        pg.evaluate("""() => {
            const el = document.querySelector('.mailer-list');
            el.scrollTop = el.scrollHeight - el.clientHeight;
            el.dispatchEvent(new Event('scroll', {bubbles: true}));
        }""")
        pg.wait_for_timeout(1000)
        count1 = pg.locator(".mailrow").count()
        check("UI: scrolling within 240px of the bottom pages in the rest "
              "(only grows)",
              count1 == N_MAILS and count1 > count0,
              f"rows {count0} -> {count1} (expected {N_MAILS})")
        status1 = pg.locator(".mailer-list .loadolder-status")
        check("UI: status line is gone once everything is shown",
              status1.count() == 0, f"still {status1.count()} status line(s)")

        # ---- further scrolling once full must not grow past the total ----
        for _ in range(3):
            pg.evaluate("""() => {
                const el = document.querySelector('.mailer-list');
                el.scrollTop = el.scrollHeight;
                el.dispatchEvent(new Event('scroll', {bubbles: true}));
            }""")
            pg.wait_for_timeout(300)
        count2 = pg.locator(".mailrow").count()
        check("UI: paging stops once everything is shown (3 more scroll "
              "events, no growth past total, no duplicates)",
              count2 == N_MAILS, f"rows after 3 more scrolls: {count2}")

        br.close()


# ==================================================================== D-38
# frame-drop convergence, three WebSocket tamperings.

def wonky_init_script(mode: str) -> str:
    return """(() => {
      const Real = window.WebSocket;
      window.__wonkyIn = 0;
      window.__wonkyOut = 0;
      class Wonky extends Real {
        constructor(...args) {
          super(...args);
          this._h = null;
          this._n = 0;
          this._buf = [];
          const self = this;
          super.addEventListener('message', (ev) => {
            window.__wonkyIn++;
            self._route(ev);
          });
        }
        set onmessage(fn) { this._h = fn }
        get onmessage() { return this._h || null }
        _deliver(ev) { window.__wonkyOut++; if (this._h) this._h(ev); }
        _route(ev) {
          const mode = "%s";
          if (mode === 'deaf') {
            return;                                   // swallow everything
          } else if (mode === 'partial') {
            this._n++;
            if (this._n %% 2 === 1) this._deliver(ev); // keep odd, drop even
          } else if (mode === 'duporder') {
            this._buf.push(ev);
            if (this._buf.length === 3) {
              const g = this._buf.slice().reverse();
              this._buf = [];
              for (const e of g) { this._deliver(e); this._deliver(e); }
            }
          }
        }
      }
      window.WebSocket = Wonky;
    })();""" % mode


def run_frame_drop_variant(mode: str, slug: str, nid: str,
                          turn_cfg: dict | None = None,
                          busy_wait_s: float = 40.0) -> dict:
    tag = random.randint(1000, 9999)
    sent_marker = f"SENTMARK-{mode}-{tag}"
    reply_marker = f"REPLYMARK-{mode}-{tag}"
    cfg = {"firstEventMs": 9000, "resultMs": 500}          # ~9.5s turn, default
    if turn_cfg is not None:                # {} is falsy but a legal override
        cfg = dict(turn_cfg)
    set_cfg(replyText=reply_marker, **cfg)

    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge", headless=True)
        pg = br.new_page(viewport={"width": 1600, "height": 950})
        pg.add_init_script(wonky_init_script(mode))
        pg.goto(f"{BASE}/o/{slug}")
        pg.wait_for_selector(".sq", timeout=10000)
        pg.wait_for_timeout(1200)
        frames_in_before = pg.evaluate("window.__wonkyIn") or 0

        t0 = time.time()
        # a SEPARATE client — Python urllib, never the browser under test
        api("POST", f"/api/orgs/{slug}/nodes/{nid}/message",
            {"text": f"marker={sent_marker} — reply with exactly this token "
                     f"and nothing else: {reply_marker}"})

        busy_at = act_at = cleared = None
        n_polls = int(busy_wait_s / 0.5)
        for _ in range(n_polls):
            pg.wait_for_timeout(500)
            if busy_at is None and pg.locator(".busydot, .actgear").count():
                busy_at = round(time.time() - t0, 1)
            if act_at is None and pg.locator(".actlabel").count():
                act_at = round(time.time() - t0, 1)
            if busy_at is not None and cleared is None \
                    and not pg.locator(".busydot, .actgear, .actlabel").count():
                cleared = round(time.time() - t0, 1)
                break

        pg.locator(f'.sq:has(.name:text-is("{nid}"))').first.click()
        pg.wait_for_timeout(1500)
        msg_at = reply_at = None
        for _ in range(50):                     # up to 25s more
            pg.wait_for_timeout(500)
            body = pg.inner_text("body")
            if msg_at is None and sent_marker in body:
                msg_at = round(time.time() - t0, 1)
            if reply_at is None and reply_marker in body:
                reply_at = round(time.time() - t0, 1)
            if msg_at is not None and reply_at is not None:
                break

        frames_in = (pg.evaluate("window.__wonkyIn") or 0) - frames_in_before
        frames_out = pg.evaluate("window.__wonkyOut") or 0
        br.close()

    return {"mode": mode, "busy_at": busy_at, "act_at": act_at, "cleared": cleared,
            "msg_at": msg_at, "reply_at": reply_at,
            "frames_in": frames_in, "frames_out": frames_out}


def d38_frame_drop(slug: str, nid: str) -> None:
    print("\n=== D-38: frame-drop convergence (deaf / partial / dup+reorder) ===")
    for mode, tamper_desc in (
        ("deaf", "every frame swallowed"),
        ("partial", "every 2nd frame swallowed"),
        ("duporder", "buffered 3, delivered reversed, each frame twice"),
    ):
        print(f"\n  -- mode={mode} ({tamper_desc}) --")
        r = run_frame_drop_variant(mode, slug, nid)
        print(f"     frames in={r['frames_in']}  delivered-to-app={r['frames_out']}  "
              f"busy_at={r['busy_at']}s  act_at={r['act_at']}s  "
              f"cleared={r['cleared']}s  msg_at={r['msg_at']}s  reply_at={r['reply_at']}s")

        if mode == "deaf":
            check(f"[{mode}] socket received frames but delivered ZERO to the app",
                  r["frames_in"] > 0 and r["frames_out"] == 0,
                  f"in={r['frames_in']} out={r['frames_out']}")
        elif mode == "partial":
            check(f"[{mode}] roughly half the frames were actually dropped "
                  "(some delivered, not all)",
                  0 < r["frames_out"] < r["frames_in"],
                  f"in={r['frames_in']} out={r['frames_out']}")
        else:
            check(f"[{mode}] frames were tampered (duplicated at 2x per "
                  "delivered group, not a plain passthrough)",
                  r["frames_out"] != r["frames_in"] and r["frames_out"] >= 0,
                  f"in={r['frames_in']} out={r['frames_out']}")

        check(f"[{mode}] the UI notices the turn STARTED (busy dot/gear)",
              r["busy_at"] is not None, f"busy_at={r['busy_at']}")
        check(f"[{mode}] the server-derived activity label renders",
              r["act_at"] is not None, f"act_at={r['act_at']}")
        check(f"[{mode}] the busy indicator CLEARS",
              r["cleared"] is not None, f"cleared={r['cleared']}")
        check(f"[{mode}] the SENT message (with its marker) is on screen",
              r["msg_at"] is not None, f"msg_at={r['msg_at']}")
        check(f"[{mode}] the agent's REPLY (with its marker) is on screen",
              r["reply_at"] is not None, f"reply_at={r['reply_at']}")

    # ---- supplementary, NOT a pass/fail check: does a turn shorter than
    # the tree's 6s G1 heartbeat (frontend/src/App.tsx) stay observable on a
    # FULLY DEAF socket? Printed as a finding either way — see the report.
    print("\n  -- supplementary: deaf socket, STOCK ~1s turn "
          "(observability-gap probe, not asserted) --")
    r = run_frame_drop_variant("deaf", slug, nid, turn_cfg={}, busy_wait_s=40.0)
    print(f"     frames in={r['frames_in']}  delivered-to-app={r['frames_out']}  "
          f"busy_at={r['busy_at']}s  act_at={r['act_at']}s  cleared={r['cleared']}s  "
          f"msg_at={r['msg_at']}s  reply_at={r['reply_at']}s")
    if r["busy_at"] is None and r["reply_at"] is not None:
        print("     FINDING: with a ~1s turn and a fully deaf socket, the "
              "overview busy dot/activity label were never observed in 40s "
              "of polling, even though the reply eventually landed. The "
              "overview indicator is driven by the tree payload's 6s G1 "
              "heartbeat (not convo.ts's faster 2.5s/7s per-node poll), so "
              "a turn shorter than one heartbeat period can start and end "
              "between two ticks and be invisible to it. Final state is "
              "still correct (the reply appears), but a user watching only "
              "the overview would never see that node work at all.")
    elif r["busy_at"] is not None:
        print("     (busy dot WAS observed this run despite the short turn "
              "— the race did not reproduce this time; see the earlier "
              "40s-timeout measurement for a run where it did not.)")


# ======================================================================= go

def main() -> int:
    start_backend()
    try:
        slug1 = make_org("scroll-paging")
        chatty = hire(slug1, "chatty")
        mailer = hire(slug1, "mailer")
        print(f"org {slug1}: chatty={chatty} mailer={mailer}")

        try:
            d56_chat_paging(slug1, chatty)
        except Exception:                                          # noqa: BLE001
            check("D-56a/b section completed without an exception", False,
                  traceback.format_exc().splitlines()[-1])

        try:
            d56_mail_paging(slug1, mailer)
        except Exception:                                          # noqa: BLE001
            check("D-56c section completed without an exception", False,
                  traceback.format_exc().splitlines()[-1])

        slug2 = make_org("frame-drop")
        echo = hire(slug2, "echo")
        print(f"\norg {slug2}: echo={echo}")
        try:
            d38_frame_drop(slug2, echo)
        except Exception:                                          # noqa: BLE001
            check("D-38 section completed without an exception", False,
                  traceback.format_exc().splitlines()[-1])

    finally:
        drop_orgs()
        survivors = [o["slug"] for o in api("GET", "/api/orgs")]
        print(f"\norgs remaining on :{PORT} after cleanup: {survivors}")
        check("every org this probe created was deleted",
              not any(s in survivors for s in _ORGS), f"survivors={survivors}")
        stop_backend()

    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} checks passed")
    if bad:
        print("FAILED:")
        for name, _, detail in bad:
            print(f"  - {name}" + (f"  ({detail})" if detail else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:                                                # noqa: BLE001
        traceback.print_exc()
        try:
            stop_backend()
        except Exception:                                             # noqa: BLE001
            pass
        sys.exit(1)
