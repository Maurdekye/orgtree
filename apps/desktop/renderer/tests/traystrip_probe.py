"""traystrip_probe.py — the agents-tray wrap must not eat the canvas's clicks.

    python -B tests/traystrip_probe.py
    python -B tests/traystrip_probe.py --expect-fail     # known-negative control

THE DEFECT (user report 2026-08-29)
-----------------------------------
    "the left 50px or so of agent desk view is uninteractable; it just shows a
     grab hand and doesn't let me click anything when i hover it. it hides text
     entry, buttons, and the model hire cards."

`.tray-wrap` is the absolutely-positioned box that holds the agents tray and
its toggle. Commit 605036f (2026-08-21) gave it `top: 10px` alongside its
`bottom: 10px` so the tray's `max-height: 100%` would resolve against the real
canvas height instead of a guessed vh fraction. That is correct for the tray,
but a definite height is also a definite AREA: the wrap became an invisible
column as wide as its toggle (~77px measured) running the FULL height of the
canvas at `z-index: 7` — above the desk, above the cards, above everything.

It shows a grab cursor because it declares none of its own and inherits
`.viewport`'s `cursor: grab`, and it does not even pan because the wrap's
`onPointerDown` calls `stopPropagation`. So it looks like canvas, behaves like
nothing, and hides whatever the desk happens to have under it.

THE FIX under test: `.tray-wrap { pointer-events: none }` with
`.tray-wrap > * { pointer-events: auto }` — the wrap keeps its size and claims
no clicks; the toggle and the tray claim their own.

WHY A REAL BROWSER
------------------
This is a hit-testing bug. jsdom applies no stylesheet, does no layout and has
no `elementFromPoint` worth the name, so a unit test could only assert that the
CSS text says what we just wrote — which is not the claim. The claim is "a
click at these screen coordinates reaches the desk", and only a browser that
has actually composited the page can answer it. So this probe runs the REAL
app (a throwaway backend serving `frontend/dist`) rather than a hand-built
fixture: the whole defect was a stacking relationship between two real
components, and a fixture that re-declares that relationship would be
re-asserting the thing under test.

RUN IT WITH the plain `python` on PATH (needs playwright, fastapi, uvicorn and
websockets importable — the repo `.venv` has the backend deps but not
playwright). `sys.executable` also launches the backend subprocess.

HARD CONSTRAINTS OBSERVED
-------------------------
- Binds ONLY port 7405 by default (--port to override). Never 7360/7361/7362
  (the live deployment) and never 7401 (the backend test rig).
- Its own ORGTREE_DATA/HOME under a temp dir, ORGTREE_BRIDGE_PORT=0, and
  ORGTREE_CLAUDE_CLI=backend/tests/fakecli.js — no real model call ever.
- Deletes every org it creates.
- Never rebuilds `frontend/dist`. Build it yourself first (`npm run build`) or
  this probe measures a stale bundle.

WHAT IT ASSERTS
---------------
§1  The rig is loaded: the tray-wrap column actually OVERLAPS the desk panel
    at this window size, and at least one interactive desk control lies under
    it. A run that measured nothing is a FAILURE here, not a pass — a clean
    sheet and a probe pointed at empty space look identical otherwise.
§2  Hit test: every interactive element (button/input/textarea/select) inside
    the desk, plus the left hire chips, that lies under the column resolves to
    ITSELF under `elementFromPoint`, never to `.tray-wrap`.
§3  Real click, text entry: clicking the composer at a point inside the column
    focuses the composer. `document.activeElement` identity, not "a handler
    exists".
§4  Real click, hire card: clicking a left hire chip inside the column spawns
    the draft node.
§5  Not over-fixed — the toggle still works: a real click on `.tray-toggle`
    opens the tray.
§6  Not over-fixed — the open tray still absorbs: a point over the tray's own
    background resolves to the tray, not to the canvas underneath it.

THE KNOWN-NEGATIVE CONTROL
--------------------------
`--expect-fail` injects `.tray-wrap, .tray-wrap > * { pointer-events: auto
!important }` — a VALUE replacement restoring exactly the pre-fix behaviour,
not a syntax error that would kill the check with an exception and prove
nothing. The run must go RED. If it does not, this probe is not measuring what
it claims and its green means nothing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7405
EXPECT_FAIL = "--expect-fail" in sys.argv
BASE = f"http://127.0.0.1:{PORT}"

# ⚠ TWO WINDOW SIZES, AND THEY ARE NOT INTERCHANGEABLE. The focus glide fits
# the square desk to min(vw, vh) - 48 and centres it, so the window width sets
# where the desk's left edge lands. The three casualties do NOT all fall under
# the 77px column at once, and no amount of tuning makes them: the hire chips
# hang OUTSIDE the card (right edge at desk.left - 22) while the composer sits
# INSIDE it (left edge at about desk.left + 56), and those two are ~78px apart
# — one column's width. Push the desk right far enough for the chips to enter
# the column and the composer has already left it.
#   780x800 -> desk.left ~74: the composer and the desk buttons are covered.
#   900x800 -> desk.left ~118: the left hire chips are covered.
# §1b asserts per-window what that window is supposed to be measuring, so a
# layout change that slides the desk out from under the column fails loudly
# instead of passing on an empty set.
WINDOWS = [
    ({"width": 780, "height": 800}, {"text entry", "button"}),
    ({"width": 900, "height": 800}, {"hire chip"}),
]

CONTROL_CSS = ".tray-wrap, .tray-wrap > * { pointer-events: auto !important; }"

TMP = tempfile.mkdtemp(prefix="orgtree-traystrip-")
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


def _log_tail(n: int = 3000) -> str:
    try:
        return open(LOG, encoding="utf-8", errors="replace").read()[-n:]
    except OSError:
        return "(no log)"


def start_backend() -> None:
    """Same shape as tests/live_probe.py's: own data dir, own home, own port,
    fake CLI, bridge listener disabled."""
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
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump({"default": {"replyText": "ack."}}, f)
    log = open(LOG, "a", encoding="utf-8")
    PROC = subprocess.Popen(
        [sys.executable, "-m", "orgtree.api"], cwd=os.path.join(_REPO, "backend"),
        env=env, stdout=log, stderr=log, text=True)
    for _ in range(200):
        if PROC.poll() is not None:
            raise RuntimeError(f"backend exited with {PROC.returncode}:\n" + _log_tail())
        try:
            urllib.request.urlopen(BASE + "/api/orgs", timeout=1).read()
            print(f"backend up on :{PORT}  (data={DATA})")
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


def drop_orgs() -> None:
    for slug in list(_ORGS):
        try:
            api("DELETE", f"/api/orgs/{slug}")
        except Exception as e:                                    # noqa: BLE001
            print(f"  (cleanup) failed to delete {slug}: {e}")


# ------------------------------------------------------------ browser-side JS

# Everything interactive the desk owns, plus the left-hand hire chips — the
# three casualties the user named live in this set. For each one that overlaps
# the tray column, sample the overlap and report what actually gets the hit.
COVERED = """() => {
  const wrap = document.querySelector('.tray-wrap');
  const desk = document.querySelector('.desk-over');
  if (!wrap || !desk) return {error: 'wrap=' + !!wrap + ' desk=' + !!desk};
  const w = wrap.getBoundingClientRect();
  const d = desk.getBoundingClientRect();
  const targets = [
    ...document.querySelectorAll('.desk-over button, .desk-over input, ' +
      '.desk-over textarea, .desk-over select'),
    ...document.querySelectorAll('.hsof.side-l button'),
  ];
  const out = [];
  for (const el of targets) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const x0 = Math.max(b.left, w.left), x1 = Math.min(b.right, w.right);
    if (x1 - x0 < 2) continue;                   // not under the column
    const y0 = Math.max(b.top, w.top), y1 = Math.min(b.bottom, w.bottom);
    if (y1 - y0 < 2) continue;
    const hits = [];
    for (const f of [0.25, 0.5, 0.75]) {
      const x = x0 + (x1 - x0) * 0.5, y = y0 + (y1 - y0) * f;
      const t = document.elementFromPoint(x, y);
      hits.push({
        x: +x.toFixed(1), y: +y.toFixed(1),
        ok: !!t && (t === el || el.contains(t)),
        got: !t ? 'null' : (t.tagName.toLowerCase() +
          (typeof t.className === 'string' && t.className
            ? '.' + t.className.trim().split(/\\s+/).join('.') : '')),
      });
    }
    out.push({
      what: el.tagName.toLowerCase() +
        (typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
      kind: el.closest('.hsof') ? 'hire chip'
        : (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? 'text entry'
        : 'button',
      hits,
    });
  }
  return {
    wrap: {l: +w.left.toFixed(1), r: +w.right.toFixed(1),
           t: +w.top.toFixed(1), b: +w.bottom.toFixed(1),
           w: +w.width.toFixed(1), h: +w.height.toFixed(1)},
    desk: {l: +d.left.toFixed(1), r: +d.right.toFixed(1), w: +d.width.toFixed(1)},
    overlap: +(Math.min(w.right, d.right) - Math.max(w.left, d.left)).toFixed(1),
    covered: out,
  };
}"""


def open_desk(pg, slug: str) -> None:
    pg.goto(f"{BASE}/o/{slug}")
    pg.wait_for_selector(".sq", timeout=15000)
    pg.wait_for_timeout(2000)                     # let the intro fit settle
    pg.locator('.sq:has(.name:text-is("alpha"))').first.click()
    pg.wait_for_selector(".desk-over .msgs", timeout=15000)
    pg.wait_for_timeout(2500)                     # let the focus glide land
    # the left hire column is gated on `.sq.desk.edge-l` — the card tracks which
    # edge the cursor is nearest, so park the pointer on the desk's left half.
    box = pg.evaluate("""() => { const b =
      document.querySelector('.sq.desk').getBoundingClientRect();
      return [b.left + b.width * 0.12, b.top + b.height * 0.5]; }""")
    pg.mouse.move(box[0], box[1])
    pg.wait_for_timeout(400)


def run(pg, win: dict, want: set[str]) -> None:
    tag = f"[{win['width']}x{win['height']}]"
    geo = pg.evaluate(COVERED)
    if geo.get("error"):
        check(f"{tag} §1 rig: the desk and the tray wrap are both on the page",
              False, geo["error"])
        return
    print(f"  wrap  x {geo['wrap']['l']}..{geo['wrap']['r']} "
          f"({geo['wrap']['w']}px wide, {geo['wrap']['h']}px tall)")
    print(f"  desk  x {geo['desk']['l']}..{geo['desk']['r']}  "
          f"overlap with the column: {geo['overlap']}px")

    # ---- §1 the rig is loaded ------------------------------------------
    check(f"{tag} §1a the tray column overlaps the desk panel",
          geo["overlap"] > 4, f"overlap {geo['overlap']}px")
    kinds = {c["kind"] for c in geo["covered"]}
    for kind in sorted(want):
        got = [c["what"] for c in geo["covered"] if c["kind"] == kind]
        check(f"{tag} §1b a '{kind}' actually lies under the column "
              "(else nothing was measured)", bool(got), f"{len(got)}: {got[:4]}")
    check(f"{tag} §1c something was measured at all",
          len(geo["covered"]) >= 1,
          f"{len(geo['covered'])} measured, kinds={sorted(kinds)}")

    # ---- §2 hit test ----------------------------------------------------
    bad = [(c["what"], c["kind"], h) for c in geo["covered"]
           for h in c["hits"] if not h["ok"]]
    check(f"{tag} §2 every control under the column resolves to itself, not the wrap",
          not bad,
          "all clear" if not bad else
          "; ".join(f"{w} ({k}) at ({h['x']},{h['y']}) hit {h['got']}"
                    for w, k, h in bad[:5]))

    if "text entry" in want:
        click_composer(pg, tag)
    if "button" in want:
        tray_still_works(pg, tag)
    if "hire chip" in want:
        click_hire_chip(pg, tag)


def click_composer(pg, tag: str) -> None:
    # ---- §3 real click: text entry --------------------------------------
    pt = pg.evaluate("""() => {
      const w = document.querySelector('.tray-wrap').getBoundingClientRect();
      const t = document.querySelector('.desk-over textarea');
      if (!t) return null;
      const b = t.getBoundingClientRect();
      const x0 = Math.max(b.left, w.left), x1 = Math.min(b.right, w.right);
      if (x1 - x0 < 2) return null;
      return [(x0 + x1) / 2, b.top + b.height / 2];
    }""")
    if pt is None:
        check(f"{tag} §3 real click on the composer inside the column focuses it",
              False, "the composer does not lie under the column — rig broken")
        return
    pg.evaluate("() => document.activeElement && document.activeElement.blur()")
    pg.mouse.click(pt[0], pt[1])
    pg.wait_for_timeout(250)
    who = pg.evaluate("""() => { const a = document.activeElement;
      if (!a) return 'null';
      return a.tagName.toLowerCase() +
        (a.closest('.desk-over') ? ' (in desk)' : ' (outside desk)'); }""")
    check(f"{tag} §3 real click on the composer inside the column focuses it",
          who == "textarea (in desk)",
          f"clicked ({pt[0]:.0f},{pt[1]:.0f}); activeElement = {who}")


def tray_still_works(pg, tag: str) -> None:
    # ---- §5 the toggle still works --------------------------------------
    pg.locator(".tray-toggle").click()
    pg.wait_for_timeout(400)
    check(f"{tag} §5 the tray toggle still opens the tray (not over-fixed)",
          pg.locator(".tray").count() == 1,
          f"{pg.locator('.tray').count()} .tray in the DOM after the click")

    # ---- §6 the open tray still absorbs its own area ---------------------
    got = pg.evaluate("""() => {
      const t = document.querySelector('.tray');
      if (!t) return 'no tray';
      const b = t.getBoundingClientRect();
      const e = document.elementFromPoint(b.left + b.width - 3, b.top + 3);
      if (!e) return 'null';
      return (t === e || t.contains(e)) ? 'tray'
        : e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/)[0];
    }""")
    check(f"{tag} §6 a point over the open tray still resolves to the tray, "
          "not the canvas", got == "tray", f"hit {got}")
    pg.locator(".tray-toggle").click()            # close it again
    pg.wait_for_timeout(300)


def click_hire_chip(pg, tag: str) -> None:
    # ---- §4 real click: a hire chip --------------------------------------
    before = pg.locator(".sq.draft").count()
    # ⚠ AN ENABLED CHIP, and `:not(disabled)` is doing real work here (D-199,
    # found 2026-08-30). This used to take the first chip under the column,
    # which was fine while side strips only ever carried offerable families.
    # D-199 removed the `!side` asymmetry, so an installed-but-signed-out
    # provider now renders on the LEFT strip too, disabled — and on this
    # probe's throwaway HOME that is exactly what Antigravity is, so the first chip
    # became a dead one and §4 started failing on a correct page.
    # A disabled chip is the wrong target regardless of which build put it
    # there: this section asserts that a real click REACHES the control
    # through the tray column, and a control that does nothing when clicked
    # cannot answer that question either way.
    pt = pg.evaluate("""() => {
      const w = document.querySelector('.tray-wrap').getBoundingClientRect();
      for (const el of document.querySelectorAll('.hsof.side-l button')) {
        if (el.disabled) continue;
        const b = el.getBoundingClientRect();
        const x0 = Math.max(b.left, w.left), x1 = Math.min(b.right, w.right);
        if (x1 - x0 >= 2 && b.top >= w.top && b.bottom <= w.bottom)
          return [(x0 + x1) / 2, b.top + b.height / 2];
      }
      return null;
    }""")
    if pt is None:
        check(f"{tag} §4 real click on a left hire chip inside the column "
              "spawns the draft", False,
              "no ENABLED left hire chip lies under the column — rig broken")
        return
    pg.mouse.click(pt[0], pt[1])
    pg.wait_for_timeout(700)
    after = pg.locator(".sq.draft").count()
    check(f"{tag} §4 real click on a left hire chip inside the column spawns the draft",
          after == before + 1,
          f"clicked ({pt[0]:.0f},{pt[1]:.0f}); .sq.draft {before} -> {after}")


def main() -> int:
    print(f"traystrip_probe — {'CONTROL (--expect-fail)' if EXPECT_FAIL else 'shipped CSS'}")
    if not os.path.isdir(os.path.join(_REPO, "frontend", "dist")):
        print("!! frontend/dist is missing — run `npm run build` first.")
        return 2
    start_backend()
    try:
        r = api("POST", "/api/orgs", {"name": "zz traystrip probe"})
        slug = r.get("slug") or r.get("org", {}).get("slug")
        _ORGS.append(slug)
        api("POST", f"/api/orgs/{slug}/ops", {
            "op": "hire", "actor": "@user", "parent": None, "tier": "haiku",
            "grant": 2, "name": "alpha", "charter": "a traystrip-probe agent",
            "tools": {"bash": False, "web": False, "edit": False,
                      "subagents": False, "mcp": []},
            "org_visibility": "team", "add_dirs": []})

        with sync_playwright() as p:
            br = p.chromium.launch(channel="msedge", headless=True)
            try:
                for win, want in WINDOWS:
                    print(f"\n--- {win['width']}x{win['height']}  "
                          f"(measuring: {', '.join(sorted(want))}) ---")
                    pg = br.new_page(viewport=win)
                    open_desk(pg, slug)
                    if EXPECT_FAIL:
                        # value replacement, not a syntax break: the wrap and
                        # its children go back to taking hits exactly as they
                        # did before the fix. A control that dies in setup is
                        # not a control.
                        pg.add_style_tag(content=CONTROL_CSS)
                        pg.wait_for_timeout(200)
                    try:
                        run(pg, win, want)
                    finally:
                        shot = os.path.join(
                            _HERE, "traystrip-%s-%d.png"
                            % ("control" if EXPECT_FAIL else "fixed", win["width"]))
                        try:
                            pg.screenshot(path=shot)
                            print(f"  screenshot: {shot}")
                        except Exception:                         # noqa: BLE001
                            pass
                        pg.close()
            finally:
                br.close()
    except Exception:                                             # noqa: BLE001
        traceback.print_exc()
        check("probe ran to completion", False, "exception above")
    finally:
        drop_orgs()
        stop_backend()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    if EXPECT_FAIL:
        # The control must be detected. It must ALSO have got far enough to
        # measure something — a control that produced no checks at all failed
        # in setup and proves nothing about the instrument.
        if not RESULTS:
            print("CONTROL INCONCLUSIVE: the run produced no checks at all.")
            return 1
        if fails:
            print(f"CONTROL OK: {len(fails)} finding(s) — the probe can go red.")
            return 0
        print("CONTROL FAILED: the pre-fix CSS was NOT detected. "
              "This probe's green means nothing until that is fixed.")
        return 1
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
