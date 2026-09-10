"""pendparity_probe.py — pending messages render EXACTLY like transcript ones.

User report 2026-09-10 (post alpha.8): "pending messages still visually unlike
transcript" — after the shared MailMessage component landed, so the remaining
differences live where a jsdom structure test cannot see them: in the CASCADE.
The two surfaces mount identical card markup inside DIFFERENT wrappers
(.typed-input vs .pendrow/.pendghost), and a wrapper's own or inherited
computed style (white-space, fonts, backgrounds, widths, stacking gaps) is
only observable in a real browser.

So this renders the SAME rows through both REAL code paths (Msg for settled,
PendingMailRow/PendingGhostRow for pending — the components the desk itself
mounts) against the real styles.css in headless Edge, walks each settled/
pending card pair in lockstep, and diffs every element's computed visual
properties plus geometry. The contract:

  * the card subtrees are structurally identical (tags + classes, in order);
  * every element pair computes IDENTICAL visual style;
  * the cards start at the same x and the pending card gives up width ONLY
    to the pending-state chrome beside it (receipt tag / retract ✕ / ghost
    actions) — the one thing allowed to differ, because it is the metadata
    a settled row does not have;
  * two mails in one settled turn stack with the same gap two pending rows
    have, so a burst does not change shape when it delivers.

INSTRUMENT CONTROL: a style override is injected and must be DETECTED, so a
walker that silently compares nothing can never pass. Requires playwright
with the msedge channel (same dependency as cardlayout_probe.py).

Run:  python tests/pendparity_probe.py        (from apps/desktop/renderer)
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "pendparity-build.mjs"

# The visual vocabulary of "identical": paint, box, and typography. Layout
# mode props (display/flex) are included because a wrapper that changes them
# rearranges the same markup.
PROPS = [
    "background-color", "color", "opacity",
    "border-top-color", "border-top-style", "border-top-width",
    "border-right-color", "border-right-style", "border-right-width",
    "border-bottom-color", "border-bottom-style", "border-bottom-width",
    "border-left-color", "border-left-style", "border-left-width",
    "border-top-left-radius", "border-top-right-radius",
    "border-bottom-left-radius", "border-bottom-right-radius",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "font-family", "font-size", "font-style", "font-weight",
    "font-variant-numeric", "line-height", "letter-spacing",
    "text-transform", "text-align", "white-space", "overflow-wrap",
    "display", "flex-direction", "align-items", "justify-content",
    "row-gap", "column-gap",
]

# The ONE declared exemption: the pending-state chrome (receipt tag, retract
# ✕, ghost actions) is metadata a settled row does not have — its subtree is
# skipped, and NOTHING else may differ. Skipping is per-element, so a chrome
# class smeared onto a shared element would still be caught as structure.
CHROME = ".pend-tag, .pend-x, .ghost-acts"

WALK = """(sel) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const props = %s;
  const out = [];
  const visit = (el, path) => {
    if (el.matches('%s')) return;
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of props) style[p] = cs.getPropertyValue(p);
    const r = el.getBoundingClientRect();
    out.push({ path, tag: el.tagName, classes: [...el.classList].sort().join(' '),
               style, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
    [...el.children].forEach((c, i) => visit(c, path + '/' + i + ':' + c.tagName.toLowerCase()));
  };
  visit(root, '.');
  return out;
}"""


def compare(name: str, a: list, b: list, *, geometry: bool) -> list[str]:
    bad = []
    if a is None or b is None:
        return [f"{name}: a side did not render (settled={a is not None}, pending={b is not None})"]
    if len(a) != len(b):
        return [f"{name}: different element counts ({len(a)} vs {len(b)})"]
    for ea, eb in zip(a, b):
        who = f"{name} {ea['path']}"
        if (ea["tag"], ea["classes"]) != (eb["tag"], eb["classes"]):
            bad.append(f"{who}: structure differs — {ea['tag']}.{ea['classes']} vs {eb['tag']}.{eb['classes']}")
            continue
        for p in PROPS:
            if ea["style"][p] != eb["style"][p]:
                bad.append(f"{who} <{ea['tag'].lower()} class='{ea['classes']}'>: {p} = "
                           f"'{ea['style'][p]}' (settled) vs '{eb['style'][p]}' (pending)")
        if geometry and abs(ea["rect"]["x"] - eb["rect"]["x"]) > 1:
            bad.append(f"{who}: left edge differs by {abs(ea['rect']['x'] - eb['rect']['x']):.1f}px")
    return bad


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="orgtree-pendparity-") as tmp:
        out = pathlib.Path(tmp)
        subprocess.run(["node", str(BUILD), str(out)], cwd=FRONTEND, check=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 900, "height": 2400}, device_scale_factor=1)
            page.goto((out / "probe.html").as_uri())
            page.wait_for_selector("#pending .turn-mail")
            walk = WALK % (PROPS, CHROME)

            def cards(sel: str):
                return page.evaluate(walk, sel)

            # §1 card-for-card: receipt form and retract form against settled
            # (m3's pending copy carries a typed `ev` the settled row lacks —
            # the user's 2026-09-10 capture — and must still match)
            for i in range(4):
                s = cards(f'#settled .turn-mail[data-mail-id="m{i}"]')
                for form in ("pending", "retract"):
                    failures += compare(f"m{i}/{form}", s, cards(f'#{form} .turn-mail[data-mail-id="m{i}"]'),
                                        geometry=True)

            # §2 the ghost (fresh and failed): its CARD must match the settled
            # card of the same message — the failed dress lives on the wrapper
            s0 = cards('#settled .turn-mail[data-mail-id="m0"]')
            failures += compare("ghost", s0, cards('#ghost .pendghost:not(.failed) .turn-mail'), geometry=False)
            failures += compare("ghost/failed-card", s0, cards('#ghost .pendghost.failed .turn-mail'), geometry=False)

            # §3 width: a pending card spans EXACTLY the settled card's width —
            # the receipt rides the metadata strip instead of a side column
            geo = page.evaluate("""() => {
              const width = sel => document.querySelector(sel).getBoundingClientRect().width;
              return {
                settled: width('#settled .turn-mail[data-mail-id="m0"]'),
                pending: width('#pending .turn-mail[data-mail-id="m0"]'),
                retract: width('#retract .turn-mail[data-mail-id="m0"]'),
                ghost: width('#ghost .pendghost:not(.failed) .turn-mail'),
              };
            }""")
            for form in ("pending", "retract", "ghost"):
                if abs(geo["settled"] - geo[form]) > 1:
                    failures.append(f"§3: the {form} card is {geo['settled'] - geo[form]:.1f}px narrower "
                                    f"than its settled twin ({geo[form]:.1f} vs {geo['settled']:.1f})")
            # …and the receipt really is IN the strip, at its right end, not a column
            tag = page.evaluate("""() => {
              const tag = document.querySelector('#pending .turn-mail[data-mail-id="m0"] .turn-mail-head .pend-tag');
              if (!tag) return null;
              const t = tag.getBoundingClientRect();
              const card = tag.closest('.turn-mail').getBoundingClientRect();
              return { inStrip: true, right: card.right - t.right, top: t.top - card.top };
            }""")
            if not tag:
                failures.append("§3: the delivery receipt is no longer in the card's metadata strip")
            elif tag["right"] > 24 or tag["top"] > 24:
                failures.append(f"§3: the receipt is not at the card's top right "
                                f"(inset right {tag['right']:.1f}px, top {tag['top']:.1f}px)")

            # §4 stacking: a two-mail turn and two pending rows keep one rhythm
            gaps = page.evaluate("""() => {
              const rs = sel => [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect());
              const batch = rs('#settled-batch .turn-mail');
              const pend = rs('#pending .pendrow');
              return { batch: batch[1].top - batch[0].bottom, pend: pend[1].top - pend[0].bottom };
            }""")
            if abs(gaps["batch"] - gaps["pend"]) > 1:
                failures.append(f"§4: stacking gap differs — settled batch {gaps['batch']:.1f}px vs pending {gaps['pend']:.1f}px")

            # §C the instrument must be able to fail: a deliberate skew on the
            # pending side has to surface in the same comparison
            page.evaluate("""() => { const s = document.createElement('style');
              s.id = 'skew'; s.textContent = '#pending .turn-mail { padding-top: 17px !important; }';
              document.head.appendChild(s); }""")
            control = compare("control", cards('#settled .turn-mail[data-mail-id="m0"]'),
                              cards('#pending .turn-mail[data-mail-id="m0"]'), geometry=False)
            page.evaluate("() => document.querySelector('#skew').remove()")
            if not control:
                failures.append("CONTROL FAILURE: an injected padding skew went undetected — the diff is vacuous")

            page.screenshot(path=str(HERE / "pendparity-evidence.png"), full_page=True)
            browser.close()

    if failures:
        print(f"pendparity_probe: {len(failures)} difference(s)")
        for f in failures:
            print("  ✖ " + f)
        return 1
    print("pendparity_probe: PASS — pending and settled cards compute identical styles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
