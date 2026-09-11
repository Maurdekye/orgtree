"""histident_probe.py — STEP 2: does the agent-history row keep the model chip
on the same line as the agent name it belongs to?

THE DEFECT (user screenshot 2026-09-11, uploads/image-73.png). In the desk's
history tab, a LEGACY row drew the provider letter on a line of its own ABOVE
the agent name — "S" sitting over "coordinator-astra". `AgentName` renders a
FRAGMENT by contract (a chip box and a name box, side by side, so call sites
keep their own layout), and `.tier` is `display: grid`, which is BLOCK-level:
inside an ordinary `<span>` the chip therefore takes a whole line and strands
the name under it. The projected EVENT rows never showed it, because
`.event-actor` already wraps their actor in an inline-flex.

This is a question the repo's jsdom suite cannot answer. jsdom has no box
model and no cascade, so "the chip is beside the name" is something it decides
by abstaining, and an abstention reads exactly like a pass. So measure in a
real engine — the system Edge, headless, via Playwright (the same
channel="msedge" recipe tools/ui_probe.py uses, so no browser download). It
opens a file:// URL and touches no backend, no port, no user data.

    node tests/histident_dump.mjs C:/tmp/hi.html
    python tests/histident_probe.py C:/tmp/hi.html [--css PATH] [--shot PNG]
                                    [--expect-fail] [--unwrap] [--nowrap-row]

WHAT IT CHECKS, at four viewport widths (1280, 700, 460, 340):
  1. oneline   — every identity's chip and name share a line: their boxes
                 overlap vertically and the chip's right edge is at or before
                 the name's left edge. Measured on EVERY identity on the page,
                 legacy rows and the projected event row alike, so "they are
                 together" cannot be true of one row and false of the next.
  2. inside    — the identity does not hang outside its row's content box.
                 This is the guard on the `white-space: nowrap` the fix uses:
                 an unbreakable identity that is wider than the row would
                 overflow rather than wrap, and that is a regression too.
  3. wrapped   — ⚠ THE ANTI-VACUITY CHECK, and the reason four widths exist.
                 At the two narrow widths the row's OTHER content must
                 actually wrap — the detail text has to start on a lower line
                 than the timestamp. Without this, "the identity did not wrap"
                 is free at any width where nothing wraps at all, and the
                 whole probe would be a measurement of a roomy page.
  4. control   — the row naming a sender this tree does not hold carries NO
                 chip. Every check above is about pairs of boxes; if the page
                 had no chips they would all pass by having nothing to look
                 at. This is the assertion that the page under the instrument
                 is one where the instrument can fail.
  5. ordering  — the chip comes BEFORE the name, not after it. `oneline`
                 alone is satisfied by an identity drawn backwards.

THE CONTROLS. Each must FAIL, and `--expect-fail` makes that the passing
outcome:

    python tests/histident_probe.py C:/tmp/hi.html --unwrap      --expect-fail
    python tests/histident_probe.py C:/tmp/hi.html --nowrap-row  --expect-fail
    python tests/histident_probe.py C:/tmp/hi.html --reverse     --expect-fail
    python tests/histident_probe.py C:/tmp/hi.html --wide-name   --expect-fail
    python tests/histident_probe.py C:/tmp/hi.html --css <pre-fix sheet> \
                                                   --expect-fail

Measured — the counts below are what each control actually produced against
this fixture, not what it ought to produce:
    --unwrap / pre-fix sheet  ->  12 oneline   (3 identities x 4 widths)
    --reverse                 ->  12 ordering  (the same 3 x 4)
    --wide-name               ->   9 inside    (3 x the 3 narrow widths; at
                                                1280 the row still has room)
    --nowrap-row              ->   3 wrapped + 1 inside. The second is honest
                                   rather than stray: a row that cannot wrap
                                   squeezes the long identity out of its own
                                   right edge, which is check 2 correctly
                                   noticing an overflow.

`--unwrap` neutralises the fix's own rule — it puts the legacy identity back
to `display: inline`, which is the exact state the user photographed.

`--reverse` draws the chip AFTER the name while leaving both on one line.
`--unwrap` does NOT reach check 5: a stacked identity trips check 1 first and
the ordering test never runs on it, so without this control that check would
never have been watched fail.

`--nowrap-row` stops the ROW wrapping. It fires check 3 alone, which is the
one check whose job is to prove the others were not answered by a page with
room to spare.

`--wide-name` pads the name past the width of its row. That is the regression
check 2 exists for: `white-space: nowrap` makes the identity unbreakable, so
one too wide for its row hangs out of it instead of wrapping. THE HEADROOM,
measured at the narrowest width here: the fixture's 41-character agent id
draws a 302.8px identity in a 334px row, so 27px of slack — roughly three
more characters. A name past about 44 characters WOULD overflow at 340px.
That is the price of the "one nonbreaking unit" this fix was asked for, and
the long-name row in the dump is what keeps the price visible.

⚠ NAME THE PRE-FIX COMMIT for `--css`, never `HEAD`. Once this work is
committed `HEAD` IS the new sheet, the control passes, and the probe then
reports that it proves nothing. The pre-fix sheet is the one at b200c4b.

WHAT NO CONTROL HERE COVERS, said plainly: check 4 (`control`) cannot have
one. It asserts the page still holds a row with a name and NO chip, and no
stylesheet can add a chip element to a row that has none, so the mutation
would have to be to the fixture rather than to the thing under test. It is
guarded one step upstream instead: `histident.dump.tsx` refuses to write a
page at all if its chipless row grows a chip.
"""
import argparse
import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_CSS = HERE.parent / "src" / "styles.css"
WIDTHS = (1280, 700, 460, 340)

MEASURE = """
() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top,
             bottom: r.bottom, left: r.left, right: r.right,
             mid: r.top + r.height / 2, display: s.display,
             white: s.whiteSpace }
  }
  // The identity is wherever a chip and a name sit together — read off the
  // ELEMENTS, not off a class this fix happens to introduce, so the same
  // measurement describes the legacy rows and the projected event row and
  // keeps working if either is restyled.
  const idents = [...document.querySelectorAll('.hist-row, .event-head')]
    .map((line) => {
      const chip = line.querySelector('.tier')
      const name = line.querySelector('.cc-name')
      // the row's own first and last pieces, for the wrap check: the
      // timestamp is always first and the detail text always last
      const kids = [...line.children]
      return {
        where: line.className.split(' ')[0],
        who: (name && name.textContent || '').trim(),
        line: box(line), chip: box(chip), name: box(name),
        holder: box(chip && chip.parentElement),
        first: box(kids[0]), last: box(kids[kids.length - 1]),
        pad: parseFloat(getComputedStyle(line).paddingLeft),
      }
    })
  return { idents, plain: [...document.querySelectorAll('.hist-row')]
    .filter((r) => (r.textContent || '').includes('nobody-here'))
    .map((r) => ({ chips: r.querySelectorAll('.tier').length,
                   names: r.querySelectorAll('.cc-name').length })) }
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--css", default=str(DEFAULT_CSS))
    ap.add_argument("--shot")
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--unwrap", action="store_true",
                    help="put the legacy identity back to display: inline — "
                         "the user's own screenshot, which must FAIL")
    ap.add_argument("--nowrap-row", action="store_true",
                    help="stop the history row wrapping: the control for the "
                         "anti-vacuity check, which must FAIL")
    ap.add_argument("--reverse", action="store_true",
                    help="draw the chip after the name: the control for the "
                         "ordering check, which must FAIL")
    ap.add_argument("--wide-name", action="store_true",
                    help="pad the name past its row's width: the control for "
                         "the overflow check, which must FAIL")
    a = ap.parse_args()

    css = pathlib.Path(a.css).resolve().read_text(encoding="utf-8")
    if a.unwrap:
        # THE DEFECT, PUT BACK. `.tier` is `display: grid` — block-level — so
        # an inline holder gives it a line of its own and the name drops
        # under it. Three classes beat `.hist-actor`'s one.
        css += """
.desk-body .msgs .hist-actor { display: inline; white-space: normal; }
"""
    if a.reverse:
        css += """
.desk-body .msgs .hist-actor { flex-direction: row-reverse; }
"""
    if a.wide_name:
        css += """
.desk-body .msgs .hist-actor .cc-name { padding-left: 600px; }
"""
    if a.nowrap_row:
        # ⚠ NOT A REGRESSION ANYONE EXPECTS — a control for the CHECK. With
        # the row unable to wrap, "the identity stayed on one line" is true
        # for a reason that has nothing to do with the identity, and check 3
        # is what notices.
        css += """
.desk-body .msgs .hist-row { flex-wrap: nowrap; }
"""
    body = pathlib.Path(a.html).resolve().read_text(encoding="utf-8")
    page = (f"<!doctype html><meta charset=utf-8><style>{css}</style>"
            f"<body class='dark'>{body}</body>")
    tmp = pathlib.Path(a.html).with_suffix(".page.html")
    tmp.write_text(page, encoding="utf-8")

    fails: list[str] = []
    seen = 0
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        ctx = b.new_context(viewport={"width": WIDTHS[0], "height": 900},
                            device_scale_factor=2)
        pg = ctx.new_page()
        pg.goto(tmp.as_uri(), wait_until="load")
        pg.wait_for_selector(".hist-row", state="attached", timeout=8000)

        for width in WIDTHS:
            pg.set_viewport_size({"width": width, "height": 900})
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            at = f"@{width}px"

            # 4. control — the page has a row with a name and NO chip, so the
            #    checks below are looking at something that could differ
            if len(m["plain"]) != 1 or m["plain"][0]["chips"] != 0:
                fails.append(f"control {at}: the chipless row is {m['plain']} "
                             "— every other check here compares a chip box "
                             "against a name box, and a page where every name "
                             "has a chip cannot tell them apart")
            with_ident = [i for i in m["idents"] if i["chip"] and i["name"]]
            if len(with_ident) < 3:
                fails.append(f"control {at}: only {len(with_ident)} identities "
                             "on the page — the dump is not the scene this "
                             "probe is about")
            seen = max(seen, len(with_ident))

            for i in with_ident:
                who, chip, name, line = i["who"], i["chip"], i["name"], i["line"]
                tag = f"{i['where']}/{who} {at}"
                # 1. oneline — the boxes overlap vertically. Overlap rather
                #    than equal midpoints: the chip is 16px and the name's
                #    line box is not, so their centres legitimately differ by
                #    a fraction of a pixel.
                if chip["bottom"] <= name["top"] + 0.5 or name["bottom"] <= chip["top"] + 0.5:
                    fails.append(
                        f"oneline {tag}: the chip and the name are on "
                        f"different lines (chip {chip['top']:.1f}.."
                        f"{chip['bottom']:.1f}, name {name['top']:.1f}.."
                        f"{name['bottom']:.1f})")
                # 5. ordering — chip first, then the name
                elif name["left"] < chip["right"] - 0.5:
                    fails.append(
                        f"ordering {tag}: the name starts at "
                        f"{name['left']:.1f} and the chip ends at "
                        f"{chip['right']:.1f} — they overlap or are reversed")
                # 2. inside — the identity stays within its row
                holder = i["holder"]
                if holder["right"] > line["right"] + 0.5:
                    fails.append(
                        f"inside {tag}: the identity ends at "
                        f"{holder['right']:.1f} and its row at "
                        f"{line['right']:.1f} — a nonbreaking identity that "
                        "is wider than the row overflows instead of wrapping")

            # 3. wrapped — at the narrow widths the row's other content must
            #    genuinely be wrapping, or nothing above was tested
            if width <= 700:
                rows = [i for i in m["idents"] if i["where"] == "hist-row"]
                moved = [i for i in rows
                         if i["last"] and i["first"]
                         and i["last"]["top"] > i["first"]["top"] + 1]
                if not moved:
                    fails.append(
                        f"wrapped {at}: no history row wrapped its own detail "
                        "text onto a second line, so 'the identity did not "
                        "wrap' is a statement about a roomy page and not "
                        "about the identity")

        if a.shot:
            pg.set_viewport_size({"width": 460, "height": 900})
            pg.wait_for_timeout(120)
            pg.screenshot(path=a.shot, full_page=True)
            print("wrote", a.shot)
        b.close()

    for f in fails:
        print("  FAIL", f)
    print(json.dumps({"widths": list(WIDTHS), "identities": seen,
                      "failures": len(fails)}, indent=2))
    ok = not fails
    if a.expect_fail:
        print("\n" + ("failed as required — this probe can see the regression"
                      if not ok else
                      "PASSED WITH THE CONTROL — this probe proves nothing; "
                      "the sheet or mutation you passed does not remove the "
                      "rule under test (did you use HEAD instead of the "
                      "pre-fix commit?)"))
        return 0 if not ok else 1
    print("\n" + ("OK — every identity measured in a real engine at "
                  f"{len(WIDTHS)} widths" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
