"""refchip_probe.py — does a canonical reference actually sit in the line?

A `.ref-chip` is a `button` written in the middle of a sentence, and the
sentences it appears in are inside `.settings` modals (the docket is one).
`.settings button` sets font-size 14px, padding 7px 15px and border-radius 6px
— so without a rule that beats it, a mid-sentence reference renders as a
rounded control roughly 35px tall punching a hole through the paragraph. The
shipped rule is `.ref-chip.ref-chip`, a DOUBLED class chosen for specificity
(0,2,0 beats 0,1,1) rather than for scoping.

That is a claim about a CASCADE, and it was reasoned, not measured. jsdom
cannot settle it: it computes no layout and no used values. This drives the
real component with the real sheet in Edge and asks the browser.

    python -B tests/refchip_probe.py                  # the shipped sheet
    python -B tests/refchip_probe.py --json out.json  # ...and keep the numbers
    python -B tests/refchip_probe.py --baseline       # the sheet BEFORE this
        # work (35e4afa:frontend/src/styles.css) — the red half; it MUST fail
    python -B tests/refchip_probe.py --mutant all     # KNOWN-NEGATIVE CONTROLS

WHAT IT CHECKS
  chrome-gone   the ready chip has no button chrome: padding 0 on all four
                sides, border 0, radius 0, transparent background
  in-the-line   the paragraph containing a chip is NO TALLER than the same
                sentence with no chip in it, and the chip's own box is within
                a pixel or two of the text's line box
  inline        `display: inline` — an inline-block would take the padding
                and the line box with it
  clickable     the READY chip is underlined with a pointer cursor; pending,
                absent, foreign and elsewhere are NOT underlined and do NOT
                get a pointer, because a chip that invites a click and does
                nothing is worse than one that explains itself
  why-visible   the one-word verdict after a failed reference is actually
                rendered (non-zero box), not merely present in the DOM
  no-separator  nothing in the surrounding container punctuates its children
                with a generated `::after`. A chip is two elements, so a
                container that does would paint a separator INSIDE one
                reference — the exact defect checklist-evidence measured in
                the turn-mail header on 2026-09-05, where `:not()`'s argument
                weight made a (0,2,0) suppression lose.

THE POSITIVE CONTROL IS IN THE PAGE, NOT IN THE ASSERTIONS. A bare `<button>`
sits in the same paragraph. If IT does not measure as button chrome, then
`.settings button` never applied in this run — the environment is wrong, not
the CSS — and the probe says so and fails rather than reporting a clean sheet.

Requires playwright with the msedge channel (same dependency as the other
probes in this folder).
"""
from __future__ import annotations

import argparse
import json
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
STYLES = FRONTEND / "src" / "styles.css"
BUILD = HERE / "refchip_build.mjs"

# ⚠ NAMED EXPLICITLY, NEVER `HEAD`. This is the tip of main this branch grew
# from, before any `.ref-chip` rule existed. Written as `HEAD:` it would BE
# the new sheet the moment this work was committed, and the control would pass
# while measuring the thing it was meant to disprove.
BASELINE_REV = "35e4afa"

# ----------------------------------------------------------------- mutants
# Each is an exact-once substitution on the CURRENT styles.css, applied in
# memory by the build script. Each targets one assertion.
MUTANTS: dict[str, tuple[str, str, str]] = {
    # (old, new, which check must go red)
    # ⚠ the anchor carries the first declaration line: ".ref-chip.ref-chip {"
    # alone appears THREE times (the reset, and the button/span rules), and the
    # build refuses a substitution that is not exactly once rather than
    # silently mutating the first one it finds.
    "single-class": (
        ".ref-chip.ref-chip {\n  font-family: var(--mono);",
        ".ref-chip {\n  font-family: var(--mono);",
        "chrome-gone/in-the-line: a single class loses to `.settings button`"),
    "inline-block": (
        "  appearance: none; display: inline; text-align: left;",
        "  appearance: none; display: inline-block; text-align: left;",
        "inline: an inline-block takes padding and the line box with it"),
    "inert-looks-live": (
        "span.ref-chip.ref-chip {\n"
        "  color: var(--dim); cursor: default; text-decoration: none;",
        "span.ref-chip.ref-chip {\n"
        "  color: var(--dim); cursor: pointer; text-decoration: underline;",
        "clickable: an inert outcome invites a click it will not answer"),
    "no-underline": (
        "button.ref-chip.ref-chip {\n"
        "  color: var(--accent); cursor: pointer;\n"
        "  text-decoration: underline; text-underline-offset: 2px;",
        "button.ref-chip.ref-chip {\n"
        "  color: var(--accent); cursor: pointer;",
        "clickable: the live chip is not marked as a link at all"),
    "why-hidden": (
        "  font-family: var(--sans, inherit); font-size: 0.85em; margin-left: 4px;\n"
        "  opacity: 0.75; font-style: italic;",
        "  font-family: var(--sans, inherit); font-size: 0.85em; margin-left: 4px;\n"
        "  opacity: 0.75; font-style: italic; display: none;",
        "why-visible: the verdict is in the DOM but not on the screen"),
    # the separator defect one panel over, reproduced here on purpose: if it
    # ever reaches a container of ours, `no-separator` must see it
    "separator": (
        ".ref-chip .ref-why {",
        ".docket-desc-body span:not(:last-child)::after { content: ' \\00b7 '; }\n"
        ".ref-chip .ref-why {",
        "no-separator: a generated separator is painted INSIDE a reference"),
}

LINES = ["ready", "plain", "control", "absent", "pending", "foreign",
         "elsewhere", "two"]

MEASURE = """
() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect();
    return { w: px(r.width), h: px(r.height), top: px(r.top) } };
  const out = { lines: {}, chips: {}, sep: {} };
  for (const id of %s) {
    const el = document.getElementById('line-' + id);
    if (!el) continue;
    out.lines[id] = box(el);
    const chip = el.querySelector('.ref-chip') || el.querySelector('#bare');
    if (!chip) continue;
    const cs = getComputedStyle(chip);
    const why = chip.querySelector('.ref-why');
    out.chips[id] = {
      tag: chip.tagName.toLowerCase(),
      display: cs.display, cursor: cs.cursor,
      decoration: cs.textDecorationLine,
      padTop: px(cs.paddingTop), padRight: px(cs.paddingRight),
      padBottom: px(cs.paddingBottom), padLeft: px(cs.paddingLeft),
      borderTop: px(cs.borderTopWidth), radius: px(cs.borderTopLeftRadius),
      bg: cs.backgroundColor, fontSize: px(cs.fontSize),
      ...box(chip),
      why: why ? box(why) : null,
      whyDisplay: why ? getComputedStyle(why).display : null,
    };
    // a generated separator anywhere around the chip or its parts
    const after = (n) => { const c = getComputedStyle(n, '::after').content;
      return (c && c !== 'none' && c !== 'normal') ? c : null };
    out.sep[id] = [...el.querySelectorAll('.ref-chip, .ref-chip *')]
      .map(after).filter(Boolean);
    // and the STRUCTURE that makes internal punctuation impossible: at most
    // one element child, and it is the last one
    out.chips[id].kids = chip.children.length;
    out.chips[id].lastKid = chip.children.length === 0
      || chip.children[chip.children.length - 1].classList.contains('ref-why');
  }
  return out;
}
""" % json.dumps(LINES)

TRANSPARENT = ("rgba(0, 0, 0, 0)", "transparent")


def build(outdir: pathlib.Path, source: str | None, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
    if source:
        args += ["--source", source]
    if mutant:
        old, new, _ = MUTANTS[mutant]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                          encoding="utf-8")
        json.dump([{"old": old, "new": new}], tmp)
        tmp.close()
        args += ["--subst", tmp.name]
    try:
        subprocess.run(["node", *args], check=True, cwd=str(FRONTEND))
    finally:
        if tmp:
            pathlib.Path(tmp.name).unlink(missing_ok=True)


def check(obs: dict) -> list[str]:
    fails: list[str] = []
    lines, chips, sep = obs["lines"], obs["chips"], obs["sep"]

    # ---- THE ENVIRONMENT CONTROL, FIRST. If the bare button is not wearing
    # `.settings button`'s chrome, this run cannot say anything about a rule
    # that exists to beat it.
    bare = chips.get("control")
    if not bare:
        return ["control: the bare button did not render — the page is wrong"]
    if bare["padLeft"] < 10 or bare["radius"] < 4:
        fails.append(
            "CONTROL FAILED: the bare button measured padding-left "
            f"{bare['padLeft']}px radius {bare['radius']}px — `.settings button` "
            "did not apply, so nothing here is a measurement of the cascade")
        return fails

    ready = chips.get("ready")
    if not ready:
        return fails + ["ready: no chip rendered in the measured line"]

    # ---- chrome-gone
    for side in ("padTop", "padRight", "padBottom", "padLeft"):
        if ready[side] != 0:
            fails.append(f"chrome-gone: the ready chip kept {side}={ready[side]}px "
                         f"(the bare control has padLeft={bare['padLeft']}px)")
    if ready["borderTop"] != 0:
        fails.append(f"chrome-gone: border {ready['borderTop']}px")
    if ready["radius"] != 0:
        fails.append(f"chrome-gone: border-radius {ready['radius']}px")
    if ready["bg"] not in TRANSPARENT:
        fails.append(f"chrome-gone: background {ready['bg']}")

    # ---- inline
    if ready["display"] != "inline":
        fails.append(f"inline: display is {ready['display']}, not inline")

    # ---- in-the-line: the sentence with the chip is no taller than the one
    # without it. THIS is the user-visible defect; the property checks above
    # only explain it.
    plain_h = lines["plain"]["h"]
    if lines["ready"]["h"] > plain_h + 0.5:
        fails.append(f"in-the-line: the line with a chip is {lines['ready']['h']}px, "
                     f"the same sentence without one is {plain_h}px")
    if ready["h"] > plain_h + 0.5:
        fails.append(f"in-the-line: the chip's own box is {ready['h']}px tall "
                     f"against a {plain_h}px line")
    # and the control line IS taller — the failure mode is real and reachable
    if lines["control"]["h"] <= plain_h + 0.5:
        fails.append("CONTROL FAILED: the bare button did not make its line "
                     "taller, so 'no taller' is not evidence of anything")

    # ---- clickable
    if "underline" not in ready["decoration"]:
        fails.append(f"clickable: the ready chip is not underlined "
                     f"({ready['decoration']})")
    if ready["cursor"] != "pointer":
        fails.append(f"clickable: the ready chip's cursor is {ready['cursor']}")
    for name in ("absent", "pending", "foreign", "elsewhere"):
        c = chips.get(name)
        if not c:
            fails.append(f"{name}: no chip rendered")
            continue
        if c["tag"] != "span":
            fails.append(f"{name}: rendered as <{c['tag']}>, not an inert span")
        if c["cursor"] == "pointer":
            fails.append(f"{name}: shows a pointer cursor — it looks clickable")
        if "underline" in c["decoration"]:
            fails.append(f"{name}: is underlined — it looks like a link")

    # ---- why-visible
    for name in ("absent", "pending", "foreign", "elsewhere"):
        c = chips.get(name)
        if not c:
            continue
        why = c["why"]
        if not why:
            fails.append(f"{name}: no verdict element after the token")
        elif why["w"] <= 0 or why["h"] <= 0:
            fails.append(f"{name}: the verdict is in the DOM but measures "
                         f"{why['w']}x{why['h']} — it is not on the screen")

    # ---- the structural half of no-separator. `AgentName` is two spans, so a
    # container that punctuates its children paints a separator BETWEEN the
    # model chip and the name it belongs to (measured by checklist-evidence,
    # 2026-09-05). A RefChip cannot suffer that as long as its only element
    # child is the LAST one — which is a structural fact, so it is asserted
    # rather than inferred from a page that happens not to punctuate.
    for name, c in chips.items():
        if name in ("plain", "control"):
            continue
        if c.get("kids", 0) > 1:
            fails.append(f"{name}: the chip has {c['kids']} element children — "
                         "a punctuating container would paint between them")
        if not c.get("lastKid", True):
            fails.append(f"{name}: the chip's verdict element is not last")

    # ---- no-separator
    for name, found in sep.items():
        if found:
            fails.append(f"no-separator: generated content around the {name} "
                         f"chip: {found}")
    return fails


def run(html: pathlib.Path, verbose: bool = True) -> tuple[list[str], dict]:
    errors: list[str] = []
    with sync_playwright() as p:
        br = p.chromium.launch(channel="msedge")
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(html.as_uri(), wait_until="load")
        pg.wait_for_selector(".ref-chip", state="attached", timeout=8000)
        obs = pg.evaluate(MEASURE)
        br.close()
    obs["errors"] = errors
    fails = check(obs)
    if errors:
        fails.append(f"page errors: {errors}")
    if verbose:
        for name in LINES:
            if name in obs["chips"]:
                print(f"  {name:<10} {json.dumps(obs['chips'][name])}")
    return fails, obs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", action="store_true",
                    help=f"measure {BASELINE_REV}'s styles.css — the red half")
    ap.add_argument("--source", help="another styles.css to bundle instead")
    ap.add_argument("--mutant", help="a MUTANTS key, or 'all' — each must FAIL")
    ap.add_argument("--json", help="write the observations here")
    a = ap.parse_args()

    out = FRONTEND / "node_modules" / ".orgtree-refchip"
    html = out / "probe.html"
    source = a.source

    if a.baseline:
        if source:
            raise SystemExit("--baseline and --source are the same slot")
        old = out.parent / ".orgtree-refchip-baseline.css"
        old.parent.mkdir(parents=True, exist_ok=True)
        blob = subprocess.run(
            ["git", "show", f"{BASELINE_REV}:frontend/src/styles.css"],
            cwd=str(FRONTEND.parent), capture_output=True, check=True).stdout
        old.write_bytes(blob)
        source = str(old)
        print(f"refchip_probe: BASELINE {BASELINE_REV} — this MUST fail")

    if a.mutant:
        names = list(MUTANTS) if a.mutant == "all" else [a.mutant]
        weak, report = [], {}
        for name in names:
            print(f"\nrefchip_probe: MUTANT {name} — {MUTANTS[name][2]}")
            build(out, None, name)
            fails, obs = run(html, verbose=False)
            report[name] = {"fails": fails, "obs": obs}
            if fails:
                print(f"  rejected ({len(fails)} finding(s)); e.g. {fails[0]}")
            else:
                print("  !! MEASURED CLEAN — the assertion this mutant targets "
                      "is decorative")
                weak.append(name)
        if a.json:
            pathlib.Path(a.json).write_text(json.dumps(report, indent=2),
                                            encoding="utf-8")
        if weak:
            print(f"\n  CONTROL FAILED: {weak} passed the probe.")
            return 1
        print(f"\n  CONTROLS OK — all {len(names)} mutant(s) rejected.")
        return 0

    label = f"--source {source}" if source else "the shipped stylesheet"
    print(f"refchip_probe: measuring {label}")
    build(out, source, None)
    fails, obs = run(html)
    if a.json:
        pathlib.Path(a.json).write_text(
            json.dumps({"source": source or str(STYLES), "fails": fails,
                        "obs": obs}, indent=2), encoding="utf-8")
    if fails:
        print(f"\n  {len(fails)} finding(s):")
        for f in fails:
            print("   - " + f)
        return 0 if a.baseline else 1
    if a.baseline:
        print("\n  !! THE BASELINE MEASURED CLEAN. The sheet from before this "
              "work styles the chips correctly, which means this probe is not "
              "measuring what it claims to.")
        return 1
    print("\n  OK — a reference sits inside the line: no button chrome, "
          "display inline,\n  the paragraph is no taller than the same sentence "
          "without it, the live chip\n  is underlined and the inert ones are not, "
          "and no generated separator is\n  painted inside a chip.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
