"""edgejump_probe.py — do the jump-card forms really occupy the widths the
unit test assumes?

`edgejump.test.ts` reasons about whether a card covers the desk, and to do that
it needs each form's width. jsdom cannot supply one — it has no box model, so
every width it reports is 0. The test therefore takes the widths from the
constants in shared.ts and from the max-width in styles.css, which makes those
numbers an ASSUMPTION rather than a measurement: if the real stylesheet renders
the tab form at 90px instead of 22, the unit test stays green and the cards go
back to sitting on the chat text.

This closes that gap the only way it can be closed — render the real markup
against the real src/styles.css in a real engine and measure. Same two-step
shape as acctcols_probe.py next door (Resonite's), and deliberately so; that
file is theirs, this one is mine, and neither imports the other.

    python tests/edgejump_probe.py                 # measure and check
    python tests/edgejump_probe.py --expect-fail   # KNOWN-NEGATIVE CONTROL:
                                                   # run with the ej-* rules
                                                   # stripped; must FAIL.

The control is the point. "All three forms fit their budget" is only meaningful
if this script is capable of reporting that they do not.
"""

import argparse
import pathlib
import re
import sys
import tempfile
import os

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"

SHARED = FRONTEND / "src" / "canvas" / "shared.ts"


def _const(name: str, source: str) -> int:
    """Read a budget straight out of shared.ts.

    Hard-coding these here would let the two files drift silently: someone
    raises EJ_MID to make the unit test pass, this probe keeps checking the old
    number, and the check quietly stops describing what ships. Parsing means
    there is exactly one place the budget lives.
    """
    m = re.search(rf"^export const {name} = (\d+)", source, re.M)
    if not m:
        raise SystemExit(f"could not read {name} from {SHARED} — the probe "
                         f"cannot check a budget it cannot find")
    return int(m.group(1))


_src = SHARED.read_text(encoding="utf-8")
# `tab` is the max-width on .edge-jump.ej-tab in styles.css; the other two are
# the shared.ts constants the placement code actually reasons with
BUDGET = {
    "full": _const("EJ_FULL", _src),
    "mid": _const("EJ_MID", _src),
    "tab": 22,
}

# A LONG name on purpose: the full form is bounded by max-width + ellipsis, and
# the mid/tab forms must not be quietly widened by the name they are hiding.
NAME = "bug-overlapping-coworker-jump-cards"

CHEVRON = ('<svg viewBox="0 0 24 24" style="width:1em;height:1em;flex:none">'
           '<path d="M15 6l-6 6 6 6"/></svg>')
SPINNER = ('<svg class="cc-spin" viewBox="0 0 24 24" '
           'style="width:1em;height:1em;flex:none"><circle cx="12" cy="12" '
           'r="9" fill="none" stroke="currentColor"/></svg>')


def card(form: str, mail: bool) -> str:
    # WORST CASE ON PURPOSE: a long name, a busy spinner AND a three-digit
    # unread count. An earlier version of this fixture left the spinner out and
    # measured a card narrower than the one that actually ships — a fixture
    # that under-specifies is the same abstention as a check that never runs.
    cls = f"edge-jump l ej-{form}" + (" ej-mail" if mail else "")
    return (
        f'<button class="{cls}" data-form="{form}" '
        f'data-mail="{int(mail)}" style="top:200px">'
        f'{CHEVRON}'
        f'<span class="tier t-opus">O</span>'
        f'<span class="ej-name">{NAME}</span>'
        f'{SPINNER}'
        f'<b class="eye-count">{"128" if mail else "3"}</b>'
        f'</button>')


def build_page(css: str) -> str:
    cards = "".join(card(f, m) for f in ("full", "mid", "tab")
                    for m in (False, True))
    # one positioned ancestor, since .edge-jump is position:absolute
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>\n"
        + css +
        "\n</style></head><body style='margin:0'>"
        "<div id='vp' style='position:relative;width:900px;height:600px'>"
        + cards +
        "</div></body></html>")


MEASURE = """() => [...document.querySelectorAll('.edge-jump')].map((el) => {
  const r = el.getBoundingClientRect()
  const name = el.querySelector('.ej-name')
  return {
    form: el.dataset.form,
    mail: el.dataset.mail === '1',
    width: Math.round(r.width * 100) / 100,
    left: Math.round(r.left * 100) / 100,
    nameShown: name ? getComputedStyle(name).display !== 'none' : false,
  }
})"""


def run(css_text: str, verbose: bool = True):
    fd, page = tempfile.mkstemp(suffix=".html", dir=str(FRONTEND / "node_modules"))
    os.close(fd)
    pathlib.Path(page).write_text(build_page(css_text), encoding="utf-8")
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page(viewport={"width": 900, "height": 600})
            pg.goto(pathlib.Path(page).as_uri())
            pg.wait_for_selector(".edge-jump", timeout=8000)
            rows = pg.evaluate(MEASURE)
            b.close()
    finally:
        os.unlink(page)

    fails = []
    if len(rows) != 6:
        fails.append(f"measured {len(rows)} cards, expected 6 — the fixture "
                     f"did not render, so nothing below means anything")
    for r in rows:
        budget = BUDGET[r["form"]]
        tag = f"{r['form']}{'+mail' if r['mail'] else ''}"
        if verbose:
            print(f"  {tag:<10} width={r['width']:>7.2f}  budget={budget:>3}  "
                  f"name={'shown' if r['nameShown'] else 'hidden'}")
        if r["width"] > budget:
            fails.append(f"{tag}: {r['width']:.2f}px exceeds its {budget}px "
                         f"budget — edgejump.test.ts assumes it fits")
        # the name must be hidden in exactly the shed forms, or the widths
        # above are a coincidence of this fixture's name length
        if r["form"] == "full" and not r["nameShown"]:
            fails.append("full form hid the name — that is the one form whose "
                         "entire purpose is to show it")
        if r["form"] in ("mid", "tab") and r["nameShown"]:
            fails.append(f"{tag}: name still displayed in a shed form")
    return rows, fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    a = ap.parse_args()

    css = CSS.read_text(encoding="utf-8")
    if a.expect_fail:
        # strip every rule whose selector mentions ej-mid / ej-tab: the
        # pre-fix sheet, where all three forms render at full width
        css = re.sub(r"^[^{}]*\.ej-(?:mid|tab)[^{}]*\{[^}]*\}\s*",
                     "", css, flags=re.M)
        print("-- CONTROL: ej-mid/ej-tab rules stripped from the sheet")

    rows, fails = run(css)

    if a.expect_fail:
        if fails:
            print(f"\nCONTROL OK — the stripped sheet fails, as it must "
                  f"({len(fails)}):")
            for f in fails:
                print("   ·", f)
            return 0
        print("\n⚠ CONTROL BROKEN: the sheet with the fix stripped out still "
              "PASSED. This probe cannot see the thing it claims to measure, "
              "so every green run of it is vacuous.")
        return 1

    if fails:
        print(f"\nFAIL ({len(fails)}):")
        for f in fails:
            print("   ·", f)
        return 1
    print("\nOK — every form fits its budget and sheds the name as intended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
