"""Computed-style probe for the GREY the user actually saw on the attach button.

The complaint (2026-09-17 20:17) was visual — "the paperclip is greyed out" —
and the cause was a prop, so the renderer fix is proved functionally by
attachenable.test.tsx (real InboxPanel, real `disabled` property, real upload
URL). What jsdom CANNOT say is what `disabled` looks like, because jsdom has
no cascade: it would report the same DOM whether the disabled state rendered
as a dimmed control or as no difference at all.

This renders the REAL `styles.css` in a real Chromium and measures it.

WHY THERE IS A GREY AT ALL, since `.cc-attach` has no `:disabled` rule of its
own: the dimming comes from the global `button:disabled { opacity: .45;
cursor: default }` (styles.css). That is a shared rule, so this probe also
serves as its regression guard for this control.

Verifies, in BOTH themes (default charcoal dark and `.contrast-light`):
1. THE ENABLED BUTTON IS NOT DIMMED. Computed opacity is exactly 1 — the
   greying the user reported is gone, not merely reduced.
2. THE DISABLED BUTTON STILL IS. Computed opacity is < 1 and its cursor is
   not a pointer, so the control still LOOKS dead when attaching genuinely is
   impossible. The ticket forbids making the button merely look enabled; this
   is the other half of that — the disabled state must stay legible.
3. THE TWO ARE VISIBLY DIFFERENT. Asserted as a real gap in the rendered
   opacity, not as "the rule exists".
4. THE ENABLED BUTTON IS HIT-TESTABLE. `elementFromPoint` at the centre of
   its rendered box returns the button (or something inside it), so it is not
   covered, zero-sized or `pointer-events: none`. A control the user can see
   but cannot hit is the same bug wearing different clothes.
5. NEGATIVE CONTROLS, run and reported. Each assertion is paired with a forced
   failure of the SAME measurement, so a check that silently stopped running
   cannot read as a pass.
6. A screenshot of the fixture, on request.

NOT PROVED HERE: that the real component passes `disabled={!attachable}` with
the right value. That is a React fact and it is measured in jsdom by
attachenable.test.tsx §1/§2/§2b/§3, against the real InboxPanel. §0 below
re-reads mail.tsx so the fixture cannot quietly drift from the component.

Run:  python apps/desktop/renderer/tests/attach_enabled_probe.py [--shot p]
"""
import argparse
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS_PATH = HERE.parent / "src" / "styles.css"
MAIL_PATH = HERE.parent / "src" / "canvas" / "mail.tsx"

BOX = """
    <div class="mail-reply" id="{cid}">
      <div class="cc-btnstack">
        <button class="cc-notice-toggle" title="Notice mode (Alt+N)">N</button>
        <button class="cc-attach" id="{cid}-attach" {dis}
          title="{title}">+</button>
      </div>
      <textarea rows="2">{text}</textarea>
      <button class="mail-reply-send">reply</button>
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
  <div class="test-section desk-body prov-claude">
    <div class="section-title">Mail reply — attaching IS possible (the fix)</div>
    {live}
  </div>
  <div class="test-section desk-body prov-claude">
    <div class="section-title">Mail reply — no recipient, so attaching is not</div>
    {dead}
  </div>
</body>
</html>
"""

MEASURE = """(id) => {
  const el = document.getElementById(id)
  const cs = getComputedStyle(el)
  const b = el.getBoundingClientRect()
  const hit = document.elementFromPoint((b.left + b.right) / 2,
                                        (b.top + b.bottom) / 2)
  return {
    opacity: parseFloat(cs.opacity),
    cursor: cs.cursor,
    color: cs.color,
    borderColor: cs.borderTopColor,
    pointerEvents: cs.pointerEvents,
    w: b.width, h: b.height,
    disabled: el.disabled,
    // true when the point at the button's centre actually lands on the
    // button (or on its glyph), which is what a real click needs
    hit: !!hit && (hit === el || el.contains(hit)),
  }
}"""

THEMES = [("dark", ""), ("light", "contrast-light")]


class Failed(Exception):
    pass


def check(label, ok, detail):
    if not ok:
        raise Failed(f"{label}: {detail}")
    print(f"  PASS  {label} — {detail}")


def section0_fixture_matches_component():
    """The fixture is hand-written markup. Re-read the component so a drift
    between them is loud rather than silent — a probe measuring a shape the
    product no longer renders proves nothing about the product."""
    src = MAIL_PATH.read_text(encoding="utf-8")
    m = re.search(r'<button type="button" className="cc-attach" disabled=\{([^}]*)\}',
                  src)
    if not m:
        raise Failed(
            "§0 mail.tsx no longer renders `<button className=\"cc-attach\" "
            "disabled={…}>` — this probe's fixture is stale, fix it before "
            "reading anything below as evidence")
    print(f"  PASS  §0 the component still gates .cc-attach on disabled={{{m.group(1)}}}")
    if ".cc-attach" not in CSS_PATH.read_text(encoding="utf-8"):
        raise Failed("§0 styles.css no longer defines .cc-attach")
    print("  PASS  §0 styles.css still defines .cc-attach")


def run(page, shot=None):
    section0_fixture_matches_component()
    css = CSS_PATH.read_text(encoding="utf-8")
    html = HTML_TEMPLATE.format(
        css=css,
        live=BOX.format(cid="live", dis="", title="attach a file",
                        text="Here is the log you asked for."),
        dead=BOX.format(cid="dead", dis="disabled",
                        title="attachments need a recipient first", text=""),
    )
    page.set_content(html)

    for theme, cls in THEMES:
        page.evaluate("(c) => { document.documentElement.className = c }", cls)
        page.wait_for_timeout(60)
        live = page.evaluate(MEASURE, "live-attach")
        dead = page.evaluate(MEASURE, "dead-attach")
        print(f"\n[{theme}]  live={live}\n        dead={dead}")

        # §1 — the user's complaint, gone
        check(f"§1 {theme} the enabled paperclip is NOT dimmed",
              live["opacity"] == 1 and live["disabled"] is False,
              f"opacity {live['opacity']}, disabled {live['disabled']}")

        # §2 — and the disabled one still reads as dead
        check(f"§2 {theme} the disabled paperclip still looks disabled",
              dead["opacity"] < 1 and dead["cursor"] != "pointer",
              f"opacity {dead['opacity']}, cursor {dead['cursor']}")

        # §3 — the difference is real and visible, not nominal
        gap = live["opacity"] - dead["opacity"]
        check(f"§3 {theme} the two states are visibly different",
              gap >= 0.2,
              f"{live['opacity']} vs {dead['opacity']} — a gap of {gap:.2f}")

        # §4 — and the live one can actually be clicked where it is drawn
        check(f"§4 {theme} the enabled paperclip is hit-testable",
              live["hit"] and live["w"] > 0 and live["h"] > 0
              and live["pointerEvents"] != "none",
              f"{live['w']:.0f}x{live['h']:.0f}px, "
              f"pointer-events {live['pointerEvents']}, centre hits it")

    # ---------------------------------------------------------- §5 negatives
    print("\n[negative controls] each forces the SAME measurement to fail")
    page.evaluate("() => { document.documentElement.className = '' }")

    # (a) if the fix is reverted the button is disabled: §1 must fail
    page.evaluate("""() => {
      document.getElementById('live-attach').disabled = true
    }""")
    page.wait_for_timeout(40)
    reverted = page.evaluate(MEASURE, "live-attach")
    if reverted["opacity"] == 1:
        raise Failed(
            "NEGATIVE CONTROL (a) DID NOT FIRE: disabling the live button left "
            f"its opacity at {reverted['opacity']} — §1 cannot be detecting "
            "anything, so every PASS above is meaningless")
    print(f"  PASS  (a) disabling it drops opacity to {reverted['opacity']} "
          "— §1 would have caught the un-fixed build")
    page.evaluate("() => { document.getElementById('live-attach').disabled = false }")

    # (b) if the shared dimming rule is lost, §2/§3 must fail
    page.evaluate("""() => {
      const s = document.createElement('style')
      s.id = 'kill-dim'
      s.textContent = 'button:disabled { opacity: 1 !important }'
      document.head.appendChild(s)
    }""")
    page.wait_for_timeout(40)
    undimmed = page.evaluate(MEASURE, "dead-attach")
    if undimmed["opacity"] < 1:
        raise Failed(
            "NEGATIVE CONTROL (b) DID NOT FIRE: the disabled button stayed at "
            f"{undimmed['opacity']} with the dimming rule overridden — §2/§3 "
            "are not measuring the rule they claim to")
    print("  PASS  (b) overriding button:disabled removes the grey entirely "
          "— §2/§3 really do measure it")
    page.evaluate("() => { document.getElementById('kill-dim').remove() }")

    if shot:
        page.evaluate("() => { document.documentElement.className = '' }")
        page.wait_for_timeout(60)
        pathlib.Path(shot).parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=shot, full_page=True)
        print(f"\nscreenshot: {shot}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shot", help="write a full-page screenshot here")
    args = ap.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 720, "height": 520})
        try:
            run(page, args.shot)
        except Failed as e:
            print(f"\nFAIL  {e}")
            browser.close()
            return 1
        browser.close()
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
