"""modalpin_probe.py — can a modal actually be pinned and dragged in a browser?

User spec 2026-09-06: "most openable modals in the app should be able to be
pinned to the window and dragged around, like pinned agent windows. this goes
for inboxes, usage, presentations, the docket, etc."

`modalpin.test.tsx` owns the DOM-level contract in jsdom — the store, which
element carries the window, what the handlers write. It cannot answer the half
of this feature that IS layout and input: jsdom paints nothing, has no
`pointer-events`, no `position: sticky`, no scrolling, no text selection and no
real pointer. So this file drives the REAL DocGalleryModal ("presentations",
one of the four surfaces the user named) in Edge, with the real stylesheet, and
asks the browser.

    python -B tests/modalpin_probe.py                  # the shipped code
    python -B tests/modalpin_probe.py --json out.json  # ...and keep the numbers
    python -B tests/modalpin_probe.py --mutant all     # KNOWN-NEGATIVE CONTROLS
        # every named mutant is applied to the current source in memory and
        # MUST make this probe fail; a mutant that measures clean means the
        # check it targets is decorative

WHAT IT CHECKS
  centred    before anything is pinned the surface is exactly what it was: a
             dimmed backdrop that takes clicks, a centred panel, no inline rect
  pin        the pin control turns it into a window WHERE IT ALREADY WAS
             (measureRect), absolutely positioned, geometry in localStorage
  through    a pinned window has no backdrop: a click outside it reaches the
             page behind. CONTROL: the same click while centred closes the
             surface and never reaches the button behind
  drag       a real mouse press-move-release on the title bar moves the window
             by exactly the pointer's delta, and commits it
  clamp      a drag toward the top-left corner and past the right edge leaves
             the whole window inside the browser window
  resize     the SE corner grows the window; the W edge past the minimum keeps
             the EAST edge still
  state      an inner list scrolled and a row selected keep both across a pin
             and an unpin. CONTROL: the scroll offset must be non-zero first,
             or the check is free
  sticky     with the panel itself scrolled, the title bar — the drag handle —
             is still at the top of the window and still drags it
  select     text inside a pinned window can still be selected with the mouse
  escape     Escape closes a centred surface and is ignored by a pinned one
  stack      two pinned windows coexist; a press raises one over the other
  unpin      the surface goes back to centred, with its backdrop
  headrow    the three surfaces that keep their title INSIDE a header row —
             the gallery, the docket and the document reader — say their name
             once while pinned, and the controls sharing that row stay where
             the user put them. CONTROL: centred, each one still shows its own
             title, and the row's last control is still at the right edge

POSITIVE CONTROLS live inside the checks (marked CONTROL above): the
click-through check requires the centred case to behave the OLD way, and the
state check requires a scroll offset it can actually lose. The mutants are the
rest of the proof.

Requires playwright with the msedge channel (same dependency as
confirmfocus_probe / kbdhire_probe).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "modalpin_build.mjs"

# ----------------------------------------------------------------- mutants
# Each is an exact-once substitution on the CURRENT source, applied in memory
# by the build script. Each targets one check that passes before AND after the
# patch — including the CSS, because half of what this probe measures is CSS.
MUTANTS: dict[str, tuple[str, str, str, str]] = {
    # (file, old, new, which check must go red)
    "remount-on-pin": (
        "src/canvas/modalpin.tsx",
        "        {children}\n",
        "        {pinned ? <div className=\"regression-wrapper\">{children}</div> : children}\n",
        "state: pinning rebuilds the surface and loses its scroll/selection"),
    "backdrop-keeps-taking-clicks": (
        "src/styles.css",
        "  background: none; pointer-events: none; display: block;",
        "  background: none; pointer-events: auto; display: block;",
        "through: the invisible backdrop still eats clicks meant for the page"),
    "pinned-window-still-dims-the-page": (
        "src/styles.css",
        ".overlay.overlay-pinned {\n"
        "  /* not a modal any more: no dimming, and every click falls through to what\n"
        "     is behind it. The panel takes its own pointer events back below. */\n"
        "  background: none;",
        ".overlay.overlay-pinned {\n"
        "  background: rgba(0, 0, 0, .45);",
        "centred/pin: a pinned window is still a modal interruption"),
    "the-title-bar-scrolls-away": (
        "src/styles.css",
        "  position: sticky; top: -8px; z-index: 6; margin: -8px -10px 0;",
        "  position: static; z-index: 6; margin: -8px -10px 0;",
        "sticky: the drag handle scrolls out of the window"),
    "the-window-is-not-positioned": (
        "src/styles.css",
        ".modalpin-win {\n  position: absolute;",
        ".modalpin-win {\n  position: static;",
        "pin: the panel is not a window at all"),
    "the-panel-cannot-be-clicked": (
        "src/styles.css",
        ".overlay.overlay-pinned > * { pointer-events: auto; }",
        ".overlay.overlay-pinned > * { pointer-events: none; }",
        "through/drag: the window itself stops taking input"),
    # THE one clamp boundary (see the ⚠ in gestureRect): the render is what
    # keeps a window on screen, and it is measured MID-DRAG because the commit
    # clamps too — a check that only looked after the release would pass with
    # this removed and would be measuring the commit instead.
    "no-render-time-clamp": (
        "src/canvas/modalpin.tsx",
        "  const rect = pin ? clampRect(live ?? pin.rect, winSize()) : null",
        "  const rect = pin ? (live ?? pin.rect) : null",
        "clamp: a window can be dragged off the screen and lost"),
    "escape-closes-a-pinned-window": (
        "src/canvas/modalpin.tsx",
        "  useEsc(useCallback(() => { if (!pinned) esc() }, [pinned, esc]))",
        "  useEsc(esc)",
        "escape: a pinned window is dismissed by a key meant for a dialog"),
    "a-fresh-pin-jumps-somewhere-else": (
        "src/canvas/modalpin.tsx",
        "  const r = el?.getBoundingClientRect()\n"
        "  if (!r || r.width <= 0 || r.height <= 0) return MODAL_FALLBACK_RECT",
        "  const r = el?.getBoundingClientRect()\n"
        "  if (r || !r) return MODAL_FALLBACK_RECT",
        "pin: the window does not appear where the panel already was"),
    "no-raise-on-press": (
        "src/canvas/modalpin.tsx",
        "        onPointerDown={pinned ? () => raiseModal(kind) : undefined}>",
        "        onPointerDown={undefined}>",
        "stack: the window you press does not come to the front"),
    # ---- the nested-dialog family. This IS the defect that was measured on
    # 2026-09-06 (compose's backdrop covering the pinned inbox that raised it),
    # so each of these puts a piece of it back.
    "nested-dialog-stays-inside-its-host": (
        "src/canvas/modalpin.tsx",
        "  if (typeof document === 'undefined') return <>{children}</>\n",
        "  if (typeof document !== 'undefined') return <>{children}</>\n",
        "nested: the dialog is trapped in its host's stacking context again"),
    "nested-dialog-sits-inside-the-pin-band": (
        "src/styles.css",
        ".modalpin-over > .overlay { z-index: 31; }",
        ".modalpin-over > .overlay { z-index: 20; }",
        "nested: a dialog raised from a pinned window renders behind it"),
    # the measured defect itself, put straight back: a dialog raised from a
    # pinned window that goes on dimming and eating clicks even once it is a
    # window of its own. (Scoped to `.modalpin-over`, so this is a different
    # mutant from `pinned-window-still-dims-the-page` — that one is killed by
    # the gallery checks long before these ever run.)
    "a-pinned-dialog-still-dims-its-host": (
        "src/styles.css",
        ".modalpin-over > .overlay { z-index: 31; }",
        ".modalpin-over > .overlay { z-index: 30;\n"
        "  background: rgba(0, 0, 0, .45) !important;\n"
        "  pointer-events: auto !important; }",
        "nested-pin: pinning the dialog does not give the host window back"),
    # the OTHER half of ModalOverPins: the parent has to be CONSTANT. A portal
    # whose container is rebuilt remounts everything under it, which is how a
    # half-typed draft dies on a pin toggle — the thing Astra named.
    # the obvious-looking alternative to a constant parent: portal only WHILE
    # the dialog is pinned. ⚠ READ WHAT THIS ACTUALLY PROVES — it is killed by
    # the two `nested` checks (centred, the dialog is back inside its host), and
    # NOT by the draft assertion, which survives it. See the ⚠ on that
    # assertion: nothing that can be done to this file loses that draft.
    "the-portal-is-conditional-on-being-pinned": (
        "src/canvas/modalpin.tsx",
        "  if (typeof document === 'undefined') return <>{children}</>\n"
        "  return createPortal(",
        "  if (useModalPin('compose') === null) return <>{children}</>\n"
        "  return createPortal(",
        "nested: a conditional portal leaves the centred dialog inside its host"),
    "two-titles-on-a-pinned-window": (
        "src/styles.css",
        ".modalpin-win > h3:first-of-type { display: none; }",
        ".modalpin-win > h3:first-of-type { display: revert; }",
        "title: a pinned window shows its title twice"),
    "the-window-bar-name-is-not-a-heading": (
        "src/canvas/modalpin.tsx",
        "            <span className=\"modalpin-name\" role=\"heading\" aria-level={3}>",
        "            <span className=\"modalpin-name\">",
        "title: with the h3 hidden, the window has no heading at all"),
    "every-heading-is-hidden-not-just-the-title": (
        "src/styles.css",
        ".modalpin-win > h3:first-of-type { display: none; }",
        ".modalpin-win h3, .settings h3 { display: none; }",
        "title: the CONTROL — a centred surface keeps its own heading"),
    # THE DEFECT THAT SHIPPED IN THE FIRST VERSION OF THIS RULE, one surface
    # shape at a time: a child combinator that misses a title nested one level
    # down inside a header row. Both mutants are the rule as it was before the
    # fix for that half of the app.
    "the-title-rule-misses-a-header-row": (
        "src/styles.css",
        ".modalpin-win > .gallery-head > h3,\n"
        ".modalpin-win > .doc-reader-head > .doc-reader-title { display: none; }",
        ".modalpin-win > .doc-reader-head > .doc-reader-title { display: none; }",
        "headrow/gallery + headrow/docket: a pinned window shows its title twice"),
    "the-title-rule-misses-the-document-reader": (
        "src/styles.css",
        ".modalpin-win > .gallery-head > h3,\n"
        ".modalpin-win > .doc-reader-head > .doc-reader-title { display: none; }",
        ".modalpin-win > .gallery-head > h3 { display: none; }",
        "headrow/reader: the reader's <b> title is not reachable by tag"),
    "the-header-control-slides-left-with-the-heading": (
        "src/styles.css",
        ".modalpin-win.gallery-modal > .gallery-head { justify-content: flex-end; }",
        ".modalpin-win.gallery-modal > .gallery-head { justify-content: flex-start; }",
        "headrow/gallery: hiding the heading moved the show-retired checkbox"),
    "the-reader-keeps-its-dangling-separator": (
        "src/styles.css",
        ".modalpin-win > .doc-reader-head > .doc-reader-meta > .doc-reader-sep {\n"
        "  display: none;\n}",
        ".modalpin-win > .doc-reader-head > .doc-reader-meta > .doc-reader-sep {\n"
        "  display: revert;\n}",
        "headrow/reader: the pinned header opens on a separator with no title"),
}


def build(outdir: pathlib.Path, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
    if mutant:
        f, old, new, _ = MUTANTS[mutant]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                          encoding="utf-8")
        json.dump([{"file": f, "old": old, "new": new}], tmp)
        tmp.close()
        args += ["--subst", tmp.name]
    try:
        subprocess.run(["node", *args], check=True, cwd=str(FRONTEND))
    finally:
        if tmp:
            pathlib.Path(tmp.name).unlink(missing_ok=True)
    if not (outdir / "probe.css").exists():
        raise SystemExit("bundle produced no probe.css — styles.css import lost")


# ------------------------------------------------------------- page helpers
BOX = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { x: Math.round(r.x), y: Math.round(r.y),
           w: Math.round(r.width), h: Math.round(r.height),
           position: cs.position, pointerEvents: cs.pointerEvents,
           background: cs.backgroundColor, zIndex: cs.zIndex,
           left: el.style.left, top: el.style.top };
}
"""
STORED = "() => JSON.parse(localStorage.getItem('orgtree-modal-pins') || 'null')"
LOG = "() => window.__probe.log.slice()"

GALLERY = ".gallery-modal"
BAR = ".gallery-modal .modalpin-bar"
# the toggle is the only control in the bar that carries aria-pressed —
# `.modalpin-btn` alone also matches the window's close button
PIN_BTN = ".gallery-modal .modalpin-bar .modalpin-btn[aria-pressed]"
# the gallery panel is ALSO a `.settings`, so the second surface has to be
# named by what it is not — otherwise every selector below matches both
SECOND = ".settings:not(.gallery-modal):not(.wide):not(.cmp-modal)"
SECOND_PIN_BTN = SECOND + " .modalpin-bar .modalpin-btn[aria-pressed]"
SECOND_WIN = SECOND + ".modalpin-win"

# the `?compose=1` fixture: a real org inbox, and the real compose dialog it
# raises from inside itself. `.cmp-modal` is also a `.settings`, so SECOND has
# to exclude it as well as the inbox's `.wide`.
INBOX = ".settings.wide"
COMPOSE = ".settings.cmp-modal"
# the highest z-index a pinned window can take; a dialog raised from one has to
# clear it (MODAL_Z_TOP in modalpin.tsx — kept here as a literal on purpose, so
# a change on one side is a red check rather than two values moving together)
MODAL_Z_TOP = 29
DRAFT = "a half-typed draft that must survive being pinned"

# ---- the surfaces whose own title sits INSIDE A HEADER ROW rather than in the
# plain <h3> the other fourteen open with. That shape is invisible to a child
# combinator, so the first version of the title rule reached none of them and
# all three said their name twice while pinned (found by codex-delivery,
# browser-measured, 2026-09-06). Each is driven here as ITSELF, one per page
# load: (fixture, panel, the title element under it, the words it says, what to
# wait for). `.gallery-head` is the gallery's own markup, worn by the docket.
HEAD_ROW_SURFACES = [
    ("gallery", ".gallery-modal", ".gallery-head > h3", "Presented documents",
     ".gallery-modal .mailer-list"),
    ("docket", ".docket-modal", ".gallery-head > h3", "Work docket",
     ".docket-modal .gallery-head"),
    ("reader", ".doc-reader", ".doc-reader-head > .doc-reader-title",
     "Document number 0 — a presented plan with a long enough title to wrap",
     ".doc-reader .doc-reader-body"),
]

# ⚠ `innerText`, NOT `textContent`: the question is what the user SEES, and
# textContent counts a heading that CSS has hidden. The last element in the
# header row is whatever control that row ends with — the gallery's checkbox,
# the docket's and the reader's close button — and it has to stay at the right
# edge in both modes, which is where the user asked for it.
HEAD_ROW = """
(a) => {
  const [panel, titleSel, words] = a;
  const w = document.querySelector(panel);
  if (!w) return null;
  const t = w.querySelector(':scope > ' + titleSel);
  const bar = w.querySelector(':scope > .modalpin-bar .modalpin-name');
  const head = t && t.parentElement;
  const last = head && head.lastElementChild;
  const wr = w.getBoundingClientRect();
  const lr = last && last.getBoundingClientRect();
  return {
    pinned: w.classList.contains('modalpin-win'),
    display: t ? getComputedStyle(t).display : null,
    text: t ? t.textContent.trim() : null,
    bar: bar ? bar.textContent.trim() : null,
    shown: w.innerText.split(words).length - 1,
    head: head ? head.innerText.trim() : null,
    ctl: last ? last.className : null,
    ctlGap: lr ? Math.round(wr.right - lr.right) : null,
    ctlRoom: lr ? Math.round(wr.width - lr.width) : null,
  };
}
"""


class Page:
    def __init__(self, pg, html: pathlib.Path, fail):
        self.pg = pg
        self.html = html
        self.fail = fail

    def open(self, query: str = "", reset: bool = True,
             ready: str = ".gallery-modal .mailer-list") -> None:
        """load the page. `reset` clears the stored pins first — a pin SURVIVES
        a reload (that is the feature), so without this every check would
        inherit the previous one's windows."""
        self.pg.goto(self.html.as_uri() + ("?" + query if query else ""),
                     wait_until="load")
        if reset:
            self.pg.evaluate("() => localStorage.clear()")
            self.pg.reload(wait_until="load")
        self.pg.wait_for_selector(ready, timeout=8000)

    def box(self, sel: str) -> dict | None:
        return self.pg.evaluate(BOX, sel)

    def stored(self) -> dict | None:
        return self.pg.evaluate(STORED)

    def log(self) -> list[str]:
        return self.pg.evaluate(LOG)

    def click(self, sel: str) -> None:
        """click a control the way a user would — and if something is covering
        it, SAY SO by name and click it anyway. A probe that just hung there
        would report a mutant as "could not run", which proves the mutant broke
        something but not that any named check caught it."""
        try:
            self.pg.locator(sel).first.click(timeout=4000)
        except Exception:                    # noqa: BLE001 — timeout or overlay
            self.fail(f"reach: {sel} could not be clicked — something is "
                      f"covering it or it is not there")
            try:
                self.pg.eval_on_selector(sel, "(el) => el.click()")
            except Exception:                # noqa: BLE001 — it is simply gone
                pass
        self.pg.wait_for_timeout(60)

    def drag(self, sel: str, dx: int, dy: int, *, steps: int = 6,
             at: tuple[float, float] | None = None) -> None:
        """a real press-move-release with the mouse, on `sel`."""
        b = self.box(sel)
        assert b, f"no element for {sel}"
        sx = at[0] if at else b["x"] + b["w"] / 2
        sy = at[1] if at else b["y"] + b["h"] / 2
        self.pg.mouse.move(sx, sy)
        self.pg.mouse.down()
        self.pg.mouse.move(sx + dx, sy + dy, steps=steps)
        self.pg.mouse.up()
        self.pg.wait_for_timeout(60)

    def drag_hold(self, sel: str, dx: int, dy: int):
        """press and move WITHOUT releasing, so the caller can measure the
        window while the gesture is still in flight — the only moment the
        render-time clamp is the thing being tested rather than the commit."""
        b = self.box(sel)
        assert b, f"no element for {sel}"
        sx, sy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        self.pg.mouse.move(sx, sy)
        self.pg.mouse.down()
        self.pg.mouse.move(sx + dx, sy + dy, steps=6)
        self.pg.wait_for_timeout(40)

    def drop(self) -> None:
        self.pg.mouse.up()
        self.pg.wait_for_timeout(60)

    def key(self, k: str) -> None:
        self.pg.keyboard.press(k)
        self.pg.wait_for_timeout(60)


def near(a: float, b: float, tol: float = 2.0) -> bool:
    return abs(a - b) <= tol


# ------------------------------------------------------------------- checks
def run(html: pathlib.Path, verbose: bool = True) -> tuple[list[str], dict]:
    fails: list[str] = []
    obs: dict = {}

    def bad(msg: str) -> None:
        fails.append(msg)
        if verbose:
            print(f"    FAIL {msg}")

    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge")
        ctx = br.new_context(viewport={"width": 1280, "height": 900})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: bad(f"page error: {e}"))
        page = Page(pg, html, bad)

        # ---------------------------------------------------------- centred
        page.open()
        overlay = page.box(".overlay")
        panel = page.box(GALLERY)
        obs["centred"] = {"overlay": overlay, "panel": panel}
        if not overlay or not panel:
            bad("centred: the gallery did not render")
            br.close()
            return fails, obs
        if overlay["pointerEvents"] != "auto":
            bad(f"centred: the backdrop does not take clicks ({overlay['pointerEvents']})")
        if overlay["background"] in ("rgba(0, 0, 0, 0)", "transparent"):
            bad("centred: the backdrop is not dimmed")
        if panel["left"] or panel["top"]:
            bad(f"centred: the panel carries an inline rect ({panel['left']},{panel['top']})")
        if not page.pg.locator(PIN_BTN).count():
            bad("centred: the real gallery panel offers no pin control")
        # ...and it costs the panel almost nothing: the bar is pulled up into
        # the padding the panel already had, so the heading does not walk down
        # the page. In flow at its own height it would land near y+58; the
        # centred layout has to stay close to the panel's own 22px padding.
        bar = page.box(".gallery-modal .modalpin-bar")
        head = page.box(".gallery-modal .gallery-head")
        obs["centred_bar"] = {"bar": bar, "head": head, "panel": panel}
        if not bar or bar["y"] < panel["y"] - 1:
            bad(f"centred: the pin control is outside the panel ({bar})")
        if head and head["y"] - panel["y"] > 40:
            bad(f"centred: the pin control pushed the panel's heading down "
                f"({head['y'] - panel['y']}px below the panel's top)")

        # CONTROL for `through`: the background button sits ABOVE the centred
        # panel on the page, and clicking it hits the backdrop instead — the
        # click closes the surface and never reaches the button. That is the
        # behaviour a pinned window has to break, so it is measured first.
        btn = page.box("#behind-modal")
        obs["behind_button"] = btn
        page.pg.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
        page.pg.wait_for_timeout(80)
        log = page.log()
        obs["centred_backdrop_click"] = log
        if "close gallery" not in log:
            bad("centred: a backdrop click no longer closes the surface")
        if "background clicked" in log:
            bad("centred: a backdrop click reached the page behind it")

        # ------------------------------------------------------------- pin
        page.open()
        before = page.box(GALLERY)
        page.click(PIN_BTN)
        pinned = page.box(GALLERY)
        overlay = page.box(".overlay")
        stored = page.stored()
        obs["pin"] = {"before": before, "after": pinned, "overlay": overlay,
                      "stored": stored}
        if not pinned or pinned["position"] != "absolute":
            bad(f"pin: the window is not positioned ({pinned and pinned['position']})")
        elif not (near(pinned["x"], before["x"], 4) and near(pinned["y"], before["y"], 4)
                  and near(pinned["w"], before["w"], 4) and near(pinned["h"], before["h"], 4)):
            bad(f"pin: the window did not appear where the panel was: "
                f"{before} -> {pinned}")
        if overlay and overlay["pointerEvents"] != "none":
            bad(f"pin: the backdrop still takes clicks ({overlay['pointerEvents']})")
        if overlay and overlay["background"] not in ("rgba(0, 0, 0, 0)", "transparent"):
            bad(f"pin: the page is still dimmed behind the window ({overlay['background']})")
        if not stored or "gallery" not in stored:
            bad(f"pin: nothing was stored ({stored})")

        # ⚠ SHRINK IT FIRST, or every measurement below is the clamp's. The
        # gallery is `.settings.wide` — 96vw by 88vh — so a pinned one nearly
        # fills the browser window and can barely be dragged anywhere: a drag
        # check against it would measure the clamp and call it a drag.
        page.drag(".gallery-modal + .modalpin-resize-frame .modalpin-rs.se", -560, -380)
        small = page.box(GALLERY)
        obs["shrunk"] = small
        if small["w"] > 900 or small["h"] > 600:
            bad(f"resize: the SE corner did not shrink the window ({small})")

        # --------------------------------------------------------- through
        page.pg.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
        page.pg.wait_for_timeout(80)
        log = page.log()
        obs["through"] = log
        if "background clicked" not in log:
            bad("through: a click outside the pinned window did not reach the page")
        if "close gallery" in log:
            bad("through: a click outside the pinned window closed it")

        # ------------------------------------------------------------ drag
        r0 = page.box(GALLERY)
        page.drag(BAR, 120, 60)
        r1 = page.box(GALLERY)
        stored = page.stored()
        obs["drag"] = {"from": r0, "to": r1, "stored": stored}
        if not (near(r1["x"], r0["x"] + 120) and near(r1["y"], r0["y"] + 60)):
            bad(f"drag: the window did not follow the pointer 1:1 ({r0} -> {r1})")
        if not stored or not near(stored["gallery"]["rect"]["x"], r1["x"]):
            bad(f"drag: the move was not committed ({stored})")

        # ----------------------------------------------------------- clamp
        # MEASURED MID-DRAG, before the pointer is released: the commit clamps
        # too, so a check taken after the release would pass even with the
        # render-time clamp gone and would be measuring the wrong guard.
        page.drag_hold(BAR, -3000, -3000)
        r = page.box(GALLERY)
        obs["clamp_topleft"] = r
        if r["x"] < -1 or r["y"] < -1:
            bad(f"clamp: the window escaped past the top-left mid-drag ({r})")
        page.drop()
        page.drag_hold(BAR, 3000, 3000)
        r = page.box(GALLERY)
        obs["clamp_bottomright"] = r
        if r["x"] + r["w"] > 1281 or r["y"] + r["h"] > 901:
            bad(f"clamp: the window escaped past the bottom-right mid-drag ({r})")
        page.drop()
        r = page.box(GALLERY)
        obs["clamp_committed"] = r
        if r["x"] + r["w"] > 1281 or r["y"] + r["h"] > 901:
            bad(f"clamp: the committed rect is outside the window ({r})")

        # ---------------------------------------------------------- resize
        page.drag(BAR, -200, -150)
        r0 = page.box(GALLERY)
        page.drag(".gallery-modal + .modalpin-resize-frame .modalpin-rs.se", 60, 40)
        r1 = page.box(GALLERY)
        obs["resize_se"] = {"from": r0, "to": r1}
        if not (near(r1["w"], r0["w"] + 60, 4) and near(r1["h"], r0["h"] + 40, 4)):
            bad(f"resize: the SE corner did not grow the window ({r0} -> {r1})")
        # the west edge dragged far past the minimum must pin the EAST edge
        east = r1["x"] + r1["w"]
        page.drag(".gallery-modal + .modalpin-resize-frame .modalpin-rs.w", 3000, 0)
        r2 = page.box(GALLERY)
        obs["resize_w"] = r2
        if not near(r2["x"] + r2["w"], east, 4):
            bad(f"resize: shrinking from the west walked the east edge "
                f"({east} -> {r2['x'] + r2['w']})")
        if r2["w"] < 319:
            bad(f"resize: the window shrank past the shared floor ({r2['w']})")

        # ----------------------------------------------------------- state
        page.open()
        page.pg.locator(".gallery-modal .mailrow").nth(3).click()
        page.pg.wait_for_timeout(80)
        page.pg.eval_on_selector(".gallery-modal .mailer-list",
                                 "(el) => { el.scrollTop = 420 }")
        page.pg.wait_for_timeout(60)
        before = page.pg.evaluate(
            "() => ({ top: document.querySelector('.gallery-modal .mailer-list').scrollTop,"
            " sel: document.querySelectorAll('.gallery-modal .mailrow.on').length,"
            " read: (document.querySelector('.gallery-modal .mailer-read')"
            "   .textContent || '').slice(0, 40) })")
        obs["state_before"] = before
        if before["top"] <= 0:
            bad("state: the fixture's list did not scroll — the check would be free")
        if before["sel"] != 1:
            bad(f"state: no row is selected before the pin ({before['sel']})")
        page.click(PIN_BTN)
        after = page.pg.evaluate(
            "() => ({ top: document.querySelector('.gallery-modal .mailer-list').scrollTop,"
            " sel: document.querySelectorAll('.gallery-modal .mailrow.on').length,"
            " read: (document.querySelector('.gallery-modal .mailer-read')"
            "   .textContent || '').slice(0, 40) })")
        obs["state_after"] = after
        if after != before:
            bad(f"state: pinning rebuilt the surface — {before} became {after}")
        page.click(PIN_BTN)
        back = page.pg.evaluate(
            "() => ({ top: document.querySelector('.gallery-modal .mailer-list').scrollTop,"
            " sel: document.querySelectorAll('.gallery-modal .mailrow.on').length,"
            " read: (document.querySelector('.gallery-modal .mailer-read')"
            "   .textContent || '').slice(0, 40) })")
        obs["state_unpinned"] = back
        if back != before:
            bad(f"state: unpinning rebuilt the surface — {before} became {back}")

        # ---------------------------------------------------------- sticky
        # the second surface is a PANEL that scrolls, which the gallery (with
        # its own inner scroller) is not — that is the case where a title bar
        # that is not sticky takes the drag handle away with it
        page.open("two=1")
        page.click(SECOND_PIN_BTN)
        page.pg.eval_on_selector(
            "#second-head", "(el) => { el.parentElement.scrollTop = 500 }")
        page.pg.wait_for_timeout(60)
        panel = page.box(SECOND_WIN)
        bar = page.box(SECOND_WIN + " .modalpin-bar")
        scrolled = page.pg.eval_on_selector(SECOND_WIN, "(el) => el.scrollTop")
        obs["sticky"] = {"panel": panel, "bar": bar, "scrollTop": scrolled}
        if scrolled <= 0:
            bad("sticky: the panel did not scroll — the check would be free")
        elif not near(bar["y"], panel["y"], 3):
            bad(f"sticky: the title bar left the top of the window "
                f"(bar y={bar['y']}, window y={panel['y']}, scrollTop={scrolled})")
        # and it still drags from there
        r0 = page.box(SECOND_WIN)
        page.drag(SECOND_WIN + " .modalpin-bar", 40, 30)
        r1 = page.box(SECOND_WIN)
        obs["sticky_drag"] = {"from": r0, "to": r1}
        if not (near(r1["x"], r0["x"] + 40) and near(r1["y"], r0["y"] + 30)):
            bad(f"sticky: the scrolled-down title bar no longer drags ({r0} -> {r1})")

        # ----------------------------------------------------------- stack
        # park the second window in the BOTTOM-LEFT and put the gallery, pinned
        # and shrunk, in the TOP-RIGHT. Two windows that overlap would make
        # "press the lower one" mean "press whatever is on top there", which is
        # not the question — so the press point is asserted to be clear.
        page.drag(SECOND_WIN + " .modalpin-bar", -3000, 3000)
        page.click(PIN_BTN)
        page.drag(".gallery-modal + .modalpin-resize-frame .modalpin-rs.se", -560, -380)
        page.drag(BAR, 3000, -3000)
        g = page.box(GALLERY)
        sec = page.box(SECOND_WIN)
        obs["stack"] = {"gallery": g, "second": sec}
        if page.pg.locator(".overlay-pinned").count() != 2:
            bad("stack: two pinned windows are not both on screen")
        zs = [int(z or 0) for z in page.pg.evaluate(
            "() => [...document.querySelectorAll('.overlay-pinned')]"
            ".map((e) => getComputedStyle(e).zIndex)")]
        obs["stack_z"] = zs
        if len(set(zs)) != 2:
            bad(f"stack: the two windows share a z-index ({zs})")
        # the gallery was pinned SECOND, so it is on top; press the other one.
        # DOM order here is [gallery, second], so the gallery's z must be the
        # higher of the two before anything is pressed.
        if zs and zs[0] < zs[1]:
            bad(f"stack: the newer window is not the top one ({zs})")
        press = (sec["x"] + sec["w"] / 2, sec["y"] + sec["h"] - 14)
        if (g["x"] <= press[0] <= g["x"] + g["w"]
                and g["y"] <= press[1] <= g["y"] + g["h"]):
            bad(f"stack: the press point is under the other window — the check "
                f"would measure nothing ({press} in {g})")
        page.pg.mouse.click(*press)
        page.pg.wait_for_timeout(80)
        zs2 = [int(z or 0) for z in page.pg.evaluate(
            "() => [...document.querySelectorAll('.overlay-pinned')]"
            ".map((e) => getComputedStyle(e).zIndex)")]
        obs["stack_after"] = zs2
        if not zs2 or zs2[1] != max(zs2) or zs2[1] == zs2[0]:
            bad(f"stack: pressing the lower window did not raise it "
                f"({zs} -> {zs2})")

        # ---------------------------------------------------------- escape
        page.key("Escape")
        obs["escape_pinned"] = page.log()
        if page.pg.locator(GALLERY).count() == 0:
            bad("escape: a pinned window was dismissed by Escape")
        # ...and unpinning restores the modal rules. Skipped, loudly, when the
        # surface is already gone — otherwise the escape failure above would be
        # reported as a crash instead of as the check that caught it.
        if page.pg.locator(GALLERY).count() == 0:
            obs["unpin"] = "skipped: the surface was already closed"
        else:
            page.click(PIN_BTN)
            un = page.box(GALLERY)
            ov = page.box(".overlay")
            obs["unpin"] = {"panel": un, "overlay": ov}
            if un["position"] == "absolute" or un["left"]:
                bad(f"unpin: the panel is still a window ({un})")
            if ov["background"] in ("rgba(0, 0, 0, 0)", "transparent"):
                bad("unpin: the backdrop did not come back")
            page.key("Escape")
            page.pg.wait_for_timeout(80)
            obs["escape_centred"] = page.log()
            if page.pg.locator(GALLERY).count() != 0:
                bad("escape: a centred modal no longer closes on Escape")

        # ---------------------------------------------------------- select
        page.open()
        page.pg.locator(".gallery-modal .mailrow").nth(1).click()
        page.pg.wait_for_timeout(120)
        page.click(PIN_BTN)
        body = page.box(".gallery-modal .mailer-read")
        page.pg.mouse.move(body["x"] + 30, body["y"] + body["h"] / 2)
        page.pg.mouse.down()
        page.pg.mouse.move(body["x"] + body["w"] - 40, body["y"] + body["h"] / 2,
                           steps=8)
        page.pg.mouse.up()
        sel = page.pg.evaluate("() => (window.getSelection() || '').toString()")
        obs["select"] = sel
        if not sel.strip():
            bad("select: text inside a pinned window cannot be selected")

        # ------------------------------------------------- nested / title
        # The rest of this file drives the gallery. These last three drive the
        # REAL OrgInboxModal and the REAL ComposeModal, because the question
        # they answer only exists when one modal is opened from INSIDE another
        # — and it was a real defect: measured on 2026-09-06, compose's
        # backdrop covered the pinned inbox that raised it and made that
        # window's own drag handle and close button unreachable.
        page.open("compose=1&two=1", ready=INBOX)
        # a pinned host, small and out of the way. Seeded rather than clicked:
        # a full-size pinned inbox covers the second surface's pin control, and
        # this fixture would then be measuring its own layout, not the app's.
        page.pg.evaluate(
            "() => localStorage.setItem('orgtree-modal-pins', JSON.stringify("
            "{'org-inbox': {rect: {x: 20, y: 20, w: 520, h: 380}, z: 0}}))")
        page.open("compose=1&two=1", reset=False, ready=INBOX + ".modalpin-win")
        page.click(SECOND_PIN_BTN)
        page.drag(SECOND + ".modalpin-win .modalpin-bar", 0, 300,
                  at=None)
        host = page.box(INBOX + ".modalpin-win")
        if not host:
            bad("nested: the org inbox did not come up pinned")
        page.click("text=compose mail")
        page.pg.wait_for_selector(COMPOSE, timeout=8000)

        nested = page.pg.evaluate("""() => {
          const p = document.querySelector('.settings.cmp-modal');
          const o = p && p.closest('.overlay');
          if (!o) return null;
          const cs = getComputedStyle(o);
          return { parent: o.parentElement.className,
                   atBody: o.parentElement.parentElement === document.body,
                   z: cs.zIndex, bg: cs.backgroundColor, pe: cs.pointerEvents };
        }""")
        obs["nested"] = nested
        if not nested:
            bad("nested: compose did not open from the pinned inbox")
        else:
            # 1. OUT of the host. A DOM descendant of a pinned panel paints
            #    inside that panel's z band whatever its own z-index says.
            if "modalpin-over" not in nested["parent"] or not nested["atBody"]:
                bad(f"nested: the dialog is still inside its host "
                    f"(parent {nested['parent']!r})")
            # 2. ABOVE the whole pinned band, or a dialog raised from a pinned
            #    window renders BEHIND that window — the same bug, sign flipped
            if int(nested["z"] or 0) <= MODAL_Z_TOP:
                bad(f"nested: a centred dialog sits inside the pinned band "
                    f"(z-index {nested['z']}, band tops out at {MODAL_Z_TOP})")
            # 3. CONTROL — centred behaviour is UNCHANGED. It is still a modal:
            #    it still dims, and it still takes clicks. Without this the two
            #    checks above could be passed by deleting the backdrop.
            if nested["bg"] in ("rgba(0, 0, 0, 0)", "transparent"):
                bad("nested: the centred dialog lost its backdrop")
            if nested["pe"] != "auto":
                bad(f"nested: the centred dialog stopped taking clicks "
                    f"({nested['pe']})")

        # ------------------------------------------------------ nested-pin
        # ...and pinning the dialog is what gives the host back, which is the
        # whole reason compose is pinnable (Astra 2026-09-06).
        page.pg.fill(COMPOSE + " textarea", DRAFT)
        page.click(COMPOSE + " .modalpin-bar .modalpin-btn[aria-pressed]")
        hbar = page.box(INBOX + ".modalpin-win .modalpin-bar")
        top = page.pg.evaluate(
            "(p) => { const e = document.elementFromPoint(p.x, p.y);"
            "  return e ? (e.className || e.tagName) : null }",
            {"x": hbar["x"] + 30, "y": hbar["y"] + 13}) if hbar else None
        draft = page.pg.eval_on_selector(COMPOSE + " textarea", "el => el.value")
        cmp_over = page.pg.evaluate(
            "() => { const o = document.querySelector('.settings.cmp-modal')"
            "  .closest('.overlay'); const cs = getComputedStyle(o);"
            "  return { cls: o.className, bg: cs.backgroundColor,"
            "           pe: cs.pointerEvents } }")
        obs["nested_pin"] = {"host_top": top, "draft": draft, "cmp": cmp_over}
        if "overlay-pinned" not in cmp_over["cls"]:
            bad("nested-pin: the dialog did not become a window")
        if cmp_over["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"):
            bad("nested-pin: a pinned dialog still dims the page behind it")
        if top is None or "modalpin" not in str(top):
            bad(f"nested-pin: the host window's own title bar is still covered "
                f"(topmost there is {top!r})")
        # The requirement Astra named: pinning must not lose a half-typed
        # draft. The text is typed BEFORE the pin, so an empty box would not
        # pass this for the wrong reason.
        #
        # ⚠ BUT SAY WHAT THIS IS: AN ASSERTION WITH NO NEGATIVE CONTROL. I
        # tried three mutants against it and all three survived — a changing
        # portal key, a rebuilt portal container, and a portal made conditional
        # on the pin. None of them lose the draft, and the reason is structural
        # rather than lucky: the text lives in ComposeModal's own state, and
        # ComposeModal is the component that RENDERS all of this, so nothing
        # pinning does can unmount it. Losing the draft would take a change
        # somewhere else entirely — compose being rendered from a different
        # place when pinned, say. So this line is a tripwire for that future
        # refactor, and it is NOT evidence that the requirement was at risk and
        # was met. Do not quote it as one.
        if draft != DRAFT:
            bad(f"nested-pin: the draft was lost on pin ({draft!r})")

        # ---------------------------------------------------------- title
        # one visible title, one accessible heading (Astra 2026-09-06)
        titles = page.pg.evaluate("""() => {
          const w = document.querySelector('.settings.wide.modalpin-win');
          const h = w && w.querySelector(':scope > h3');
          const n = w && w.querySelector('.modalpin-name');
          return { h3: h ? getComputedStyle(h).display : null,
                   h3text: h ? h.textContent.trim() : null,
                   bar: n ? n.textContent.trim() : null,
                   role: n ? n.getAttribute('role') : null,
                   level: n ? n.getAttribute('aria-level') : null };
        }""")
        obs["title"] = titles
        if titles["h3text"] is None:
            bad("title: the pinned panel has no title h3 to speak of — this "
                "check cannot see anything and is not measuring the app")
        else:
            if titles["h3"] != "none":
                bad(f"title: a pinned window shows its title twice "
                    f"(the panel's own h3 is {titles['h3']})")
            if titles["role"] != "heading" or titles["level"] != "3":
                bad(f"title: the window bar's name is not a heading "
                    f"(role {titles['role']!r}, level {titles['level']!r}) — "
                    f"with the h3 hidden the window has none at all")
            if titles["bar"] != titles["h3text"]:
                bad(f"title: the bar says {titles['bar']!r} where the panel's "
                    f"own heading says {titles['h3text']!r}")
        # CONTROL: the same h3 is VISIBLE when the surface is centred. Without
        # this, `display: none` on every h3 everywhere would pass the above.
        page.click(INBOX + ".modalpin-win .modalpin-bar .modalpin-btn[aria-pressed]")
        centred_h3 = page.pg.evaluate(
            "() => { const w = document.querySelector('.settings.wide');"
            "  const h = w && w.querySelector(':scope > h3');"
            "  return h ? getComputedStyle(h).display : null }")
        obs["title_centred"] = centred_h3
        if centred_h3 in (None, "none"):
            bad(f"title: unpinning left the panel's own heading hidden "
                f"({centred_h3!r}) — the centred surface now has no title")

        # ------------------------------------------------------- headrow
        # The check above measures a surface whose title is a DIRECT child h3.
        # These three keep theirs inside a header row, which is the shape the
        # rule missed — so each one is loaded and pinned as itself, and the
        # measurement is what the browser actually renders.
        for name, panel, title_sel, words, ready in HEAD_ROW_SURFACES:
            arg = [panel, title_sel, words]
            page.open("titles=" + name, ready=ready)
            before = page.pg.evaluate(HEAD_ROW, arg)
            obs[f"headrow_{name}_centred"] = before
            if before is None or before["text"] is None:
                bad(f"headrow/{name}: nothing at `{panel} > {title_sel}` — "
                    f"this check can see no title at all and is not measuring "
                    f"the app")
                continue
            # the fixture has to SAY the words, or every count below is free
            if before["text"] != words:
                bad(f"headrow/{name}: the panel's own title reads "
                    f"{before['text']!r}, not {words!r} — the fixture and this "
                    f"check have drifted apart")
                continue
            # CONTROL: centred, the surface shows its own title, exactly once
            if before["display"] == "none" or before["shown"] != 1:
                bad(f"headrow/{name}: CONTROL — centred, this surface does not "
                    f"show its own title once (display {before['display']!r}, "
                    f"{before['shown']} occurrence(s) on screen)")
            page.click(panel + " .modalpin-bar .modalpin-btn[aria-pressed]")
            after = page.pg.evaluate(HEAD_ROW, arg)
            obs[f"headrow_{name}_pinned"] = after
            if not after["pinned"]:
                bad(f"headrow/{name}: the pin control did not turn the surface "
                    f"into a window — nothing after this is about pinning")
                continue
            if after["shown"] != 1:
                bad(f"headrow/{name}: a pinned window shows its title "
                    f"{after['shown']} time(s) — {after['text']!r} in the "
                    f"panel and {after['bar']!r} in the window bar")
            if after["display"] != "none":
                bad(f"headrow/{name}: the panel's own title is still "
                    f"{after['display']!r} inside a pinned window")
            if after["bar"] != words:
                bad(f"headrow/{name}: the window bar says {after['bar']!r}, "
                    f"which is not the title the panel just gave up "
                    f"({words!r}) — the words moved, they did not vanish")
            # ...and the controls that share that row keep their place. The
            # gallery's header is `space-between` over two children, so hiding
            # the heading is exactly what would slide its checkbox to the left.
            if before["ctlRoom"] is None or before["ctlRoom"] < 200:
                bad(f"headrow/{name}: the header's last control "
                    f"({before['ctl']!r}) is within {before['ctlRoom']}px of "
                    f"the panel's own width — it cannot be seen to move, so "
                    f"the position check below is free")
            for mode, m in (("centred", before), ("pinned", after)):
                if m["ctlGap"] is None or m["ctlGap"] > 40:
                    bad(f"headrow/{name}: {mode}, the header row's last "
                        f"control ({m['ctl']!r}) sits {m['ctlGap']}px from the "
                        f"panel's right edge — it belongs at the far right")
            # the reader's "· node · time" trails a title that is no longer
            # there, so the separator must go with it
            if name == "reader" and (after["head"] or "").startswith("·"):
                bad(f"headrow/reader: the pinned header opens on a dangling "
                    f"separator ({after['head'][:40]!r})")
            if name == "reader" and not (before["head"] or "").startswith(words):
                bad(f"headrow/reader: CONTROL — centred, the header does not "
                    f"open with the document's title ({before['head']!r})")

        br.close()
    return fails, obs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write the observations here")
    ap.add_argument("--mutant", help="a mutant name, or 'all'")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        out = pathlib.Path(td)
        if args.mutant == "all":
            bad = 0
            for name in MUTANTS:
                d = out / name
                build(d, name)
                print(f"  mutant {name} ...")
                try:
                    fails, _ = run(d / "probe.html", verbose=False)
                except Exception as e:      # noqa: BLE001 — any failure is a kill
                    # a mutant that makes the page unusable (a control the probe
                    # can no longer even click) is killed just as surely as one
                    # that trips an assertion — but say WHICH it was
                    first = str(e).strip().splitlines()[0]
                    print(f"    killed (the probe could not run) -> {first[:90]}")
                    continue
                if fails:
                    print(f"    killed  -> {fails[0][:90]}")
                else:
                    print(f"    SURVIVED — nothing here tests "
                          f"{MUTANTS[name][3]!r}")
                    bad += 1
            print(f"\n{len(MUTANTS) - bad} of {len(MUTANTS)} mutants killed")
            return 1 if bad else 0
        build(out, args.mutant)
        fails, obs = run(out / "probe.html")
        if args.json:
            pathlib.Path(args.json).write_text(json.dumps(obs, indent=2),
                                               encoding="utf-8")
        if fails:
            print(f"\n{len(fails)} check(s) failed")
            return 1
        print("\nall checks passed")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
