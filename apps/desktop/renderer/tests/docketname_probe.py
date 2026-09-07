"""docketname_probe.py — STEP 2: does an agent's NAME still read like the
surface it was put on?

Two surfaces gained the shared `<AgentName/>` — the docket's owner group
heading and a name written in ordinary prose — and both claims are about the
CASCADE, which the repo's jsdom suite cannot see: it has no box model and no
computed styles, so "the heading kept its own font" and "the mention did not
become a padded block" are questions it answers by abstaining. An abstention
reads exactly like a pass.

So this measures in a real engine — the system Edge, headless, via Playwright
(the same channel="msedge" recipe tools/ui_probe.py uses, so no browser
download). It opens a file:// URL and touches no backend, no port and no user
data.

    node tests/docketname_dump.mjs /tmp/docketname.html
    python tests/docketname_probe.py /tmp/docketname.html [--css PATH] [--shot PNG]
                                     [--expect-fail]

WHAT IT CHECKS
  1. headfont  — the group head's name wears the HEADING's font, size, spacing
                 and case, not `.cc-name`'s 12.5px mono. Measured against the
                 `Unassigned` head, which is a plain span in the same strip.
  2. headmono  — and the mono face IS in play on this page: the actor names in
                 the rows are mono, so check 1 is a real distinction rather
                 than a page where every font is the same.
  3. headchip  — the model chip fits inside the heading's own line box.
  4. prosebox  — a mention in prose is inline text: no padding, no radius, and
                 no taller than the line it sits in. (`.settings button` sets
                 `font-size: 14px; padding: 7px 15px; border-radius: 6px`, and
                 this panel IS a `.settings` modal — an unreset button punches
                 a 35px hole in the sentence. That has happened here before:
                 see the `.docket-ref` comment in styles.css.)
  5. prosesame — the agent mention and the item mention beside it are the same
                 size and sit on the same line, so one sentence does not carry
                 two kinds of typography.
  6. prosechip — the model chip a mention wears (Astra ruling 2026-09-05: the
                 CURRENT model of the desk the name goes to) sits INSIDE the
                 line it is written on. The panel's 16px row chip would set the
                 paragraph's line height instead; this is the check that says
                 which of those two happened.

THE CONTROL. `--css <sheet without these rules>` must FAIL, and
`--expect-fail` makes that the passing outcome:

    git show 9e328e8:frontend/src/styles.css > /tmp/pre.css
    python tests/docketname_probe.py /tmp/docketname.html --css /tmp/pre.css --expect-fail

⚠ NAME THE PRE-SERIES COMMIT, NOT `HEAD`. Once this work is committed `HEAD`
IS the new sheet, and the control then passes and says the probe proves
nothing — which is what it did to this author, once. 9e328e8 is the commit
these two surfaces were built on.

Pairing today's markup with the previous sheet is sound HERE precisely because
the markup change is what the old sheet mishandles: the old sheet still styles
`.cc-name` and `.docket-ref`, so it shows what those rules do to these elements
without the three-class resets — which is the whole claim. Measured, it fails
on seven counts.

⚠ THAT CONTROL DOES NOT EXERCISE CHECK 6: the old sheet's 16px chip still fits
inside an 18.8px line, so the chip check would pass either way and would be an
assertion nobody had ever seen fail. `--break-chip` is its own control — it
appends one rule that grows the chip past the line and must FAIL:

    python tests/docketname_probe.py /tmp/docketname.html --break-chip --expect-fail
"""
import argparse
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_CSS = HERE.parent / "src" / "styles.css"

MEASURE = """
() => {
  const one = (sel, root) => (root ?? document).querySelector(sel)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return {
      x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom,
      mid: r.top + r.height / 2,
      family: s.fontFamily, size: parseFloat(s.fontSize),
      weight: s.fontWeight, spacing: s.letterSpacing,
      transform: s.textTransform, display: s.display,
      padTop: parseFloat(s.paddingTop), padLeft: parseFloat(s.paddingLeft),
      padBottom: parseFloat(s.paddingBottom), padRight: parseFloat(s.paddingRight),
      radius: parseFloat(s.borderTopLeftRadius),
      lineHeight: s.lineHeight,
    }
  }
  const heads = [...document.querySelectorAll('.docket-group-head')]
  const agentHead = heads.find((h) => h.querySelector('.docket-group-agent'))
  const plainHead = heads.find((h) => !h.querySelector('.docket-group-agent'))
  const desc = one('.docket-desc-body')
  const proseAgent = desc && one('.docket-ref-agent', desc)
  const proseItem = desc && [...desc.querySelectorAll('.docket-ref')]
    .find((e) => !e.classList.contains('docket-ref-agent'))
  const proseText = desc && [...desc.querySelectorAll('span')]
    .find((e) => !e.classList.contains('docket-mention')
      && (e.textContent ?? '').trim().length > 5)
  const proseMention = desc && one('.docket-mention', desc)
  const proseChip = desc && one('.docket-mention .tier', desc)
  return {
    head: box(agentHead),
    headName: box(agentHead && one('.docket-group-name', agentHead)),
    headChip: box(agentHead && one('.tier', agentHead)),
    plainName: box(plainHead && one('span:not(.docket-group-n)', plainHead)),
    actorName: box(one('.docket-actor-name')),
    desc: box(desc),
    proseAgent: box(proseAgent),
    proseItem: box(proseItem),
    proseText: box(proseText),
    proseMention: box(proseMention),
    proseChip: box(proseChip),
  }
}
"""


def near(a, b, tol):
    return a is not None and b is not None and abs(a - b) <= tol


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--css", default=str(DEFAULT_CSS))
    ap.add_argument("--shot")
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--break-chip", action="store_true",
                    help="grow the in-prose chip past the line: check 6's own "
                         "control, which must FAIL")
    a = ap.parse_args()

    css = pathlib.Path(a.css).resolve().read_text(encoding="utf-8")
    if a.break_chip:
        css += """
.docket-modal .docket-mention .tier { width: 30px; height: 30px; font-size: 18px; }
"""
    body = pathlib.Path(a.html).resolve().read_text(encoding="utf-8")
    page = (f"<!doctype html><meta charset=utf-8><style>{css}</style>"
            f"<body class='dark'>{body}</body>")
    tmp = pathlib.Path(a.html).with_suffix(".page.html")
    tmp.write_text(page, encoding="utf-8")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        ctx = b.new_context(viewport={"width": 1280, "height": 900},
                            device_scale_factor=2)
        pg = ctx.new_page()
        pg.goto(tmp.as_uri(), wait_until="load")
        pg.wait_for_selector(".docket-group-head", state="attached", timeout=8000)
        m = pg.evaluate(MEASURE)
        if a.shot:
            el = pg.query_selector(".docket-modal")
            if el:
                el.screenshot(path=a.shot)
                print("wrote", a.shot)
        ctx.close()
        b.close()

    # ⚠ NOTHING TO MEASURE IS A FAILURE, NOT A PASS. Every check below reads
    # two boxes; a missing one would make every comparison vacuously true.
    missing = [k for k, v in m.items() if v is None]
    fails = []
    if missing:
        fails.append(f"missing: the probe never found {', '.join(missing)} — "
                     "nothing was measured")
        for k, v in m.items():
            print(f"  {k}: {'MISSING' if v is None else 'found'}")
        print("\nFAIL" if not a.expect_fail else "\nfailed as required")
        return 0 if a.expect_fail else 1

    hn, pn, an = m["headName"], m["plainName"], m["actorName"]
    print(f"  head name   : {hn['size']}px {hn['family'][:28]!r} "
          f"spacing={hn['spacing']} case={hn['transform']}")
    print(f"  plain head  : {pn['size']}px {pn['family'][:28]!r} "
          f"spacing={pn['spacing']} case={pn['transform']}")
    print(f"  row actor   : {an['size']}px {an['family'][:28]!r}")

    # 1. headfont — the heading's own typography, not `.cc-name`'s
    if hn["family"] != pn["family"]:
        fails.append("headfont: the group head's NAME is in a different face "
                     f"({hn['family'][:30]!r}) from the heading beside it "
                     f"({pn['family'][:30]!r})")
    for key, label in (("size", "size"), ("spacing", "letter-spacing"),
                       ("transform", "text-transform"), ("weight", "weight")):
        if hn[key] != pn[key]:
            fails.append(f"headfont: the group head's name has {label} "
                         f"{hn[key]!r}, the heading beside it {pn[key]!r}")

    # 2. headmono — the face this reset exists to override is really on this
    #    page, or check 1 is a distinction between two identical things
    if an["family"] == pn["family"]:
        fails.append("headmono: the row actor name is in the SAME face as a "
                     "plain heading, so nothing on this page distinguishes "
                     "the mono `.cc-name` — check 1 cannot fail")

    # 3. headchip — inside the heading's line
    hc, hd = m["headChip"], m["head"]
    print(f"  head chip   : {hc['w']:.1f}x{hc['h']:.1f} in a "
          f"{hd['h']:.1f}px head")
    if hc["h"] > hd["h"]:
        fails.append(f"headchip: the chip is {hc['h']:.1f}px tall in a "
                     f"{hd['h']:.1f}px heading — it sets the row's height")
    if hc["top"] < hd["top"] - 0.5 or hc["bottom"] > hd["bottom"] + 0.5:
        fails.append("headchip: the chip pokes out of the heading's box "
                     f"(chip {hc['top']:.1f}..{hc['bottom']:.1f}, head "
                     f"{hd['top']:.1f}..{hd['bottom']:.1f})")

    # 4. prosebox — inline text, not a control
    pa, pt = m["proseAgent"], m["proseText"]
    print(f"  prose agent : {pa['size']}px h={pa['h']:.1f} "
          f"pad={pa['padTop']}/{pa['padRight']}/{pa['padBottom']}/{pa['padLeft']} "
          f"radius={pa['radius']} display={pa['display']}")
    print(f"  prose text  : {pt['size']}px h={pt['h']:.1f}")
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if pa[side] > 0.01:
            fails.append(f"prosebox: the mention carries {side}={pa[side]}px — "
                         "the `.settings button` chrome was not reset")
    if pa["radius"] > 0.01:
        fails.append(f"prosebox: the mention has a {pa['radius']}px corner "
                     "radius — it is drawn as a button, mid-sentence")
    # ⚠ THE TOLERANCE IS MEASURED, NOT GUESSED. An inline mention is a little
    # taller than the run beside it (the underline sits below the descenders):
    # the ITEM mention, which shipped and was reviewed, measures 17.2px against
    # a 16.0px line. So the bar is "no taller than that", plus a 4px ceiling
    # over the line — the failure this guards against is the 35px padded block
    # `.settings button` produces, which is 19px over.
    if pa["h"] > pt["h"] + 4:
        fails.append(f"prosebox: the mention is {pa['h']:.1f}px tall in a "
                     f"{pt['h']:.1f}px line — it punches a hole in the prose")
    if pa["size"] >= pt["size"]:
        fails.append(f"prosebox: the mention is set at {pa['size']}px against "
                     f"{pt['size']}px prose — the mono face reads a size large")

    # 5. prosesame — the two kinds of mention match each other
    pi = m["proseItem"]
    print(f"  prose item  : {pi['size']}px h={pi['h']:.1f} mid={pi['mid']:.1f} "
          f"(agent mid={pa['mid']:.1f})")
    if not near(pa["size"], pi["size"], 0.01):
        fails.append(f"prosesame: an agent mention is {pa['size']}px and an "
                     f"item mention {pi['size']}px in the same sentence")
    if pa["h"] > pi["h"] + 0.5:
        fails.append(f"prosesame: the agent mention is {pa['h']:.1f}px tall "
                     f"where the item mention beside it is {pi['h']:.1f}px")
    if not near(pa["mid"], pi["mid"], 1.0):
        fails.append("prosesame: the two mentions do not sit on the same line "
                     f"(agent {pa['mid']:.1f}, item {pi['mid']:.1f})")

    # 6. prosechip — the chip is inside the line, not setting its height
    pc, pm = m["proseChip"], m["proseMention"]
    line = float(pt["lineHeight"].rstrip("px")) if pt["lineHeight"].endswith("px")         else pt["h"]
    print(f"  prose chip  : {pc['w']:.1f}x{pc['h']:.1f} in a {line:.1f}px line; "
          f"mention h={pm['h']:.1f} vs item {pi['h']:.1f}")
    if pc["h"] > line:
        fails.append(f"prosechip: the chip is {pc['h']:.1f}px tall in a "
                     f"{line:.1f}px line — it sets the paragraph's line height")
    # the whole mention, chip included, must still be a line of text. The item
    # mention beside it is the shipped, reviewed reference; 2px is the room the
    # chip's border takes, measured, not guessed.
    if pm["h"] > pi["h"] + 2:
        fails.append(f"prosechip: the mention with its chip is {pm['h']:.1f}px "
                     f"where the plain item mention is {pi['h']:.1f}px")
    if pc["mid"] < pt["mid"] - line / 2 or pc["mid"] > pt["mid"] + line / 2:
        fails.append("prosechip: the chip's centre is outside the line band of "
                     f"the prose (chip {pc['mid']:.1f}, text {pt['mid']:.1f} "
                     f"± {line / 2:.1f})")
    if pc["x"] >= m["proseAgent"]["x"]:
        fails.append("prosechip: the chip is not before the name it belongs to")

    for f in fails:
        print("  FAIL", f)
    ok = not fails
    if a.expect_fail:
        print("\nCONTROL: " + ("failed as required — the probe can fail"
                               if not ok else
                               "PASSED, which means this probe proves nothing"))
        return 0 if not ok else 1
    print("\n" + ("all checks pass" if ok else f"{len(fails)} FAILURE(S)"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
