"""Real-browser colour contract for the header's live-agent model counts.

    python -B tests/header_tier_probe.py
    python -B tests/header_tier_probe.py --expect-fail

The header is an inventory by model tier. Each count must keep its tier colour
for Codex (Reserve/Luna/Terra/Sol) and Antigravity (Flash/Pro), just as it does on
cards. The negative control removes only those six colour rules and must be
caught.
"""

import argparse
import pathlib

from playwright.sync_api import sync_playwright


CSS = pathlib.Path(__file__).resolve().parents[1] / "src" / "styles.css"
EXPECTED = {
    "gpt-reserve": "rgb(155, 183, 220)",
    "luna": "rgb(155, 183, 220)",
    "terra": "rgb(127, 174, 95)",
    "sol": "rgb(255, 138, 61)",
    "flash": "rgb(174, 226, 249)",
    "pro": "rgb(107, 69, 214)",
}
CONTROL = """
.chip.agents b.t-gpt-reserve, .chip.agents b.t-luna, .chip.agents b.t-terra, .chip.agents b.t-sol,
.chip.agents b.t-flash, .chip.agents b.t-pro { color: var(--ink) !important; }
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    args = ap.parse_args()
    html = "<span class='chip agents'>" + "".join(
        f"<b class='t-{tier}'>{tier[0].upper()}1</b>" for tier in EXPECTED
    ) + "</span>"
    css = CSS.read_text(encoding="utf-8") + (CONTROL if args.expect_fail else "")

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.set_content(f"<style>{css}</style>{html}")
        got = page.evaluate("""() => Object.fromEntries(
          [...document.querySelectorAll('.chip.agents b')].map((el) => [
            [...el.classList].find((c) => c.startsWith('t-')).slice(2),
            getComputedStyle(el).color,
          ])
        )""")
        browser.close()

    failures = [
        f"{tier} is {got.get(tier)}, expected {colour}"
        for tier, colour in EXPECTED.items() if got.get(tier) != colour
    ]
    if args.expect_fail:
        if len(failures) != len(EXPECTED):
            print("CONTROL FAILED — removing provider-tier header colours escaped detection")
            return 1
        print("CONTROL OK — removing all Codex/Antigravity header tier colours was detected")
        return 0
    if failures:
        print("\n".join("FAIL: " + failure for failure in failures))
        return 1
    print("OK — Codex and Antigravity header model counts use their tier colours")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
