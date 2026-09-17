"""Visual and computed-style probe for notice-mode composer border.

Verifies:
1. .turn-mail.passive and .cc-composer.notice-armed share the exact notice flair edge
   (dashed style and color-mix(--dim 55%, --line) color).
2. .cc-composer.notice-armed maintains 1px border width and 7px 9px padding (no layout shift).
3. Both dark theme and light theme resolve correctly.
4. Generates a visual screenshot showing a notice bubble and notice-armed composer in the same view.
"""
import argparse
import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS_PATH = HERE.parent / "src" / "styles.css"

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    {css}
    body {{
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 20px;
      max-width: 600px;
    }}
    .test-section {{
      display: flex;
      flex-direction: column;
      gap: 12px;
    }}
    .section-title {{
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--dim);
    }}
  </style>
</head>
<body>
  <div class="test-section">
    <div class="section-title">Notice message bubble in transcript</div>
    <div class="turn-mail event-surface passive" data-mail-id="m1">
      <header class="turn-mail-head event-head">
        <b>coordinator-opus</b>
        <span class="tier">opus</span>
        <time>12:45 PM</time>
        <span class="turn-mail-passive">no reply expected</span>
      </header>
      <div class="turn-mail-body">
        <div class="turn-mail-preview">
          <div class="turn-mail-preview-content">
            Status notice: all acceptance checks verified. Notice flair edge is dashed neutral.
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="test-section">
    <div class="section-title">Composer in notice mode (armed)</div>
    <div class="cc-composer notice-armed" id="armed-composer">
      <button class="cc-attach" title="Attach file">+</button>
      <button class="cc-notice-toggle armed" title="Notice mode (Alt+N)">🔔</button>
      <textarea rows="1" id="composer-text">Ready to dispatch passive notice to coordinator-opus...</textarea>
      <button class="cc-send" title="Send notice">↑</button>
    </div>
  </div>

  <div class="test-section">
    <div class="section-title">Ordinary composer (unarmed reference)</div>
    <div class="cc-composer" id="plain-composer">
      <button class="cc-attach" title="Attach file">+</button>
      <button class="cc-notice-toggle" title="Notice mode (Alt+N)">🔔</button>
      <textarea rows="1" placeholder="Type a message...">Ordinary message...</textarea>
      <button class="cc-send" title="Send" disabled>↑</button>
    </div>
  </div>
</body>
</html>
"""


def run_probe(shot_path: str | None = None) -> dict:
    css_text = CSS_PATH.read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 700, "height": 480})
        html = HTML_TEMPLATE.format(css=css_text)
        page.set_content(html)
        page.wait_for_timeout(100)

        # Measure in default dark theme
        eval_script = """() => {
          const bubble = document.querySelector('.turn-mail.passive')
          const armed = document.querySelector('#armed-composer')
          const plain = document.querySelector('#plain-composer')
          const csBubble = window.getComputedStyle(bubble)
          const csArmed = window.getComputedStyle(armed)
          const csPlain = window.getComputedStyle(plain)

          return {
            bubble: {
              borderLeftStyle: csBubble.borderLeftStyle,
              borderLeftColor: csBubble.borderLeftColor,
              borderLeftWidth: csBubble.borderLeftWidth,
            },
            armed: {
              borderTopStyle: csArmed.borderTopStyle,
              borderLeftStyle: csArmed.borderLeftStyle,
              borderTopColor: csArmed.borderTopColor,
              borderLeftColor: csArmed.borderLeftColor,
              borderTopWidth: csArmed.borderTopWidth,
              borderLeftWidth: csArmed.borderLeftWidth,
              padding: csArmed.padding,
            },
            plain: {
              borderTopStyle: csPlain.borderTopStyle,
              borderLeftStyle: csPlain.borderLeftStyle,
              borderTopColor: csPlain.borderTopColor,
              borderLeftColor: csPlain.borderLeftColor,
              borderTopWidth: csPlain.borderTopWidth,
              borderLeftWidth: csPlain.borderLeftWidth,
              padding: csPlain.padding,
            }
          }
        }"""
        dark_measurements = page.evaluate(eval_script)

        # Focus inside armed composer and re-measure
        page.focus("#composer-text")
        page.wait_for_timeout(50)
        focus_measurements = page.evaluate("""() => {
          const armed = document.querySelector('#armed-composer')
          const cs = window.getComputedStyle(armed)
          return {
            borderTopStyle: cs.borderTopStyle,
            borderTopColor: cs.borderTopColor,
            borderTopWidth: cs.borderTopWidth,
          }
        }""")

        # Take screenshot if requested
        if shot_path:
            page.screenshot(path=shot_path, full_page=True)

        # Test in contrast-light theme
        page.evaluate("() => document.documentElement.classList.add('contrast-light')")
        page.wait_for_timeout(50)
        light_measurements = page.evaluate(eval_script)

        browser.close()

        return {
            "dark": dark_measurements,
            "focused": focus_measurements,
            "light": light_measurements,
        }


def main():
    parser = argparse.ArgumentParser(description="Probe notice border styling")
    parser.add_argument("--shot", type=str, default=None, help="Save screenshot to PNG")
    args = parser.parse_args()

    results = run_probe(shot_path=args.shot)
    print(json.dumps(results, indent=2))

    # Assertions
    dark = results["dark"]
    assert dark["bubble"]["borderLeftStyle"] == "dashed", f"bubble style: {dark['bubble']}"
    assert dark["armed"]["borderLeftStyle"] == "dashed", f"armed style: {dark['armed']}"
    assert dark["armed"]["borderTopStyle"] == "dashed", f"armed top style: {dark['armed']}"
    assert dark["armed"]["borderLeftColor"] == dark["bubble"]["borderLeftColor"], (
        f"color mismatch: armed={dark['armed']['borderLeftColor']} bubble={dark['bubble']['borderLeftColor']}"
    )
    assert dark["armed"]["borderLeftWidth"] == "1px", f"armed border width is {dark['armed']['borderLeftWidth']}"
    assert dark["armed"]["padding"] == dark["plain"]["padding"], "padding shifted on notice mode"

    # Focus within stays dashed and same color
    focused = results["focused"]
    assert focused["borderTopStyle"] == "dashed", f"focused style: {focused}"
    assert focused["borderTopColor"] == dark["bubble"]["borderLeftColor"], f"focused color: {focused}"

    # Light theme matches between bubble and composer
    light = results["light"]
    assert light["bubble"]["borderLeftStyle"] == "dashed", f"light bubble style: {light['bubble']}"
    assert light["armed"]["borderLeftStyle"] == "dashed", f"light armed style: {light['armed']}"
    assert light["armed"]["borderLeftColor"] == light["bubble"]["borderLeftColor"], (
        f"light color mismatch: armed={light['armed']['borderLeftColor']} bubble={light['bubble']['borderLeftColor']}"
    )

    print("\nALL INVARIANTS PASSED!")


if __name__ == "__main__":
    main()
