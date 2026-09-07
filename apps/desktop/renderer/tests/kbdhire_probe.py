"""kbdhire_probe.py — can a real browser actually put the caret there, and can
Tab reach everything in the hire dialog?

Companion to tests/kbdhire.test.tsx, which owns the behaviour: that the name
field is focused when the draft opens, that Enter and Ctrl+Enter confirm, that
Escape cancels, and that the new agent's desk opens with its message box
focused. All of that is DOM semantics — focus, activeElement, event dispatch —
and jsdom implements it faithfully, so asserting it in a browser as well would
be theatre.

TWO THINGS jsdom CANNOT ANSWER, WHICH IS WHY THIS FILE EXISTS.

1. WHETHER THE FOCUS LANDS AT ALL. jsdom applies no stylesheet and does no
   layout, so `el.focus()` there always succeeds. A real browser REFUSES focus
   to an element that is `display:none`, `visibility:hidden`, or `disabled` —
   and both fields under test live inside counter-scaled, conditionally-shown
   panels (`.draft-over`, `.desk-over`) with real rules attached. A green jsdom
   run plus a hidden field is a workflow that is broken for the user and
   passing in CI.

2. WHETHER TAB REACHES EVERY CONTROL. jsdom does not implement sequential focus
   navigation at all — pressing Tab there does nothing. "Can the dialog be
   completed by keyboard alone?" is exactly a Tab-order question, so it can
   only be answered here.

    python tests/kbdhire_probe.py                # measure and check
    python tests/kbdhire_probe.py --expect-fail  # KNOWN-NEGATIVE CONTROL:
                                                 # hides the two fields the way
                                                 # a real regression would;
                                                 # must FAIL.
    python tests/kbdhire_probe.py --shot out.png # and look at it

The control is the point. "The browser puts the caret in the name field" means
nothing unless this script is demonstrably able to report that it does not —
and since a probe that only ever calls `.focus()` on a visible element would
report success no matter what, the control hides them and requires the report
to go red.

Requires playwright with the msedge channel (same dependency, and the same
reason, as chipbar_probe.py and bearercard_probe.py next door).
"""

import argparse
import os
import pathlib
import sys
import tempfile

from playwright.sync_api import sync_playwright

# the Windows console defaults to cp1252 and this script prints arrows; without
# this it dies in its own report AFTER measuring, which reads exactly like a
# measurement failure and is not one
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"
DESK = FRONTEND / "src" / "canvas" / "desk.tsx"


def _check_fixture_still_matches_source() -> None:
    """The fixture must be the markup the app really emits.

    A probe measuring markup the app never renders is worth less than no probe,
    because it is believed. These are the exact hooks under test; if any moves,
    this file is measuring a dialog that does not ship.
    """
    cards = CARDS.read_text(encoding="utf-8")
    for needed in ('<input className="df-name" placeholder="name…"',
                   'className="df-gear"',
                   'className="df-preset-add"',
                   '<textarea className="df-charter"',
                   '<div className="df-foot">',
                   # the focus call this probe exists to corroborate
                   "el.focus({ preventScroll: true })"):
        if needed not in cards:
            raise SystemExit(
                f"cards.tsx no longer emits {needed!r} — this probe's fixture "
                f"is stale and would be measuring a dialog the app never "
                f"draws. Update draft_form() and this guard together.")
    desk = DESK.read_text(encoding="utf-8")
    for needed in ("'cc-composer' + (canMail ? '' : ' off')",
                   "el.focus({ preventScroll: true })"):
        if needed not in desk:
            raise SystemExit(
                f"desk.tsx no longer emits {needed!r} — the composer this "
                f"probe focuses is not the one that ships.")
    css = CSS.read_text(encoding="utf-8")
    for needed in (".df-name", ".df-charter", ".cc-composer", ".draft-over"):
        if needed not in css:
            raise SystemExit(
                f"styles.css no longer contains {needed!r} — the rules that "
                f"decide whether these fields are visible have moved.")


VIEW_W, VIEW_H = 1400, 900
NODE_W = NODE_H = 124

# The draft form, as DraftNode renders it, and the desk composer as DeskChat
# renders it. Both are placed inside the world-scaled `.space`/`.sq` chrome they
# really live in, because that chrome is what could hide them.
def draft_form() -> str:
    return (
        f"<div class='sq draft' style='position:relative;"
        f"width:{NODE_W}px;height:{NODE_H}px'>"
        "<div class='cbar' style='height:42px'></div>"
        "<div class='draft-tag'>uninitialized</div>"
        "<div class='draft-over'><div class='draft-inner'>"
        "<div class='df-head'>"
        "<span class='tier t-haiku'>H</span>"
        "<input class='df-name' placeholder='name…'>"
        "<button class='df-gear'>G</button>"
        "</div>"
        "<select class='df-preset-add'><option value=''>add charter preset…</option></select>"
        "<div class='df-charter-wrap'>"
        "<textarea class='df-charter' placeholder='charter (optional)…'></textarea>"
        "</div>"
        "<div class='df-foot'><span class='spacer'></span>"
        "<button class='df-cancel'>cancel</button>"
        "<button class='primary df-hire'>hire</button>"
        "</div>"
        "</div></div></div>")


def desk_card() -> str:
    return (
        f"<div class='sq live desk tier-haiku' style='position:relative;"
        f"width:{NODE_W}px;height:{NODE_H}px'>"
        "<div class='cbar' style='height:42px'></div>"
        "<div class='desk-over'><div class='desk-body'>"
        "<div class='cc-head'><span class='cc-name'>newbie</span></div>"
        "<div class='cc-composer'>"
        "<button class='cc-attach'>A</button>"
        "<textarea rows='2' placeholder='message newbie…'></textarea>"
        "<button class='cc-send'>S</button>"
        "</div>"
        "</div></div></div>")


# The control hides both fields the way a real regression would — a panel that
# stops being displayed, a field collapsed to nothing. Appended last so it wins
# on specificity-tie/order.
HIDE_CSS = """
/* ---- probe control: the fields are present but cannot be focused ---- */
.df-name { display: none; }
.cc-composer textarea { visibility: hidden; }
"""


def build_page(css: str, hide: bool) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>\n"
        + css + (HIDE_CSS if hide else "")
        + "\n/* probe chrome only: never touches the rules under test */"
        "\n.probe-row{display:flex;gap:80px;padding:60px 40px;background:#1f1f1f}"
        "\n.probe-cell{display:flex;flex-direction:column;gap:10px}"
        "\n.probe-label{font:11px Consolas,monospace;color:#8a8a8a}"
        "\n</style></head><body style='margin:0;background:#1f1f1f'>"
        "<div class='probe-row'>"
        "<div class='probe-cell'><div class='probe-label'>hire draft</div>"
        + draft_form() + "</div>"
        "<div class='probe-cell'><div class='probe-label'>the new desk</div>"
        + desk_card() + "</div>"
        "</div></body></html>")


# What has focus, named the way a human reads it.
WHO = """
() => {
  const el = document.activeElement;
  if (!el || el === document.body) return '(nothing)';
  const c = el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : '';
  return el.tagName.toLowerCase() + c;
}
"""


def run(css_text: str, hide: bool, shot: str | None = None,
        verbose: bool = True):
    fd, page = tempfile.mkstemp(suffix=".html",
                                dir=str(FRONTEND / "node_modules"))
    os.close(fd)
    order: list[str] = []
    landed: dict[str, str] = {}
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page(viewport={"width": VIEW_W, "height": VIEW_H},
                            device_scale_factor=2)
            pathlib.Path(page).write_text(build_page(css_text, hide),
                                          encoding="utf-8")
            pg.goto(pathlib.Path(page).as_uri())
            # `state="attached"`, NOT the default "visible". The control's
            # whole point is a field that is present and NOT visible, and the
            # default made the control DIE here — which exits non-zero and
            # looks like a red control while actually being a probe that never
            # measured anything. A control has to fail on the assertion, not on
            # the setup.
            pg.wait_for_selector(".df-name", state="attached", timeout=8000)
            if shot:
                sp = pathlib.Path(shot)
                sp.parent.mkdir(parents=True, exist_ok=True)
                pg.locator(".probe-row").screenshot(path=str(sp))

            # ① the two focus calls the app makes on mount, made here the same
            # way — and then we ask the BROWSER where the caret went, which is
            # the whole question. `preventScroll` matches the app's call: the
            # fields sit inside a transform-panned, overflow:hidden viewport
            # and a scrolling focus would move the world.
            for sel in (".df-name", ".cc-composer textarea"):
                pg.evaluate(
                    "(s) => { document.activeElement?.blur();"
                    " document.querySelector(s)"
                    ".focus({ preventScroll: true }) }", sel)
                landed[sel] = pg.evaluate(WHO)

            # ② Tab order from the name field: can a keyboard reach every
            # control in the dialog, or is something mouse-only? Real Tab
            # presses through the real browser — jsdom cannot do this at all.
            pg.evaluate("() => { document.activeElement?.blur();"
                        " document.querySelector('.df-name')?.focus() }")
            seen = pg.evaluate(WHO)
            order.append(seen)
            for _ in range(8):
                pg.keyboard.press("Tab")
                who = pg.evaluate(WHO)
                order.append(who)
                if who == "(nothing)":
                    break
            b.close()
    finally:
        os.unlink(page)

    fails = []
    if verbose:
        print("  focus(), then what the browser says has the caret:")
        for sel, got in landed.items():
            mark = "  " if got != "(nothing)" else "!!"
            print(f"  {mark}{sel:<28} -> {got}")
        print("\n  Tab order out of the name field:")
        print("     " + "\n  -> ".join(order))

    if landed.get(".df-name") != "input.df-name":
        fails.append(
            f"focusing the hire draft's name field left the caret on "
            f"{landed.get('.df-name')!r} — the browser refused it. The dialog "
            f"opens and the user cannot type the name.")
    if landed.get(".cc-composer textarea") != "textarea":
        fails.append(
            f"focusing the desk's message box left the caret on "
            f"{landed.get('.cc-composer textarea')!r} — the browser refused "
            f"it. The hire walks you to the desk and you still cannot type.")

    # every control the dialog offers must be Tab-reachable, or "keyboard-only"
    # is untrue at that step. Named individually so a failure says WHICH.
    for sel, what in ((".df-gear", "the permissions gear"),
                      (".df-preset-add", "the charter-preset picker"),
                      (".df-charter", "the charter text box"),
                      (".df-cancel", "the cancel button"),
                      (".df-hire", "the hire button")):
        if not any(sel.lstrip(".") in o for o in order):
            fails.append(
                f"Tab never reaches {what} ({sel}) — it can only be operated "
                f"with a mouse, so the dialog is not completable by keyboard. "
                f"Order was: {' -> '.join(order)}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true",
                    help="hide the two fields; the run MUST fail")
    ap.add_argument("--shot", help="write a picture of both surfaces")
    a = ap.parse_args()

    _check_fixture_still_matches_source()
    css = CSS.read_text(encoding="utf-8")
    if a.expect_fail:
        print("kbdhire_probe: KNOWN-NEGATIVE CONTROL (both fields hidden)")
    else:
        print("kbdhire_probe: measuring the shipped dialog")
    fails = run(css, hide=a.expect_fail, shot=a.shot)

    if a.expect_fail:
        if fails:
            print(f"\n  CONTROL OK — a hidden field fails, as it must "
                  f"({len(fails)} finding(s)). The probe can see a focus that "
                  f"does not land.")
            for f in fails[:2]:
                print("   e.g. " + f)
            return 0
        print("\n  CONTROL FAILED: hidden fields measured CLEAN.")
        print("  This probe cannot see the defect it exists to catch, so a "
              "green run against the real sheet proves nothing.")
        return 1

    if fails:
        print(f"\n  {len(fails)} finding(s):")
        for f in fails:
            print("   - " + f)
        return 1
    print("\n  OK — the browser puts the caret in the hire draft's name field "
          "and in the\n  desk's message box, and Tab reaches every control in "
          "the dialog.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
