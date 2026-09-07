"""chipbar_probe.py — can you actually click an agent's credit bar?

User report 2026-08-28: "when viewing agents from a distance, the leftward hire
coworker badges overlap the budget bar, making it untouchable unless zoomed in
far enough to reduce their relative size".

THE MECHANISM, which is the reason this has to be measured rather than reasoned
about. Both things live in the same narrow strip immediately left of the card:

    .cbar          left: -22px; width: 14px; z-index: 2     -> world x [-22, -8]
    .hsof.side-l   anchored near the card edge; z-index: 3

but they scale differently. The bar is world-scaled, so its screen width is
14*z and it collapses toward nothing as you zoom out. The chips carry
`scale(var(--invzf))`, an UNCLAMPED counter-scale, so they hold a constant
SCREEN size at every zoom. Zoom out far enough and a screen-constant column
sits on top of a bar that has shrunk to a few pixels — and because the chips
are z-index 3 against the bar's 2, and become `pointer-events: auto` the moment
the card is hovered with the left edge nearest, the chips receive the click.
The bar is not merely covered; it is unreachable.

WHY A BROWSER. jsdom does no layout: every rect there is 0x0, so an overlap
check under it passes for the same reason it would pass on a blank page. And a
unit test that multiplies constants by an assumed scale is arithmetic wearing a
measurement's clothes — a seat on this repo shipped exactly that this week,
assuming 58px for a box that really rendered at 101.63px, green throughout. So
this renders the real markup against the real src/styles.css in real headless
Edge, and asks the only question that matters:

    with the cursor ON the bar, what does document.elementFromPoint return?

That is the user's complaint stated as a measurement. Geometry overlap is
reported too, because the fix is supposed to remove the OVERLAP rather than
merely reorder what sits on top -- if you only flip z-index or pointer-events,
the hit test goes green while the badge still visually buries the bar.

SECOND ROUND, 2026-08-28: "on the left side they look good, but on the right
they stick out too far, since there's no budget bar there."

The first fix anchored each column on the far edge of the thing beside it, and
wrote the right-hand figure as an unconditional 24px — the extent of the doc
chips. But `.cbar` is drawn for EVERY live card while `.doc-chips` is drawn
only for a card that has presented documents (and never at desk fill), so on
most cards the right column stood 24px out with nothing in between: three times
the open canvas the left side shows. The clearance is the neighbour's extent,
so it belongs only where the neighbour is. This probe therefore measures the
GAP as well as the overlap, on both sides, for a card WITH documents and a card
WITHOUT, and at desk fill — and asserts they are the same when there is nothing
on the right to clear.

THIRD ROUND, 2026-08-29: when a second provider family was added, the bottom
strip grew upward into the card and covered its content. The strip was held by
its bottom edge (`bottom: -21px`), so a second row necessarily moved its top
further inside the panel. The shipped rule holds the strip by its top edge;
this probe renders and measures that bottom strip in both overview and desk
cards and asserts that its visual top stays at the card's bottom edge rather
than drifting into the content.

    python tests/chipbar_probe.py                 # measure and check
    python tests/chipbar_probe.py --expect-fail   # KNOWN-NEGATIVE CONTROL:
                                                  # restores the PRE-FIX rules;
                                                  # must FAIL.
    python tests/chipbar_probe.py --expect-fail-const
                                                  # SECOND CONTROL: restores the
                                                  # unconditional 24px right
                                                  # clearance; must FAIL on the
                                                  # symmetry check.
    python tests/chipbar_probe.py --expect-fail-bottom
                                                  # THIRD CONTROL: restores the
                                                  # old bottom-edge anchor; must
                                                  # FAIL on two provider rows.
    python tests/chipbar_probe.py --shot out.png  # and look at it

The controls are the point. "The bar is reachable at every zoom" and "the two
sides sit the same distance off the card" mean nothing unless this script is
demonstrably able to report that they do not.

Requires playwright with the msedge channel (same dependency, and the same
reason, as edgejump_probe.py and actlabel_probe.py next door).
"""

import argparse
import os
import pathlib
import re
import sys
import tempfile

from playwright.sync_api import sync_playwright

# the Windows console defaults to cp1252 and this script prints box-drawing and
# arrows; without this the probe dies in its own report AFTER measuring, which
# reads exactly like a measurement failure and is not one
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
SHARED = FRONTEND / "src" / "canvas" / "shared.ts"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"


def _node_size() -> tuple[int, int]:
    """Card geometry straight out of shared.ts — hard-coding 124 here would let
    the two drift in silence."""
    src = SHARED.read_text(encoding="utf-8")
    m = re.search(r"^export const NODE_W = (\d+), NODE_H = (\d+)", src, re.M)
    if not m:
        raise SystemExit(f"could not read NODE_W/NODE_H from {SHARED}")
    return int(m.group(1)), int(m.group(2))


def _zmax() -> float:
    src = SHARED.read_text(encoding="utf-8")
    m = re.search(r"^export const Z_MAX = ([\d.]+)", src, re.M)
    if not m:
        raise SystemExit(f"could not read Z_MAX from {SHARED}")
    return float(m.group(1))


NODE_W, NODE_H = _node_size()
Z_MAX = _zmax()


def _check_fixture_still_matches_source() -> None:
    """The fixture must be the markup the app really emits.

    A probe measuring markup the app never renders is worth less than no probe,
    because it is believed. These are the exact hooks the CSS under test keys
    on; if any of them moves, this file is measuring a card that does not ship.
    """
    src = CARDS.read_text(encoding="utf-8")
    for needed in ("'hsof' + (side ? ` side side-${side[0]}` : '')",
                   "'cbar' + (draftMode || drag ? ' dragging' : '')",
                   'className="hsof-bridge bridge-l"',
                   'className="hsof-bridge bridge-r"',
                   "'edge-' + edge",
                   # the fixture runs a JS port of trackEdge so the transit
                   # walk is driven by the real nearest-edge rule rather than
                   # by a class this file preset for itself. If the rule moves,
                   # the port is measuring a card that does not ship.
                   "const next = d === 1 - y ? 'b' : d === y ? 't' "
                   ": d === x ? 'l' : 'r'",
                   # the right column is only drawn beyond the doc chips when
                   # there ARE doc chips; both render conditions live here
                   "(node.documents?.length ?? 0) > 0 && onOpenDoc",
                   # FR-15 M8 provider families: the .hs-fam wrapper layer,
                   # the tier-count ordering and the away-edge reversal are
                   # DOM this fixture now mirrors — if any of them moves,
                   # update card() and this guard together. (The wrapper
                   # landed without a guard needle once and this probe spent
                   # an evening measuring a card the app never draws.)
                   'fams.map((f) => <div className="hs-fam" key={f.key}>',
                   "fams.sort((a, b) => b.tiers.length - a.tiers.length)",
                   "if (away) fams.reverse()"):
        if needed not in src:
            raise SystemExit(
                f"cards.tsx no longer emits {needed!r} — this probe's fixture "
                f"is stale and would be measuring a card the app never draws. "
                f"Update card() and this guard together.")
    css = CSS.read_text(encoding="utf-8")
    for needed in (".hsof.side-l", ".cbar {", "--invzf",
                   "--hsof-l-clear", "--hsof-r-clear",
                   ".hsof .hs-fam", ".hsof.side .hs-fam",
                   ".sq.desk > .hsof:not(.side)"):
        if needed not in css:
            raise SystemExit(
                f"styles.css no longer contains {needed!r} — the rules under "
                f"test have moved; update this probe with them.")


# Zoom levels to sweep. 0.24 is the canvas floor (OrgCanvas clamps there),
# Z_MAX the ceiling. The interesting band is the low end — that is "viewing
# agents from a distance" — but the sweep covers the range so a fix that
# merely moves the failure to a different zoom is caught rather than praised.
ZOOMS = [0.24, 0.35, 0.55, 0.8, 1.0, 2.1, 4.0, Z_MAX]
# the desk only exists from Z_DESK up (OrgCanvas floors the focus zoom there),
# so sweeping it below that would measure a card the app never draws
DESK_ZOOMS = [2.1, 4.0, Z_MAX]

# THREE cards, because the right-hand strip has two states and the left has one.
# `.cbar` is drawn for every live card; `.doc-chips` only when the node has
# presented documents, and never at desk fill (the desk header carries titled
# badges instead). The bare card is the common one and is the one the second
# user report is about.
#
# `bar_overlap_ok` is the desk's licensed exception, and it is licensed by the
# user rather than by this file: 2026-08-28, "when in desk view move the
# coworker hire buttons back to their old positions right next to the card, so
# they're still on screen there". A world-px clearance is 264 screen px at
# z=12, so honouring it up close threw the columns off the screen. Standing
# next to the card again means the left column crosses the outer edge of the
# credit bar in the first stretch of the desk range — so the OVERLAP is allowed
# here and only here, while the thing the user actually complained about, that
# the bar cannot be CLICKED, is still asserted at every zoom of every variant.
VARIANTS = [
    {"key": "with documents", "docs": True, "desk": False, "zooms": ZOOMS,
     "bar_overlap_ok": False},
    {"key": "no documents", "docs": False, "desk": False, "zooms": ZOOMS,
     "bar_overlap_ok": False},
    {"key": "desk fill", "docs": False, "desk": True, "zooms": DESK_ZOOMS,
     "bar_overlap_ok": True},
    # FR-15 M8: codex signed in — each side strip is TWO family columns
    # (codex outer, claude inner). Width growth must go OUTWARD only; the
    # bar/doc-chip clearances are anchored at the inner edge and must hold.
    {"key": "two providers", "docs": True, "desk": False, "zooms": ZOOMS,
     "bar_overlap_ok": False, "families": 2},
    {"key": "two providers desk", "docs": False, "desk": True,
     "zooms": DESK_ZOOMS, "bar_overlap_ok": True, "families": 2},
]

# A mid-sized holding: seat 1 + grant 5 at the default 7px/credit. Height is
# incidental to the defect (the collision is horizontal) but a realistic bar
# makes the screenshot legible and gives elementFromPoint a real target.
BAR_H = 42

# --shot writes one picture per variant, at the zoom where that variant's
# geometry is easiest to read. The cursor is parked on the card's RIGHT edge
# first, because nearest-edge gating means the app never shows both columns at
# once and the right one is what the second report is about.
SHOT_ZOOM = {"with documents": 1.0, "no documents": 1.0, "desk fill": 4.0,
             "two providers": 1.0, "two providers desk": 4.0}

# A JS port of NodeSquare's trackEdge (cards.tsx) — the nearest-edge rule that
# decides which column is live. Ported rather than preset as a class because the
# transit walk's whole question is whether the column STAYS live as the cursor
# leaves the card, and a preset class answers that by assumption. The guard in
# _check_fixture_still_matches_source pins the expression to the source.
TRACK_EDGE = """
const sq = document.querySelector('.sq');
sq.addEventListener('pointermove', (e) => {
  const r = sq.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const d = Math.min(x, 1 - x, 1 - y, y);
  const next = d === 1 - y ? 'b' : d === y ? 't' : d === x ? 'l' : 'r';
  for (const c of ['edge-t', 'edge-b', 'edge-l', 'edge-r']) sq.classList.remove(c);
  sq.classList.add('edge-' + next);
});
"""


def card(docs: bool, desk: bool, families: int = 1) -> str:
    """The real card markup, trimmed to what the rules under test key on.

    No `edge-*` class is preset: TRACK_EDGE sets it from the real pointer, the
    way the app does. `.doc-chips` is present or absent exactly as cards.tsx
    renders it, because that is now the thing the geometry depends on.

    FR-15 M8: SpawnChips wraps each provider's chips in an `.hs-fam` and the
    side strips are a ROW of family COLUMNS — the fixture mirrors that DOM
    exactly, including the order rule (higher tier count nearest the card, so
    the codex family renders FIRST on side-l and LAST on side-r). `families=2`
    is the codex-signed-in card; `families=1` the signed-out/kiosk one. Both
    ship. (This fixture measured bare un-wrapped chips for one evening and
    the probe spent it measuring a card the app never draws — see the guard.)
    """
    claude = "<div class='hs-fam'>" + "".join(
        f"<button class='t-{t}'>{ltr}</button>"
        for t, ltr in (("haiku", "H"), ("sonnet", "S"),
                       ("opus", "O"), ("fable", "F"))) + "</div>"
    codex = ("<div class='hs-fam'>" + "".join(
        f"<button class='t-{t}'>{ltr}</button>"
        for t, ltr in (("gpt-reserve", "R"), ("luna", "L"),
                       ("terra", "T"), ("sol", "S"))) + "</div>") \
        if families > 1 else ""
    chips_l = codex + claude          # away-edge: outer family first
    chips_r = claude + codex          # near-edge order
    chips_b = claude + codex          # bottom: inward-first, then outward
    # `focused ? 'desk' : lod` — the desk card also drops .sq-head (the desk
    # renders its own chrome) and gains the opaque .desk-over panel inset 2px
    lod = "desk" if desk else "norm"
    body = (
        "<div class='desk-over'></div>" if desk
        else "<div class='sq-head'><span class='name'>ceo</span></div>")
    return (
        f"<div class='sq live {lod} tier-haiku' "
        f"style='width:{NODE_W}px;height:{NODE_H}px'>"
        f"<div class='cbar' style='height:{BAR_H}px'>"
        f"<div class='cbar-clip'></div></div>"
        f"<div class='hsof-bridge bridge-l'></div>"
        f"<div class='hsof-bridge bridge-r'></div>"
        f"<div class='hsof side side-l'>{chips_l}</div>"
        f"<div class='hsof side side-r'>{chips_r}</div>"
        f"<div class='hsof'>{chips_b}</div>"
        + ("<div class='doc-chips'><div class='doc-chip'>D</div></div>"
           if docs else "")
        + body +
        "</div>")


def build_page(css: str, z: float, docs: bool, desk: bool,
               families: int = 1) -> str:
    """One card at one zoom, inside a .space carrying exactly the custom
    properties OrgCanvas sets on it — same expressions, so the probe cannot
    disagree with the app about what --invzf is."""
    invz = min(2.4, max(1 / Z_MAX, 1 / z))
    invzf = max(1 / Z_MAX, 1 / z)
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>\n"
        + css +
        "\n/* probe chrome only: never touches the rules under test */"
        f"\n.probe-pad{{padding:{PAD_T}px {PAD_L}px;background:#1f1f1f}}"
        "\n</style></head><body style='margin:0;background:#1f1f1f'>"
        "<div class='probe-pad'>"
        f"<div class='space' style=\"transform:scale({z});"
        f"transform-origin:top left;"
        f"--invz:{invz:.3f};--invzf:{invzf:.3f};--z:{z:.3f}\">"
        + card(docs, desk, families) +
        "</div></div><script>" + TRACK_EDGE + "</script></body></html>")


# Rects for the three actors, plus the hit test. Every number is read from the
# browser's own layout; nothing here is derived from a constant.
MEASURE = """
() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return {x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom}; };
  const sq = document.querySelector('.sq');
  const bar = document.querySelector('.cbar');
  const chipsL = document.querySelector('.hsof.side-l');
  const chipsR = document.querySelector('.hsof.side-r');
  const chipsB = document.querySelector('.hsof:not(.side)');
  const docs = document.querySelector('.doc-chips');
  const cs = getComputedStyle(chipsL);
  return {
    sq: r(sq), bar: r(bar), chipsL: r(chipsL), chipsR: r(chipsR),
    chipsB: r(chipsB), docs: r(docs),
    chipsLPointer: cs.pointerEvents, chipsLOpacity: cs.opacity,
  };
}
"""

# What is actually under the cursor, at the point the user is aiming for.
HIT = """
(pt) => {
  const el = document.elementFromPoint(pt.x, pt.y);
  if (!el) return {tag: null, cls: null};
  const own = el.closest('.cbar, .hsof, .doc-chips, .sq');
  return {tag: el.tagName.toLowerCase(), cls: el.className || null,
          owner: own ? own.className : null};
}
"""


def overlap(a, b) -> float:
    """Horizontal overlap in CSS px. Horizontal because the collision is
    horizontal: both actors run the full height of the strip beside the card,
    and a fix is only real if it separates them on x."""
    if not a or not b:
        return 0.0
    return max(0.0, min(a["right"], b["right"]) - max(a["x"], b["x"]))


# Restores the PRE-FIX geometry for --expect-fail. Appended last so it wins on
# specificity-tie/order. This is the known-negative control: with these rules
# the probe MUST report the bar unreachable, or it is not measuring anything.
PRE_FIX_CSS = """
/* ---- probe control: pre-fix rules, restored verbatim ---- */
.hsof.side-l { left: -21px; right: auto; padding-right: 0;
  transform: translateY(-50%) scale(var(--invzf, 1));
  transform-origin: center right; }
.hsof.side-r { right: -21px; left: auto; padding-left: 0;
  transform: translateY(-50%) scale(var(--invzf, 1));
  transform-origin: center left; }
"""


# Restores today's UNCONDITIONAL right-hand clearance for --expect-fail-const:
# the first fix's constant 24px, applied whether or not the card has doc chips,
# with the bridges written as their own constants. This is the known-negative
# control for the SECOND round: with these rules the probe must report the two
# sides sitting different distances off the card, or the symmetry check below
# is not measuring anything.
CONST_CSS = """
/* ---- probe control: unconditional right clearance, restored ---- */
.hsof.side-r { right: auto; left: calc(100% + 24px); }
.sq.desk > .hsof.side-r { left: calc(100% + 26px); }
.sq > .hsof-bridge.bridge-l { width: 22px; }
.sq > .hsof-bridge.bridge-r { width: 24px; }
"""

# Restores the user-visible multi-provider regression by value replacement:
# the old rule holds the bottom strip by its bottom edge, so the second family
# row grows upward over the card. Both overview and desk overrides are restored
# because the defect existed in both places.
BOTTOM_CSS = """
/* ---- probe control: old bottom-edge anchor, restored ---- */
.hsof:not(.side) { top: auto; bottom: -21px; }
.sq.desk > .hsof:not(.side) { top: auto; bottom: -24px; }
"""

# How far apart the two sides may sit before it counts as an asymmetry. Both
# figures come out of the same layout engine and should agree exactly, so this
# is a sub-pixel rounding allowance, not a tuning knob.
SYM_TOL = 1.0

# The viewport is deliberately large. At desk fill a 124px card is 1488px wide
# and just as tall, and the previous 1600x900 put the bar, the column centres
# and the whole right-hand strip off-screen there — which the probe reported as
# "not measured", at exactly the zoom where a 2px world error costs 24 screen
# px. PAD_L clears the left strip at z=12 (24*12 plus the column's own 22px);
# PAD_T is small so the card's full height still fits.
VIEW_W, VIEW_H = 2400, 1600
PAD_L, PAD_T = 340, 40

# Sampling the transit with one round-trip per pixel made a 312px walk at desk
# fill take longer than the rest of the run put together. Instead a listener
# records, for every pointermove the browser actually dispatches, whether the
# column under test was interactive at that moment; the probe then does the
# moves and reads the log once. It is registered on `document` in the BUBBLE
# phase so it runs AFTER the card's own trackEdge handler has set the
# nearest-edge class — a capture-phase listener would sample the class from
# before the move it is reporting on.
TRANSIT_TAP = """
() => {
  window.__probe = { sel: null, log: [] };
  document.addEventListener('pointermove', (e) => {
    const s = window.__probe.sel;
    if (!s) return;
    const el = document.querySelector(s);
    window.__probe.log.push([e.clientX,
      el && getComputedStyle(el).pointerEvents === 'auto' ? 1 : 0]);
  });
}
"""


def _transit(pg, m, side: str):
    """Worst dead run, in screen px, on the way OUT to a column.

    Walk the cursor from just inside the card's edge out to the chips and watch
    whether they stay interactive the whole way. They are gated on `.sq:hover`,
    so any x where the pointer is over neither the card nor one of its
    descendants makes them vanish mid-reach. Moving the chips clear of their
    neighbour is only a real fix if it does not open such a gap — otherwise the
    neighbour becomes clickable and the hire gesture becomes unreachable, which
    is trading one bug for another rather than fixing one.

    ⚠ DIRECTION IS LOAD-BEARING: walk OUTWARD from inside the card, because
    that is the only way a user can arrive. The chips are `pointer-events:
    none` until the card is hovered, so approaching from open canvas they are
    not hit-testable at all and never can be — walking inward measures a path
    nobody can take and reports a working fix as broken. (It did.)

    Returns None when the walk does not fit on screen, which is a "not
    measured" and must never be reported as a clean 0.0.
    """
    col = m["chipsL"] if side == "l" else m["chipsR"]
    if not col or not col["h"]:
        return None
    cy = col["y"] + col["h"] / 2
    if not 0 <= cy <= VIEW_H:
        return None
    if side == "l":
        x_from, x_to, step = m["sq"]["x"] + 4, col["x"] + 2, -1.0
    else:
        x_from, x_to, step = m["sq"]["right"] - 4, col["right"] - 2, 1.0
    if not 0 <= x_from <= VIEW_W or not 0 <= x_to <= VIEW_W:
        return None
    # One Playwright RPC per pixel made the full matrix take many minutes on
    # Windows. Chromium can generate the same real pointermove sequence inside
    # one call via `steps`; keep the positioning move out of the measurement.
    pg.evaluate("() => { window.__probe.sel = null; window.__probe.log = [] }")
    pg.mouse.move(x_from, cy)
    pg.evaluate("(s) => { window.__probe.sel = s; window.__probe.log = [] }",
                ".hsof.side-" + side)
    pg.mouse.move(x_to, cy, steps=max(1, int(abs(x_to - x_from))))
    log = pg.evaluate("() => { const l = window.__probe.log; "
                      "window.__probe.sel = null; return l }")
    if not log:
        return None
    worst = run_ = 0.0
    for _x, live in log:
        if live:
            run_ = 0.0
        else:
            run_ += abs(step)
            worst = max(worst, run_)
    return worst


def run(css_text: str, shot: str | None = None, verbose: bool = True):
    rows = []
    fd, page = tempfile.mkstemp(suffix=".html",
                                dir=str(FRONTEND / "node_modules"))
    os.close(fd)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page(viewport={"width": VIEW_W, "height": VIEW_H},
                            device_scale_factor=2)
            for v in VARIANTS:
                for z in v["zooms"]:
                    pathlib.Path(page).write_text(
                        build_page(css_text, z, v["docs"], v["desk"],
                                   v.get("families", 1)),
                        encoding="utf-8")
                    pg.goto(pathlib.Path(page).as_uri())
                    pg.wait_for_selector(".cbar", timeout=8000)
                    pg.evaluate(TRANSIT_TAP)
                    m = pg.evaluate(MEASURE)
                    if (not m["bar"] or not m["chipsL"] or not m["chipsR"]
                            or not m["chipsB"]):
                        raise SystemExit(
                            "the fixture did not render a bar, both side chip "
                            "columns — nothing below would mean anything")
                    if v["docs"] and not m["docs"]:
                        raise SystemExit(
                            "the with-documents fixture rendered no .doc-chips")
                    if not v["docs"] and m["docs"]:
                        raise SystemExit(
                            "the bare fixture rendered .doc-chips anyway")
                    row = {"v": v["key"], "z": z, "docs_on": v["docs"]}
                    # put the real cursor on the bar, exactly where the user
                    # aims, THEN ask what is under it. Hovering matters: the
                    # chips are gated on .sq:hover, so a hit test without a
                    # real pointer would measure a card in a state the user
                    # never sees.
                    # ⚠ clamp the aim point into the VIEWPORT before hit-
                    # testing. At desk zoom the bar can be taller than the
                    # window, so its geometric centre is off-screen and
                    # elementFromPoint returns null — which this probe
                    # cheerfully reported as "the bar is unreachable". That is
                    # a false alarm of exactly the kind that trains people to
                    # stop reading a check, so it is measured properly instead:
                    # aim at the centre of the bar's VISIBLE part, and say
                    # plainly when none of it is visible.
                    vis_x0 = max(0.0, m["bar"]["x"])
                    vis_x1 = min(float(VIEW_W), m["bar"]["right"])
                    vis_y0 = max(0.0, m["bar"]["y"])
                    vis_y1 = min(float(VIEW_H), m["bar"]["bottom"])
                    if vis_x1 <= vis_x0 or vis_y1 <= vis_y0:
                        row["offscreen"] = True
                        row.update({k: m[k] for k in
                                    ("sq", "bar", "chipsL", "chipsR", "chipsB",
                                     "docs")})
                        rows.append(row)
                        continue
                    bx = (vis_x0 + vis_x1) / 2
                    by = (vis_y0 + vis_y1) / 2
                    pg.mouse.move(bx, by)
                    pg.wait_for_timeout(60)   # let the opacity transition settle
                    m2 = pg.evaluate(MEASURE)  # re-read: hover changes the chips
                    hit = pg.evaluate(HIT, {"x": bx, "y": by})
                    if shot and z == SHOT_ZOOM.get(v["key"]):
                        # clip around the CARD, not around .probe-pad: the
                        # scaled .space contributes no layout height, so the
                        # pad's own box is 2*PAD_T tall and a screenshot of it
                        # cuts the card off at the knees
                        s, pad = m2["sq"], 70
                        p = pathlib.Path(shot)
                        p = p.with_name(f"{p.stem}-{v['key'].replace(' ', '')}"
                                        f"-z{z:g}{p.suffix}")
                        p.parent.mkdir(parents=True, exist_ok=True)
                        pg.mouse.move(s["x"] + s["w"] - 6,
                                      s["y"] + s["h"] / 2)   # right edge live
                        pg.wait_for_timeout(220)
                        pg.screenshot(path=str(p), clip={
                            "x": max(0.0, s["x"] - pad), "y": max(0.0, s["y"] - pad),
                            "width": min(float(VIEW_W), s["w"] + 2 * pad),
                            "height": min(float(VIEW_H), s["h"] + 2 * pad)})
                    row.update({k: m2[k] for k in
                                ("sq", "bar", "chipsL", "chipsR", "chipsB",
                                 "docs")})
                    row["hit"] = hit
                    row["deadL"] = _transit(pg, m2, "l")
                    row["deadR"] = _transit(pg, m2, "r")
                    rows.append(row)
            b.close()
    finally:
        os.unlink(page)

    fails = []
    # The gap the user is looking at, on each side, in screen px: from the
    # card's own edge to the NEAREST thing standing beyond it, whatever that
    # thing is. Deliberately not "card to bar" and "card to column": which
    # element is nearest changes with the state and the zoom — the doc chips
    # when the node has documents, the hire column itself at desk fill, where
    # it now stands inside the bar's span — and it is the nearest thing, not a
    # named one, that the eye reads as how far the furniture sits off the card.
    for r in rows:
        if r.get("offscreen"):
            continue
        r["openL"] = r["sq"]["x"] - max(r["bar"]["right"], r["chipsL"]["right"])
        r["openR"] = min(x["x"] for x in (r["docs"], r["chipsR"]) if x) \
            - r["sq"]["right"]

    for v in VARIANTS:
        mine = [r for r in rows if r["v"] == v["key"]]
        if verbose:
            print("\n  -- " + v["key"] + " " + "-" * (58 - len(v["key"])))
            print("     zoom   bar x-span        chips-L x-span     overlap  "
                  "what the click hits")
        for r in mine:
            if r.get("offscreen"):
                if verbose:
                    print(f"     {r['z']:5.2f}   bar is larger than the window "
                          f"at this zoom — no visible part to aim at; "
                          f"not measured")
                continue
            bar, ch = r["bar"], r["chipsL"]
            ov = overlap(bar, ch)
            owner = (r["hit"].get("owner") or "").strip()
            reaches_bar = "cbar" in owner
            if verbose:
                flag = "  " if (ov == 0 and reaches_bar) else "!!"
                print(f"  {flag}{r['z']:5.2f}   "
                      f"[{bar['x']:8.1f},{bar['right']:8.1f}]  "
                      f"[{ch['x']:8.1f},{ch['right']:8.1f}]  "
                      f"{ov:7.1f}  {owner or '(nothing)'}")
            if not reaches_bar:
                fails.append(
                    f"[{v['key']}] z={r['z']}: the cursor is on the bar and "
                    f"the click lands on {owner or 'nothing'} — the bar is "
                    f"UNREACHABLE. This is the user's first complaint.")
            if ov > 0 and not v["bar_overlap_ok"]:
                fails.append(
                    f"[{v['key']}] z={r['z']}: the left chips overlap the bar "
                    f"by {ov:.1f}px. Even if the hit test passes, the badge is "
                    f"sitting on top of the bar — the fix must remove the "
                    f"overlap, not reorder it.")
        if v["bar_overlap_ok"] and verbose:
            print("    (overlap is LICENSED at desk fill — user ruling "
                  "2026-08-28 put the columns back beside the card here.\n"
                  "     The click landing on the bar is still asserted, and "
                  "that is the complaint.)")

        # THE THIRD USER REPORT: adding a provider family must not move the
        # bottom strip's TOP upward. Compare the two-family fixture with the
        # one-family fixture at the same desk state and zoom. This is stronger
        # than guessing the border-box offset (which scales with the world
        # transform): a top anchor is invariant; the old bottom anchor moves
        # upward by exactly the added family's row height.
        if v.get("families", 1) > 1:
            if verbose:
                print("\n    bottom strip: top shift after adding provider")
            base_key = "desk fill" if v["desk"] else "no documents"
            for r in mine:
                base = next((b for b in rows
                             if b["v"] == base_key and b["z"] == r["z"]), None)
                if not base:
                    fails.append(f"[{v['key']}] z={r['z']}: no one-provider "
                                 "baseline; bottom-anchor check is vacuous")
                    continue
                shift = r["chipsB"]["y"] - base["chipsB"]["y"]
                if verbose:
                    print(f"    z={r['z']:5.2f}  one {base['chipsB']['y']:7.1f}  "
                          f"two {r['chipsB']['y']:7.1f}  shift {shift:6.1f}px")
                if abs(shift) > 0.25:
                    fails.append(
                        f"[{v['key']}] z={r['z']}: the two-provider bottom "
                        f"strip moved its top by {shift:.1f}px â€” the second "
                        f"provider row is growing over panel "
                        f"content instead of away from the bottom edge. This "
                        f"is the user's third complaint.")

        # the mirror strip: the right column must still clear the doc chips
        if v["docs"]:
            if verbose:
                print("\n    right strip: chips-R vs .doc-chips")
            for r in mine:
                ov = overlap(r.get("chipsR"), r.get("docs"))
                if verbose and r.get("docs"):
                    d, c = r["docs"], r["chipsR"]
                    print(f"    z={r['z']:5.2f}  "
                          f"docs [{d['x']:7.1f},{d['right']:7.1f}]"
                          f"  chips-R [{c['x']:7.1f},{c['right']:7.1f}]"
                          f"  overlap {ov:7.1f}px")
                if ov > 0:
                    fails.append(
                        f"[{v['key']}] z={r['z']}: the right chips overlap the "
                        f"doc chips by {ov:.1f}px — the clearance the first "
                        f"fix put there has been lost.")

        # THE SECOND USER REPORT, stated as a measurement. With nothing on the
        # right to clear, the open canvas between the card and the first thing
        # beside it must read the same on both sides. `openL` is card-to-bar,
        # `openR` is card-to-column; when they differ the badges on one side
        # visibly stand further off the card than on the other, which is what
        # "they stick out too far" means.
        else:
            if verbose:
                print("\n    symmetry: open canvas beside the card, "
                      "left (card->bar) vs right (card->column)")
            for r in mine:
                if r.get("offscreen"):
                    continue
                d = abs(r["openR"] - r["openL"])
                if verbose:
                    print(f"    z={r['z']:5.2f}  left {r['openL']:7.2f}px   "
                          f"right {r['openR']:7.2f}px   difference {d:6.2f}px")
                if d > SYM_TOL:
                    fails.append(
                        f"[{v['key']}] z={r['z']}: the right column stands "
                        f"{r['openR']:.1f}px off the card where the left side "
                        f"shows {r['openL']:.1f}px of open canvas — a "
                        f"{d:.1f}px asymmetry with nothing on the right to "
                        f"clear. This is the user's second complaint.")

        # reaching either column must not have become the new problem
        if verbose:
            print("\n    transit — cursor walked from the card out to each "
                  "column;\n    a dead run is where they stop being "
                  "interactive mid-reach")
        for r in mine:
            if r.get("offscreen"):
                continue
            for side, key in (("left", "deadL"), ("right", "deadR")):
                d = r[key]
                if verbose:
                    shown = "not measured" if d is None else f"{d:6.1f}px"
                    print(f"    z={r['z']:5.2f}  {side:<5}  "
                          f"worst dead run {shown}")
                if d:
                    fails.append(
                        f"[{v['key']}] z={r['z']}: reaching the {side} chips "
                        f"crosses {d:.1f}px where they are not interactive — "
                        f"they vanish mid-reach. The neighbour may be "
                        f"clickable now, but the hire gesture is not.")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true",
                    help="restore the pre-fix rules; the run MUST fail")
    ap.add_argument("--expect-fail-const", action="store_true",
                    help="restore the unconditional 24px right-hand "
                         "clearance; the run MUST fail")
    ap.add_argument("--expect-fail-bottom", action="store_true",
                    help="restore the old bottom-edge anchor; two provider "
                         "rows MUST overlap the card")
    ap.add_argument("--shot", help="write a screenshot of the bare card at z=1")
    a = ap.parse_args()

    if sum((a.expect_fail, a.expect_fail_const, a.expect_fail_bottom)) > 1:
        raise SystemExit("pick one control: they answer different questions")

    _check_fixture_still_matches_source()
    css = CSS.read_text(encoding="utf-8")
    control = None
    if a.expect_fail:
        css, control = css + PRE_FIX_CSS, "pre-fix rules"
        print("chipbar_probe: KNOWN-NEGATIVE CONTROL (pre-fix rules restored)")
    elif a.expect_fail_const:
        css, control = css + CONST_CSS, "unconditional right clearance"
        print("chipbar_probe: KNOWN-NEGATIVE CONTROL (the first fix's "
              "unconditional 24px right clearance restored)")
    elif a.expect_fail_bottom:
        css, control = css + BOTTOM_CSS, "old bottom-edge anchor"
        print("chipbar_probe: KNOWN-NEGATIVE CONTROL (the old bottom-edge "
              "anchor restored)")
    else:
        print("chipbar_probe: measuring the shipped rules")
    fails = run(css, shot=a.shot)

    if control:
        if fails:
            print(f"\n  CONTROL OK — the {control} sheet fails, as it must "
                  f"({len(fails)} finding(s)). The probe can see this defect.")
            for f in fails[:3]:
                print("   e.g. " + f)
            return 0
        print(f"\n  CONTROL FAILED: the {control} measured CLEAN.")
        print("  This probe cannot see the defect it exists to catch, so a "
              "green run against the real sheet proves nothing.")
        return 1

    if fails:
        print(f"\n  {len(fails)} finding(s):")
        for f in fails:
            print("   - " + f)
        return 1
    print("\n  OK — the cursor on the bar hits the bar at every zoom; the "
          "columns clear\n  whatever stands beside them; and with nothing to "
          "clear the two sides sit\n  the same distance off the card; and "
          "multi-provider bottom rows grow away\n  from card content in both "
          "overview and desk layouts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
