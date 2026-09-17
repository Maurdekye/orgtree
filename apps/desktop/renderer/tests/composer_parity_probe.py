"""Computed-style and geometry probe for the REPLY composer's notice controls.

Sibling of notice_composer_probe.py, which does the same job for the desk
composer (`.cc-composer`). This one covers the three composers that gained the
toggle on 2026-09-17 — mail reply, ticket reply, presentation reply — all of
which are the one component, `MailReplyBox`, rendering `.mail-reply`.

These are VISUAL requirements, so a CSS text assertion is not evidence: it can
pin a declaration that renders as something else entirely. jsdom is no better
— it has no layout and no cascade at all. This renders the real `styles.css`
in a real Chromium and MEASURES the result.

Verifies:
1. PLACEMENT. The toggle's rendered box sits ABOVE the attach button's —
   bottom above the other's top, sharing a horizontal centre — and the attach
   button still lands on the composer's bottom baseline, level with the reply
   button, so adding the toggle moved nothing that was already there.
2. NO BLANK BAND ABOVE THE TEXT. The button column is now 52px and the
   composer is `align-items: flex-end`, so without `.mail-reply textarea {
   align-self: flex-start }` the shorter draft is pushed to the bottom and the
   text floats below a gap — the exact complaint that was fixed in the desk
   composer the same day. Measured as the distance from the composer's content
   top to the textarea's top, which must be ~0.
3. THE ARMED EDGE. Dashed (the shared --notice-edge-style token, so it can
   never drift from the notice mail card's flair), the width and padding
   unchanged from the unarmed box, and its colour the ACCENT rather than the
   neutral notice grey — measured per provider inside a desk, and at the root
   for the modals that are not inside one.
4. THE TWO ARMED COMPOSERS MATCH. `.mail-reply.notice-armed` and
   `.cc-composer.notice-armed` are measured side by side and must report the
   same style, width and colour: one notice edge in the product, not two.
5. Both themes: the default charcoal dark and `.contrast-light`.
6. NEGATIVE CONTROLS, run and reported. Every "is different" and every
   "is above" assertion is paired with a forced failure of the SAME
   measurement, so a check that silently stopped running cannot read as a
   pass.
7. A screenshot of the whole fixture, on request.

NOT PROVED HERE: that the attachment glyph is the same drawing everywhere.
That is a React/MUI fact, not a CSS one, and it is proved in jsdom by
composerparity.test.tsx §1/§1b/§1c, which compares the rendered SVG path data
of the real components.

The fixture reproduces mail.tsx's `.mail-reply` markup. The REAL component's
structure is pinned in jsdom by composerparity.test.tsx — and §0 below
re-reads mail.tsx to fail loudly if the two ever drift apart.

Run:  python apps/desktop/renderer/tests/composer_parity_probe.py [--shot p]
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
MAIL_PATH = HERE.parent / "src" / "canvas" / "mail.tsx"

# provider class -> the accent that class resolves --accent to, in both themes
PROVIDERS = {
    "prov-claude": "rgb(217, 119, 87)",       # #d97757
    "prov-openai": "rgb(34, 196, 189)",       # #22c4bd
    "prov-google": "rgb(80, 144, 245)",       # #5090f5
    "prov-openrouter": "rgb(118, 36, 244)",   # hsl(263.7 90.4% 54.9%)
}

REPLY = """
    <div class="mail-reply {armed}" id="{cid}">
      <div class="cc-btnstack">
        <button class="cc-notice-toggle {armed_btn}" title="Notice mode (Alt+N)">N</button>
        <button class="cc-attach" title="Attach file">+</button>
      </div>
      <textarea rows="2" id="{cid}-text">{text}</textarea>
      <button class="mail-reply-send">reply</button>
    </div>
"""

# the desk composer, for the side-by-side edge comparison in §4
DESK = """
    <div class="cc-composer notice-armed" id="desk-armed">
      <div class="cc-btnstack">
        <button class="cc-notice-toggle armed">N</button>
        <button class="cc-attach">+</button>
      </div>
      <textarea rows="2">Ready to send a notice…</textarea>
      <button class="cc-send">^</button>
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
  </div>

  <div class="test-section desk-body prov-claude">
    <div class="section-title">Ticket / mail / presentation reply, armed (Claude desk)</div>
    {armed_reply}
  </div>

  <div class="test-section desk-body prov-claude">
    <div class="section-title">The same reply box, unarmed (reference)</div>
    {plain_reply}
  </div>

  <div class="test-section desk-body prov-claude">
    <div class="section-title">The DESK composer, armed — the edge these must match</div>
    {desk_composer}
  </div>

  <div class="test-section">
    <div class="section-title">Armed reply OUTSIDE any desk (a modal: docket, inbox)</div>
    {root_reply}
  </div>
</body>
</html>
"""

# Placement is geometry, not markup order: measure the rendered boxes.
PLACEMENT = """(cid) => {
  const box = document.getElementById(cid)
  const toggle = box.querySelector('.cc-notice-toggle')
  const attach = box.querySelector('.cc-attach')
  const send = box.querySelector('.mail-reply-send')
  const text = box.querySelector('textarea')
  const cs = getComputedStyle(box)
  const r = el => { const b = el.getBoundingClientRect(); return {
    top: b.top, bottom: b.bottom, left: b.left, right: b.right,
    cx: (b.left + b.right) / 2, w: b.width, h: b.height } }
  const b = box.getBoundingClientRect()
  return { toggle: r(toggle), attach: r(attach), send: r(send), text: r(text),
           box: r(box), stack: r(box.querySelector('.cc-btnstack')),
           padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom),
           borderTop: parseFloat(cs.borderTopWidth),
           // the gap the user complained about: content top -> first line
           gapAboveText: r(text).top - (b.top + parseFloat(cs.borderTopWidth)
                                        + parseFloat(cs.paddingTop)) }
}"""

EDGES = """(cid) => {
  const el = document.getElementById(cid)
  const cs = getComputedStyle(el)
  return {
    style: cs.borderTopStyle, color: cs.borderTopColor, width: cs.borderTopWidth,
    padding: cs.padding, radius: cs.borderTopLeftRadius,
    accent: cs.getPropertyValue('--accent').trim(),
  }
}"""

BUBBLE = """() => {
  const cs = getComputedStyle(document.getElementById('bubble'))
  return { style: cs.borderLeftStyle, color: cs.borderLeftColor,
           width: cs.borderLeftWidth }
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
        "rootPlacement": page.evaluate(PLACEMENT, "root-armed"),
        "armed": page.evaluate(EDGES, "armed"),
        "plain": page.evaluate(EDGES, "plain"),
        "rootArmed": page.evaluate(EDGES, "root-armed"),
        "deskArmed": page.evaluate(EDGES, "desk-armed"),
        "providers": {},
    }
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
        armed_reply=REPLY.format(cid="armed", armed="notice-armed",
                                 armed_btn="armed", text="Ready to send a notice…"),
        plain_reply=REPLY.format(cid="plain", armed="", armed_btn="",
                                 text="An ordinary reply…"),
        root_reply=REPLY.format(cid="root-armed", armed="notice-armed",
                                armed_btn="armed", text="Ready to send a notice…"),
        desk_composer=DESK,
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 700, "height": 760})
        page.set_content(html)
        page.wait_for_timeout(120)

        dark = measure(page)
        page.focus("#armed-text")
        page.wait_for_timeout(50)
        focused = page.evaluate(EDGES, "armed")
        page.evaluate("() => document.activeElement.blur()")
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}-dark.png", full_page=True)

        # §6a control for "the armed edge is not the neutral notice grey":
        # force --accent back to the grey and confirm the same measurement now
        # reports them equal. If this does not trip, §3's colour check is
        # proving nothing.
        page.evaluate(
            """() => { document.getElementById('armed').style.setProperty(
                 '--accent', 'var(--notice-edge-color)') }""")
        page.wait_for_timeout(30)
        control_grey = page.evaluate(EDGES, "armed")
        page.evaluate("() => document.getElementById('armed').style.removeProperty('--accent')")

        # §6b control for "the toggle is ABOVE attach": put them back in a ROW.
        page.evaluate(
            """() => { document.querySelector('#armed .cc-btnstack')
                 .style.flexDirection = 'row' }""")
        page.wait_for_timeout(30)
        control_beside = page.evaluate(PLACEMENT, "armed")
        page.evaluate(
            """() => { document.querySelector('#armed .cc-btnstack')
                 .style.removeProperty('flex-direction') }""")

        # §6c control for "no blank band above the text": take the textarea's
        # align-self away and confirm the gap comes back.
        page.evaluate(
            """() => { document.querySelector('#armed textarea')
                 .style.alignSelf = 'auto' }""")
        page.wait_for_timeout(30)
        control_gap = page.evaluate(PLACEMENT, "armed")
        page.evaluate(
            """() => { document.querySelector('#armed textarea')
                 .style.removeProperty('align-self') }""")

        page.evaluate("() => document.documentElement.classList.add('contrast-light')")
        page.wait_for_timeout(80)
        light = measure(page)
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}-light.png", full_page=True)

        browser.close()
        return {"dark": dark, "light": light, "focused": focused,
                "controlGrey": control_grey, "controlBeside": control_beside,
                "controlGap": control_gap}


def check_placement(where: str, m: dict) -> None:
    t, a, s, b = m["toggle"], m["attach"], m["send"], m["box"]
    assert t["bottom"] <= a["top"] + 0.5, \
        f"{where}: the notice toggle must sit ABOVE the attach button ({t}, {a})"
    assert abs(t["cx"] - a["cx"]) < 0.5, \
        f"{where}: the two controls share a horizontal centre — one column, not a row ({t['cx']} vs {a['cx']})"
    assert t["w"] == a["w"] == 24 and t["h"] == a["h"] == 24, \
        f"{where}: neither button is the agreed 24px circle ({t}, {a})"
    assert abs(a["bottom"] - s["bottom"]) < 0.5, \
        f"{where}: the attach button no longer rests on the composer baseline "\
        f"with the reply button ({a}, {s})"
    assert abs(a["bottom"] - (b["bottom"] - m["padBottom"] - m["borderTop"])) < 1.5, \
        f"{where}: that baseline is the composer's own bottom padding edge ({a}, {b})"
    assert m["gapAboveText"] < 1.0, \
        f"{where}: {m['gapAboveText']:.2f}px of blank space above the first line "\
        f"of text — the draft must start at the composer's content top"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Probe the reply composer's notice controls")
    parser.add_argument("--shot", type=str, default=None,
                        help="write <prefix>-dark.png and <prefix>-light.png")
    args = parser.parse_args()

    # §0 the fixture must still describe the real reply box
    mail = MAIL_PATH.read_text(encoding="utf-8")
    stack = re.search(r'<div className="cc-btnstack">(.*?)\n        </div>', mail, re.S)
    assert stack, "mail.tsx no longer renders a .cc-btnstack — this probe's fixture is stale"
    assert stack.group(1).index("cc-notice-toggle") < stack.group(1).index("cc-attach"), \
        "mail.tsx renders the attach button before the notice toggle — the fixture is stale"
    assert "'mail-reply' + (noticeArmed && notice ? ' notice-armed' : '')" in mail, \
        "mail.tsx no longer puts `notice-armed` on `.mail-reply` — the fixture is stale"

    results = run_probe(shot_prefix=args.shot)
    print(json.dumps(results, indent=2))

    for theme in ("dark", "light"):
        m = results[theme]
        grey = m["noticeGrey"]

        # §1 + §2 placement and the blank band, in both themes and in both
        # hosts (inside a desk, and in a modal that is not inside one)
        check_placement(f"{theme}/armed", m["placement"])
        check_placement(f"{theme}/plain", m["plainPlacement"])
        check_placement(f"{theme}/root", m["rootPlacement"])

        # §3 the armed edge: shared dashed STYLE, accent COLOUR
        assert m["armed"]["style"] == "dashed", \
            f"{theme}: armed edge is {m['armed']['style']}, not dashed"
        assert m["armed"]["style"] == m["bubble"]["style"], \
            f"{theme}: armed edge style drifted from the notice card's ({m['armed']}, {m['bubble']})"
        assert m["armed"]["width"] == "1px", \
            f"{theme}: armed border width is {m['armed']['width']}"
        assert m["armed"]["padding"] == m["plain"]["padding"], \
            f"{theme}: arming shifted the composer's padding"
        assert m["armed"]["radius"] == m["plain"]["radius"], \
            f"{theme}: arming changed the composer's corners"
        assert m["armed"]["color"] != grey, \
            f"{theme}: the armed edge is the neutral notice grey ({m['armed']['color']})"
        assert m["armed"]["color"] == m["armed"]["accent"] \
            or m["armed"]["color"] == PROVIDERS["prov-claude"], \
            f"{theme}: the armed edge is not the accent ({m['armed']})"
        assert m["rootArmed"]["color"] != grey and m["rootArmed"]["style"] == "dashed", \
            f"{theme}: outside a desk the armed edge lost its treatment ({m['rootArmed']})"

        # every provider, not just the one on screen
        for cls, expected in PROVIDERS.items():
            got = m["providers"][cls]
            assert got["color"] == expected, \
                f"{theme}/{cls}: armed edge is {got['color']}, expected {expected}"
            assert got["style"] == "dashed", f"{theme}/{cls}: {got}"

        # §4 the two armed composers wear the SAME edge
        for k in ("style", "width", "color"):
            assert m["armed"][k] == m["deskArmed"][k], \
                f"{theme}: the reply composer's armed {k} ({m['armed'][k]}) differs from " \
                f"the desk composer's ({m['deskArmed'][k]}) — there is one notice edge"

        # the unarmed box is untouched: solid, and NOT the accent
        assert m["plain"]["style"] == "solid", f"{theme}: unarmed edge is {m['plain']['style']}"

    # focusing the draft must not wash the armed colour away
    assert results["focused"]["color"] == results["dark"]["armed"]["color"], \
        f"focus changed the armed edge colour: {results['focused']}"
    assert results["focused"]["style"] == "dashed", results["focused"]

    # §6 THE CONTROLS — each must report the failure it was built to force
    assert results["controlGrey"]["color"] == results["dark"]["noticeGrey"], \
        "NEGATIVE CONTROL DID NOT TRIP: forcing --accent to the notice grey did " \
        f"not make the armed edge grey ({results['controlGrey']}) — the colour " \
        "assertions above are not measuring what they claim"
    cb = results["controlBeside"]
    assert not (cb["toggle"]["bottom"] <= cb["attach"]["top"] + 0.5), \
        "NEGATIVE CONTROL DID NOT TRIP: the two buttons were forced back into a " \
        f"ROW and 'above' still held ({cb['toggle']}, {cb['attach']})"
    cg = results["controlGap"]
    assert cg["gapAboveText"] > 1.0, \
        "NEGATIVE CONTROL DID NOT TRIP: align-self was removed and the text still " \
        f"started at the content top (gap {cg['gapAboveText']:.2f}px) — §2 is vacuous"

    print("\nOK — reply composer: toggle above attach, no blank band above the "
          "draft, shared dashed edge in the accent colour, both themes, all "
          "four providers, and all three negative controls tripped.")
    print(f"  gap above the draft: {results['dark']['placement']['gapAboveText']:.2f}px "
          f"(control, with the rule removed: {cg['gapAboveText']:.2f}px)")


if __name__ == "__main__":
    main()
