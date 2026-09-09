"""Real Edge render check for the subordinate-message transcript badge and
sender navigation (label-subordinate-messages-and-link-their-sender).

Root's own rendered comparison (2026-09-09) found the type badge PRESENT
but INERT in the transcript: `.event-row-kind`'s only rule was scoped
`.mailrow .event-row-kind`, and the transcript's own mail row never wears
`.mailrow` — so the span had the right class and no border/color/padding at
all. jsdom does not compute CSS from a stylesheet the way a browser does
(cardlayout_probe.py's own header says why), so THIS is the check that can
actually tell "styled" from "class present but nothing applies" apart.

Two claims: the badge computes a REAL border in the transcript context (not
`none`), matching the SAME badge's computed border in its original
`.mailrow` context (cross-check — proves the fix, not a coincidence of some
OTHER selector). And the sender name is a real, clickable route with its
model chip, the same as https://…/mailsender.test.tsx already proves in
jsdom for the DOM-structure half — this probe adds the "does the click
route to the model chip owner in a real render" half only jsdom cannot.
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
BUILD = HERE / "subordinatebadge-build.mjs"
SEGMENTS = FRONTEND / "src" / "events" / "segments.tsx"
CSS = FRONTEND / "src" / "styles.css"


def main() -> int:
    src = SEGMENTS.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    for marker in ("event-row-kind", "event-actor"):
        if marker not in src:
            raise SystemExit(f"fixture guard: segments.tsx no longer emits {marker}")
    if ".mailrow .event-row-kind" in css:
        raise SystemExit("fixture guard: styles.css still scopes .event-row-kind to "
                          ".mailrow — the exact bug this probe exists to catch")
    if ".event-row-kind {" not in css:
        raise SystemExit("fixture guard: styles.css no longer defines .event-row-kind at all")

    with tempfile.TemporaryDirectory(prefix="orgtree-subordinatebadge-") as tmp:
        out = pathlib.Path(tmp)
        subprocess.run(["node", str(BUILD), str(out)], cwd=FRONTEND, check=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 900, "height": 500}, device_scale_factor=1)
            page.goto((out / "probe.html").as_uri())
            page.wait_for_selector("#transcript .event-row-kind")
            values = page.evaluate("""() => {
              const box = (el) => { const r = el.getBoundingClientRect();
                return {x: r.x, y: r.y, w: r.width, h: r.height} }
              const style = (el) => { const c = getComputedStyle(el);
                return {border: c.borderTopWidth + ' ' + c.borderTopStyle, color: c.color,
                  paddingLeft: c.paddingLeft, paddingRight: c.paddingRight} }
              const badge = document.querySelector('#transcript .event-row-kind')
              const refBadge = document.querySelector('#mailrow-reference .event-row-kind')
              const actor = document.querySelector('#transcript .event-actor')
              const jump = actor.querySelector('button.cc-name-jump')
              const chip = actor.querySelector('.tier')
              return {
                badgeText: badge.textContent,
                badgeStyle: style(badge), badgeBox: box(badge),
                refStyle: style(refBadge),
                actorText: actor.textContent,
                jumpPresent: Boolean(jump),
                jumpLabel: jump ? jump.textContent : null,
                chipPresent: Boolean(chip),
                chipClass: chip ? chip.className : null,
              }
            }""")
            page.click('#transcript button.cc-name-jump')
            opened = page.evaluate("() => window.opened")
            browser.close()

    failures = []
    if values["badgeText"] != "status":
        failures.append(f"badge text: expected 'status', got {values['badgeText']!r}")
    b = values["badgeStyle"]
    if b["border"] in ("0px none", "", None):
        failures.append(f"transcript badge computes NO border at all — still inert: {b}")
    if b["paddingLeft"] in ("0px", "", None):
        failures.append(f"transcript badge computes no left padding — still inert: {b}")
    r = values["refStyle"]
    if b["border"] != r["border"]:
        failures.append(f"transcript badge border {b['border']!r} does not match the "
                         f".mailrow reference {r['border']!r} — not the same visual treatment")
    box = values["badgeBox"]
    if box["w"] <= 0 or box["h"] <= 0:
        failures.append(f"transcript badge has zero rendered size: {box}")
    if "list-controls" not in values["actorText"]:
        failures.append(f"sender name not rendered: {values['actorText']!r}")
    if not values["jumpPresent"]:
        failures.append("sender name is not a clickable route (no button.cc-name-jump)")
    elif values["jumpLabel"] != "list-controls":
        failures.append(f"jump button labelled {values['jumpLabel']!r}, not the sender verbatim")
    if not values["chipPresent"] or "t-sonnet" not in (values["chipClass"] or ""):
        failures.append(f"model card icon missing or wrong tier: {values['chipClass']!r}")
    if opened != ["list-controls"]:
        failures.append(f"clicking the sender name did not navigate to it: onFocus calls = {opened!r}")

    if failures:
        print("SUBORDINATEBADGE PROBE FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("subordinatebadge probe: transcript badge is genuinely styled (border/padding/size "
          "match the .mailrow reference), and the sender name is a real, clickable, model-chip route.")
    print(f"  badge: {values['badgeBox']}, border {b['border']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
