"""bearercard_probe.py — does a LIVE knowledge bearer look alive?

User report 2026-08-28, from a screenshot of two cards side by side: "why are
these two retired agent piles not together as a single pile?" — and then, once
told that the left one was not retired at all and was in fact running a turn at
that moment: "it looks retired... the ui is too similar. it needs to look more
like a normal agent".

THE MECHANISM, which is why this has to be measured in a browser rather than
reasoned about from the source. `bearer_state` records where an agent's context
came from. It is not a lifecycle state — a rehired knowledge bearer holds a
seat, takes turns and works like any other report. But the card keyed its
lifecycle wash on that field alone:

    .sq.bearer { background:#262628; border-color:#3a3a3c;
                 border-top-color:#4a4a4c; opacity:.7 }

and CSS cascade order did the rest. All three of the declarations that matter
sit at the same specificity as the rules they were silently beating, and
`.sq.bearer` came later in the sheet:

    .sq.tier-* (line ~819)  border-top-color   -> the tier stripe went grey
    .sq.busy   (line ~336)  border-color       -> "a turn is RUNNING" went grey
    .sq.archived (line ~334) opacity: .5       -> .7 sat right beside it

So a live, mid-turn agent was drawn with no tier colour, no running border, and
an archived-adjacent fade. The fix scopes the wash with `:not(.live)`.

WHY A BROWSER. Every claim above is a claim about the CASCADE — which
declaration wins on a real element with a real class list. That cannot be read
off the source honestly (I got the specificity of `:not()` wrong once while
writing this) and jsdom does not do cascade resolution for shorthand/inherited
colour the way a browser does. So this renders the real card markup against the
real src/styles.css in headless Edge and asks `getComputedStyle` what actually
won, for six cards that differ only in the two fields under test.

    python tests/bearercard_probe.py                # measure and check
    python tests/bearercard_probe.py --expect-fail  # KNOWN-NEGATIVE CONTROL:
                                                    # restores the pre-fix
                                                    # rules AND the pre-fix
                                                    # chip markup; must FAIL.
    python tests/bearercard_probe.py --shot out.png # and look at it

The control is the point. "A live bearer reads as live" means nothing unless
this script is demonstrably able to report that it does not.

Requires playwright with the msedge channel (same dependency, and the same
reason, as chipbar_probe.py next door).
"""

import argparse
import os
import pathlib
import sys
import tempfile

from playwright.sync_api import sync_playwright

# the Windows console defaults to cp1252 and this script prints arrows and box
# drawing; without this the probe dies in its own report AFTER measuring, which
# reads exactly like a measurement failure and is not one
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"


def _check_fixture_still_matches_source() -> None:
    """The fixture must be the markup the app really emits.

    A probe measuring markup the app never renders is worth less than no probe,
    because it is believed. These are the exact hooks the rules under test key
    on; if any moves, this file is measuring a card that does not ship.
    """
    src = CARDS.read_text(encoding="utf-8")
    for needed in (
            # the class list under test, in the order the card builds it
            "const cls = ['sq', node.state,",
            "if (node.busy) cls.push('busy')",
            "if (node.bearer_state) cls.push('bearer')",
            "const stackN = (node.lineage ?? []).length",
            "if (!focused && stackN) cls.push('stack' + Math.min(stackN, 3))",
            # the two chips, which are the whole point of the second half
            '<span className="badge dim">{node.state}</span>',
            '<span className="badge bearermark"'):
        if needed not in src:
            raise SystemExit(
                f"cards.tsx no longer emits {needed!r} — this probe's fixture "
                f"is stale and would be measuring a card the app never draws. "
                f"Update card() and this guard together.")
    css = CSS.read_text(encoding="utf-8")
    for needed in (".sq.bearer:not(.live)", ".badge.bearermark",
                   ".sq.archived", ".sq.busy", ".sq.tier-opus"):
        if needed not in css:
            raise SystemExit(
                f"styles.css no longer contains {needed!r} — the rules under "
                f"test have moved; update this probe with them.")


# The six cards. They differ in exactly two fields — lifecycle state and
# bearer_state — plus `busy`, because "is a turn running" is one of the signals
# the wash was eating. Everything else is held constant so any difference the
# probe reports is attributable.
#
# `lineage` is set on both bearers because a rehired bearer really does have a
# predecessor session, and the resulting `.sq.stack1` offset shadow is part of
# what the user was looking at. It is NOT under test here (it is a true fact
# about the node and it renders the same on any card with history) — it is
# present so the measured card is the card that shipped.
CARDS_UNDER_TEST = [
    {"key": "plain live", "state": "live", "bearer": None,
     "busy": False, "lineage": 0},
    {"key": "plain live, busy", "state": "live", "bearer": None,
     "busy": True, "lineage": 0},
    {"key": "bearer live", "state": "live", "bearer": "knowledge",
     "busy": False, "lineage": 1},
    {"key": "bearer live, busy", "state": "live", "bearer": "knowledge",
     "busy": True, "lineage": 1},
    {"key": "bearer archived", "state": "archived", "bearer": "knowledge",
     "busy": False, "lineage": 1},
    {"key": "plain archived", "state": "archived", "bearer": None,
     "busy": False, "lineage": 0},
]

VIEW_W, VIEW_H = 1400, 460
NODE_W = NODE_H = 124


def card(c: dict, pre_fix: bool) -> str:
    """One card, built the way NodeSquare builds it.

    `pre_fix` restores the chip markup that shipped before this fix: ONE
    `badge dim` in which the bearer state stands in for the lifecycle state.
    The control has to restore that too — the defect was half markup and half
    stylesheet, and a control that only reverted the CSS would leave the chips
    already fixed and under-report.
    """
    cls = ["sq", c["state"], "norm", "tier-opus", "edge-b"]
    if c["busy"]:
        cls.append("busy")
    if c["bearer"]:
        cls.append("bearer")
    if c["lineage"]:
        cls.append("stack" + str(min(c["lineage"], 3)))
    if pre_fix:
        if c["bearer"]:
            state = "" if c["state"] == "live" else c["state"] + " · "
            chips = f"<span class='badge dim'>{state}{c['bearer']}</span>"
        elif c["state"] != "live":
            chips = f"<span class='badge dim'>{c['state']}</span>"
        else:
            chips = ""
    else:
        chips = ""
        if c["state"] != "live":
            chips += f"<span class='badge dim'>{c['state']}</span>"
        if c["bearer"]:
            chips += (f"<span class='badge bearermark'>{c['bearer']}</span>")
    return (
        f"<div class='{' '.join(cls)}' data-key=\"{c['key']}\" "
        f"style='position:relative;width:{NODE_W}px;height:{NODE_H}px'>"
        f"<div class='sq-head'>"
        f"<span class='tier t-opus'>O</span>"
        f"<span class='name'>inline-images@0</span>"
        f"</div>"
        f"<div class='sq-badges'>{chips}</div>"
        f"</div>")


def build_page(css: str, pre_fix: bool) -> str:
    """All six cards on one page, so every number is measured under the same
    stylesheet in the same paint — a difference between two of them cannot be
    an artefact of two different runs."""
    row = "".join(
        f"<div class='probe-cell'><div class='probe-label'>{c['key']}</div>"
        + card(c, pre_fix) + "</div>"
        for c in CARDS_UNDER_TEST)
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>\n"
        + css
        + (PRE_FIX_CSS if pre_fix else "")
        + "\n/* probe chrome only: never touches the rules under test */"
        "\n.probe-row{display:flex;gap:44px;padding:60px 34px;background:#1f1f1f}"
        "\n.probe-cell{display:flex;flex-direction:column;gap:12px}"
        "\n.probe-label{font:11px Consolas,monospace;color:#8a8a8a}"
        "\n</style></head><body style='margin:0;background:#1f1f1f'>"
        f"<div class='probe-row'>{row}</div></body></html>")


# Restores the PRE-FIX rules for --expect-fail. Appended last so it wins on
# specificity-tie/order. `.badge.bearermark` is not deleted (a stylesheet can
# only be appended to) — it is flattened back into exactly `badge dim`, which
# is what the bearer chip used to be.
PRE_FIX_CSS = """
/* ---- probe control: pre-fix rules, restored ---- */
.sq.bearer {
  background: #262628; border-color: #3a3a3c; border-top-color: #4a4a4c;
  opacity: .7;
}
.sq.bearer .name { color: var(--dim); }
.badge.bearermark {
  color: #7a7a7a; background: var(--input); border: 1px solid transparent;
}
"""

# Every declaration the fix is about, read off the element the browser actually
# painted. `border-left-color` stands for the ring colour: `.sq.busy` and
# `.sq.bearer` both set the `border-color` shorthand, and the left edge is the
# one no other rule touches (the top edge carries the tier stripe).
MEASURE = """
() => {
  const out = {};
  for (const sq of document.querySelectorAll('.sq')) {
    const cs = getComputedStyle(sq);
    const name = sq.querySelector('.name');
    const chips = [...sq.querySelectorAll('.sq-badges > *')].map((el) => {
      const c = getComputedStyle(el);
      return {cls: el.className, text: el.textContent.trim(),
              color: c.color, background: c.backgroundColor,
              borderColor: c.borderTopColor, borderStyle: c.borderTopStyle};
    });
    out[sq.dataset.key] = {
      opacity: cs.opacity,
      background: cs.backgroundColor,
      topColor: cs.borderTopColor,
      ringColor: cs.borderLeftColor,
      nameColor: name ? getComputedStyle(name).color : null,
      chips,
    };
  }
  return out;
}
"""


def run(css_text: str, pre_fix: bool, shot: str | None = None,
        verbose: bool = True):
    fd, page = tempfile.mkstemp(suffix=".html",
                                dir=str(FRONTEND / "node_modules"))
    os.close(fd)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page(viewport={"width": VIEW_W, "height": VIEW_H},
                            device_scale_factor=2)
            pathlib.Path(page).write_text(build_page(css_text, pre_fix),
                                          encoding="utf-8")
            pg.goto(pathlib.Path(page).as_uri())
            pg.wait_for_selector(".sq", timeout=8000)
            m = pg.evaluate(MEASURE)
            if shot:
                sp = pathlib.Path(shot)
                sp.parent.mkdir(parents=True, exist_ok=True)
                pg.locator(".probe-row").screenshot(path=str(sp))
            b.close()
    finally:
        os.unlink(page)

    missing = [c["key"] for c in CARDS_UNDER_TEST if c["key"] not in m]
    if missing:
        raise SystemExit(f"the fixture did not render {missing} — nothing "
                         f"below would mean anything")

    fails = []
    if verbose:
        print(f"  {'card':<20} {'opacity':>7}  {'background':<18} "
              f"{'tier stripe':<18} {'ring':<18}")
        print("  " + "-" * 88)
        for k, v in m.items():
            print(f"  {k:<20} {v['opacity']:>7}  {v['background']:<18} "
                  f"{v['topColor']:<18} {v['ringColor']:<18}")

    live, bl = m["plain live"], m["bearer live"]
    # ① A LIVE BEARER IS DRAWN LIKE A LIVE AGENT. Four declarations, named
    # separately so a failure says WHICH signal went missing rather than "the
    # cards differ".
    for prop, label in (("opacity", "the archived-style fade"),
                        ("background", "the card fill"),
                        ("topColor", "the tier stripe"),
                        ("ringColor", "the card border"),
                        ("nameColor", "the agent's name")):
        if live[prop] != bl[prop]:
            fails.append(
                f"a LIVE knowledge bearer differs from a plain live agent in "
                f"{prop} ({label}): bearer {bl[prop]!r} vs live {live[prop]!r}."
                f" This is the user's complaint — the card reads as retired.")

    # ② …INCLUDING WHILE IT IS WORKING. The busy border is the mark that says a
    # turn is running right now, and it is the one the user most needed.
    lbusy, bbusy = m["plain live, busy"], m["bearer live, busy"]
    if lbusy["ringColor"] != bbusy["ringColor"]:
        fails.append(
            f"a BUSY live bearer does not wear the running border: "
            f"{bbusy['ringColor']!r} vs a busy plain agent's "
            f"{lbusy['ringColor']!r}. An agent mid-turn must look mid-turn.")
    if lbusy["ringColor"] == live["ringColor"]:
        raise SystemExit(
            "the fixture's busy card is indistinguishable from its idle one, "
            "so check ② cannot fail and proves nothing — fix the fixture")

    # ③ THE BEARER MARK IS NOT THE ARCHIVED CHIP. Same slot, same row; if they
    # are drawn identically the card says "knowledge" in the voice it says
    # "archived", which is how this started.
    bmark = next((c for c in bl["chips"] if "bearermark" in c["cls"]), None)
    arch = next((c for c in m["plain archived"]["chips"]
                 if c["text"] == "archived"), None)
    if not bmark:
        fails.append(
            "the live bearer draws no bearer chip at all — the marking was "
            "supposed to be demoted, not dropped.")
    if not arch:
        raise SystemExit("the archived card drew no lifecycle chip, so check "
                         "③ has nothing to compare against — fix the fixture")
    if bmark and (bmark["color"], bmark["background"], bmark["borderStyle"]) \
            == (arch["color"], arch["background"], arch["borderStyle"]):
        fails.append(
            f"the bearer chip is styled exactly like the `archived` chip "
            f"(colour {bmark['color']}, fill {bmark['background']}, border "
            f"{bmark['borderStyle']}) — provenance is wearing the lifecycle's "
            f"clothes.")

    # ④ AN ARCHIVED BEARER STILL READS ARCHIVED. This is the other half of the
    # pair, and the thing a careless fix breaks: do not make every bearer look
    # alive in order to make the live one look alive.
    ba = m["bearer archived"]
    if ba["opacity"] == bl["opacity"] and ba["background"] == bl["background"]:
        fails.append(
            "an ARCHIVED knowledge bearer is drawn identically to a LIVE one "
            f"(opacity {ba['opacity']}, fill {ba['background']}) — the live "
            "case was fixed by making every bearer look alive.")
    if float(ba["opacity"]) >= float(live["opacity"]):
        fails.append(
            f"an archived bearer is no more faded than a live agent "
            f"({ba['opacity']} vs {live['opacity']}) — retired must still read "
            f"as retired.")

    # ⑤ …AND SAYS SO IN WORDS. The lifecycle chip used to be swallowed by the
    # bearer chip; an archived bearer must still show `archived` itself.
    if not any(c["text"] == "archived" for c in ba["chips"]):
        fails.append(
            f"an archived bearer's chips are {[c['text'] for c in ba['chips']]}"
            f" — none of them says `archived`, so the card states its "
            f"provenance and hides its lifecycle.")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true",
                    help="restore the pre-fix rules and markup; MUST fail")
    ap.add_argument("--shot", help="write a picture of all six cards")
    a = ap.parse_args()

    _check_fixture_still_matches_source()
    css = CSS.read_text(encoding="utf-8")
    if a.expect_fail:
        print("bearercard_probe: KNOWN-NEGATIVE CONTROL (pre-fix rules and "
              "chip markup restored)")
    else:
        print("bearercard_probe: measuring the shipped card")
    fails = run(css, pre_fix=a.expect_fail, shot=a.shot)

    if a.expect_fail:
        if fails:
            print(f"\n  CONTROL OK — the pre-fix card fails, as it must "
                  f"({len(fails)} finding(s)). The probe can see this defect.")
            for f in fails[:4]:
                print("   e.g. " + f)
            return 0
        print("\n  CONTROL FAILED: the pre-fix card measured CLEAN.")
        print("  This probe cannot see the defect it exists to catch, so a "
              "green run against the real sheet proves nothing.")
        return 1

    if fails:
        print(f"\n  {len(fails)} finding(s):")
        for f in fails:
            print("   - " + f)
        return 1
    print("\n  OK — a live knowledge bearer is drawn exactly like a live "
          "agent,\n  wears the running border while it works, carries a bearer "
          "mark that is\n  not the archived chip, and an archived bearer still "
          "reads as archived.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
