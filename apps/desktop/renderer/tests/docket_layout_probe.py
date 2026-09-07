"""Real-browser geometry for the docket list after the name change (w31b77251).

WHY THIS EXISTS AND THE COMPONENT TESTS DO NOT COVER IT. The user's objection
was a LAYOUT one, twice, from screenshots: the item name was a padded bordered
button, it ate the row's second line, and the agent name beside it truncated to
"c…". Every DOM test passed throughout — the name WAS present, the updater WAS
present. Presence is not the property that was wrong.

So this plants the REAL <DocketModal/> markup (via docket_dump.mjs) against the
REAL styles.css, in a real browser, at the width the panel actually gets, and
measures:

  * the item name is TEXT, not a control — no button anywhere in a row's name
    line, and none beside the detail name except the agent jump
  * no row's content overflows its own box horizontally
  * the last-updater name is not squeezed to a stub: it gets a real share of
    the row, and the ellipsis (if any) leaves several characters
  * a mention inside the description renders inline — same line box as the
    words around it, not a block that breaks the sentence

    python -B tests/docket_layout_probe.py
    python -B tests/docket_layout_probe.py --expect-fail chip   # planted mutant
    python -B tests/docket_layout_probe.py --shot out.png       # look at it
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

# the bullets ARE the finding for one of the controls below, so the report has
# to be able to print them — a cp1252 console otherwise dies with
# UnicodeEncodeError and the control looks like a crash instead of a catch
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS = HERE.parent / "src" / "styles.css"

# The panel is a modal over the canvas; the frame gives it the width it really
# gets and nothing else. NARROW ON PURPOSE — the user's screenshot was a narrow
# list, and a wide viewport hides exactly the crowding being tested.
FRAME = """
html, body { margin: 0; background: var(--bg); }
body > .overlay { position: static; }
.settings.wide.docket-modal { width: 760px; max-width: 760px; }
.mailpane { height: 460px; }
"""

# Known negatives. Each is a way the rejected design comes back, or a way the
# row silently degrades; the probe must FAIL every one of them.
CONTROLS = {
    # ⚠ A CONTROL MUST BE ABLE TO FIRE. The first version of the "chip" control
    # put a border back on the name and the probe still passed, because the
    # check it was aimed at looked for the removed element's CLASS — and no
    # stylesheet can add a class. The checks below are GEOMETRIC for exactly
    # that reason: they measure the box, so a stylesheet can break them.
    #
    # the exact thing the user removed: a padded, bordered name
    "chip": """
.docket-rowname, .docket-slug-text {
  border: 1px solid var(--line-soft); background: var(--input);
  border-radius: 3px; padding: 0 5px; max-width: 190px; }
""",
    # the consequence they actually saw — the updater squeezed to a stub
    "squeeze": """
.docket-row .l2 .docket-status { min-width: 190px; }
""",
    # a mention that breaks the sentence it sits in
    "blockref": """.docket-modal .docket-ref { display: block; padding: 7px 15px; }""",
    # the run-together sub-line: "In progressclickable-docket-references-…"
    "runtogether": """.docket-pane-sub .docket-slug-text { margin: 0; }""",
    # w2d5fab0a element 3: a dot that says the same thing for every status is
    # decoration, not an indicator — and it would still LOOK right
    "onedot": """.docket-row .l1 .docket-dot { background: var(--work) !important; }""",
    "nodot": """.docket-row .l1 .docket-dot { display: none; }""",
    # w2d5fab0a element 4: two lists, one bullet — the exact wall of identical
    # dots the element exists to break up
    "samebullet": """.docket-list-items.mark-next li::before { content: '✓'; }""",
    # the alignment the dot broke: three children under space-between
    "centred": """.docket-row .l1 { justify-content: space-between; }
.docket-row .l1 .mtime { margin-left: 0; }""",
    # w2d5fab0a element 1: nesting that does not read as nesting
    "flat": """.docket-row.docket-child {
  margin-left: 0 !important; padding-left: 10px !important; }""",
    # Astra 2026-09-05: every edge parked in one column at the far left,
    # instead of travelling with the item it describes
    "sharededge": """.docket-row.docket-child {
  margin-left: 0 !important;
  padding-left: calc(10px + var(--docket-depth, 1) * 16px) !important; }""",
    # w2d5fab0a element 2: the skeleton lines gone
    "noline": """.docket-row.docket-child::before, .docket-row.docket-child::after {
  display: none !important; }""",
    # the attention reason run together into one paragraph — the shape the
    # plain <div> had before the pre-wrap rule, and the reason the specifics
    # the user is being asked to confirm were unreadable (user 2026-09-05)
    "nowrap": """.docket-attention-body { white-space: normal !important; }""",
}

# what a name may cost in chrome before it is a control again, and how much of
# an agent's name must still be readable. The floor is not a wish: the worst
# row measured here is the ATTENTION row, whose Dismiss button shares the line,
# and it shows 45px / 50% of "codex-checklist". The bar sits just under that on
# purpose, so this fails the moment that row gets worse — and the `squeeze`
# control drives it to a fraction of it.
UPDATER_MIN_PX = 40
UPDATER_MIN_SHOWN = 0.45
SUB_GAP_MIN_PX = 3

MEASURE = r"""
() => {
  const bad = []
  const px = (v) => parseFloat(v) || 0
  const rows = [...document.querySelectorAll('.mailrow.docket-row')]
  if (rows.length < 4) bad.push(`only ${rows.length} rows rendered`)

  for (const r of rows) {
    const name = r.querySelector('.l1 .mfrom')
    const label = (name?.textContent ?? '?')
    if (!name) { bad.push('a row has no name element'); continue }

    // 1. THE NAME IS TEXT, MEASURED AS SUCH — not a bordered, padded box, and
    //    not a button. Checking the class alone would pass on a restyled span.
    if (name.tagName === 'BUTTON') bad.push(`${label}: the row name is a button`)
    // the FOLD ARROW is a control here on purpose (the approved design: the
    // arrow expands, the row selects). Anything else in the name line is the
    // chip coming back.
    if (r.querySelector('.l1 button:not(.docket-fold)')) {
      bad.push(`${label}: a control other than the fold arrow is in the name line`)
    }
    const ncs = getComputedStyle(name)
    if (px(ncs.borderTopWidth) || px(ncs.borderLeftWidth)) {
      bad.push(`${label}: the row name is boxed again (border)`)
    }
    if (px(ncs.paddingLeft) > 1 || px(ncs.paddingTop) > 1) {
      bad.push(`${label}: the row name is padded like a chip`)
    }

    // 1b. THE NAME FOLLOWS ITS DOT IMMEDIATELY. `.mailrow .l1` is
    //     `space-between`, so the moment the row grew a third child the name
    //     floated to the middle of the row. It passed every DOM test — the
    //     name was present, the time was present — and looked obviously wrong.
    //
    //     ⚠ MEASURED AGAINST THE DOT, not against the row's content edge.
    //     Rows now start with different things: a parent has a fold arrow, a
    //     leaf does not, and a child is indented. The gap between the dot and
    //     the name is the one distance that means the same on every row.
    const nb = name.getBoundingClientRect()
    const dotEl = r.querySelector('.l1 .docket-dot')
    const after = dotEl ? dotEl.getBoundingClientRect().right
      : r.getBoundingClientRect().left + px(getComputedStyle(r).paddingLeft)
    if (nb.left - after > 14) {
      bad.push(`${label}: the row name sits ${(nb.left - after).toFixed(0)}px `
        + 'after its status dot — it is not left-aligned')
    }

    // 2. nothing overflows the row horizontally
    const rb = r.getBoundingClientRect()
    for (const child of r.querySelectorAll('.l1 > *, .l2 > *')) {
      const cb = child.getBoundingClientRect()
      // a hidden element has a zero rect at the origin, which would read as a
      // spill and mask whatever actually went wrong with it
      if (cb.width === 0 && cb.height === 0) continue
      if (cb.right > rb.right + 0.5 || cb.left < rb.left - 0.5) {
        bad.push(`${label}: ${child.className || child.tagName} spills outside the row`)
      }
    }

    // 3. the updater is not squeezed to a stub. It is allowed to ellipsise — a
    //    long agent name should — but "c…" is the defect that started this.
    const up = r.querySelector('.l2 .docket-actor-name')
    if (up) {
      const w = up.getBoundingClientRect().width
      const shown = up.scrollWidth > 0 ? w / up.scrollWidth : 1
      if (w < __UP_PX__) {
        bad.push(`${label}: updater "${up.textContent}" is only ${w.toFixed(0)}px wide`)
      }
      if (shown < __UP_SHOWN__) {
        bad.push(`${label}: updater "${up.textContent}" shows only `
          + `${(shown * 100).toFixed(0)}% of its name`)
      }
    }
  }

  // 4. the detail name is text too, and does not run into the status word
  const sub = document.querySelector('.docket-pane-sub')
  const slug = sub?.querySelector('.docket-slug-text')
  const status = sub?.querySelector('.docket-status')
  if (!slug || !status) {
    bad.push('the detail sub-line lost its status or its name — probe inert')
  } else {
    if (slug.tagName === 'BUTTON') bad.push('the detail name is a button again')
    const scs = getComputedStyle(slug)
    if (px(scs.borderTopWidth) || px(scs.paddingLeft) > 1) {
      bad.push('the detail name is a boxed chip again')
    }
    const gap = slug.getBoundingClientRect().left - status.getBoundingClientRect().right
    if (gap < __SUB_GAP__) {
      bad.push(`the status word and the name run together (${gap.toFixed(1)}px apart)`)
    }
  }

  // 5. a mention is inline prose, not a block that breaks the sentence
  const body = document.querySelector('.docket-desc-body')
  const ref = body?.querySelector('.docket-ref')
  if (!ref) {
    bad.push('no mention rendered in the description — the probe is inert')
  } else {
    const rb = ref.getBoundingClientRect()
    const rcs = getComputedStyle(ref)
    if (rcs.display !== 'inline') bad.push(`the mention is display:${rcs.display}`)
    if (px(rcs.paddingLeft) > 1) bad.push('the mention carries button padding')
    const line = px(getComputedStyle(body).lineHeight) || 20
    if (rb.height > line * 1.6) {
      bad.push(`the mention is ${rb.height.toFixed(0)}px tall on an `
        + `${line.toFixed(0)}px line`)
    }
    // and the two decoys in the same sentence must NOT have become links
    const linked = [...body.querySelectorAll('.docket-ref')].map((e) => e.textContent)
    if (linked.length !== 1) {
      bad.push(`${linked.length} mentions linked in a sentence with one real `
        + `one: ${linked.join(', ')}`)
    }
  }
  // 6. w2d5fab0a element 3 — the status dot. Checking that a dot EXISTS is
  //    nearly free and nearly worthless; what makes it an indicator is that it
  //    agrees with the coloured left edge on the same row. A dot painted one
  //    colour for every status passes "a dot is present" and means nothing.
  const seen = new Set()
  for (const r of rows) {
    const label = r.querySelector('.l1 .mfrom')?.textContent ?? '?'
    const dot = r.querySelector('.l1 .docket-dot')
    if (!dot) { bad.push(`${label}: no status dot`); continue }
    const db = dot.getBoundingClientRect()
    // HIDDEN COUNTS AS ABSENT. `querySelector` finds a display:none dot
    // perfectly well, so "the element exists" is not the question.
    if (db.width < 4 || db.height < 4) {
      bad.push(`${label}: the status dot is `
        + `${db.width.toFixed(1)}x${db.height.toFixed(1)} — hidden or collapsed`)
      continue
    }
    const dcs = getComputedStyle(dot)
    const edge = getComputedStyle(r).borderLeftColor
    if (dcs.backgroundColor !== edge) {
      bad.push(`${label}: the dot (${dcs.backgroundColor}) and the row edge `
        + `(${edge}) disagree about the status`)
    }
    seen.add(dcs.backgroundColor)
  }
  // …and across a fixture holding five different statuses they cannot all be
  // the same colour. This is what catches a dot that is merely decorative.
  if (rows.length >= 4 && seen.size < 3) {
    bad.push(`every status dot is one of only ${seen.size} colours across `
      + `${rows.length} rows of differing status`)
  }

  // 6b. w2d5fab0a elements 1 and 2 — the nesting has to LOOK nested, and the
  //     skeleton line has to be drawn. Both are pure CSS claims; no DOM test
  //     can see either, which is the whole reason this file exists.
  const child = document.querySelector('.docket-row.docket-child')
  if (!child) {
    bad.push('no nested row in the fixture — the nesting checks are inert')
  } else {
    const parent = document.querySelector('.docket-row.docket-parent')
    if (!parent) bad.push('a child row with no parent row above it')
    const cb = child.getBoundingClientRect()
    const nameL = child.querySelector('.l1 .mfrom')?.getBoundingClientRect().left ?? 0
    // ⚠ MEASURED FROM WHERE THE ROW ACTUALLY STARTS, not from one property.
    // Two earlier versions of this check measured the wrong thing: the NAME's
    // position (which tracks the fold arrow, and reported a child as eight
    // pixels LEFT of its parent while the indent worked), and then
    // `paddingLeft` (which went constant the moment the indent moved to a
    // margin so the edge could indent with the row). The row's own left is
    // the property being claimed, and it does not care how it was produced.
    const indent = cb.left - (parent ? parent.getBoundingClientRect().left : cb.left)
    if (indent < 12) {
      bad.push(`a sub-item is indented only ${indent.toFixed(0)}px from its `
        + 'parent — it does not read as nested')
    }
    // the connecting line is drawn, is inside the row, and is to the LEFT of
    // the name it connects
    for (const which of ['::before', '::after']) {
      const cs = getComputedStyle(child, which)
      if (cs.content === 'none' || cs.display === 'none') {
        bad.push(`the skeleton line ${which} is not drawn`)
        continue
      }
      const w = px(cs.width), h = px(cs.height)
      if (w < 0.5 || h < 0.5) bad.push(`the skeleton line ${which} is ${w}x${h}`)
      if (px(cs.left) > nameL - cb.left) {
        bad.push(`the skeleton line ${which} is right of the name it connects`)
      }
    }
    // the fold control exists on the parent and is a real hit target
    const fold = parent?.querySelector('.docket-fold')
    if (!fold) bad.push('a parent row has no fold control')
    else {
      const fb = fold.getBoundingClientRect()
      if (fb.width < 8 || fb.height < 8) {
        bad.push(`the fold control is ${fb.width.toFixed(0)}x${fb.height.toFixed(0)}`)
      }
    }
  }

  // 7. w2d5fab0a element 4 — the two progress lists must not wear the same
  //    bullet, and each must actually draw one
  const done = document.querySelector('.docket-list-items.mark-done li')
  const next = document.querySelector('.docket-list-items.mark-next li')
  if (!done || !next) {
    bad.push('one of the progress lists is missing — probe inert')
  } else {
    const dm = getComputedStyle(done, '::before')
    const nm = getComputedStyle(next, '::before')
    const empty = (c) => !c || c === 'none' || c === '""' || c === "''"
    if (empty(dm.content)) bad.push('the completed list draws no bullet')
    if (empty(nm.content)) bad.push('the next list draws no bullet')
    if (dm.content === nm.content) {
      bad.push(`both progress lists use the same bullet ${dm.content}`)
    }
    if (dm.color === nm.color) {
      bad.push('both progress bullets are the same colour')
    }
  }

  return bad
}
"""

# THE SECOND PANE. The attention reason lives on a different item from the
# mentions, and one pane is open at a time — so it gets its own page. The claim
# is a pure CSS one (`white-space: pre-wrap`), which no DOM test can see: jsdom
# applies no stylesheet, so docket.test.tsx §34 can only pin the text and the
# element. What the user actually asked for is that the lines they must read are
# SEPARATE ON SCREEN, and that is a measurement.
MEASURE_ATTENTION = r"""
() => {
  const bad = []
  const box = document.querySelector('.mailer-read .docket-attention-box')
  if (!box) return ['no attention box on the second page — this check is inert']
  const body = box.querySelector('.docket-attention-body')
  if (!body) {
    return ['the reason has no body element of its own — the pre-wrap rule has '
      + 'nothing to hang on, and the lines run together']
  }
  const written = ((body.textContent ?? '').match(/\n/g) ?? []).length + 1
  if (written < 4) {
    return [`the fixture reason is only ${written} line(s) — this check is inert`]
  }
  // count the LINE BOXES the text actually occupies. Without pre-wrap the
  // newlines become spaces and these four short lines reflow into two or three.
  const r = document.createRange()
  r.selectNodeContents(body)
  const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)))
  if (tops.size < written) {
    bad.push(`the attention reason renders on ${tops.size} line(s) where the `
      + `agent wrote ${written} — the specifics run together`)
  }
  const bb = body.getBoundingClientRect(), xb = box.getBoundingClientRect()
  if (bb.right > xb.right + 1 || bb.bottom > xb.bottom + 1) {
    bad.push('the reason spills out of its own box')
  }
  return bad
}
"""


def dump(select: str | None = None) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "docket.html"
        cmd = ["node", str(HERE / "docket_dump.mjs"), str(out)]
        if select:
            cmd.append(select)
        subprocess.run(cmd, check=True, capture_output=True)
        return out.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", nargs="?", const="chip",
                    choices=sorted(CONTROLS),
                    help="run a known-negative control; the probe must FAIL it")
    ap.add_argument("--shot")
    args = ap.parse_args()
    css = CSS.read_text(encoding="utf-8")
    sheet = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
             f"{CONTROLS.get(args.expect_fail or '', '')}</style>\n")
    html = sheet + dump()
    # the second pane, opened on the item that carries a manual flag
    html_attn = sheet + dump("explain-unavailable-actions")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 820, "height": 720},
                                device_scale_factor=2)
        page.set_content(html)
        page.wait_for_timeout(150)
        bad = page.evaluate(MEASURE
                            .replace('__UP_PX__', str(UPDATER_MIN_PX))
                            .replace('__UP_SHOWN__', str(UPDATER_MIN_SHOWN))
                            .replace('__SUB_GAP__', str(SUB_GAP_MIN_PX)))
        attn = browser.new_page(viewport={"width": 820, "height": 720},
                                device_scale_factor=2)
        attn.set_content(html_attn)
        attn.wait_for_timeout(150)
        bad += attn.evaluate(MEASURE_ATTENTION)
        attn_lines = attn.evaluate(
            "() => {"
            "  const b = document.querySelector('.docket-attention-body');"
            "  if (!b) return 0;"
            "  const r = document.createRange(); r.selectNodeContents(b);"
            "  return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size }")
        # measured separately so a green run states NUMBERS, not "fine"
        facts = page.evaluate(
            "() => {"
            "  const up = [...document.querySelectorAll('.l2 .docket-actor-name')];"
            "  const w = up.map((e) => e.getBoundingClientRect().width);"
            "  const list = document.querySelector('.mailer-list');"
            "  return { rows: document.querySelectorAll('.mailrow.docket-row').length,"
            "    refs: document.querySelectorAll('.docket-ref').length,"
            "    listW: list ? list.getBoundingClientRect().width : 0,"
            "    dots: new Set([...document.querySelectorAll('.l1 .docket-dot')].map((e) => getComputedStyle(e).backgroundColor)).size,"
            "    minUpdater: w.length ? Math.min(...w) : 0 } }")
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
    print(f"OK — {facts['rows']} rows in a {facts['listW']:.0f}px list; every item "
          f"name is plain text with no chip and no control; nothing spills out of "
          f"its row; the narrowest last-updater name is {facts['minUpdater']:.0f}px "
          f"and readable; {facts['refs']} mentions render inline in the detail pane; "
          f"status dots agree with their row edges in {facts['dots']} distinct "
          f"colours; the two progress lists draw different bullets; on the "
          f"second pane the four-line attention reason renders on "
          f"{attn_lines} separate lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
