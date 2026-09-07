"""Real-browser geometry for the desk's own docket tab (`.docket-agent`).

WHY THIS EXISTS AND THE COMPONENT TESTS DO NOT COVER IT. progress.test.tsx §4
proves the tab is wired, lists the right rows and opens the right pane — in
jsdom, which applies no stylesheet at all. Every claim the new CSS makes is a
LAYOUT claim: two panes side by side inside a narrow desk column, both filling
the panel's height, and one scrollbar per pane rather than a third around the
whole thing. None of that is visible to a DOM test, and all of it is what the
reader actually sees.

The rows themselves are NOT re-measured here — the tab wears `.docket-modal`
and `docket_layout_probe.py` already measures a row against those rules. This
probe measures only what differs between a modal and a tab.

    python -B tests/deskdocket_layout_probe.py
    python -B tests/deskdocket_layout_probe.py --expect-fail narrow
    python -B tests/deskdocket_layout_probe.py --shot out.png
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

# The desk column, at the width it really gets, and nothing else. NARROW ON
# PURPOSE: this tab's whole difficulty is that the docket's modal layout has to
# survive in a fraction of the width it was designed for, and a wide viewport
# hides exactly that.
FRAME = """
html, body { margin: 0; background: var(--bg); }
.deskdocket-frame {
  width: 430px; height: 520px; display: flex; flex-direction: column;
}
"""

# Known negatives: each is a way this layout comes back broken. The probe must
# FAIL every one of them, or the checks below are decoration.
CONTROLS = {
    # the NOOP: a rule that changes nothing must SURVIVE, or every "killed"
    # below is really an environment-sensitive check reporting noise
    "noop": ".docket-agent { --deskdocket-noop: 1; }",
    # the list squeezed back to a sliver — the modal's 36% in a desk column
    "narrow": ".docket-agent .mailer-list { width: 20% !important; }",
    # the modal's max-width cap coming back on a wide desk is the same defect
    # in the other direction; at this frame it shows as a stacked layout
    "stacked": ".docket-agent .mailer { display: block !important; }",
    # the flex chain broken: the two-pane box stops filling the tab and
    # collapses to its content height
    "collapsed": ".msgs.docket-agent { display: block !important; }",
    # the third scrollbar — the whole two-pane box scrolling inside the tab
    # while each pane also scrolls inside it
    "outerscroll": (".msgs.docket-agent { overflow-y: auto !important; }"
                    ".docket-agent .mailer { flex: none !important;"
                    " height: 1400px !important; }"),
    # the empty state hugging the corner of an empty box
    "cramped": ".docket-agent > .pad { padding: 0 !important; }",
}

MEASURE = r"""
() => {
  const bad = []
  const px = (v) => parseFloat(v) || 0
  const panel = document.querySelector('.msgs.docket-agent')
  if (!panel) return ['no .docket-agent panel rendered — the probe is inert']
  const pb = panel.getBoundingClientRect()
  const rows = [...panel.querySelectorAll('.mailrow.docket-row')]
  if (rows.length < 4) bad.push(`only ${rows.length} rows rendered`)

  // 1. THE TWO PANES ARE SIDE BY SIDE AND BOTH REAL. A stacked or collapsed
  //    pane still renders every row a DOM test looks for.
  const list = panel.querySelector('.mailer-list')
  const read = panel.querySelector('.mailer-read')
  if (!list || !read) return bad.concat('the tab has no two-pane box at all')
  const lb = list.getBoundingClientRect(), rb = read.getBoundingClientRect()
  if (lb.width < 150) bad.push(`the list is ${lb.width.toFixed(0)}px wide`)
  if (rb.width < 150) bad.push(`the detail pane is ${rb.width.toFixed(0)}px wide`)
  if (rb.left < lb.right - 1) {
    bad.push('the two panes overlap or are stacked rather than side by side')
  }

  // 2. THE BOX FILLS THE TAB. If the flex chain breaks it shrinks to its
  //    content and the list becomes a stub with dead space under it.
  const mailer = panel.querySelector('.mailer')
  const mb = mailer.getBoundingClientRect()
  if (mb.height < pb.height * 0.9) {
    bad.push(`the two-pane box fills ${(mb.height / pb.height * 100).toFixed(0)}%`
      + ' of the tab height')
  }

  // 3. ONE SCROLLER PER PANE, NOT A THIRD AROUND THEM. The rows walk off the
  //    top of the panel when the whole box scrolls inside the tab.
  if (panel.scrollHeight > panel.clientHeight + 1) {
    bad.push(`the whole tab scrolls (${panel.scrollHeight} > ${panel.clientHeight})`
      + ' — the list already has its own scrollbar inside it')
  }
  if (getComputedStyle(list).overflowY !== 'auto') {
    bad.push('the list is not the thing that scrolls')
  }

  // 4. A REAL SLUG IS READABLE IN THIS WIDTH. Presence is not the property:
  //    a 60px column shows every row and none of their names.
  //
  //    ⚠ MEASURED AS A FRACTION OF THE NAME, NOT AS PIXELS. A pixel floor
  //    fails a genuinely SHORT slug that fits perfectly ("mail-ack" is 48px
  //    and entirely on screen), which is a false alarm, and passes a long one
  //    in a wide column that is still cut in half.
  let longest = 0
  for (const r of rows) {
    const name = r.querySelector('.l1 .mfrom')
    const label = name?.textContent ?? '?'
    if (!name) { bad.push('a row has no name element'); continue }
    longest = Math.max(longest, name.scrollWidth)
    const shown = name.scrollWidth ? name.clientWidth / name.scrollWidth : 1
    if (shown < 0.55) {
      bad.push(`${label}: only ${(shown * 100).toFixed(0)}% of the item name `
        + 'is on screen')
    }
    if (r.getBoundingClientRect().right > lb.right + 1) {
      bad.push(`${label}: the row overflows the list it is in`)
    }
    // the assignment column is the other half of the row and must not be
    // squeezed out by the name beside it
    const who = r.querySelector('.l2 .docket-actor-name')
    if (!who) { bad.push(`${label}: no assignment shown on the row`); continue }
    if (who.getBoundingClientRect().width < 40) {
      bad.push(`${label}: the assignment is squeezed to `
        + `${who.getBoundingClientRect().width.toFixed(0)}px`)
    }
  }

  // …and the fixture has to CONTAIN a name too long for this column, or the
  // check above is free
  if (longest < lb.width) {
    bad.push(`the longest slug in the fixture (${longest.toFixed(0)}px) fits `
      + `the list (${lb.width.toFixed(0)}px) — the readability check is inert`)
  }

  // 5. the open pane is the docket's own, and its content stays inside it
  const sub = read.querySelector('.docket-pane-sub')
  if (!sub) bad.push('the detail pane is not the docket pane')
  for (const el of read.querySelectorAll('.docket-list, .docket-desc, .docket-pane-sub')) {
    if (el.getBoundingClientRect().right > rb.right + 1) {
      bad.push(`${el.className}: the pane content spills out of the pane`)
    }
  }
  return bad
}
"""

# The empty tab is its own page: an agent with no assigned work reads a
# sentence, and that sentence is the entire panel for them.
MEASURE_EMPTY = r"""
() => {
  const bad = []
  const panel = document.querySelector('.msgs.docket-agent')
  if (!panel) return ['no panel on the empty page — this check is inert']
  if (panel.querySelector('.mailer')) {
    return ['the empty page still rendered the two-pane box — wrong fixture']
  }
  const note = panel.querySelector('.pad')
  if (!note) return ['the empty tab renders nothing at all']
  const nb = note.getBoundingClientRect(), pb = panel.getBoundingClientRect()
  if ((note.textContent ?? '').trim().length < 20) {
    bad.push('the empty tab says almost nothing')
  }
  // ⚠ THE INSET IS MEASURED TO THE TEXT, NOT TO THE BOX. The panel's own 6px
  // padding already moves the box, so a check that only asked "is the box off
  // the edge" passed with the sentence's own padding removed — it was reading
  // the panel's padding back to itself. The range is where the text is.
  const range = document.createRange()
  range.selectNodeContents(note)
  const tb = range.getBoundingClientRect()
  if (tb.left - pb.left < 10 || tb.top - pb.top < 10) {
    bad.push(`the empty sentence is jammed into the corner of the panel `
      + `(${(tb.left - pb.left).toFixed(0)}px in, ${(tb.top - pb.top).toFixed(0)}px down)`)
  }
  if (nb.width < pb.width * 0.7) {
    bad.push(`the empty sentence uses ${(nb.width / pb.width * 100).toFixed(0)}%`
      + ' of the panel width')
  }
  return bad
}
"""


def dump(dest: pathlib.Path, empty: bool = False) -> str:
    cmd = ["node", str(HERE / "deskdocket_dump.mjs"), str(dest)]
    if empty:
        cmd.append("empty")
    subprocess.run(cmd, check=True, capture_output=True)
    return dest.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", nargs="?", const="narrow",
                    choices=sorted(CONTROLS),
                    help="run a known-negative control; the probe must FAIL it "
                         "(except `noop`, which it must PASS)")
    ap.add_argument("--shot")
    args = ap.parse_args()
    css = CSS.read_text(encoding="utf-8")
    sheet = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
             f"{CONTROLS.get(args.expect_fail or '', '')}</style>\n")
    with tempfile.TemporaryDirectory() as tmp:
        full = sheet + dump(pathlib.Path(tmp) / "deskdocket.html")
        empty = sheet + dump(pathlib.Path(tmp) / "empty.html", empty=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 470, "height": 620},
                                device_scale_factor=2)
        page.set_content(full)
        page.wait_for_timeout(150)
        bad = page.evaluate(MEASURE)
        blank = browser.new_page(viewport={"width": 470, "height": 620},
                                 device_scale_factor=2)
        blank.set_content(empty)
        blank.wait_for_timeout(150)
        bad += blank.evaluate(MEASURE_EMPTY)
        # measured separately so a green run states NUMBERS, not "fine"
        facts = page.evaluate(
            "() => {"
            "  const p = document.querySelector('.msgs.docket-agent');"
            "  const l = p.querySelector('.mailer-list');"
            "  const r = p.querySelector('.mailer-read');"
            "  const m = p.querySelector('.mailer');"
            "  const nm = [...p.querySelectorAll('.l1 .mfrom')]"
            "    .map((e) => e.getBoundingClientRect().width);"
            "  return { rows: p.querySelectorAll('.mailrow.docket-row').length,"
            "    listW: Math.round(l.getBoundingClientRect().width),"
            "    readW: Math.round(r.getBoundingClientRect().width),"
            "    fill: Math.round(m.getBoundingClientRect().height"
            "      / p.getBoundingClientRect().height * 100),"
            "    overflow: p.scrollHeight - p.clientHeight,"
            "    minName: nm.length ? Math.round(Math.min(...nm)) : 0 } }")
        if args.shot:
            page.screenshot(path=args.shot, full_page=True)
            print(f"saved {args.shot}")
        browser.close()

    noop = args.expect_fail == "noop"
    if args.expect_fail and not noop:
        if bad:
            print(f"CONTROL {args.expect_fail} correctly FAILED:")
            for b in bad:
                print("  -", b)
            return 0
        print(f"⚠ CONTROL {args.expect_fail} PASSED — this probe cannot see "
              f"the defect it exists to catch.")
        return 1
    if bad:
        print("FAIL" + (" (noop control)" if noop else ""))
        for b in bad:
            print("  -", b)
        return 1
    print(f"OK{' (noop control survived)' if noop else ''} · "
          f"rows={facts['rows']} list={facts['listW']}px read={facts['readW']}px "
          f"fill={facts['fill']}% outer-overflow={facts['overflow']}px "
          f"narrowest-name={facts['minName']}px")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
