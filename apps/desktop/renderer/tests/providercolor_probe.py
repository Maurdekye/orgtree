"""Real-browser check for provider color on far- and middle-zoom agent cards.

Run from frontend/:
  python tests/providercolor_probe.py
  python tests/providercolor_probe.py --expect-fail
  python tests/providercolor_probe.py --shot provider-cards.png

The negative control removes both overview cues. It must be detected; a probe
that merely reports a clean sheet is not evidence that the colors are visible.
"""

import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
CSS = (HERE.parent / "src" / "styles.css").read_text(encoding="utf-8")
CODEX = "rgb(34, 196, 189)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--shot")
    args = ap.parse_args()

    mutant = """
      .sq.mini { background-color: var(--panel) !important; }
      .sq.mini::before { width: 0 !important; }
      .sq.norm { border-color: var(--line) !important; }
      .sq.norm::before { box-shadow: none !important; }
    """ if args.expect_fail else ""

    html = f"""<!doctype html><style>{CSS}\n{mutant}
      body {{ margin: 30px; background: #1f1f1f; color: #e8e8e8; }}
      .row {{ display: flex; gap: 30px; align-items: flex-start; }}
      .zoomslot {{ width: 55px; height: 55px; }}
      .zoomslot.middle-slot {{ width: 100px; height: 100px; }}
      .sample {{ position: relative !important; width: 124px; height: 124px;
                 transform: scale(.4) !important; transform-origin: top left; }}
      .sample.middle {{ transform: scale(.75) !important; }}
      .caption {{ font: 13px sans-serif; margin: 8px 0 24px; }}
    </style>
    <div class="row">
      <div><div class="zoomslot"><div id="claude" class="sq mini tier-sol sample">
        <div class="mini-name">claude-agent</div></div></div>
        <div class="caption">Claude · overview</div></div>
      <div><div class="zoomslot"><div id="codex" class="sq mini tier-sol prov-openai sample">
        <div class="mini-name">codex-agent</div></div></div>
        <div class="caption">Codex · overview</div></div>
      <div><div class="zoomslot middle-slot"><div id="claudeNorm"
        class="sq norm tier-sol sample middle"><div class="mini-name">claude-agent</div>
        </div></div><div class="caption">Claude · middle</div></div>
      <div><div class="zoomslot middle-slot"><div id="codexNorm"
        class="sq norm tier-sol prov-openai sample middle"><div class="mini-name">codex-agent</div>
        </div></div><div class="caption">Codex · middle</div></div>
    </div>"""

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 650, "height": 240})
        page.set_content(html)
        values = page.evaluate("""() => {
          const read = (id) => {
            const el = document.getElementById(id)
            const s = getComputedStyle(el)
            const rail = getComputedStyle(el, '::before')
            return { surface: s.backgroundColor, border: s.borderLeftColor,
                     rail: rail.backgroundColor, railWidth: rail.width,
                     railContent: rail.content, glow: rail.boxShadow }
          }
          return { claude: read('claude'), codex: read('codex'),
                   claudeNorm: read('claudeNorm'), codexNorm: read('codexNorm') }
        }""")
        if args.shot:
            page.screenshot(path=args.shot)
        browser.close()

    failures = []
    for provider in ("claude", "codex"):
        v = values[provider]
        if v["surface"] in ("rgb(37, 37, 38)", "rgba(37, 37, 38, 1)"):
            failures.append(f"{provider} mini card has no provider wash")
        if v["railWidth"] != "6px":
            failures.append(f"{provider} rail is {v['railWidth']}, expected 6px")
    if values["claude"]["rail"] == values["codex"]["rail"]:
        failures.append("Claude and Codex rails resolve to the same color")
    if values["codex"]["rail"] != CODEX:
        failures.append(f"Codex rail is {values['codex']['rail']}, expected {CODEX}")
    if values["claude"]["surface"] == values["codex"]["surface"]:
        failures.append("Claude and Codex card washes resolve to the same color")
    for provider in ("claudeNorm", "codexNorm"):
        if values[provider]["glow"] == "none":
            failures.append(f"{provider} middle card has no provider glow")
    if values["claudeNorm"]["border"] == values["codexNorm"]["border"]:
        failures.append("Claude and Codex middle-card borders resolve to the same color")
    if values["claudeNorm"]["glow"] == values["codexNorm"]["glow"]:
        failures.append("Claude and Codex middle-card glows resolve to the same color")

    if args.expect_fail:
        if len(failures) < 2:
            print("FAIL — negative control was not detected")
            return 1
        print("OK — negative control detected:")
        for failure in failures:
            print(f"  · {failure}")
        return 0
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  · {failure}")
        return 1
    print("OK — far and middle cards carry distinct Claude orange / Codex #22c4bd teal cues")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
