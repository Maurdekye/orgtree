"""showoncanvas_probe.py - a pinned window's "Show on canvas", driven with a
REAL right-click and a REAL left-click in a REAL browser.

User bug, 2026-09-11: "pinned desk rightclick Show on canvas only highlights
the already open pinned desk". `showoncanvas.test.tsx` owns the wiring in
jsdom - which route the entry takes, where the camera lands, that the pin
survives, and that a GENERIC jump to the same pinned agent still raises the
window. This file exists for the two things jsdom cannot answer about a
floating window's own menu:

  * IS THE ENTRY ACTUALLY REACHABLE. The menu is a document-body popup over a
    z-index 10-16 pinned window over the canvas. jsdom dispatches events at
    elements and has no hit testing at all, so "the handler runs" there is not
    "a person can click it". Here the right-click and the menu click are real
    mouse events at real coordinates, and the entry is hit-tested at its own
    centre before being clicked.
  * DOES THE CANVAS VISIBLY GO THERE. jsdom does no layout, so it can only
    read the camera numbers the component wrote. Here the agent's own card is
    measured where it is actually painted.

ANTI-VACUITY. §F requires the camera to MOVE and the pin to SURVIVE; §G is
the rule this change carves an exception out of - the same page, the same
open window, the GENERIC route (activating the title's name, which every
other agent name does too), which must raise the window and leave the camera
alone. §G leans on §F having just moved the camera on this very page, so "it
did not move" cannot pass because nothing here can move it. Mutants below
must make the sections they name fail.

    cd apps/desktop/renderer
    python -B tests/showoncanvas_probe.py
    python -B tests/showoncanvas_probe.py --mutant all
    python -B tests/showoncanvas_probe.py --list-mutants
    python -B tests/showoncanvas_probe.py --headed

Requires playwright with the msedge channel. Missing either, it EXITS INERT
(code 3) and says so - it never reports a pass it could not have failed.
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
BUILD = HERE / "focusstick_build.mjs"     # same page, same real OrgCanvas

VP = (1280, 900)
SETTLE = 1400
PIN = {"id": "cto", "x": 60, "y": 60, "w": 460, "h": 360}

MUTANTS: dict[str, tuple[str, str, list[str]]] = {
    # the menu entry back on the generic jump - the reported bug
    "menu-generic": (
        "            onSelect: () => onShowOnCanvas(pin.id) },",
        "            onSelect: () => onJump(pin.id) },",
        ["F"]),
    # the flag reaches centerOn and is ignored
    "ignore-flag": (
        "    if (!onCanvas && pinnedIdsRef.current.has(id)) {",
        "    if (pinnedIdsRef.current.has(id)) {",
        ["F"]),
    # the exception leaks into the generic route
    "leak-generic": (
        "            if (e.detail !== 0) return\n            onJump?.(id)",
        "            if (e.detail !== 0) return\n            onShowOnCanvas(id)",
        ["G"]),
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


# ⚠ focusstick_build.mjs substitutes into OrgCanvas.tsx only. The menu entry
# lives in pins.tsx, so that mutant needs its own swap - added here rather
# than by widening the shared bundler, which other probes depend on.
PINS_MUTANTS = {"menu-generic", "leak-generic"}


def build_with_pins(outdir: pathlib.Path, mutant: str | None) -> None:
    if mutant not in PINS_MUTANTS:
        build(outdir, mutant)
        return
    pins = RENDERER / "src" / "canvas" / "pins.tsx"
    original = pins.read_bytes()
    old, new, _ = MUTANTS[mutant]
    body = original.decode("utf-8").replace("\r\n", "\n")
    if body.count(old) != 1:
        raise SystemExit(f"mutant {mutant} matched {body.count(old)} times in "
                         "pins.tsx - the mutant is stale")
    try:
        pins.write_bytes(body.replace(old, new).replace("\n", "\r\n").encode("utf-8"))
        build(outdir, None)
    finally:
        pins.write_bytes(original)


BOX = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
"""


class Page:
    def __init__(self, pg, html: pathlib.Path):
        self.pg = pg
        self.html = html

    def open(self) -> None:
        self.pg.set_viewport_size({"width": VP[0], "height": VP[1]})
        self.pg.goto(self.html.as_uri(), wait_until="load")
        self.pg.wait_for_selector(".viewport", state="attached", timeout=8000)
        self.pg.wait_for_timeout(1200)
        self.pg.evaluate("() => window.__probe.clearPins()")
        self.pg.wait_for_timeout(200)

    def pin(self, spec: dict) -> bool:
        self.pg.evaluate("(p) => window.__probe.setPins([p])", spec)
        self.pg.wait_for_timeout(SETTLE)
        return bool(self.box(".pinwin"))

    def box(self, sel: str):
        return self.pg.evaluate(BOX, sel)

    def cam(self) -> str:
        return self.pg.evaluate(
            "() => document.querySelector('.space')?.style.transform ?? ''")

    def placeholder_card(self):
        """the card the placeholder is sitting in, as painted.

        ⚠ NOT found by its `.name`: a card wearing the desk layout (a real
        desk OR this pinned placeholder) hides the name element, so a
        name-based search finds nothing and reports "no card" when the card is
        right there. The placeholder is a CHILD of the card, so walk up."""
        return self.pg.evaluate("""
        () => {
          const h = document.querySelector('.pin-holder');
          const c = h?.closest('.sq');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          const mid = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { x: r.x, y: r.y, width: r.width, height: r.height,
                   inside: !!mid && c.contains(mid) };
        }
        """)

    def right_click_title(self) -> bool:
        b = self.box(".pinwin-title")
        if not b:
            return False
        self.pg.mouse.click(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2,
                            button="right")
        self.pg.wait_for_timeout(300)
        return True

    def menu_labels(self) -> list[str]:
        return self.pg.evaluate(
            "() => [...document.querySelectorAll('.ctxmenu [role=\"menuitem\"]')]"
            ".map((b) => b.textContent ?? '')")

    def menu_item_reachable(self, label: str):
        """hit-test the entry at its OWN centre: a menu item that a real click
        cannot land on is not a menu item"""
        return self.pg.evaluate("""
        (label) => {
          const b = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
            .find((e) => e.textContent === label);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, reached: !!hit && (hit === b || b.contains(hit)),
                   on: hit ? (hit.className?.baseVal ?? hit.className ?? hit.tagName) + '' : 'none' };
        }
        """, label)

    def click_menu_item(self, at) -> None:
        self.pg.mouse.click(at["x"], at["y"])
        self.pg.wait_for_timeout(SETTLE)

    def enter_on_pin_name(self) -> bool:
        """the GENERIC route: activating the pinned title's agent name with the
        keyboard, which is what every other agent name does too"""
        ok = self.pg.evaluate("""
        () => { const n = document.querySelector('.pinwin-title .pinwin-name');
          if (!n) return 0; n.focus(); return document.activeElement === n ? 1 : 0 }
        """)
        if not ok:
            return False
        self.pg.keyboard.press("Enter")
        self.pg.wait_for_timeout(SETTLE)
        return True


class Report:
    def __init__(self) -> None:
        self.failed: set[str] = set()
        self.passed: set[str] = set()

    def ok(self, sec: str, msg: str) -> None:
        self.passed.add(sec)
        print(f"  ok   §{sec} {msg}")

    def bad(self, sec: str, msg: str) -> None:
        self.failed.add(sec)
        print(f"  FAIL §{sec} {msg}")


def run(pg, html: pathlib.Path, R: Report) -> None:
    P = Page(pg, html)
    P.open()
    if not P.pin(PIN):
        R.bad("F", "the pinned window did not render - nothing to right-click")
        R.bad("G", "the pinned window did not render")
        return

    before = P.cam()
    if not P.right_click_title():
        R.bad("F", "no .pinwin-title to right-click")
        return
    labels = P.menu_labels()
    if "Show on canvas" not in labels:
        R.bad("F", f"the title's menu has no 'Show on canvas' entry: {labels}")
        return
    R.ok("F", f"a real right-click on the pinned title opens its menu: {labels}")
    at = P.menu_item_reachable("Show on canvas")
    if not at or not at["reached"]:
        R.bad("F", "the entry exists but a hit test at its own centre lands on "
                   f"{at['on'] if at else 'nothing'!r} - a real click cannot reach it")
        return
    R.ok("F", "...and a hit test at the entry's own centre reaches the entry")

    P.click_menu_item(at)
    after = P.cam()
    if after == before:
        R.bad("F", f"the canvas did not move at all: still {before} - this is "
                   "the reported bug, the action only touched the window that "
                   "was already in front of the reader")
    else:
        R.ok("F", "a real click on the entry moved the canvas camera")
    if not P.box(".pinwin"):
        R.bad("F", "the pinned window is GONE - it must stay open")
    else:
        R.ok("F", "...and the pinned window is still open")
    card = P.placeholder_card()
    if not card:
        R.bad("F", "the canvas moved but no card is showing the pinned "
                   "placeholder, so the camera did not land on the agent")
    elif not card["inside"]:
        R.bad("F", f"the placeholder card is painted at {card['x']:.0f},"
                   f"{card['y']:.0f} but a hit test at its own centre lands "
                   "outside it - it is covered or off-screen")
    else:
        R.ok("F", f"...and the agent's own card is painted at "
                  f"{card['width']:.0f}x{card['height']:.0f} at "
                  f"{card['x']:.0f},{card['y']:.0f} showing the pinned "
                  "placeholder, reachable at its own centre")

    # ---- §G the GENERIC route, on a FRESH page.
    #
    # ⚠ NOT continued from §F, and the first cut of this probe was wrong to
    # try: by the end of §F the camera is ALREADY parked on that agent's card,
    # so a generic route that wrongly navigated would navigate to where the
    # camera already is and move nothing. The `leak-generic` mutant survived
    # exactly that way. A fresh page puts the camera back on the whole org,
    # where the two routes have visibly different destinations.
    P.open()
    if not P.pin(PIN):
        R.bad("G", "the pinned window did not render on the second page")
        return
    parked = P.cam()
    if not P.enter_on_pin_name():
        R.bad("G", "INERT: the pinned title's name could not take keyboard "
                   "focus, so the generic route was never exercised")
        return
    if P.cam() != parked:
        R.bad("G", "activating the pinned window's NAME moved the canvas "
                   f"({parked} -> {P.cam()}) - the generic jump must raise the "
                   "window instead; the canvas route belongs to the explicit "
                   "menu entry alone")
    else:
        R.ok("G", "the generic name activation left the camera alone - it "
                  "raises the window, as a jump to a pinned agent should")
    # THE POSITIVE CONTROL, on this same fresh page: the explicit entry DOES
    # move it from here, so "nothing moved" above is a result rather than a
    # property of the page.
    if not P.right_click_title():
        R.bad("G", "POSITIVE CONTROL: no title bar to right-click")
        return
    at = P.menu_item_reachable("Show on canvas")
    if not at or not at["reached"]:
        R.bad("G", "POSITIVE CONTROL: the menu entry is not reachable here")
        return
    P.click_menu_item(at)
    if P.cam() == parked:
        R.bad("G", "POSITIVE CONTROL FAILED: the explicit entry did not move "
                   "the camera from this page either, so §G cannot tell the "
                   "two routes apart")
    else:
        R.ok("G", "...and the explicit entry, from the same camera, DOES move "
                  "it - the two routes are genuinely distinguished")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mutant", help="name, or 'all'")
    ap.add_argument("--list-mutants", action="store_true")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    if args.list_mutants:
        for name, (_, _, sec) in MUTANTS.items():
            print(f"{name:14s} must fail §{', §'.join(sec)}")
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

    worst, summary = 0, []
    with tempfile.TemporaryDirectory() as td:
        for mutant in names:
            out = pathlib.Path(td) / (mutant or "real")
            build_with_pins(out, mutant)
            R = Report()
            print(f"\n=== {'mutant ' + mutant if mutant else 'the shipped canvas'} ===")
            with sync_playwright() as p:
                try:
                    browser = p.chromium.launch(channel="msedge",
                                                headless=not args.headed)
                except Exception as exc:                          # noqa: BLE001
                    print(f"INERT: no msedge channel for playwright "
                          f"({exc.__class__.__name__}) - this probe measured "
                          "NOTHING. It is not a pass.")
                    return 3
                pg = browser.new_page(viewport={"width": VP[0], "height": VP[1]})
                errors: list[str] = []
                pg.on("pageerror", lambda e: errors.append(str(e)))
                try:
                    run(pg, out / "probe.html", R)
                finally:
                    browser.close()
            if errors:
                R.bad("page", f"the page threw: {errors[:3]}")
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

    print("\n---- summary ----")
    for line in summary:
        print(line)
    return worst


if __name__ == "__main__":
    sys.exit(main())
