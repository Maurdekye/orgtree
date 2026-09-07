"""mailsender_probe.py — STEP 2: is the sender's model card actually WEARABLE
where it was just put, and is the name actually CLICKABLE there?

Two surfaces gained the shared identity — the mail LIST ROW and the desk
transcript's mail card — and the interesting claims about both are claims the
repo's jsdom suite cannot make. jsdom has no box model, no cascade and no hit
testing, so "the row did not grow", "the `.settings button` chrome was reset"
and "the name is the thing under the cursor" are questions it answers by
abstaining, and an abstention reads exactly like a pass.

So this measures in a real engine — the system Edge, headless, via Playwright
(the same channel="msedge" recipe tools/ui_probe.py uses, so no browser
download). It opens a file:// URL and touches no backend, no port, no user
data.

    node tests/mailsender_dump.mjs /tmp/ms.html
    python tests/mailsender_probe.py /tmp/ms.html [--css PATH] [--shot PNG]
                                     [--expect-fail] [--break-chip]

WHAT IT CHECKS
  1. rowheight  — a row with a model chip is no taller than a row without one.
                  The dump carries both (an agent sender and an @system
                  notice), so this is a COMPARISON inside one page, not an
                  assertion about a number somebody chose.
  2. rowchrome  — the name button inside the row carries no button chrome.
                  `.settings button` sets `font-size: 14px; padding: 7px 15px;
                  border-radius: 6px`, and the user's inbox IS a `.settings`
                  modal, so an unreset button turns an 11px row into a 35px
                  one. That has happened in this repo before (see the
                  `.docket-ref` comment in styles.css).
  3. rowtype    — the name is set in the ROW's type, not `.cc-name`'s 12.5px,
                  measured against the plain `@system` name on the same page.
  4. rowchip    — the chip fits inside the row's first line.
  5. rowhit     — THE CLICK ACTUALLY LANDS ON THE NAME.
                  `document.elementFromPoint` at the name's own centre must
                  return the button or something inside it. A control point on
                  the row's preview line must return something that is NOT the
                  button, so the check distinguishes "the name is hittable"
                  from "everything hits the name".
  6. cardhead   — the card's chip and name sit inside the header's line box and
                  the chip comes before the name.
  7. carddot    — ⚠ NO STRAY SEPARATOR. `.turn-mail-head span:not(:last-child)
                  ::after` puts a '·' after ANY span, and BOTH halves of an
                  identity are spans — so left alone it punctuates between the
                  model card and the name it belongs to ("O · astra your
                  superior · …"). Read off the real ::after content.
  8. cardtype   — the name kept the header's own type: same size as the `<b>`
                  metadata the header already had… which is the one thing here
                  with no `<b>` left to compare against, so it is compared to
                  the header's declared 11.5px and to the plain metadata spans
                  beside it (10.5px), and must match neither the 12.5px
                  `.cc-name` default nor the 14px `.settings button`.
  9. liveheight — the MID-TURN steered row is no taller with an identity than
                  without. The dump carries two live rows with the same body
                  and the same length; only the chip differs.
                  ⚠ THE UNRESOLVED SENDER HAD TO BE GIVEN THE SAME TYPE for
                  this to mean anything. Left at the body's 14px sans, the
                  row WITHOUT a chip measured TALLER (54.6 vs 53.1) and the
                  comparison passed for a reason that was not the chip — a
                  vacuous pass, found by running this and reading the numbers.
                  `.live-mail-head b` now matches `.live-mail-head .cc-name`.
 10. livechip    — that chip fits inside the attribution line and comes first.
 11. livetype    — the live sender is the sheet's declared 13px mono, not
                  `.cc-name`'s 12.5px flexible column header and not a 14px
                  button, and carries no button chrome. This is the check the
                  PRE-SERIES sheet fires for the live row.

THE THIRD SURFACE — THE NODE'S OWN MAILBOX (added 2026-09-05, when the desk's
inbox tab was finally given the desk's `onJump`). It is not a repeat of checks
1-5: those rows live under `.overlay > .settings`, these live in a
`.desk-body`, and a reset proven for one cascade is not proven for the other.
The dump reaches this markup by CLICKING the tab, because `view` is DeskChat's
own state and there is no prop for it.

 12. boxroute   — the sender is a <button> and a sender the tree does NOT hold
                  is a <span>. Read off the TAG, in the engine.
 13. boxchrome/ — no button chrome survived into the desk row, and the name
     boxtype/     keeps its line's type; the chip did not grow the row and
     boxheight/   sits inside the row's first line.
     boxchip
 14. boxhit     — the pointer at the centre of the name finds the name, and
                  the preview line does not.

⚠ THE HIT TEST RUNS IN A SECOND PASS. The user's inbox is a `position: fixed`
overlay, and this page carries both mailboxes at once, so the modal is painted
over the desk under it — the first run of check 14 reported the desk's sender
as unreachable and named the MODAL's list as the thing on top. That is an
artifact of stacking two screens that are never on screen together. The overlay
is removed and the hit measured again, last, after everything else; both passes
report which row they picked and the probe fails if they picked different ones.

THE CONTROL. `--css <a sheet without these rules>` must FAIL, and
`--expect-fail` makes that the passing outcome:

    git show 1ac1dc7:frontend/src/styles.css > /tmp/pre.css
    python tests/mailsender_probe.py /tmp/ms.html --css /tmp/pre.css --expect-fail

⚠ NAME THE PRE-SERIES COMMIT, NOT `HEAD`. Once this work is committed `HEAD`
IS the new sheet, the control passes, and the probe then reports that it proves
nothing — which is what it did to this author's predecessor once. 1ac1dc7 is
the commit these two surfaces were built on.

Pairing today's markup with the previous sheet is sound HERE precisely because
the markup change is what the old sheet mishandles: the old sheet still styles
`.cc-name`, `.sender .tier` and `.turn-mail-head span::after`, so it shows what
those rules do to these elements without the new resets — which is the whole
claim.

⚠ AND TWO MORE CONTROLS, because the sheet control above does NOT exercise
every check and a check nobody has watched fail is not a check.

`--break-chip` grows every chip. It fires checks 1 and 9 (the row and the live
row grow with the chip) — and, measured, NOTHING ELSE: a grown chip grows the
line with it, so "the chip is inside its line" stays true the whole time.

`--poke-chip` therefore exists as well: relative positioning moves the chip's
box out of its line WITHOUT changing layout, which is the only way to make the
"pokes out" halves of checks 4, 6 and 10 fire. Both must FAIL:

    python tests/mailsender_probe.py /tmp/ms.html --break-chip --expect-fail
    python tests/mailsender_probe.py /tmp/ms.html --poke-chip --expect-fail

TWO MORE, added with the third surface — and the first of them closes a gap
this file used to declare rather than fix ("check 5 has no control sheet that
breaks it"):

    python tests/mailsender_probe.py /tmp/ms.html --cover-rows  --expect-fail
    python tests/mailsender_probe.py /tmp/ms.html --chrome-desk --expect-fail

`--cover-rows` lays a row-sized pseudo-element over every row: it fires BOTH
hit tests (5 and 14) and nothing else. `--chrome-desk` gives the desk's mailbox
the button chrome the user's inbox gets from `.settings button`, which is the
only thing that fires check 13 — the pre-series sheet does not, because nothing
in this repo has ever styled a button in the `.desk-body` cascade.

WHAT NONE OF THESE COVER, said plainly. Check 12 (boxroute) has no control
here: with the wiring deleted the DUMP refuses to write a page at all (its
list-scoped fixture assertion), so the failure lands one step upstream — run
`git stash`-free: delete `onFocusAgent={onJump}` in desk.tsx and rebuild the
dump; observed 2026-09-05, "the desk mailbox's LIST section carries no
chip/jump". Its second half (an unvouched-for name must NOT be a button) is
covered by the jsdom mutant "the desk inbox always claims a route", not here.
Measured checks fired by each control, so nothing is claimed twice:
  pre-series sheet → 1,2,3,7,8,9,10,11 and boxtype/boxheight
  --break-chip     → 1, 9, boxheight        --poke-chip → 4, 6, 10, boxchip
  --cover-rows     → 5, 14                  --chrome-desk → 13
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
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return {
      x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom,
      left: r.left, right: r.right, mid: r.top + r.height / 2,
      cx: r.left + r.width / 2,
      family: s.fontFamily, size: parseFloat(s.fontSize),
      weight: s.fontWeight, display: s.display,
      padTop: parseFloat(s.paddingTop), padLeft: parseFloat(s.paddingLeft),
      padBottom: parseFloat(s.paddingBottom), padRight: parseFloat(s.paddingRight),
      radius: parseFloat(s.borderTopLeftRadius),
      lineHeight: s.lineHeight,
    }
  }
  // ⚠ SCOPED AWAY FROM `.deskbox`. The page now carries TWO mailboxes — the
  // user's (in a `.settings` overlay) and the node's own (in a `.desk-body`)
  // — and both draw `.mailrow`. An unscoped query here would quietly start
  // answering about whichever came first in the document.
  const rows = [...document.querySelectorAll('.mailrow')]
    .filter((r) => !r.closest('.deskbox'))
  // the row whose sender is an agent (it has a chip) and the row whose sender
  // is a sentinel (it has none) — the pair the height comparison rests on
  const chipRow = rows.find((r) => r.querySelector('.mfrom .tier'))
  // ⚠ THE CONTROL ROW IS A ROW NAMING A SENDER THIS TREE DOES NOT HOLD —
  // same two lines, same type, differing in exactly the thing under test. NOT
  // the system notice, which is deliberately one line shorter and a size
  // smaller. Selected BY NAME because that is the only thing that stays true
  // of it: `SenderChip` now draws such a name as a bare `<b>` with no chip,
  // no route and no `.cc-name` at all (an unknown name is not one of ours),
  // so a structural selector for it would be a selector for the @system row.
  const plainRow = rows.find((r) => {
    const f = r.querySelector('.mfrom')
    return f && f.textContent.trim() === 'nobody-here'
  })
  const rowName = chipRow && chipRow.querySelector('.mfrom .cc-name')
  const rowChip = chipRow && chipRow.querySelector('.mfrom .tier')
  const rowL1 = chipRow && chipRow.querySelector('.l1')
  const rowL2 = chipRow && chipRow.querySelector('.l2')
  const plainName = plainRow && plainRow.querySelector('.mfrom > *')
  // ⚠ THE TWO IDENTITY SHAPES DIFFER, and a check that assumed one of them
  // reported a false failure the first time this ran. `AgentName` puts the
  // chip BESIDE the name; `SenderChip` (the user's inbox) nests both inside
  // the button, so the name element's own box STARTS at the chip. What is
  // true either way is that the chip comes before the TEXT — so measure the
  // innermost thing carrying the name.
  const rowText = chipRow
    && (chipRow.querySelector('.mfrom .sender b') || rowName)
  // …and the row's own type, read off the line rather than off a neighbouring
  // row: the plain row in this dump is a SYSTEM NOTICE, which is deliberately
  // set smaller, so comparing to it fails for a reason that is not this work.
  const rowTime = chipRow && chipRow.querySelector('.mtime')

  const head = document.querySelector('.turn-mail-head')
  const cardName = head && head.querySelector('.cc-name')
  const cardChip = head && head.querySelector('.tier')
  const cardMeta = head && [...head.querySelectorAll('span')]
    .find((e) => !e.classList.contains('tier') && !e.classList.contains('cc-name'))

  // ⚠ THE HIT TEST. Not "does the element exist" but "is it what the pointer
  // finds there". Returns the tag/class path so a failure names the thing that
  // was on top instead.
  const hit = (el, dx = 0, dy = 0) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2 + dx,
                                        r.top + r.height / 2 + dy)
    if (!t) return { none: true }
    return {
      tag: t.tagName.toLowerCase(),
      cls: t.className && t.className.baseVal === undefined ? String(t.className) : '',
      inName: Boolean(rowName && (t === rowName || rowName.contains(t))),
      inRow: Boolean(chipRow && (t === chipRow || chipRow.contains(t))),
    }
  }
  // ── the LIVE steered rows: mail that arrived mid-turn ───────────────────
  // The dump carries two, identical but for whether the tree vouches for the
  // sender — so the height comparison is a comparison, not a number.
  const lives = [...document.querySelectorAll('.msg.user.live')]
  const liveChipRow = lives.find((r) => r.querySelector('.live-mail-head .tier'))
  const livePlainRow = lives.find((r) => r.querySelector('.live-mail-head')
    && !r.querySelector('.live-mail-head .tier'))
  const liveHead = liveChipRow && liveChipRow.querySelector('.live-mail-head')
  const liveName = liveChipRow && liveChipRow.querySelector('.live-mail-head .cc-name')
  const liveChip = liveChipRow && liveChipRow.querySelector('.live-mail-head .tier')
  // the body markdown under the head — the row's own type, to measure the
  // name against something on the same row rather than a number chosen here
  const liveBody = liveChipRow && liveChipRow.querySelector('.live-mail .md')

  // ── the NODE'S OWN MAILBOX, opened at the desk ──────────────────────────
  // A DIFFERENT CASCADE, which is the whole reason it is measured separately:
  // these rows sit in a `.desk-body`, not in an `.overlay > .settings`, so the
  // button reset proven for the rows above is not proven for these.
  const bRows = [...document.querySelectorAll('.deskbox .mailrow')]
  // ⚠ a DELIVERED row on both sides of the comparison: an unread row carries
  // `.unread` and its own weight, and comparing it against a read one would
  // measure that instead of the chip.
  const bChipRow = bRows.find((r) => r.querySelector('.mfrom .tier')
    && !r.classList.contains('unread'))
  const bPlainRow = bRows.find((r) => {
    const f = r.querySelector('.mfrom')
    return f && f.textContent.trim() === 'nobody-here'
  })
  const bName = bChipRow && bChipRow.querySelector('.mfrom .cc-name')
  const bChip = bChipRow && bChipRow.querySelector('.mfrom .tier')
  const bL1 = bChipRow && bChipRow.querySelector('.l1')
  const bL2 = bChipRow && bChipRow.querySelector('.l2')
  const bTime = bChipRow && bChipRow.querySelector('.mtime')
  const bPlainName = bPlainRow && bPlainRow.querySelector('.mfrom .cc-name')

  // the separator the header's own rule paints after a span
  const after = (el) => (el
    ? getComputedStyle(el, '::after').content : null)

  return {
    boxChipRow: box(bChipRow), boxPlainRow: box(bPlainRow),
    boxName: box(bName), boxChip: box(bChip), boxL1: box(bL1),
    boxTime: box(bTime), boxPlainName: box(bPlainName),
    // ⚠ TAG, NOT CLASS. `.cc-name` is drawn on a <span> when there is no
    // route and on a <button> when there is, so the tag is the fact that
    // says whether this surface offers navigation at all.
    boxNameTag: bName ? bName.tagName.toLowerCase() : null,
    boxPlainTag: bPlainName ? bPlainName.tagName.toLowerCase() : null,
    // ⚠ the sender this pass measured, so the SECOND pass (the hit test, which
    // has to run after the overlay comes off) can be checked against it — two
    // copies of a row-picking rule are two chances to drift onto two rows
    boxRowFrom: bChipRow ? bChipRow.querySelector('.mfrom').textContent.trim() : null,
    boxL2: box(bL2),
    liveChipRow: box(liveChipRow), livePlainRow: box(livePlainRow),
    liveHead: box(liveHead), liveName: box(liveName), liveChip: box(liveChip),
    liveBody: box(liveBody),
    rowChipRow: box(chipRow), rowPlainRow: box(plainRow),
    rowName: box(rowName), rowChip: box(rowChip), rowL1: box(rowL1),
    rowPlainName: box(plainName), rowText: box(rowText), rowTime: box(rowTime),
    cardHead: box(head), cardName: box(cardName), cardChip: box(cardChip),
    cardMeta: box(cardMeta),
    hitName: hit(rowName), hitBody: hit(rowL2),
    afterChip: after(cardChip), afterName: after(cardName),
  }
}
"""

# ⚠ A SECOND PASS, AND WHY IT HAS TO BE ONE. This page carries BOTH mailboxes
# so they can be measured under one sheet in one engine — but the user's inbox
# is a `position: fixed` `.overlay`, so in this page (and only in this page) it
# is painted over the desk beneath it. The first run of this check reported the
# desk's sender as unreachable and named `div.mailer-list` as the thing on top:
# the MODAL's list, not the desk's. That is an artifact of stacking two screens
# that are never on screen together, not a finding about the desk — so the
# overlay comes off and the hit test runs again on what is left.
#
# It runs LAST because it mutates the page: every measurement above, and the
# full-page screenshot, happen while the page is still whole.
HIT_DESKBOX = """
() => {
  document.querySelectorAll('.overlay').forEach((o) => o.remove())
  const rows = [...document.querySelectorAll('.deskbox .mailrow')]
  const row = rows.find((r) => r.querySelector('.mfrom .tier')
    && !r.classList.contains('unread'))
  const name = row && row.querySelector('.mfrom .cc-name')
  const l2 = row && row.querySelector('.l2')
  const hit = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2,
                                        r.top + r.height / 2)
    if (!t) return { none: true }
    return {
      tag: t.tagName.toLowerCase(),
      cls: t.className && t.className.baseVal === undefined ? String(t.className) : '',
      inName: Boolean(name && (t === name || name.contains(t))),
      inRow: Boolean(row && (t === row || row.contains(t))),
    }
  }
  return {
    boxHitName: hit(name), boxHitBody: hit(l2),
    boxHitFrom: row ? row.querySelector('.mfrom').textContent.trim() : null,
  }
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--css", default=str(DEFAULT_CSS))
    ap.add_argument("--shot")
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--break-chip", action="store_true",
                    help="grow both chips: check 1's own control, which must "
                         "FAIL")
    ap.add_argument("--poke-chip", action="store_true",
                    help="shove both chips out of their line boxes without "
                         "changing layout: the control for the 'pokes out' "
                         "halves of checks 4 and 6, which must FAIL")
    ap.add_argument("--chrome-desk", action="store_true",
                    help="give the DESK's mailbox the button chrome the "
                         "user's inbox has: the control for check 13, which "
                         "must FAIL")
    ap.add_argument("--cover-rows", action="store_true",
                    help="lay a transparent sheet over every mail row: the "
                         "control for the two HIT tests (5 and 14), which "
                         "must FAIL")
    a = ap.parse_args()

    css = pathlib.Path(a.css).resolve().read_text(encoding="utf-8")
    if a.break_chip:
        css += """
.mailrow .l1 .mfrom .tier, .mailrow .l1 .mfrom .sender .tier,
.desk-body .turn-mail-head .tier, .turn-mail-head .tier,
.desk-body .live-mail-head .tier, .live-mail-head .tier {
  width: 34px; height: 34px; font-size: 20px;
}
"""
    if a.poke_chip:
        # ⚠ WHY A SECOND CONTROL EXISTS. `--break-chip` GROWS the chip, and a
        # grown chip grows the line with it — so the row-height check fires and
        # the two "the chip is inside its line" assertions still pass, having
        # never been watched fail. Relative positioning moves the box without
        # touching layout, which is the only way to make a chip leave its line
        # while the line stays where it was.
        css += """
.mailrow .l1 .mfrom .tier, .mailrow .l1 .mfrom .sender .tier,
.desk-body .turn-mail-head .tier, .turn-mail-head .tier,
.desk-body .live-mail-head .tier, .live-mail-head .tier {
  position: relative; top: 16px;
}
"""
    if a.chrome_desk:
        # ⚠ CHECK 13 IS NOT FIRED BY THE PRE-SERIES SHEET, because nothing in
        # this repo ever gave the `.desk-body` cascade button chrome — so
        # without this the check would pass on every sheet it has ever seen
        # and would have been watched only in the abstract. This is the
        # regression it exists for, written out: a button rule that reaches
        # the node's own mailbox the way `.settings button` reaches the
        # user's.
        # ⚠ AND IT HAS TO OUTRANK THE RESET. The first version of this control
        # was `.desk-body .mailrow button.cc-name` (0,3,1) and LOST to
        # `.mailrow .l1 .mfrom .cc-name` (0,4,0), so the probe reported that
        # the control sheet proved nothing — correctly. Five classes win.
        css += """
.desk-body .mailrow .l1 .mfrom .cc-name {
  font-size: 14px; padding: 7px 15px; border-radius: 6px;
}
"""
    if a.cover_rows:
        # ⚠ THE HIT TESTS HAD NO CONTROL SHEET AND THIS FILE SAID SO. Nothing
        # in the repo's own CSS covers a mail row, so checks 5 and 14 were
        # watched only through their anti-vacuity clauses — and a check nobody
        # has seen fail is not a check. A row-sized pseudo-element paints over
        # its own row's contents without moving anything, which is exactly the
        # regression these two exist to catch (an overlay, a stretched ::after,
        # a full-bleed link) and cannot be caught by looking at the markup.
        css += """
.mailrow { position: relative; }
.mailrow::after { content: ''; position: absolute; inset: 0; }
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
        pg.wait_for_selector(".mailrow", state="attached", timeout=8000)
        m = pg.evaluate(MEASURE)
        if a.shot:
            # the whole page: the inbox modal is positioned and escapes the
            # `.viewport` box, so an element screenshot of it clips the rows
            # this probe is about
            pg.screenshot(path=a.shot, full_page=True)
            print("wrote", a.shot)
        # THE SECOND PASS — it removes the fixed inbox overlay, so it runs
        # after every measurement above and after the full-page shot. The
        # transcript-card and live-row shots below WANT the overlay gone (the
        # modal is painted over the desk and an element screenshot captures
        # the page region, not the element), which is why they come after.
        m.update(pg.evaluate(HIT_DESKBOX))
        if a.shot:
            card = pg.query_selector(".turn-mail")
            if card:
                p2 = pathlib.Path(a.shot).with_name(
                    pathlib.Path(a.shot).stem + "-card.png")
                card.screenshot(path=str(p2))
                print("wrote", p2)
            # …and the MID-TURN rows, which are the point of the second pass:
            # the settled card and the still-arriving row look different on
            # purpose, and a picture of only one of them hides that
            live = pg.query_selector(".msg.user.live")
            if live:
                p3 = pathlib.Path(a.shot).with_name(
                    pathlib.Path(a.shot).stem + "-live.png")
                live.screenshot(path=str(p3))
                print("wrote", p3)
            # …and the node's OWN mailbox, the surface this pass added
            dbox = pg.query_selector(".deskbox .mailwrap")
            if dbox:
                p4 = pathlib.Path(a.shot).with_name(
                    pathlib.Path(a.shot).stem + "-deskbox.png")
                dbox.screenshot(path=str(p4))
                print("wrote", p4)
        ctx.close()
        b.close()

    # ⚠ NOTHING TO MEASURE IS A FAILURE, NOT A PASS. Every check below reads
    # two boxes; a missing one would make every comparison vacuously true.
    fails = []
    missing = [k for k, v in m.items() if v is None]
    if missing:
        print(f"  MISSING: {', '.join(missing)}")
        fails.append(f"missing: the probe never found {', '.join(missing)} — "
                     "nothing was measured")
        print("\nFAIL" if not a.expect_fail else "\nfailed as required")
        return 0 if a.expect_fail else 1

    cr, pr = m["rowChipRow"], m["rowPlainRow"]
    rn, rc, l1, pn = m["rowName"], m["rowChip"], m["rowL1"], m["rowPlainName"]
    ch, cn, cc, cm = m["cardHead"], m["cardName"], m["cardChip"], m["cardMeta"]

    print(f"  row w/ chip : h={cr['h']:.1f}  l1 h={l1['h']:.1f}")
    print(f"  row w/o chip: h={pr['h']:.1f}")
    print(f"  row name    : {rn['size']}px {rn['family'][:26]!r} w={rn['weight']} "
          f"pad={rn['padTop']}/{rn['padRight']}/{rn['padBottom']}/{rn['padLeft']} "
          f"radius={rn['radius']}")
    print(f"  plain name  : {pn['size']}px {pn['family'][:26]!r}")
    print(f"  row chip    : {rc['w']:.1f}x{rc['h']:.1f}")
    print(f"  card head   : h={ch['h']:.1f}  name {cn['size']}px  "
          f"chip {cc['w']:.1f}x{cc['h']:.1f}  meta {cm['size']}px")
    print(f"  hit at name : {m['hitName']}")
    print(f"  hit at body : {m['hitBody']}")
    print(f"  ::after chip={m['afterChip']!r} name={m['afterName']!r}")

    # 1. rowheight — THE CHIP DID NOT MAKE THE ROW TALLER. Two rows in one
    # page, identical but for the chip (the control's sender is not in the
    # tree, so it draws a name and nothing else). This is the check
    # `--break-chip` exists to make fail.
    if cr["h"] > pr["h"] + 0.5:
        fails.append(f"rowheight: the row WITH a model chip is {cr['h']:.1f}px "
                     f"where the same row without one is {pr['h']:.1f}px — "
                     "the chip is setting the row's height")
    if l1["h"] > rc["h"] + 6:
        fails.append(f"rowheight: the row's first line is {l1['h']:.1f}px "
                     f"around a {rc['h']:.1f}px chip — something in the "
                     "identity is padding the line")

    # 2. rowchrome — no `.settings button` chrome survived into the row
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if rn[side] > 0.01:
            fails.append(f"rowchrome: the row's name carries {side}={rn[side]}px "
                         "— the `.settings button` chrome was not reset")
    if rn["radius"] > 0.01:
        fails.append(f"rowchrome: the row's name has a {rn['radius']}px corner "
                     "radius — it is drawn as a button inside a list row")

    # 3. rowtype — the ROW's type, not `.cc-name`'s 12.5px.
    # ⚠ MEASURED AGAINST THE ROW'S OWN LINE, not against the plain row: that
    # one is a system notice and is deliberately set a size smaller, so it
    # reported a failure that had nothing to do with this work. `.mtime` sits
    # in the SAME `.l1` and inherits the same type.
    tm = m["rowTime"]
    if abs(rn["size"] - l1["size"]) > 0.01:
        fails.append(f"rowtype: the agent name is {rn['size']}px in a "
                     f"{l1['size']}px row line")
    if abs(rn["size"] - tm["size"]) > 0.01:
        fails.append(f"rowtype: the agent name is {rn['size']}px where the "
                     f"timestamp on the same line is {tm['size']}px")
    if rn["family"] != tm["family"]:
        fails.append(f"rowtype: the agent name is in {rn['family'][:30]!r} and "
                     f"the rest of the line in {tm['family'][:30]!r}")
    # …and the face this reset exists to override is really on this page, or
    # the check above is a distinction between two identical things
    if cn["family"] == m["cardMeta"]["family"] and rn["size"] == 12.5:
        fails.append("rowtype: nothing on this page distinguishes `.cc-name`'s "
                     "own type — check 3 cannot fail")

    # 4. rowchip — inside the row's first line
    if rc["h"] > l1["h"] + 0.5:
        fails.append(f"rowchip: the chip is {rc['h']:.1f}px in a {l1['h']:.1f}px "
                     "line — it sets the row's height")
    if rc["top"] < l1["top"] - 0.5 or rc["bottom"] > l1["bottom"] + 0.5:
        fails.append("rowchip: the chip pokes out of the row's first line "
                     f"(chip {rc['top']:.1f}..{rc['bottom']:.1f}, line "
                     f"{l1['top']:.1f}..{l1['bottom']:.1f})")
    # ⚠ against the TEXT, not the name element: `SenderChip` nests the chip
    # inside the button, so the name's own box legitimately starts at the chip
    rt = m["rowText"]
    if rc["right"] > rt["left"] + 0.5 and rc["x"] >= rt["x"]:
        fails.append(f"rowchip: the chip (x={rc['x']:.1f}..{rc['right']:.1f}) "
                     f"is not before the name text (x={rt['x']:.1f})")

    # 5. rowhit — the click lands on the name, and not everywhere
    hn, hb = m["hitName"], m["hitBody"]
    if not hn or not hn.get("inName"):
        fails.append("rowhit: the point at the centre of the sender's name is "
                     f"not the name — elementFromPoint found {hn}")
    # ⚠ ANTI-VACUITY: if the name covered the whole row, check 5 would pass for
    # the wrong reason. The preview line must NOT hit the name.
    if hb and hb.get("inName"):
        fails.append("rowhit: the row's preview line ALSO hits the name — the "
                     "name is not a target, it is the whole row")
    if hb and not hb.get("inRow"):
        fails.append("rowhit: the control point does not even land in the row "
                     f"— the instrument is measuring the wrong place ({hb})")

    # 6. cardhead — the identity fits the transcript card's header line
    if cc["h"] > ch["h"] + 0.5:
        fails.append(f"cardhead: the chip is {cc['h']:.1f}px in a {ch['h']:.1f}px "
                     "header — it sets the card header's height")
    if cc["top"] < ch["top"] - 0.5 or cc["bottom"] > ch["bottom"] + 0.5:
        fails.append("cardhead: the chip pokes out of the header's box "
                     f"(chip {cc['top']:.1f}..{cc['bottom']:.1f}, head "
                     f"{ch['top']:.1f}..{ch['bottom']:.1f})")
    if cc["x"] >= cn["x"]:
        fails.append("cardhead: the chip is not before the name it belongs to")

    # 7. carddot — no separator between a chip and its own name
    for key, what in (("afterChip", "the model chip"), ("afterName", "the name")):
        v = m[key]
        if v and "·" in str(v):
            fails.append(f"carddot: a '·' is painted after {what} — the "
                         "header's separator rule matches any span, and both "
                         "halves of an identity are spans")

    # 8. cardtype — the header's own type, not the switchboard's or a button's
    if cn["size"] >= 12.5:
        fails.append(f"cardtype: the card's name is {cn['size']}px — that is "
                     "`.cc-name`'s 12.5px (or a button's 14px), not the "
                     "header's 11.5px")
    if cn["size"] <= cm["size"]:
        fails.append(f"cardtype: the name is {cn['size']}px against "
                     f"{cm['size']}px metadata — the sender no longer leads "
                     "the header")
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if cn[side] > 0.01:
            fails.append(f"cardtype: the card's name carries {side}="
                         f"{cn[side]}px of button chrome")

    # ── the LIVE steered row ────────────────────────────────────────────────
    lr, lp = m["liveChipRow"], m["livePlainRow"]
    lh, ln, lc, lb = m["liveHead"], m["liveName"], m["liveChip"], m["liveBody"]
    print(f"  live w/ chip: h={lr['h']:.1f}  head h={lh['h']:.1f}")
    print(f"  live w/o    : h={lp['h']:.1f}")
    print(f"  live name   : {ln['size']}px {ln['family'][:26]!r} w={ln['weight']} "
          f"pad={ln['padTop']}/{ln['padRight']}/{ln['padBottom']}/{ln['padLeft']} "
          f"radius={ln['radius']}  chip {lc['w']:.1f}x{lc['h']:.1f}  "
          f"body {lb['size']}px")

    # 9. liveheight — the identity did not grow the mid-turn row. Same
    #    envelope, same body, same length; the ONE difference is the chip.
    if lr["h"] > lp["h"] + 0.5:
        fails.append(f"liveheight: the live row WITH a chip is {lr['h']:.1f}px "
                     f"where the same row without one is {lp['h']:.1f}px — the "
                     "chip is setting the height of a row that is still "
                     "streaming")

    # 10. livechip — inside its own line, and before the name
    if lc["h"] > lh["h"] + 0.5:
        fails.append(f"livechip: the chip is {lc['h']:.1f}px in a "
                     f"{lh['h']:.1f}px attribution line")
    if lc["top"] < lh["top"] - 0.5 or lc["bottom"] > lh["bottom"] + 0.5:
        fails.append("livechip: the chip pokes out of the live row's "
                     f"attribution line (chip {lc['top']:.1f}..{lc['bottom']:.1f}"
                     f", line {lh['top']:.1f}..{lh['bottom']:.1f})")
    if lc["x"] >= ln["x"]:
        fails.append("livechip: the chip is not before the name it belongs to")

    # 11. livetype — the sheet's declared 13px mono, NOT `.cc-name`'s 12.5px
    #     flexible column header and NOT a 14px button. This is the check the
    #     PRE-SERIES sheet fires: without `.live-mail-head .cc-name` the name
    #     falls back to the switchboard default.
    if abs(ln["size"] - 13.0) > 0.01:
        fails.append(f"livetype: the live sender is {ln['size']}px — the sheet "
                     "declares 13px; 12.5px is `.cc-name`'s switchboard "
                     "default and 14px is a button's")
    if ln["size"] >= lb["size"] + 0.5:
        fails.append(f"livetype: the sender is {ln['size']}px against a "
                     f"{lb['size']}px body — it is louder than the message")
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if ln[side] > 0.01:
            fails.append(f"livetype: the live sender carries {side}="
                         f"{ln[side]}px of button chrome")
    if ln["radius"] > 0.01:
        fails.append(f"livetype: the live sender has a {ln['radius']}px corner "
                     "radius — it is drawn as a button")

    # ── the NODE'S OWN MAILBOX, at the desk ─────────────────────────────────
    bc, bp = m["boxChipRow"], m["boxPlainRow"]
    bn, bh, b1, bt = m["boxName"], m["boxChip"], m["boxL1"], m["boxTime"]
    print(f"  desk box row: h={bc['h']:.1f} (w/o chip {bp['h']:.1f})  "
          f"l1 h={b1['h']:.1f}")
    print(f"  desk box name: <{m['boxNameTag']}> {bn['size']}px "
          f"{bn['family'][:26]!r} pad={bn['padTop']}/{bn['padRight']}/"
          f"{bn['padBottom']}/{bn['padLeft']} radius={bn['radius']}  "
          f"chip {bh['w']:.1f}x{bh['h']:.1f}")
    print(f"  desk box hit : {m['boxHitName']}")
    print(f"  desk box ctl : {m['boxHitBody']}")

    # 12. boxroute — the sender name IS the control, and the unvouched-for one
    #     is NOT. Read off the TAG, in the engine, on the markup the reader
    #     gets by clicking the tab. This is what the whole wiring is for.
    if m["boxNameTag"] != "button":
        fails.append(f"boxroute: the desk mailbox draws its sender as a "
                     f"<{m['boxNameTag']}> — there is no route to click")
    if m["boxPlainTag"] != "span":
        fails.append(f"boxroute: a sender this tree does NOT hold is drawn as "
                     f"a <{m['boxPlainTag']}> — the check above would pass on "
                     "a surface that makes a button of every name")

    # 13. boxchrome/boxtype — the `.desk-body` cascade is not the `.settings`
    #     one, so this reset is a SEPARATE fact from check 2's.
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if bn[side] > 0.01:
            fails.append(f"boxchrome: the desk mailbox's name carries "
                         f"{side}={bn[side]}px of button chrome")
    if bn["radius"] > 0.01:
        fails.append(f"boxchrome: the desk mailbox's name has a "
                     f"{bn['radius']}px corner radius")
    if abs(bn["size"] - bt["size"]) > 0.01:
        fails.append(f"boxtype: the name is {bn['size']}px where the timestamp "
                     f"on the same line is {bt['size']}px")
    if bn["family"] != bt["family"]:
        fails.append(f"boxtype: the name is in {bn['family'][:30]!r} and the "
                     f"rest of its line in {bt['family'][:30]!r}")
    if bc["h"] > bp["h"] + 0.5:
        fails.append(f"boxheight: the desk mailbox row WITH a chip is "
                     f"{bc['h']:.1f}px where the same row without one is "
                     f"{bp['h']:.1f}px")
    if bh["top"] < b1["top"] - 0.5 or bh["bottom"] > b1["bottom"] + 0.5:
        fails.append("boxchip: the chip pokes out of the row's first line "
                     f"(chip {bh['top']:.1f}..{bh['bottom']:.1f}, line "
                     f"{b1['top']:.1f}..{b1['bottom']:.1f})")

    # 14. boxhit — THE POINTER FINDS THE NAME AT THE DESK, and does not find
    #     it everywhere. `--cover-rows` is this check's control.
    # ⚠ FIRST: the two passes must have picked the SAME row. They each carry a
    # copy of the rule, and two copies can drift onto two different rows —
    # after which this check would be about a row nothing else measured.
    if m["boxRowFrom"] != m["boxHitFrom"]:
        fails.append(f"boxhit: the two passes measured different rows "
                     f"({m['boxRowFrom']!r} then {m['boxHitFrom']!r}) — the "
                     "row-picking rules have drifted apart")
    bhn, bhb = m["boxHitName"], m["boxHitBody"]
    if not bhn or not bhn.get("inName"):
        fails.append("boxhit: the point at the centre of the desk mailbox's "
                     f"sender is not the name — elementFromPoint found {bhn}")
    if bhb and bhb.get("inName"):
        fails.append("boxhit: the row's preview line ALSO hits the name")
    if bhb and not bhb.get("inRow"):
        fails.append("boxhit: the control point does not even land in the row "
                     f"— the instrument is measuring the wrong place ({bhb})")

    for f in fails:
        print("  FAIL", f)
    ok = not fails
    if a.expect_fail:
        print("\n" + ("failed as required — this probe can see a regression"
                      if not ok else
                      "PASSED WITH THE CONTROL SHEET — this probe proves "
                      "nothing; the sheet you passed already contains the "
                      "rules under test (did you use HEAD instead of the "
                      "pre-series commit?)"))
        return 0 if not ok else 1
    print("\n" + ("OK — both surfaces measured in a real engine" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
