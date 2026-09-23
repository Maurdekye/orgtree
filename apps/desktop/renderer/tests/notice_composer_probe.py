"""Computed-style and geometry probe for the composer's notice controls.

These are VISUAL requirements, so a CSS text assertion is not evidence: it can
pin a declaration that renders as something else entirely. This renders the
real `styles.css` in a real Chromium and MEASURES the result.

Verifies:
1. PLACEMENT (user 2026-09-17: "place the notice message toggle above the file
   upload button, not beside it"). The toggle's rendered box sits ABOVE the
   attach button's — bottom above the other's top, sharing a horizontal centre
   — and the attach button still lands on the composer's bottom baseline,
   level with the send button, exactly where it was before the move.
2. COLOUR (user 2026-09-17: "make the outline on a notice enabled message box
   provider colored still, not grey"). The armed composer's border is DASHED —
   the same computed style as the notice mail card's flair edge, which is the
   sharing the earlier change introduced and this one keeps — but its computed
   colour is the PROVIDER's accent, for every provider, and is NOT the neutral
   notice grey. Focusing the textarea does not change it.
3. THE NOTICE MAIL CARD IS UNTOUCHED: its dashed edge keeps the neutral
   --notice-edge-color in both themes.
4. Both themes: the default charcoal dark and `.contrast-light`.
5. NEGATIVE CONTROLS. Every "is different" assertion is paired with a forced
   failure of the same measurement, so a check that silently stopped running
   cannot read as a pass.
6. A screenshot of the whole fixture, on request.

The fixture reproduces desk.tsx's composer markup. The REAL component's
structure is pinned separately, in jsdom, by noticetoggle.test.tsx — and §0
below re-reads desk.tsx to fail loudly if the two ever drift apart.
"""
import argparse
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS_PATH = HERE.parent / "src" / "styles.css"
DESK_PATH = HERE.parent / "src" / "canvas" / "desk.tsx"

# provider class -> the accent that class resolves --accent to, in both themes
PROVIDERS = {
    "prov-claude": "rgb(217, 119, 87)",       # #d97757
    "prov-openai": "rgb(34, 196, 189)",       # #22c4bd
    "prov-google": "rgb(80, 144, 245)",       # #5090f5
    "prov-openrouter": "rgb(118, 36, 244)",   # hsl(263.7 90.4% 54.9%)
}

COMPOSER = """
    <div class="cc-composer {armed}" id="{cid}">
      <div class="cc-btnstack">
        <button class="cc-notice-toggle {armed_btn}" title="Notice mode (Alt+N)">N</button>
        <button class="cc-attach" title="Attach file">+</button>
      </div>
      <textarea rows="2" id="{cid}-text">{text}</textarea>
      <button class="cc-send" title="Send">^</button>
    </div>
"""

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    {css}
    body {{
      margin: 0; padding: 24px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      display: flex; flex-direction: column; gap: 20px; max-width: 620px;
      background: var(--bg); color: var(--ink);
    }}
    .test-section {{ display: flex; flex-direction: column; gap: 12px; }}
    .section-title {{
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .05em; color: var(--dim);
    }}
  </style>
</head>
<body>
  <div class="test-section">
    <div class="section-title">Notice message card in a transcript (must not change)</div>
    <div class="turn-mail event-surface passive" id="bubble">
      <header class="turn-mail-head event-head">
        <b>coordinator-opus</b><time>12:45 PM</time>
        <span class="turn-mail-passive">no reply expected</span>
      </header>
      <div class="turn-mail-body">A passive notice. Its dashed edge stays neutral grey.</div>
    </div>
    <div class="turn-mail event-surface" id="ordinary-bubble">
      <header class="turn-mail-head event-head"><b>peer</b><time>12:46 PM</time></header>
      <div class="turn-mail-body">An ordinary mail card, for contrast.</div>
    </div>
  </div>

  <div class="test-section desk-body prov-claude">
    <div class="section-title">Composer armed for notice (Claude desk)</div>
    {armed_composer}
  </div>

  <div class="test-section desk-body prov-claude">
    <div class="section-title">Ordinary composer, same desk (unarmed reference)</div>
    {plain_composer}
  </div>

  <div class="test-section desk-body prov-openai">
    <div class="section-title">Composer armed for notice (Codex desk)</div>
    {openai_composer}
  </div>
</body>
</html>
"""

# Placement is geometry, not markup order: measure the rendered boxes.
PLACEMENT = """(cid) => {
  const composer = document.getElementById(cid)
  const toggle = composer.querySelector('.cc-notice-toggle')
  const attach = composer.querySelector('.cc-attach')
  const send = composer.querySelector('.cc-send')
  const r = el => { const b = el.getBoundingClientRect(); return {
    top: b.top, bottom: b.bottom, left: b.left, right: b.right,
    cx: (b.left + b.right) / 2, w: b.width, h: b.height } }
  return { toggle: r(toggle), attach: r(attach), send: r(send),
           composer: r(composer),
           stack: r(composer.querySelector('.cc-btnstack')) }
}"""

EDGES = """(cid) => {
  const el = document.getElementById(cid)
  const cs = getComputedStyle(el)
  return {
    style: cs.borderTopStyle, color: cs.borderTopColor, width: cs.borderTopWidth,
    leftStyle: cs.borderLeftStyle, leftColor: cs.borderLeftColor,
    padding: cs.padding, radius: cs.borderTopLeftRadius,
    accent: getComputedStyle(el).getPropertyValue('--accent').trim(),
  }
}"""

BUBBLE = """() => {
  const cs = getComputedStyle(document.getElementById('bubble'))
  const ord = getComputedStyle(document.getElementById('ordinary-bubble'))
  return { style: cs.borderLeftStyle, color: cs.borderLeftColor,
           width: cs.borderLeftWidth, background: cs.backgroundColor,
           ordinaryBackground: ord.backgroundColor,
           ordinaryStyle: ord.borderLeftStyle, ordinaryWidth: ord.borderLeftWidth }
}"""

# The neutral notice grey, resolved from the same tokens the card uses, so the
# probe never hard-codes a colour the theme is free to change.
NOTICE_GREY = """() => {
  const p = document.createElement('div')
  p.style.borderLeft = '3px solid var(--notice-edge-color)'
  document.body.appendChild(p)
  const c = getComputedStyle(p).borderLeftColor
  p.remove()
  return c
}"""


def measure(page) -> dict:
    out = {
        "bubble": page.evaluate(BUBBLE),
        "noticeGrey": page.evaluate(NOTICE_GREY),
        "placement": page.evaluate(PLACEMENT, "armed"),
        "plainPlacement": page.evaluate(PLACEMENT, "plain"),
        "armed": page.evaluate(EDGES, "armed"),
        "plain": page.evaluate(EDGES, "plain"),
        "armedOpenai": page.evaluate(EDGES, "armed-openai"),
        "providers": {},
    }
    # every provider class, measured on one armed composer that is re-dressed
    for cls in PROVIDERS:
        page.evaluate(
            """(cls) => {
              const d = document.getElementById('armed').closest('.desk-body')
              d.className = d.className.replace(/prov-\\S+/, cls)
            }""", cls)
        out["providers"][cls] = page.evaluate(EDGES, "armed")
    page.evaluate(
        """() => {
          const d = document.getElementById('armed').closest('.desk-body')
          d.className = d.className.replace(/prov-\\S+/, 'prov-claude')
        }""")
    return out


def run_probe(shot_prefix: str | None = None) -> dict:
    css_text = CSS_PATH.read_text(encoding="utf-8")
    html = HTML_TEMPLATE.format(
        css=css_text,
        armed_composer=COMPOSER.format(cid="armed", armed="notice-armed",
                                       armed_btn="armed", text="Ready to send a notice…"),
        plain_composer=COMPOSER.format(cid="plain", armed="", armed_btn="",
                                       text="An ordinary message…"),
        openai_composer=COMPOSER.format(cid="armed-openai", armed="notice-armed",
                                        armed_btn="armed", text="Ready to send a notice…"),
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 700, "height": 620})
        page.set_content(html)
        page.wait_for_timeout(120)

        dark = measure(page)
        page.focus("#armed-text")
        page.wait_for_timeout(50)
        focused = page.evaluate(EDGES, "armed")
        page.evaluate("() => document.activeElement.blur()")
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}-dark.png", full_page=True)

        # §5 negative control for the "is not grey" assertion: force the armed
        # composer's --accent BACK to the neutral notice grey and confirm the
        # same measurement now reports them equal. If this control does not
        # trip, the colour assertions below prove nothing.
        page.evaluate(
            """() => { document.getElementById('armed').style.setProperty(
                 '--accent', 'var(--notice-edge-color)') }""")
        page.wait_for_timeout(30)
        control_grey = page.evaluate(EDGES, "armed")
        page.evaluate("() => document.getElementById('armed').style.removeProperty('--accent')")

        # §5b negative control for the placement assertion: put the two buttons
        # back in a ROW and confirm "above" stops holding.
        page.evaluate(
            """() => { document.querySelector('#armed .cc-btnstack')
                 .style.flexDirection = 'row' }""")
        page.wait_for_timeout(30)
        control_beside = page.evaluate(PLACEMENT, "armed")
        page.evaluate(
            """() => { document.querySelector('#armed .cc-btnstack')
                 .style.removeProperty('flex-direction') }""")

        page.evaluate("() => document.documentElement.classList.add('contrast-light')")
        page.wait_for_timeout(80)
        light = measure(page)
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}-light.png", full_page=True)

        browser.close()
        return {"dark": dark, "light": light, "focused": focused,
                "controlGrey": control_grey, "controlBeside": control_beside}


def check_placement(where: str, m: dict) -> None:
    t, a, s, c = m["toggle"], m["attach"], m["send"], m["composer"]
    assert t["bottom"] <= a["top"] + 0.5, \
        f"{where}: the notice toggle must sit ABOVE the attach button ({t}, {a})"
    assert abs(t["cx"] - a["cx"]) < 0.5, \
        f"{where}: the two controls share a horizontal centre — one column, not a row ({t['cx']} vs {a['cx']})"
    assert t["w"] == a["w"] == 24 and t["h"] == a["h"] == 24, \
        f"{where}: neither button changed size ({t}, {a})"
    assert abs(a["bottom"] - s["bottom"]) < 0.5, \
        f"{where}: the attach button still rests on the composer baseline with send ({a}, {s})"
    assert abs(a["bottom"] - (c["bottom"] - 8)) < 1.5, \
        f"{where}: the baseline is the composer's own bottom padding edge ({a}, {c})"


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe the composer's notice controls")
    parser.add_argument("--shot", type=str, default=None,
                        help="write <prefix>-dark.png and <prefix>-light.png")
    args = parser.parse_args()

    # §0 the fixture must still describe the real composer
    desk = DESK_PATH.read_text(encoding="utf-8")
    stack = re.search(r'<div className="cc-btnstack">(.*?)\n        </div>', desk, re.S)
    assert stack, "desk.tsx no longer renders a .cc-btnstack — this probe's fixture is stale"
    assert stack.group(1).index("cc-notice-toggle") < stack.group(1).index("cc-attach"), \
        "desk.tsx renders the attach button before the notice toggle — the fixture is stale"

    results = run_probe(shot_prefix=args.shot)
    print(json.dumps(results, indent=2))

    for theme in ("dark", "light"):
        m = results[theme]
        grey = m["noticeGrey"]

        # §1 placement, in both themes (the stack is theme-independent, but a
        # theme that changed a padding would move the baseline)
        check_placement(f"{theme}/armed", m["placement"])
        check_placement(f"{theme}/plain", m["plainPlacement"])

        # §2 the armed composer: shared dashed STYLE, provider COLOUR
        assert m["armed"]["style"] == "dashed", f"{theme}: armed edge is {m['armed']['style']}, not dashed"
        assert m["armed"]["style"] == m["bubble"]["style"], \
            f"{theme}: armed edge style drifted from the notice card's ({m['armed']}, {m['bubble']})"
        assert m["armed"]["width"] == "1px", f"{theme}: armed border width is {m['armed']['width']}"
        assert m["armed"]["padding"] == m["plain"]["padding"], f"{theme}: arming shifted the composer's padding"
        assert m["armed"]["radius"] == m["plain"]["radius"], f"{theme}: arming changed the composer's corners"
        assert m["armed"]["color"] != grey, \
            f"{theme}: the armed edge is still the neutral notice grey ({m['armed']['color']})"
        assert m["armed"]["color"] == m["armed"]["accent"] or m["armed"]["color"] == PROVIDERS["prov-claude"], \
            f"{theme}: the armed edge is not the desk's provider accent ({m['armed']})"

        # every provider, not just the one on screen
        for cls, expected in PROVIDERS.items():
            got = m["providers"][cls]
            assert got["color"] == expected, f"{theme}/{cls}: armed edge is {got['color']}, expected {expected}"
            assert got["style"] == "dashed", f"{theme}/{cls}: armed edge is {got['style']}, not dashed"
            assert got["color"] != grey, f"{theme}/{cls}: armed edge is the neutral notice grey"
        # a second provider rendered simultaneously resolves independently
        assert m["armedOpenai"]["color"] == PROVIDERS["prov-openai"], \
            f"{theme}: a Codex desk's armed edge is {m['armedOpenai']['color']}"

        # §3 the notice mail card is untouched — still neutral, still dashed
        assert m["bubble"]["style"] == "dashed", f"{theme}: the notice card's edge is {m['bubble']['style']}"
        assert m["bubble"]["color"] == grey, \
            f"{theme}: the notice card's edge left the neutral token ({m['bubble']['color']} vs {grey})"
        assert m["bubble"]["width"] == "3px", f"{theme}: the notice card's edge is {m['bubble']['width']}"
        # and it is still the passive wash and the passive edge, both of which
        # an ORDINARY mail card in the same transcript does not have
        assert m["bubble"]["background"] != m["bubble"]["ordinaryBackground"], \
            f"{theme}: the notice card lost its passive background wash"
        assert (m["bubble"]["style"], m["bubble"]["width"]) != \
               (m["bubble"]["ordinaryStyle"], m["bubble"]["ordinaryWidth"]), \
            f"{theme}: the notice card's edge is no longer distinct from an ordinary card's"

        # the ORDINARY composer keeps its solid --line edge
        assert m["plain"]["style"] == "solid", f"{theme}: the unarmed composer is {m['plain']['style']}"

    # focusing must not change the armed edge at all
    f, d = results["focused"], results["dark"]["armed"]
    assert (f["style"], f["color"], f["width"]) == (d["style"], d["color"], d["width"]), \
        f"focus changed the armed edge: {f} vs {d}"

    # §5 the controls must have tripped
    assert results["controlGrey"]["color"] == results["dark"]["noticeGrey"], \
        "CONTROL FAILURE: forcing --accent to the notice grey did not make the edge grey — " \
        "the 'not grey' assertions above are vacuous"
    cb = results["controlBeside"]
    assert cb["toggle"]["bottom"] > cb["attach"]["top"] + 0.5, \
        "CONTROL FAILURE: a row-direction stack still measured as 'above' — " \
        "the placement assertions above are vacuous"

    print("\nALL INVARIANTS PASSED")


if __name__ == "__main__":
    main()
