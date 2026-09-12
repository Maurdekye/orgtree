"""trayheight_probe.py — the embedded Agents window must stay inside the canvas.

    python -B tests/trayheight_probe.py
    python -B tests/trayheight_probe.py --expect-fail deadchild
    python -B tests/trayheight_probe.py --shot out.png

THE DEFECT (user report 2026-09-12)
-----------------------------------
With enough agents in an org, the ordinary (unpinned, non-popped-out) Agents
window grows past the TOP of the Orgtree viewport: its pin / pop-out / close
bar and its filter box end up off-screen and unusable.

`.tray-wrap` is the absolutely positioned box that holds the agents surface and
its toggle. It has BOTH `top` and `bottom`, so its height is definite, and it
lays its children out bottom-up (`justify-content: flex-end`). The stylesheet
then bound the surface to that height with

    .tray-wrap > .surface-inline { display:flex; flex-direction:column;
                                   min-height:0; max-height:100% }

which is the right idea and the WRONG SELECTOR: `PinFrame` renders through
`MovableSurface`, so the DOM under `.tray-wrap` is

    .tray-wrap > .movable-anchor > .movable-surface > .movable-content
               > .movable-events > .surface-inline > .tray-panel

Those four wrappers are `display: contents`, so they generate no boxes and
`.surface-inline` really is a flex ITEM of the wrap for layout — but the child
COMBINATOR is about the DOM tree, not the box tree, so the rule never matched
anything. `.surface-inline` was left a plain block with `min-height: auto`,
which in a column flex container means "never shrink below your content", and
the surface overflowed its wrap upward.

WHY A REAL BROWSER
------------------
Every claim here is a layout claim — a percentage max-height resolving against
a containing block, a flex item's automatic minimum size, an overflow
container that has to scroll. jsdom applies no stylesheet and does no layout,
so a unit test could only assert that the CSS text says what we just wrote,
which is not the claim.

WHY A DUMP OF THE REAL COMPONENT
--------------------------------
The defect IS the shape of the DOM the components produce. A hand-built
fixture would re-declare that shape and could not have caught this. So step 1
(`trayheight_dump.mjs`) renders the real <OrgCanvas/> with its tray open and
writes the markup out; this probe lays that markup out against the real
`styles.css`.

WHAT IT ASSERTS (ordinary/embedded state)
-----------------------------------------
§0  rig: the tray really is taller than the canvas at this window size, and
    every fixture row is in the DOM. A run that measured nothing is a FAILURE.
§1  the whole surface is inside the canvas — nothing above its top, nothing
    below its bottom.
§2  every control in the surface's top bar, and the filter box, is inside the
    canvas AND resolves to itself under elementFromPoint.
§3  the rows scroll INSIDE the list: exactly one scroll container in the
    surface, and it is the list.
§4  scrolling that list to the end brings the last row inside the canvas — the
    overflow is reachable, not clipped away.
§5  no row was dropped to make it fit.

§6  RESIZE: the same page, shrunk to a much shorter window, satisfies §1-§5
    again. The cap has to be recalculated, not laid out once.

AND THE EXCLUSION (pinned state)
--------------------------------
§7  a PINNED agents window keeps the box its own rect asks for, and is not
    under `.tray-wrap` or inside `.surface-inline` at all — the exclusion is
    structural, not selector discipline. (A popped-out window lives in another
    document entirely and never renders `.surface-inline` either;
    `popout_probe.py` and `popoutstyles_probe.py` own that state.)

KNOWN-NEGATIVE CONTROLS
-----------------------
Each restores a way this comes back broken. The probe must FAIL every one of
them except `noop`, which it must PASS.

⚠ WHICH HALF OF THE RULE IS LOAD-BEARING, MEASURED RATHER THAN ASSUMED. Two
further controls were written and BOTH stayed green, so they are not in the
list: `display: block` on `.surface-inline`, and `max-height: none` on it with
the old `calc(100vh - 40px)` cap put back on the panel. Once the flex item can
shrink at all, the wrap's definite height does the rest — so `min-height: 0`
is the declaration that matters and `autominheight` is the control that proves
it. The other two declarations stay because they were already in the rule and
each is a second guarantee, not because a control can kill them.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS = HERE.parent / "src" / "styles.css"

ROWS = 40

# The app shell around the canvas: a header, then `.canvas-stage` (the dump's
# own root) filling what is left. THE HEADER IS THE POINT — it is why the
# canvas is shorter than the window, and why a `100vh`-based cap is not a cap.
FRAME = """
html, body { margin: 0; height: 100%; background: #111; }
body { display: flex; flex-direction: column; }
.probe-header { flex: 0 0 44px; background: #222; }
"""

CONTROLS = {
    # the NOOP: a rule that changes nothing must SURVIVE, or every "killed"
    # below is really an environment-sensitive check reporting noise
    "noop": ".tray-wrap { --trayheight-noop: 1; }",
    # THE SHIPPED DEFECT, restored exactly: the binding rule addresses a DOM
    # child, which `MovableSurface`'s wrappers make sure never exists
    "deadchild": (".tray-wrap .surface-inline { display: block !important;"
                  " min-height: auto !important; max-height: none !important; }"),
    # ONLY the zero minimum killed. This is the load-bearing half of the fix:
    # a column flex item whose `min-height` is `auto` never shrinks below its
    # own content, which is precisely why an unmatched rule left the surface
    # taller than its wrap.
    "autominheight": ".tray-wrap .surface-inline { min-height: auto !important; }",
    # the list stops scrolling, so the cap can only be met by clipping rows
    "noscroll": ".tray { overflow-y: hidden !important; }",
    # the wrap's height goes indefinite again (a revert that drops `top`)
    "noedge": ".tray-wrap { top: auto !important; }",
}

MEASURE = r"""
(rows) => {
  const bad = []
  const vp = document.querySelector('.viewport')
  const panel = document.querySelector('.tray-wrap .tray-panel')
  if (!vp || !panel) return ['no ' + (vp ? '.tray-panel' : '.viewport') + ' — the probe is inert']
  const v = vp.getBoundingClientRect(), p = panel.getBoundingClientRect()
  const R = (b) => `${b.top.toFixed(0)}..${b.bottom.toFixed(0)}`

  // ---- §0 the rig ----------------------------------------------------
  const list = panel.querySelector('.tray')
  if (!list) return ['the surface has no .tray list — wrong fixture']
  const got = panel.querySelectorAll('.tray-row').length
  if (got !== rows) bad.push(`${got} of ${rows} agent rows in the DOM`)
  // the natural content MUST be taller than the canvas, or nothing here is
  // being measured: a short list fits with or without the fix
  const natural = list.scrollHeight + (panel.scrollHeight - list.clientHeight)
  if (natural < v.height + 40) {
    bad.push(`the tray's own content is only ${natural.toFixed(0)}px against a `
      + `${v.height.toFixed(0)}px canvas — this window measures nothing`)
  }

  // ---- §1 inside the canvas -------------------------------------------
  if (p.top < v.top - 1) {
    bad.push(`the agents window starts ${(v.top - p.top).toFixed(0)}px ABOVE the `
      + `top of the canvas (panel ${R(p)}, canvas ${R(v)})`)
  }
  if (p.bottom > v.bottom + 1) {
    bad.push(`the agents window ends ${(p.bottom - v.bottom).toFixed(0)}px BELOW `
      + `the bottom of the canvas (panel ${R(p)}, canvas ${R(v)})`)
  }

  // ---- §2 the top controls are on screen AND clickable ------------------
  const bar = panel.querySelector('.modalpin-bar')
  if (!bar) bad.push('the surface has no top bar at all')
  const controls = [...(bar ? bar.querySelectorAll('button') : []),
                    ...panel.querySelectorAll('.tray-filter')]
  if (controls.length < 3) {
    bad.push(`only ${controls.length} top controls found — the fixture is not `
      + 'showing the pin/pop-out/close bar and the filter')
  }
  for (const el of controls) {
    const b = el.getBoundingClientRect()
    const what = (el.getAttribute('aria-label') || el.className || el.tagName)
      .toString().trim().split(/\s+/)[0]
    if (b.top < v.top - 1 || b.bottom > v.bottom + 1) {
      bad.push(`the "${what}" control is outside the canvas (${R(b)} vs ${R(v)})`)
      continue
    }
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) {
      bad.push(`the "${what}" control is on screen but something else takes the `
        + `click: ${hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).trim().split(/\s+/)[0] : 'null'}`)
    }
  }

  // ---- §3 one scroller, and it is the list -----------------------------
  const scrollers = [...panel.querySelectorAll('*')].filter((el) => {
    const oy = getComputedStyle(el).overflowY
    return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
  })
  if (!scrollers.length) {
    bad.push('nothing inside the surface scrolls, so the rows past the cap are '
      + 'simply gone')
  } else if (!scrollers.some((el) => el === list || list.contains(el))) {
    bad.push('the thing that scrolls is not the agent list')
  }
  if (panel.scrollHeight > panel.clientHeight + 1) {
    bad.push(`the whole surface scrolls (${panel.scrollHeight} > ${panel.clientHeight})`
      + ' — the list already has its own scrollbar inside it')
  }

  // ---- §4 the overflow is reachable ------------------------------------
  const scroller = scrollers.find((el) => el === list || list.contains(el)) || list
  scroller.scrollTop = scroller.scrollHeight
  const last = panel.querySelectorAll('.tray-row')[got - 1]
  if (!last) {
    bad.push('no last row to scroll to')
  } else {
    const lb = last.getBoundingClientRect()
    if (lb.bottom > v.bottom + 1 || lb.top < v.top - 1) {
      bad.push(`scrolled to the end, the last agent row is still outside the `
        + `canvas (${R(lb)} vs ${R(v)})`)
    }
    if (lb.height < 4) bad.push('the last row collapsed to nothing')
  }
  // §5 and nothing was dropped to make it fit
  if (panel.querySelectorAll('.tray-row').length !== got) {
    bad.push('rows disappeared from the DOM when the list scrolled')
  }
  scroller.scrollTop = 0
  return bad
}
"""

MEASURE_PINNED = r"""
() => {
  const bad = []
  const panel = document.querySelector('.tray-panel.modalpin-win')
  if (!panel) return ['the pinned fixture did not render a pinned window — inert']
  // PinFrame writes the pinned rect inline; the embedded cap must not touch it
  const want = parseFloat(panel.style.height || '0')
  if (!want) return ['the pinned window carries no inline height — wrong fixture']
  const h = panel.getBoundingClientRect().height
  if (Math.abs(h - want) > 1) {
    bad.push(`the pinned agents window is ${h.toFixed(0)}px tall but its own `
      + `rect asks for ${want.toFixed(0)}px — the embedded cap reached a pinned `
      + 'window')
  }
  if (getComputedStyle(panel).maxHeight === '100%') {
    bad.push('a pinned window inherited the embedded percentage cap')
  }
  // the structural half of the exclusion, visible right here: a pinned surface
  // renders `.overlay-pinned` in the org's pin layer, never `.surface-inline`
  // under the wrap
  if (panel.closest('.tray-wrap')) {
    bad.push('the pinned window is still inside .tray-wrap — the exclusion now '
      + 'rests on the selector alone')
  }
  if (panel.closest('.surface-inline')) {
    bad.push('the pinned window rendered inside .surface-inline, which is the '
      + 'embedded state')
  }
  if (!document.querySelector('.tray-wrap')) {
    bad.push('no .tray-wrap on the pinned page at all — inert')
  }
  return bad
}
"""

FACTS = r"""
() => {
  const vp = document.querySelector('.viewport').getBoundingClientRect()
  const panel = document.querySelector('.tray-wrap .tray-panel').getBoundingClientRect()
  const list = document.querySelector('.tray-wrap .tray')
  return {
    canvas: Math.round(vp.height), panel: Math.round(panel.height),
    above: Math.round(Math.max(0, vp.top - panel.top)),
    below: Math.round(Math.max(0, panel.bottom - vp.bottom)),
    scroll: Math.round(list.scrollHeight - list.clientHeight),
  }
}
"""

# Two window heights: one ordinary, one short enough that even a modest org
# overflows. Neither is 100vh-tall canvas — the header is what makes a
# viewport-fraction cap wrong, and both windows have one.
WINDOWS = [{"width": 1180, "height": 760}, {"width": 900, "height": 520}]
# what the first window is dragged down to, for the recalculation check
RESIZED = {"width": 760, "height": 430}


def dump(dest: pathlib.Path, rows: int, state: str) -> str:
    subprocess.run(["node", str(HERE / "trayheight_dump.mjs"), str(dest),
                    str(rows), state], check=True, capture_output=True)
    return dest.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", nargs="?", const="deadchild",
                    choices=sorted(CONTROLS),
                    help="run a known-negative control; the probe must FAIL it "
                         "(except `noop`, which it must PASS)")
    ap.add_argument("--shot")
    args = ap.parse_args()
    css = CSS.read_text(encoding="utf-8")
    sheet = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
             f"{CONTROLS.get(args.expect_fail or '', '')}</style>\n"
             "<div class='probe-header'></div>\n")
    with tempfile.TemporaryDirectory() as tmp:
        body = sheet + dump(pathlib.Path(tmp) / "tray.html", ROWS, "inline")
        pinned = sheet + dump(pathlib.Path(tmp) / "pinned.html", ROWS, "pinned")

    bad: list[str] = []
    facts: dict[str, dict] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        for win in WINDOWS:
            page = browser.new_page(viewport=win)
            page.set_content(body)
            page.wait_for_timeout(200)
            tag = f"[{win['width']}x{win['height']}]"
            bad += [f"{tag} {b}" for b in page.evaluate(MEASURE, ROWS)]
            facts[tag] = page.evaluate(FACTS)
            if args.shot and win is WINDOWS[0]:
                page.screenshot(path=args.shot)
                print(f"saved {args.shot}")
            # §6 THE SAME PAGE, RESIZED — not a third fresh page. A cap that is
            # computed once at first layout passes both windows above and fails
            # here, which is exactly what the user does when they drag the
            # window smaller.
            if win is WINDOWS[0]:
                page.set_viewport_size(RESIZED)
                page.wait_for_timeout(200)
                rtag = f"[resized->{RESIZED['width']}x{RESIZED['height']}]"
                bad += [f"{rtag} {b}" for b in page.evaluate(MEASURE, ROWS)]
                facts[rtag] = page.evaluate(FACTS)
            page.close()
        page = browser.new_page(viewport=WINDOWS[0])
        page.set_content(pinned)
        page.wait_for_timeout(200)
        bad += [f"[pinned] {b}" for b in page.evaluate(MEASURE_PINNED)]
        page.close()
        browser.close()

    noop = args.expect_fail == "noop"
    if args.expect_fail and not noop:
        if bad:
            print(f"CONTROL {args.expect_fail} correctly FAILED:")
            for b in bad:
                print("  -", b)
            return 0
        print(f"!! CONTROL {args.expect_fail} PASSED — this probe cannot see the "
              "defect it exists to catch.")
        return 1
    if bad:
        print("FAIL" + (" (noop control)" if noop else ""))
        for b in bad:
            print("  -", b)
        return 1
    print("OK" + (" (noop control survived)" if noop else "") + " · "
          + " · ".join(f"{t} canvas={f['canvas']}px surface={f['panel']}px "
                       f"scrollable={f['scroll']}px" for t, f in facts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
