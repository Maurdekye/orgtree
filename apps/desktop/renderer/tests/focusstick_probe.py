"""focusstick_probe.py - does a focused desk STAY FITTED in a REAL browser
when the available canvas actually changes size?

User, 2026-09-11: they like that "fit the whole org" keeps re-fitting as the
available canvas changes, until they drag or focus elsewhere, and asked for
the switchboard and individual agent desks to do the same. The camera now
remembers an INTENT (`CamIntent` in OrgCanvas.tsx) instead of a single
whole-org boolean.

WHY THIS EXISTS ON TOP OF focusstick.test.tsx. That suite runs under jsdom,
which has no layout and no ResizeObserver. The canvas size there is a number
the test states and the "resize" is a fake observer callback it fires by hand,
so two things cannot be asked - and they are the two the user described:

  * does a REAL window resize reach the canvas at all? The production path is
    `ResizeObserver -> setViewportSize -> the follow effect`, and under jsdom
    every link in it is a stand-in.
  * is the desk still FITTED afterwards? jsdom can only read back the camera
    numbers the component wrote. Whether the PAINTED desk sits inside the free
    region is a layout question, and `focusView` floors the zoom at Z_DESK on
    purpose, so "aimed at the region" and "fits in the region" are genuinely
    different claims.

WHAT IS MEASURED. Real `getBoundingClientRect()` of `.sq.desk:not(.user)` (a
focused agent desk) and `.eye-desk` (the switchboard), against the free region
computed here from the pin rectangles - independently of the TypeScript, so a
shared bug cannot agree with itself. Overflow is reported per edge, in pixels.

The REFERENCE for "still fitted" is never a number invented here: it is the
box a FRESH focus command produces at the new size, taken by re-focusing the
open desk after the measurement. Each section also requires that reference to
DIFFER from the pre-resize box, so a canvas that ignored the resize entirely
cannot pass by standing still.

ANTI-VACUITY - RED BASELINES, NOT INSPECTION. Every mutant below is applied to
the real OrgCanvas.tsx inside the bundler (the file on disk is never touched)
and MUST make the sections it names fail. A mutant that measures clean means
the assertion it targets is decorative.

    cd apps/desktop/renderer
    python -B tests/focusstick_probe.py                  # the shipped canvas
    python -B tests/focusstick_probe.py --mutant sticky  # must FAIL
    python -B tests/focusstick_probe.py --mutant all     # every mutant, in turn
    python -B tests/focusstick_probe.py --list-mutants
    python -B tests/focusstick_probe.py --headed         # watch it

Requires playwright with the msedge channel (same dependency as the other
browser probes here). If that is missing this probe EXITS INERT (code 3) and
says so - it never reports a pass it could not have failed. No backend, no
provider: the page is a local file.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
RENDERER = HERE.parent
BUILD = HERE / "focusstick_build.mjs"

BIG = (1280, 900)
SMALL = (940, 620)
GAP = 12            # clearRect.PIN_GAP
SETTLE = 1400       # ms: the 320ms refit glide, plus room for layout to land

#: Each mutant is (old, new, sections that MUST go red). Exact-match
#: substitutions applied to OrgCanvas.tsx inside the bundler.
MUTANTS: dict[str, tuple[str, str, list[str]]] = {
    # a focus command no longer CLAIMS the camera: the pre-change behaviour,
    # where only the whole-org fit was sticky
    "sticky": (
        "    camIntent.current = { kind: 'focus', id, z }\n"
        "  }, [animateTo, focusView, regionOf, setFront, toast])",
        "  }, [animateTo, focusView, regionOf, setFront, toast])",
        ["A", "B", "C"]),
    # the intent is remembered but nothing acts on it
    "refit": (
        "    if (isMobile || previous.canvas === canvas) return\n"
        "    refocus(intent.id, intent.z)",
        "    if (isMobile || previous.canvas === canvas) return",
        ["A", "B", "C"]),
    # the follow is keyed on the TREE as well as the canvas - an unrelated org
    # update then re-aims the camera while the user is reading
    "tree-keyed": (
        "    if (isMobile || previous.canvas === canvas) return",
        "    if (isMobile || previous.whole === whole) return",
        ["E"]),
    # a manual pan no longer relinquishes the camera
    "pan-keeps": (
        "    if (e.button !== 0) return\n    camIntent.current = null",
        "    if (e.button !== 0) return",
        ["D"]),
    # the refit fires but aims at the eye rather than the focused agent
    "wrong-target": (
        "    refocus(intent.id, intent.z)",
        "    refocus(USER, intent.z)",
        ["A"]),
}


def build(outdir: pathlib.Path, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
    if mutant:
        old, new, _ = MUTANTS[mutant]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                          encoding="utf-8")
        json.dump([{"old": old, "new": new}], tmp)
        tmp.close()
        args += ["--subst", tmp.name]
    try:
        subprocess.run(["node", *args], check=True, cwd=str(RENDERER))
    finally:
        if tmp:
            pathlib.Path(tmp.name).unlink(missing_ok=True)
    if not (outdir / "probe.css").exists():
        raise SystemExit("bundle produced no probe.css - styles.css import lost")


# ---------------------------------------------------------------- geometry
def obstacle(pin: dict, vp: dict) -> dict | None:
    """clip to the viewport, THEN grow by the gap - clearRect.obstacleOf"""
    x0, y0 = max(pin["x"], 0), max(pin["y"], 0)
    x1 = min(pin["x"] + pin["w"], vp["w"])
    y1 = min(pin["y"] + pin["h"], vp["h"])
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": max(0, x0 - GAP), "y": max(0, y0 - GAP),
            "r": min(vp["w"], x1 + GAP), "b": min(vp["h"], y1 + GAP)}


def clear_region(pins: list[dict], vp: dict) -> dict | None:
    """The expected free region, computed INDEPENDENTLY of the TypeScript so a
    shared bug cannot agree with itself. Largest by area; ties to the nearest
    viewport centre, then smaller x, then smaller y."""
    obs = [o for o in (obstacle(p, vp) for p in pins) if o]
    if not obs:
        return {"x": 0, "y": 0, "w": vp["w"], "h": vp["h"]}
    xs = sorted({0, vp["w"]} | {o["x"] for o in obs} | {o["r"] for o in obs})
    ys = sorted({0, vp["h"]} | {o["y"] for o in obs} | {o["b"] for o in obs})
    xs = [v for v in xs if 0 <= v <= vp["w"]]
    ys = [v for v in ys if 0 <= v <= vp["h"]]
    best = None
    for i, x0 in enumerate(xs):
        for x1 in xs[i + 1:]:
            for j, y0 in enumerate(ys):
                for y1 in ys[j + 1:]:
                    if any(x0 < o["r"] and o["x"] < x1
                           and y0 < o["b"] and o["y"] < y1 for o in obs):
                        continue
                    w, h = x1 - x0, y1 - y0
                    drift = ((x0 + w / 2) - vp["w"] / 2) ** 2 \
                        + ((y0 + h / 2) - vp["h"] / 2) ** 2
                    key = (-(w * h), drift, x0, y0)
                    if best is None or key < best[0]:
                        best = (key, {"x": x0, "y": y0, "w": w, "h": h})
    return best[1] if best else None


def overflow(box: dict, region: dict, tol: float = 1.0) -> dict:
    """how far `box` escapes `region` on each edge, in real px"""
    return {
        "left": round(max(0.0, region["x"] - box["x"] - tol), 1),
        "top": round(max(0.0, region["y"] - box["y"] - tol), 1),
        "right": round(max(0.0, box["x"] + box["width"]
                           - (region["x"] + region["w"]) - tol), 1),
        "bottom": round(max(0.0, box["y"] + box["height"]
                            - (region["y"] + region["h"]) - tol), 1),
    }


def apart(a: dict | None, b: dict | None) -> float:
    """the largest single-edge disagreement between two boxes, in px"""
    if not a or not b:
        return float("inf")
    return max(abs(a["x"] - b["x"]), abs(a["y"] - b["y"]),
               abs(a["width"] - b["width"]), abs(a["height"] - b["height"]))


def show(b: dict | None) -> str:
    if not b:
        return "<absent>"
    return (f"{b['width']:.0f}x{b['height']:.0f} at "
            f"{b['x']:.0f},{b['y']:.0f}")


BOX = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
"""

AGENT_DESK = ".sq.desk:not(.user)"
SWITCHBOARD = ".eye-desk"


class Page:
    def __init__(self, pg, html: pathlib.Path):
        self.pg = pg
        self.html = html

    # ---- lifecycle
    def open(self, size: tuple[int, int] = BIG) -> None:
        """⚠ EVERY SECTION STARTS FROM A FRESH PAGE. Focusing a card turns it
        into a desk and its `.name` goes away, so a second click_agent for the
        same agent silently finds nothing and leaves the PREVIOUS section's
        camera in place - which is how a probe reports a result it never
        measured. A reload also drops any focus, any open desk and any
        leftover pin."""
        self.pg.set_viewport_size({"width": size[0], "height": size[1]})
        self.pg.goto(self.html.as_uri(), wait_until="load")
        self.pg.wait_for_selector(".viewport", state="attached", timeout=8000)
        self.pg.wait_for_timeout(1200)   # the opening glide
        self.clear_pins()

    def vp(self) -> dict:
        b = self.pg.evaluate(BOX, ".viewport")
        return {"w": b["width"], "h": b["height"], "x": b["x"], "y": b["y"]}

    def resize(self, size: tuple[int, int]) -> None:
        self.pg.set_viewport_size({"width": size[0], "height": size[1]})
        self.pg.wait_for_timeout(SETTLE)

    # ---- state the fixture owns
    def set_pins(self, pins: list[dict]) -> None:
        self.pg.evaluate("(ps) => window.__probe.setPins(ps)", pins)
        self.pg.wait_for_timeout(SETTLE)

    def clear_pins(self) -> None:
        self.pg.evaluate("() => window.__probe.clearPins()")
        self.pg.wait_for_timeout(200)

    def set_agents(self, ids: list[str]) -> None:
        self.pg.evaluate("(ids) => window.__probe.setAgents(ids)", ids)
        self.pg.wait_for_timeout(SETTLE + 1000)   # springs, then any glide

    # ---- readers
    def box(self, sel: str) -> dict | None:
        return self.pg.evaluate(BOX, sel)

    def cam(self) -> str:
        return self.pg.evaluate(
            "() => document.querySelector('.space')?.style.transform ?? ''")

    def at_point(self, x: float, y: float) -> str:
        return self.pg.evaluate(
            "([x, y]) => { const e = document.elementFromPoint(x, y);"
            " return e ? (e.className?.baseVal ?? e.className ?? e.tagName)"
            " + '' : 'none' }", [x, y])

    def background_point(self) -> tuple[float, float] | None:
        """a point a real mouse can press to PAN: empty canvas, with no card,
        desk, HUD, tray or control bar on top of it. Searched rather than
        assumed - at desk zoom the surface fills most of the window, and a
        hard-coded corner landed on `.cbar` the first time this ran."""
        return self.pg.evaluate("""
        () => {
          const vp = document.querySelector('.viewport');
          if (!vp) return null;
          const r = vp.getBoundingClientRect();
          const blocked = '.sq, .eye-desk, .desk-over, .overlay, .cbar, .hud, ' +
            '.tray, .pinwin, button, input, textarea, a, .wd-chip, .hsof, ' +
            '.doc-chips, .pile-stack';
          for (let fy = 0.1; fy <= 0.9; fy += 0.1) {
            for (let fx = 0.02; fx <= 0.98; fx += 0.04) {
              const x = r.x + r.width * fx, y = r.y + r.height * fy;
              const e = document.elementFromPoint(x, y);
              if (!e || !vp.contains(e)) continue;
              if (e.closest(blocked)) continue;
              return { x, y, on: (e.className?.baseVal ?? e.className ?? e.tagName) + '' };
            }
          }
          return null;
        }
        """)

    def watch_during(self, sel: str, trigger: str, arg, ms: int = 1800,
                     step: int = 32) -> dict | None:
        """Fire `trigger` (a probe call, in the page) and then follow `sel`
        across the screen for `ms`, reporting the FURTHEST it ever strays from
        where it started.

        ⚠ THE END STATE IS NOT THE QUESTION HERE. A camera that re-aims itself
        at a card the layout is still moving ends up in the same place the
        per-frame follow would have held it - the surface slides across the
        window on the way, and that slide IS the complaint ("no update-event
        camera jumps"). Only sampling can see it, and the sampling has to
        start before the trigger's effects land, which is why both happen in
        one call inside the page."""
        return self.pg.evaluate("""
        async ([sel, trigger, arg, ms, step]) => {
          const read = () => { const e = document.querySelector(sel);
            if (!e) return null; const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height } };
          const first = read();
          if (!first) return null;
          window.__probe[trigger](arg);
          let worst = 0, at = first, gone = false;
          for (let t = 0; t < ms; t += step) {
            await new Promise((r) => setTimeout(r, step));
            const now = read();
            if (!now) { gone = true; continue }
            const d = Math.max(Math.abs(now.x - first.x), Math.abs(now.y - first.y),
              Math.abs(now.width - first.width), Math.abs(now.height - first.height));
            if (d > worst) { worst = d; at = now }
          }
          return { worst, first, at, gone, last: read() };
        }
        """, [sel, trigger, arg, ms, step])

    # ---- gestures
    def click_agent(self, name: str) -> bool:
        """a REAL mouse click on the card's NAME - not its geometric centre,
        which is where `.sq-actions` lives (a click there opens the retire
        confirmation instead of focusing)"""
        at = self.pg.evaluate("""
        (name) => {
          const c = [...document.querySelectorAll('.sq')].find(
            (e) => e.querySelector('.name')?.textContent?.trim() === name);
          if (!c) return null;
          const n = c.querySelector('.name') ?? c;
          const r = n.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        """, name)
        if not at:
            return False
        self.pg.mouse.click(at["x"], at["y"])
        self.pg.wait_for_timeout(SETTLE)
        return True

    def click_eye(self) -> bool:
        """the HUD eye button - the route the UI itself offers to the
        switchboard, and the same camera path as clicking the eye card (which
        sits at world x=6000 and is usually off-screen)"""
        n = self.pg.evaluate(
            "() => { const e = document.querySelector('.hud-eye');"
            " if (!e) return 0; e.click(); return 1 }")
        if not n:
            return False
        self.pg.wait_for_timeout(SETTLE)
        return True

    def refocus(self, sel: str) -> bool:
        """THE REFERENCE INSTRUMENT: re-issue the focus command for the open
        desk, which re-centres it (swbrecenter.test.tsx owns that behaviour),
        and read where a FRESH focus lands at the CURRENT size.

        ⚠ the click event is DISPATCHED on the surface rather than aimed with
        the mouse, and that is deliberate. A real click at the desk's centre
        lands on whatever control is there (the composer, a message, a tab) -
        and a click on a control must NOT re-centre, by design. The subject
        here is the camera the re-centre produces, not the hit testing, which
        swbrecenter.test.tsx already owns."""
        n = self.pg.evaluate("""
        (sel) => { const e = document.querySelector(sel);
          if (!e) return 0;
          e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 1 }
        """, sel)
        if not n:
            return False
        self.pg.wait_for_timeout(SETTLE)
        return True

    def drag_canvas(self, frm: tuple[float, float], dx: float, dy: float) -> None:
        self.pg.mouse.move(frm[0], frm[1])
        self.pg.mouse.down()
        self.pg.mouse.move(frm[0] + dx / 2, frm[1] + dy / 2, steps=4)
        self.pg.mouse.move(frm[0] + dx, frm[1] + dy, steps=4)
        self.pg.mouse.up()
        self.pg.wait_for_timeout(400)


# ------------------------------------------------------------------ the run
class Report:
    def __init__(self) -> None:
        self.failed: set[str] = set()
        self.passed: set[str] = set()
        self.lines: list[str] = []

    def ok(self, sec: str, msg: str) -> None:
        self.passed.add(sec)
        self.lines.append(f"  ok   §{sec} {msg}")
        print(f"  ok   §{sec} {msg}")

    def bad(self, sec: str, msg: str) -> None:
        self.failed.add(sec)
        self.lines.append(f"  FAIL §{sec} {msg}")
        print(f"  FAIL §{sec} {msg}")


def fitted(R: Report, sec: str, name: str, before: dict | None,
           after: dict | None, fresh: dict | None, region: dict | None) -> None:
    """the shared shape of §A/§B/§C: the surface moved, it lands where a fresh
    focus lands, and it FITS - with the positive control that a fresh focus at
    the new size wanted something different in the first place"""
    if not after or not fresh or not region:
        R.bad(sec, f"{name}: no box to measure (after={show(after)} "
                   f"fresh={show(fresh)} region={region})")
        return
    if apart(before, fresh) < 2:
        R.bad(sec, "POSITIVE CONTROL FAILED: a fresh focus after the change "
                   f"wants the same box as before it ({show(before)}), so this "
                   "section asks nothing of the canvas and would pass on a "
                   "build that ignored the change entirely")
        return
    R.ok(sec, f"positive control: the change moves where a focus belongs, "
              f"{show(before)} -> {show(fresh)}")
    d = apart(after, fresh)
    if d > 2:
        R.bad(sec, f"{name} was left at {show(after)}; a fresh focus at this "
                   f"size lands at {show(fresh)} - out by {d:.0f}px, so it did "
                   "not follow the available canvas")
    else:
        R.ok(sec, f"{name} followed the change to {show(after)} "
                  f"(a fresh focus lands within {d:.1f}px)")
    ov = overflow(after, region)
    if any(v > 0 for v in ov.values()):
        R.bad(sec, f"{name} escapes the free region "
                   f"{region['w']:.0f}x{region['h']:.0f} at "
                   f"{region['x']:.0f},{region['y']:.0f} by {ov} px")
    else:
        R.ok(sec, f"...and its painted box is INSIDE the free region "
                  f"{region['w']:.0f}x{region['h']:.0f} at "
                  f"{region['x']:.0f},{region['y']:.0f}")


def run(pg, html: pathlib.Path, R: Report) -> None:
    P = Page(pg, html)

    # ---- §A a focused AGENT DESK follows a real browser window resize
    P.open(BIG)
    if not P.click_agent("cto"):
        R.bad("A", "no card named 'cto' to click - the fixture did not render")
    elif not P.box(AGENT_DESK):
        R.bad("A", "the click opened no desk - nothing below is testable")
    else:
        before = P.box(AGENT_DESK)
        ov0 = overflow(before, clear_region([], P.vp()))
        if any(v > 0 for v in ov0.values()):
            R.bad("A", f"PRECONDITION: the desk does not even fit before the "
                       f"resize, by {ov0} px")
        P.resize(SMALL)
        after = P.box(AGENT_DESK)
        region = clear_region([], P.vp())
        if not after:
            R.bad("A", "the desk disappeared across the resize")
        else:
            P.refocus(f"{AGENT_DESK} .desk-over")
            fresh = P.box(AGENT_DESK)
            fitted(R, "A", "the agent desk", before, after, fresh, region)

    # ---- §B the focused SWITCHBOARD, same question
    P.open(BIG)
    if not P.click_eye():
        R.bad("B", "no .hud-eye button to reach the switchboard")
    elif not P.box(SWITCHBOARD):
        R.bad("B", "the eye click opened no switchboard")
    else:
        before = P.box(SWITCHBOARD)
        P.resize(SMALL)
        after = P.box(SWITCHBOARD)
        region = clear_region([], P.vp())
        if not after:
            R.bad("B", "the switchboard closed across the resize - a camera "
                       "that lands right with the surface shut is not what was "
                       "asked for")
        else:
            P.refocus(f"{SWITCHBOARD} .eye-panels")
            fresh = P.box(SWITCHBOARD)
            fitted(R, "B", "the switchboard", before, after, fresh, region)

    # ---- §C a PINNED WINDOW opening, with no window resize at all. This is
    # the half of "available canvas" a window.resize listener would miss.
    PINS = [{"id": "qa", "x": 700, "y": 80, "w": 520, "h": 720}]
    P.open(BIG)
    if not P.click_agent("cto"):
        R.bad("C", "no card named 'cto' to click")
    elif not P.box(AGENT_DESK):
        R.bad("C", "the click opened no desk")
    else:
        before = P.box(AGENT_DESK)
        vp = P.vp()
        P.set_pins(PINS)
        if not P.box(".pinwin"):
            R.bad("C", "the pin did not render - the canvas lost no space, so "
                       "this section is inert rather than passing")
        else:
            after = P.box(AGENT_DESK)
            region = clear_region(PINS, vp)
            P.refocus(f"{AGENT_DESK} .desk-over")
            fresh = P.box(AGENT_DESK)
            fitted(R, "C", "the agent desk", before, after, fresh, region)
        P.clear_pins()

    # ---- §D RELEASE: a hand-placed camera is never replaced by an automatic
    # fit - the same rule the whole-org fit has always had
    P.open(BIG)
    if not P.click_agent("cto"):
        R.bad("D", "no card named 'cto' to click")
    else:
        found = P.background_point()
        if not found:
            R.bad("D", "INERT: no pressable canvas background anywhere in the "
                       "window - a drag would not be a pan, so this section "
                       "cannot test what it claims")
        else:
            spot = (found["x"], found["y"])
            cam0 = P.cam()
            P.drag_canvas(spot, 90, 70)
            panned = P.cam()
            if panned == cam0:
                R.bad("D", "INERT: the drag did not move the camera, so "
                           "'the resize left it alone' is free")
            else:
                P.resize(SMALL)
                if P.cam() != panned:
                    R.bad("D", f"the resize replaced a hand-placed camera: "
                               f"{panned} -> {P.cam()}")
                else:
                    R.ok("D", "a hand-placed camera survived the resize "
                              "untouched")
                    # ...and the same rig DOES refit once a focus click
                    # re-arms the follow, so this cannot pass by the resize
                    # never arriving
                    if not P.refocus(f"{AGENT_DESK} .desk-over"):
                        R.bad("D", "POSITIVE CONTROL: no desk left to re-focus")
                    else:
                        armed = P.cam()
                        P.resize(BIG)
                        if P.cam() == armed:
                            R.bad("D", "POSITIVE CONTROL FAILED: with the "
                                       "follow re-armed the second resize "
                                       "still moved nothing - resizes are not "
                                       "reaching this page")
                        else:
                            R.ok("D", "...and the very same resize DOES move "
                                      "the camera once a focus click re-arms "
                                      "the follow")

    # ---- §E an unrelated ORG UPDATE must not re-aim the camera. Measured as
    # MOTION, not as an end state: a re-aim at a card the layout is still
    # moving finishes where the follow would have held it anyway, and only the
    # slide in between distinguishes them.
    P.open(BIG)
    if not P.click_agent("cto"):
        R.bad("E", "no card named 'cto' to click")
    elif not P.box(AGENT_DESK):
        R.bad("E", "the click opened no desk")
    else:
        # THE POSITIVE CONTROL FIRST, on a fresh page: the same sampler,
        # watching a real available-canvas change, must see the desk move -
        # otherwise "it did not move" below is free.
        moved = P.watch_during(AGENT_DESK, "setPins",
                               [{"id": "qa", "x": 700, "y": 80, "w": 520, "h": 720}])
        if not moved:
            R.bad("E", "INERT: the sampler could not find the desk at all")
        elif moved["worst"] < 20:
            R.bad("E", f"POSITIVE CONTROL FAILED: the sampler saw only "
                       f"{moved['worst']:.1f}px of movement while a pinned "
                       "window took a third of the canvas - it cannot see "
                       "movement, so it cannot report its absence")
        else:
            R.ok("E", f"positive control: the sampler sees {moved['worst']:.0f}px "
                      "of movement when the available canvas really changes")
            P.open(BIG)
            if not P.click_agent("cto") or not P.box(AGENT_DESK):
                R.bad("E", "the second page did not reach a focused desk")
            else:
                still = P.watch_during(
                    AGENT_DESK, "setAgents",
                    ["ceo", "cto", "qa", "ops", "x1", "x2", "x3"])
                if not still:
                    R.bad("E", "INERT: the sampler lost the desk")
                elif still["gone"]:
                    R.bad("E", "the desk vanished during an org update")
                elif still["worst"] > 8:
                    R.bad("E", f"an unrelated org update slid the focused desk "
                               f"{still['worst']:.0f}px across the screen "
                               f"({show(still['first'])} -> {show(still['at'])}) "
                               "- an update event moved the view with no resize "
                               "behind it")
                else:
                    R.ok("E", f"an unrelated org update (three more agents, the "
                              f"whole layout re-anchored) moved the focused desk "
                              f"by at most {still['worst']:.1f}px")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mutant", help="name, or 'all'")
    ap.add_argument("--list-mutants", action="store_true")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--json", help="write the observations here")
    args = ap.parse_args()

    if args.list_mutants:
        for name, (_, _, sections) in MUTANTS.items():
            print(f"{name:14s} must fail §{', §'.join(sections)}")
        return 0

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("INERT: playwright is not installed - this probe measured "
              "NOTHING. It is not a pass.")
        return 3

    names = list(MUTANTS) if args.mutant == "all" \
        else [args.mutant] if args.mutant else [None]
    for n in names:
        if n and n not in MUTANTS:
            print(f"unknown mutant {n!r}; --list-mutants")
            return 2

    worst = 0
    summary: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        for mutant in names:
            out = pathlib.Path(td) / (mutant or "real")
            build(out, mutant)
            R = Report()
            label = f"mutant {mutant}" if mutant else "the shipped canvas"
            print(f"\n=== {label} ===")
            try:
                with sync_playwright() as p:
                    try:
                        browser = p.chromium.launch(channel="msedge",
                                                    headless=not args.headed)
                    except Exception as exc:                      # noqa: BLE001
                        print(f"INERT: no msedge channel for playwright "
                              f"({exc.__class__.__name__}) - this probe "
                              "measured NOTHING. It is not a pass.")
                        return 3
                    pg = browser.new_page(viewport={"width": BIG[0], "height": BIG[1]})
                    errors: list[str] = []
                    pg.on("pageerror", lambda e: errors.append(str(e)))
                    try:
                        run(pg, out / "probe.html", R)
                    finally:
                        browser.close()
                if errors:
                    R.bad("page", f"the page threw: {errors[:3]}")
            except Exception as exc:                              # noqa: BLE001
                R.bad("run", f"the probe itself blew up: {exc!r}")

            red = sorted(R.failed)
            if mutant:
                want = set(MUTANTS[mutant][2])
                killed = want <= R.failed
                summary.append(f"{mutant:14s} must fail §{','.join(sorted(want))}"
                               f"  actually failed §{','.join(red) or '-'}"
                               f"  {'OK' if killed else 'SURVIVED'}")
                if not killed:
                    worst = 1
            else:
                summary.append(f"{'real':14s} failed §{','.join(red) or '-'}")
                if red:
                    worst = 1
            if args.json:
                pathlib.Path(args.json).write_text(
                    json.dumps({"mutant": mutant, "failed": red,
                                "lines": R.lines}, indent=2), encoding="utf-8")

    print("\n---- summary ----")
    for line in summary:
        print(line)
    return worst


if __name__ == "__main__":
    sys.exit(main())
