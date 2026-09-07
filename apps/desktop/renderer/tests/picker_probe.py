"""picker_probe.py — the OpenRouter model-selection modal, rendered and measured.

User ask 2026-09-03: the modal shows EVERY selected model on the modal itself
(overview at a glance) and each entry deselects directly (no searching for
the model first). The list is a wrapping row of chips — monogram card, label,
a ✕ icon button — wearing the selected row's tint. Behaviour (select →
appears → deselect → disappears from the list AND the search row) is proved
by `openrouter.test.tsx §2b` under jsdom; LAYOUT is not something jsdom can
see, so this probe renders the real component over styles.css in Edge and
measures it, with six favorites so the list wraps and one label is long.

    python -B tests/picker_probe.py [--shot PNG]
    python -B tests/picker_probe.py --expect-fail chips     (a control)
    python -B tests/picker_probe.py --expect-fail density   (the other one)

⚠ THERE ARE TWO KNOWN-NEGATIVE CONTROLS AND THEY RUN SEPARATELY. `chips`
restores the pre-fix chip layout; `density` restores the pre-compression row.
They were briefly one combined mutant, and that was worse than useless: the
chip failures alone filled the output, so a density check that caught nothing
would have looked identical to one that worked. A control that cannot say
WHICH check fired is not a control for either.

WHAT IT CHECKS
  1. the list is on the dialog, above the search box, with one chip per
     favorite, and every chip sits INSIDE the dialog's box (no overflow)
  2. every ✕ is a real target (≥ 20×20 css px), inside its chip, icon-only
  3. a long label is clipped inside its chip, not spilling over the ✕
  4. the list wears the selected row's tint: its border colour equals the
     border colour of a selected search row (same meaning, same colour)
  5. the search rows of the favorites read selected (the fixture's state)
  6. every search row is under ROW_MAX_PX tall and they are all the SAME
     height (user ask 2026-09-04 — the compression, measured not eyeballed)
  7. no cell wrapped: the price is one line and the detail line ellipsises.
     A compressed row that wraps is worse than a taller one that does not
  8. the row list is its own scroll container — `.orr-vendor` is sticky, and
     sticky resolves against the nearest SCROLLING ancestor, so without this
     the group headings stick to the settings modal instead of to the list
"""
from __future__ import annotations

import argparse
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
CSS = FRONTEND / "src" / "styles.css"

#: ⚠ TWO CONTROLS, SEPARATELY RUNNABLE, AND THAT SEPARATION IS THE POINT.
#: Bolting the density mutant onto the chip mutant made `--expect-fail` pass
#: for the wrong reason: the chip failures alone filled the output, so a
#: density check that caught nothing would have looked exactly the same. A
#: control that cannot say WHICH check fired is not a control for either.
CONTROLS: dict[str, str] = {
    # the original: the pre-fix chip layout (2026-09-03)
    "chips": """
.orr-sel-x { width: 10px !important; height: 10px !important; }
.orr-sel-name { max-width: none !important; overflow: visible !important; }
.orr-sel { max-width: 12em !important; }
""",
    # the pre-compression search row (2026-09-04): 3-line price cell, 34px
    # card, doubled padding — what the rows looked like before the user asked
    # for more of them on a page
    "density": """
.orr-row { padding: 6px 8px !important; }
.orr-row .orr-card { width: 34px !important; height: 34px !important; }
.orr-row .orr-price { white-space: normal !important; max-width: 4em !important; }
.orr-list { overflow-y: visible !important; }
""",
}

#: the compressed row's ceiling, in CSS px (user ask 2026-09-04: "compress
#: their height so more can be fit onto the same page at once"). MEASURED
#: here: 71.8px before, 39.9px after. 48 sits between them with ~8px of slack
#: for a font or border to move without a false alarm, while still failing the
#: uncompressed row outright.
ROW_MAX_PX = 48

FRAME = """
body { margin: 0; background: #1f1f1f; color: #e8e8e8; font: 13px system-ui, sans-serif; }
"""

MEASURE = r"""() => {
  const ROW_MAX_PX = __ROW_MAX__
  const bad = []
  const inside = (a, b, slack = 0.5) =>
    a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack
  const dialog = document.querySelector('[role="dialog"].orr-picker')
  if (!dialog) return ['no dialog rendered']
  const box = dialog.getBoundingClientRect()
  const list = dialog.querySelector('.orr-selected')
  if (!list) return ['no selected list on the dialog']
  const search = dialog.querySelector('.orr-search')
  if (!(list.getBoundingClientRect().bottom <= search.getBoundingClientRect().top + 0.5))
    bad.push('the selected list is not above the search box')
  const chips = [...list.querySelectorAll('.orr-sel')]
  if (chips.length !== 6) bad.push(`expected 6 chips, found ${chips.length}`)
  const rows = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top)))
  if (rows.size < 2) bad.push('six chips did not wrap onto a second line at 680px')
  for (const chip of chips) {
    const r = chip.getBoundingClientRect()
    const name = chip.querySelector('.orr-sel-name')?.textContent ?? '?'
    if (!inside(r, box)) bad.push(`chip "${name}" overflows the dialog`)
    const x = chip.querySelector('.orr-sel-x')
    const xr = x.getBoundingClientRect()
    if (!(xr.width >= 20 && xr.height >= 20)) bad.push(`✕ on "${name}" is ${xr.width.toFixed(0)}×${xr.height.toFixed(0)} < 20×20`)
    if (!inside(xr, r)) bad.push(`✕ on "${name}" sits outside its chip`)
    if (x.textContent.trim() !== '' || !x.querySelector('svg')) bad.push(`✕ on "${name}" is not icon-only`)
    const lab = chip.querySelector('.orr-sel-name')
    const lr = lab.getBoundingClientRect()
    if (!(lr.right <= xr.left + 0.5)) bad.push(`label "${name}" runs into the ✕`)
    if (lab.scrollWidth > lab.clientWidth + 1 && getComputedStyle(lab).textOverflow !== 'ellipsis')
      bad.push(`long label "${name}" overflows without an ellipsis`)
  }
  const long = chips.find((c) => c.querySelector('.orr-sel-name')?.textContent?.includes('maverick'))
  if (long) {
    const lab = long.querySelector('.orr-sel-name')
    if (!(lab.scrollWidth > lab.clientWidth + 1)) bad.push('the long label was not clipped')
  }
  // ── the COMPRESSED search row (user ask 2026-09-04) ───────────────────
  // "compress their height so more can be fit onto the same page at once".
  // Height is the whole point, so it is measured rather than eyeballed; and
  // a compressed row that WRAPS is worse than a taller one that does not, so
  // the columns are checked for staying on one line too.
  const searchRows = [...dialog.querySelectorAll('.orr-list .orr-row')]
  if (!searchRows.length) bad.push('no search rows rendered to measure')
  for (const row of searchRows) {
    const r = row.getBoundingClientRect()
    const who = row.querySelector('.orr-name b')?.textContent ?? '?'
    if (r.height > ROW_MAX_PX)
      bad.push(`row "${who}" is ${r.height.toFixed(1)}px tall, over the ${ROW_MAX_PX}px compressed ceiling`)
    if (!inside(r, box)) bad.push(`row "${who}" overflows the dialog`)
    // the price is one line now; if it wraps, the row grows and the columns
    // stop lining up — the exact regression the compression invites
    const price = row.querySelector('.orr-price')
    if (price) {
      const pr = price.getBoundingClientRect()
      const oneLine = parseFloat(getComputedStyle(price).lineHeight) || 16
      if (pr.height > oneLine * 1.6)
        bad.push(`price on "${who}" wrapped to ${pr.height.toFixed(1)}px (line is ${oneLine.toFixed(1)}px)`)
    }
    // …and the second name line must ellipsise rather than wrap
    const dim = row.querySelector('.orr-name .dim')
    if (dim) {
      const dr = dim.getBoundingClientRect()
      const dl = parseFloat(getComputedStyle(dim).lineHeight) || 15
      if (dr.height > dl * 1.6) bad.push(`the detail line on "${who}" wrapped`)
    }
  }
  // every row the same height: a list where one row is taller reads as a
  // broken table, and it is what a wrapping cell looks like from outside
  const heights = new Set(searchRows.map((r) => Math.round(r.getBoundingClientRect().height)))
  if (heights.size > 1) bad.push(`rows are not a uniform height: ${[...heights].join(', ')}px`)
  // the list scrolls on its own — this is what makes the sticky group
  // headings stick to the LIST rather than to the settings modal, and it is
  // load-bearing now the page is 25 rows
  const listEl = dialog.querySelector('.orr-list')
  if (listEl && !['auto', 'scroll'].includes(getComputedStyle(listEl).overflowY))
    bad.push('the row list is not its own scroll container — sticky headings will not stick')

  const on = [...dialog.querySelectorAll('.orr-row.on')]
  if (on.length !== 6) bad.push(`expected the 6 favorites' rows to read selected, found ${on.length}`)
  if (on.length) {
    const a = getComputedStyle(list).borderTopColor, b = getComputedStyle(on[0]).borderTopColor
    if (a !== b) bad.push(`the list's border (${a}) is not the selected row's (${b})`)
  }
  return bad
}"""


def dump() -> str:
    with tempfile.TemporaryDirectory(prefix="orgtree-picker-") as tmp:
        out = pathlib.Path(tmp) / "picker.html"
        subprocess.run(["node", str(HERE / "picker_dump.mjs"), str(out)],
                       cwd=FRONTEND, check=True, capture_output=True)
        return out.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", nargs="?", const="chips",
                    choices=sorted(CONTROLS),
                    help="run a known-negative control; the probe must FAIL it")
    ap.add_argument("--shot")
    args = ap.parse_args()
    fragment = dump()
    css = CSS.read_text(encoding="utf-8")
    html = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
            f"{CONTROLS.get(args.expect_fail or '', '')}</style>\n{fragment}")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 820},
                                device_scale_factor=2)
        page.set_content(html)
        page.wait_for_timeout(150)
        bad = page.evaluate(MEASURE.replace("__ROW_MAX__", str(ROW_MAX_PX)))
        # measured separately so a green run can state a NUMBER, not "fine"
        row_px = page.evaluate(
            "() => { const r = [...document.querySelectorAll('.orr-list .orr-row')]"
            "  .map((e) => e.getBoundingClientRect().height);"
            "  return r.length ? Math.max(...r) : 0 }")
        if args.shot:
            page.screenshot(path=args.shot, full_page=True)
            print(f"saved {args.shot}")
        browser.close()
    if args.expect_fail:
        if not bad:
            print(f"CONTROL FAILED — the '{args.expect_fail}' mutant passed the probe")
            return 1
        print(f"CONTROL OK — '{args.expect_fail}' is caught: " + "; ".join(bad[:3])
              + (f" … (+{len(bad) - 3})" if len(bad) > 3 else ""))
        return 0
    if bad:
        print("\n".join("FAIL: " + b for b in bad))
        return 1
    print("OK — six chips on the dialog above the search box, wrapping, inside the box; "
          "every ✕ ≥ 20×20 and icon-only; the long label clipped; the list wears the "
          "selected row's tint; the favorites' rows read selected; "
          f"search rows are {row_px:.1f}px tall (ceiling {ROW_MAX_PX}px), uniform, "
          "unwrapped, in a scrolling list")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
