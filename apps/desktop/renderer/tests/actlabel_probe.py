"""actlabel_probe.py — does the live-activity label stay inside its card?

A busy agent's card shows what it is doing right now: `Activity()` in
src/canvas/desk.tsx renders `.actlabel` — a spinning gear plus the current tool
name — onto the card at overview zoom. The tool name is arbitrary text supplied
by the running turn, and some of them are long: `mcp__orgtree__orgtree_send_notice`
shortens to `orgtree: orgtree_send_notice`.

The card is NODE_W x NODE_H (shared.ts) with 7px of padding, and that is all the
room there is. Whether a given string fits depends on the font, the glyphs and
the browser's text shaping — which is exactly the thing that cannot be computed
in jsdom, where every width is 0. A unit test that multiplies a character count
by an assumed px-per-char is a guess wearing a measurement's clothes; a seat on
this repo shipped one today that assumed 58px for a box that really rendered at
101.63px, and it was green the whole time.

So this measures. It renders the real card markup against the real
src/styles.css in real headless Edge and asks one question of every painted box
and text run on the card: is any part of it outside the card's content box?

    python tests/actlabel_probe.py                 # measure and check
    python tests/actlabel_probe.py --expect-fail   # KNOWN-NEGATIVE CONTROL:
                                                   # run the PRE-FIX sheet;
                                                   # must FAIL.
    python tests/actlabel_probe.py --shot out.png  # and look at it

The control is the point. "Nothing overflows" means nothing at all unless this
script is demonstrably able to report that something does.

Requires playwright with the msedge channel (same dependency as
edgejump_probe.py next door, and the same reason).
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
DESK = FRONTEND / "src" / "canvas" / "desk.tsx"


def _node_size() -> tuple[int, int]:
    """Read the card geometry straight out of shared.ts.

    Hard-coding 124 here would let the two files drift in silence: someone
    changes NODE_W and this probe carries on checking the old box, so the check
    stops describing what ships without ever going red. One source, parsed.
    """
    src = SHARED.read_text(encoding="utf-8")
    m = re.search(r"^export const NODE_W = (\d+), NODE_H = (\d+)", src, re.M)
    if not m:
        raise SystemExit(f"could not read NODE_W/NODE_H from {SHARED} — the "
                         f"probe cannot check a box it cannot find")
    return int(m.group(1)), int(m.group(2))


NODE_W, NODE_H = _node_size()


def _short_tool(t: str) -> str:
    """The Python twin of shortTool() in desk.tsx — the HOVER form.

    Verified against the source below rather than trusted, so a change to the
    real one turns this probe red instead of leaving it measuring a string the
    app no longer renders.
    """
    return re.sub(r"^mcp__([^_]+)__", r"\1: ", t)


def _card_tool(t: str) -> str:
    """The Python twin of cardTool() in desk.tsx — the form the CARD renders."""
    return re.sub(r"^mcp__[^_]+__", "", t)


def _check_fixture_still_matches_source() -> None:
    """The fixture must be the markup Activity() really emits.

    This is not paranoia, it is the bug this probe already had: the first
    version of the fixture wrapped the tool name in a span that carried no
    class, so the `.actlabel-text` rule matched nothing, the text wrapped to a
    clipped second line — and the probe reported OK, because the parent's
    overflow:hidden dutifully contained the mess. A probe measuring markup the
    app does not render is worth less than no probe, because it is believed.
    """
    src = DESK.read_text(encoding="utf-8")
    for twin, pattern in (("shortTool", "replace(/^mcp__([^_]+)__/, '$1: ')"),
                          ("cardTool", "replace(/^mcp__[^_]+__/, '')")):
        if pattern not in src:
            raise SystemExit(
                f"{twin}() in desk.tsx no longer matches this probe's copy of "
                f"it — the fixture would be measuring strings the app never "
                f"renders. Update the Python twin and this guard together.")
    for needed in ('className="actlabel"', 'className="actlabel-text"',
                   'className="actdots"'):
        if needed not in src:
            raise SystemExit(
                f"Activity() in desk.tsx no longer renders {needed} — this "
                f"probe's fixture is stale and would be measuring a card the "
                f"app never draws. Update card() and this guard together.")


# Real tool names, worst realistic case first. The long ones are not invented:
# they are what an orgtree agent's own MCP calls are actually named, which is
# how the user hit this.
TOOLS = [
    "mcp__orgtree__orgtree_send_notice",
    "mcp__mcplink__get_protoflux_subgraph",
    "mcp__resonite__get_sync_object_definition",
    "mcp__orgtree__orgtree_request_credits",
    # NOT a realistic name — the point. The label renders whatever tool the
    # turn called, which is unbounded: an MCP server may name its tools
    # anything, so the longest name anyone has SEEN is not the worst case, it
    # is just the worst case so far. A fix verified against observed strings is
    # a fix with a list attached; this asks whether the containment is
    # structural. One unbreakable 200-character token, no spaces to wrap at.
    "mcp__pathological__" + "z" * 200,
    # …and the same length with spaces, which wraps rather than overflowing and
    # so fails differently: this is the leg that catches a `nowrap` that was
    # never applied.
    "mcp__pathological__" + " ".join(["wrap"] * 50),
    "Read",          # the SHORT leg — see below
    "TaskCreate",
]

# The short leg is load-bearing. A "fix" that simply stopped rendering the
# activity text, or clamped the label to zero width, would satisfy every
# overflow assertion perfectly. So a short name must still render its text
# FULLY — untruncated, non-empty — or this probe fails just as loudly.
SHORT_TOOLS = {"Read", "TaskCreate"}

GEAR = ('<svg class="actgear-svg" viewBox="0 0 24 24" '
        'style="width:1em;height:1em;flex:none;fill:currentColor">'
        '<circle cx="12" cy="12" r="9"/></svg>')
WHEEL = ('<svg class="ctxwheel" viewBox="0 0 24 24" width="13" height="13">'
         '<circle class="track" cx="12" cy="12" r="9"/></svg>')


def card(tool: str, label_fn=None) -> str:
    """The card as cards.tsx really renders it: non-focused, lod !== 'mini',
    node.busy, live.

    WORST CASE ON PURPOSE — a long agent id in the head, the busy gear dot in
    the head (cards.tsx renders BOTH the head dot and the full label while
    busy), the full activity label, and a status chip plus a lineage-stack
    badge below it. An earlier fixture that left the badges out measured a
    shorter card than the one that ships, and a fixture which under-specifies
    abstains just as thoroughly as a check that never runs.
    """
    # label_fn is the CONTROL seam: pass _short_tool to rebuild the
    # keep-the-server-prefix label this fix replaced, which is the variant that
    # renders two different orgtree tools identically.
    label = (label_fn or _card_tool)(tool)   # what the card shows
    full = _short_tool(tool)                 # what the hover title carries
    return (
        f'<div class="sq live norm tier-opus edge-b busy" data-tool="{tool}" '
        f'style="position:relative;width:{NODE_W}px;height:{NODE_H}px">'
        f'  <div class="sq-head">'
        f'    <span class="tier t-opus">O</span>'
        f'    <span class="name">bug-overlapping-coworker-jump-cards</span>'
        f'    <span class="actgear">{GEAR}</span>'
        f'    {WHEEL}'
        f'  </div>'
        f'  <div class="actlabel" data-role="label" title="{full}">'
        f'<span class="actgear">{GEAR}</span>'
        f'<span class="actlabel-text" data-role="text">{label}</span>'
        f'<span class="actdots"></span>'
        f'  </div>'
        f'  <div class="sq-badges">'
        f'    <span class="statuschip working">working</span>'
        f'    <button class="badge stackbadge">2</button>'
        f'  </div>'
        f'</div>')


def build_page(css: str, label_fn=None) -> str:
    cards = "".join(card(t, label_fn) for t in TOOLS)
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>\n"
        + css +
        "\n.probe-row{display:flex;gap:40px;padding:40px;align-items:flex-start}"
        "\n</style></head><body style='margin:0;background:#1f1f1f'>"
        "<div class='probe-row'>" + cards + "</div></body></html>")


# For every card: the content box (inside border + padding), then every painted
# box on it — elements AND bare text runs, which is the whole point here, since
# pre-fix the tool name is an unwrapped text node with no element of its own to
# measure. Ranges give text runs a rect.
MEASURE = r"""() => [...document.querySelectorAll('.sq')].map((sq) => {
  const cs = getComputedStyle(sq)
  const r = sq.getBoundingClientRect()
  const px = (v) => parseFloat(v) || 0
  const box = {
    left:   r.left   + px(cs.borderLeftWidth)   + px(cs.paddingLeft),
    right:  r.right  - px(cs.borderRightWidth)  - px(cs.paddingRight),
    top:    r.top    + px(cs.borderTopWidth)    + px(cs.paddingTop),
    bottom: r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
  }
  const spills = []
  const note = (what, rect) => {
    // sub-pixel slack: text antialiasing and fractional layout routinely put a
    // glyph edge a hair past a boundary it is visually flush with. 0.5px is
    // below one device pixel here and cannot be the bug the user reported.
    const EPS = 0.5
    const d = {
      right:  rect.right  - box.right,
      left:   box.left    - rect.left,
      bottom: rect.bottom - box.bottom,
      top:    box.top     - rect.top,
    }
    for (const side of ['right', 'left', 'bottom', 'top']) {
      if (d[side] > EPS) spills.push({ what, side, by: Math.round(d[side] * 100) / 100 })
    }
  }
  // A getBoundingClientRect / Range rect reports a box's FULL extent, ignoring
  // any clipping ancestor. Taken raw that is wrong in the one direction that
  // matters here: the head's .name is `overflow:hidden; text-overflow:ellipsis`,
  // so its text measures ~114px past the card while rendering as a tidy
  // "bug-over…" well inside it. Counting that would be a false alarm — and,
  // worse, the fix below works BY clipping, so a probe blind to clipping could
  // never see the fix work. Intersect with the clip of every overflow!=visible
  // ancestor: what survives is what is actually PAINTED.
  const clipped = (rect, el) => {
    const out = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const ov = getComputedStyle(a)
      const ar = a.getBoundingClientRect()
      if (ov.overflowX !== 'visible') {
        out.left = Math.max(out.left, ar.left); out.right = Math.min(out.right, ar.right)
      }
      if (ov.overflowY !== 'visible') {
        out.top = Math.max(out.top, ar.top); out.bottom = Math.min(out.bottom, ar.bottom)
      }
    }
    return out
  }
  const gone = (v) => v.right <= v.left || v.bottom <= v.top   // fully clipped away
  // every element inside the card, except the credit bar and its layers, which
  // are DELIBERATELY outside it (.cbar is position:absolute; left:-22px) —
  // that is a design ruling, not a bug, and is why the card cannot simply be
  // given overflow:hidden.
  for (const el of sq.querySelectorAll('*')) {
    if (el.closest('.cbar')) continue
    const er = el.getBoundingClientRect()
    if (!er.width && !er.height) continue
    const vis = clipped(er, el.parentElement)
    if (gone(vis)) continue
    note(el.className && typeof el.className === 'string'
      ? '.' + el.className.split(' ').filter(Boolean).join('.')
      : el.tagName.toLowerCase(), vis)
  }
  // bare text runs — the tool name pre-fix has no element wrapper
  const walk = document.createTreeWalker(sq, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.nodeValue.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const tr = range.getBoundingClientRect()
    if (!tr.width && !tr.height) continue
    const vis = clipped(tr, n.parentElement)
    if (gone(vis)) continue
    note(`text "${n.nodeValue.trim().slice(0, 28)}"`, vis)
  }
  // How much of the name a person can actually READ. Not a guess at
  // px-per-character — a binary search over real Range rects for the longest
  // prefix that still fits the box. Needed because "contained" and "legible"
  // are different claims: the first fix here contained everything perfectly
  // and rendered two different tools as the identical `orgtree: orgtr…`.
  const visibleText = (el) => {
    const node = el.firstChild
    if (!node || node.nodeType !== 3) return el.textContent
    const s = node.nodeValue, cw = el.clientWidth, range = document.createRange()
    let lo = 0, hi = s.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      range.setStart(node, 0); range.setEnd(node, mid)
      if (range.getBoundingClientRect().width <= cw) lo = mid; else hi = mid - 1
    }
    return s.slice(0, lo)
  }
  const label = sq.querySelector('[data-role="label"]')
  const text = sq.querySelector('[data-role="text"]')
  const lh = label.getBoundingClientRect()
  return {
    tool: sq.dataset.tool,
    spills,
    labelWidth: Math.round(lh.width * 100) / 100,
    labelHeight: Math.round(lh.height * 100) / 100,
    // scrollWidth > clientWidth means the label's own content does not fit it;
    // with the fix that is fine (it is clipped and ellipsised) and without it
    // that content is painted outside the card.
    labelScroll: label.scrollWidth,
    labelClient: label.clientWidth,
    textShown: text ? text.textContent.trim() : '',
    textVisibleChars: text ? visibleText(text).trim() : '',
    titleAttr: label.getAttribute('title') || '',
    textTruncated: text ? text.scrollWidth > text.clientWidth + 0.5 : false,
    // How many line boxes the name occupies. Containment alone is NOT enough:
    // a label that wraps to two lines and has the second one clipped by the
    // parent is "contained" and still visibly broken — half a line of severed
    // glyphs, and the row twice the height it should be. The name must sit on
    // exactly ONE line and lose its tail to an ellipsis instead.
    textLines: text ? text.getClientRects().length : 0,
    // does the ellipsis the user is promised actually exist? (a clipped box
    // with no text-overflow chops mid-glyph and looks like a rendering fault)
    textEllipsis: text ? getComputedStyle(text).textOverflow : '',
    textVisible: text ? getComputedStyle(text).display !== 'none'
      && parseFloat(getComputedStyle(text).fontSize) > 0
      && text.getBoundingClientRect().width > 0 : false,
    contentW: Math.round((box.right - box.left) * 100) / 100,
    contentH: Math.round((box.bottom - box.top) * 100) / 100,
  }
})"""


def run(css_text: str, shot: str | None = None, verbose: bool = True,
        label_fn=None):
    fd, page = tempfile.mkstemp(suffix=".html",
                                dir=str(FRONTEND / "node_modules"))
    os.close(fd)
    pathlib.Path(page).write_text(build_page(css_text, label_fn),
                                  encoding="utf-8")
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page(viewport={"width": 1400, "height": 400},
                            device_scale_factor=2)
            pg.goto(pathlib.Path(page).as_uri())
            pg.wait_for_selector(".actlabel", timeout=8000)
            rows = pg.evaluate(MEASURE)
            if shot:
                pathlib.Path(shot).parent.mkdir(parents=True, exist_ok=True)
                pg.locator(".probe-row").screenshot(path=shot)
            b.close()
    finally:
        os.unlink(page)

    fails = []
    if len(rows) != len(TOOLS):
        fails.append(f"measured {len(rows)} cards, expected {len(TOOLS)} — the "
                     f"fixture did not render, so nothing below means anything")
    for r in rows:
        short = _card_tool(r["tool"])
        if verbose:
            state = "spills" if r["spills"] else "contained"
            print(f"  {short:<34} label={r['labelWidth']:>6.2f}x"
                  f"{r['labelHeight']:<6.2f} of {r['contentW']}x{r['contentH']}"
                  f"  content={r['labelScroll']}px  {state}"
                  f"  lines={r['textLines']}"
                  f"  trunc={'y' if r['textTruncated'] else 'n'}")
            for s in r["spills"]:
                print(f"      ↳ {s['side']:>6} +{s['by']}px  {s['what']}")
        for s in r["spills"]:
            fails.append(f"{short}: {s['what']} escapes the card {s['side']} "
                         f"edge by {s['by']}px")
        # one line, always — see textLines above
        if r["textLines"] != 1:
            fails.append(f"{short}: the name occupies {r['textLines']} line "
                         f"box(es), not 1 — it wrapped, and a wrapped line "
                         f"inside a clipped row is a severed half-line, not a "
                         f"fit")
        if r["textEllipsis"] != "ellipsis":
            fails.append(f"{short}: text-overflow is {r['textEllipsis']!r}, "
                         f"not 'ellipsis' — an over-long name would be chopped "
                         f"mid-glyph instead of marked as cut")
        # --- the leg that stops "delete the text" from passing ---
        if not r["textVisible"] or not r["textShown"]:
            fails.append(f"{short}: the activity text is not rendered at all — "
                         f"an empty label overflows nothing, and tells the user "
                         f"nothing either")
        # truncating is a DISPLAY decision; the full name must survive it
        if r["titleAttr"] != _short_tool(r["tool"]):
            fails.append(f"{short}: hover title is {r['titleAttr']!r}, expected "
                         f"{_short_tool(r['tool'])!r} — the ellipsised text is "
                         f"then the only copy of the name, and it is cut")
        if r["tool"] in SHORT_TOOLS:
            if r["textTruncated"]:
                fails.append(f"{short}: a short tool name was truncated — it "
                             f"fits, so it must be shown whole")
            if r["textShown"] != short:
                fails.append(f"{short}: short name rendered as "
                             f"{r['textShown']!r}, expected {short!r}")

    # --- across cards: can the user TELL THESE APART? ---
    # Containment is not the whole job. A label truncated so hard that two
    # different tools read the same is contained and useless; that is what the
    # first version of this fix did, and only looking at it caught it.
    seen: dict[str, str] = {}
    for r in rows:
        vis = r["textVisibleChars"]
        if not vis:
            continue
        if vis in seen and seen[vis] != r["tool"]:
            fails.append(
                f"{_short_tool(seen[vis])} and {_short_tool(r['tool'])} both "
                f"render as {vis!r} — two different activities are "
                f"indistinguishable on the card")
        seen[vis] = r["tool"]
    return rows, fails


# The PRE-FIX sheet: strip the containment declarations back out of .actlabel
# and drop the .actlabel-text rule entirely, reproducing exactly what shipped
# before this change. If the probe still passes against that, it is blind.
def prefix_css(css: str) -> str:
    css = re.sub(r"^\.actlabel-text\s*\{[^}]*\}\s*", "", css, flags=re.M)
    def strip(m: re.Match) -> str:
        body = m.group(2)
        for prop in ("min-width", "overflow", "max-width", "flex-wrap"):
            body = re.sub(rf"\s*{prop}\s*:[^;}}]*;?", "", body)
        return m.group(1) + body + "}"
    return re.sub(r"(^\.actlabel\s*\{)([^}]*)\}", strip, css, flags=re.M)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--expect-ambiguous", action="store_true",
                    help="KNOWN-NEGATIVE CONTROL for the legibility check: "
                         "label the cards with the server prefix kept, which "
                         "renders two orgtree tools identically. Must FAIL.")
    ap.add_argument("--shot", default=None, help="write a PNG of the cards")
    a = ap.parse_args()

    _check_fixture_still_matches_source()
    css = CSS.read_text(encoding="utf-8")

    if a.expect_ambiguous:
        # The containment control above proves this probe can see an overflow.
        # It says nothing about whether the "two tools must not look the same"
        # check can ever fire — and an assertion never seen to fail is a
        # decoration. This runs the labels the way they were before the prefix
        # was dropped and demands the ambiguity be caught.
        print("-- CONTROL: labels keep the server prefix (`orgtree: orgtr…`)")
        rows, fails = run(css, verbose=True, label_fn=_short_tool)
        amb = [f for f in fails if "indistinguishable" in f]
        if amb:
            print(f"\nCONTROL OK — the prefixed labels are caught as "
                  f"indistinguishable, as they must be:")
            for f in amb:
                print("   ·", f)
            return 0
        print("\n⚠ CONTROL BROKEN: two tools rendering as the same string were "
              "NOT reported. The legibility check cannot fail, so every green "
              "run of it is vacuous.")
        return 1

    if a.expect_fail:
        stripped = prefix_css(css)
        if stripped == css:
            print("⚠ CONTROL BROKEN: stripping the fix changed nothing in the "
                  "sheet, so this run is not a control at all.")
            return 1
        css = stripped
        print("-- CONTROL: containment stripped from .actlabel (the pre-fix sheet)")

    rows, fails = run(css, shot=a.shot)

    if a.expect_fail:
        # a control must fail for the RIGHT reason: something painted outside
        # the card. "the text vanished" would also be a failure, and would not
        # prove this probe can see an overflow.
        spilled = sum(len(r["spills"]) for r in rows)
        if fails and spilled:
            print(f"\nCONTROL OK — the pre-fix sheet spills {spilled} box(es) "
                  f"outside the card, as it must:")
            for f in fails:
                print("   ·", f)
            return 0
        if fails:
            print("\n⚠ CONTROL BROKEN: the pre-fix sheet failed, but not by "
                  "overflowing — so this probe still has not shown it can see "
                  "an overflow.")
            return 1
        print("\n⚠ CONTROL BROKEN: the sheet with the fix stripped out still "
              "PASSED. This probe cannot see the thing it claims to measure, "
              "so every green run of it is vacuous.")
        return 1

    if fails:
        print(f"\nFAIL ({len(fails)}):")
        for f in fails:
            print("   ·", f)
        return 1
    print("\nOK — every activity label stays inside its card, and short tool "
          "names still render in full")
    return 0


if __name__ == "__main__":
    sys.exit(main())
