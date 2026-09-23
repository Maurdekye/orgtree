"""Geometry probe for the desk composer's vertical alignment.

The requirement is "text starts at the TOP of the message box" (user
2026-09-17). That is a statement about rendered boxes, so a CSS assertion
cannot check it: `align-self: flex-start` is correct-looking CSS that still
leaves a gap if something else in the row changes. This renders the real
`styles.css` against desk.tsx's composer markup in a real Chromium and
measures.

What it asserts:

1. NO BLANK SPACE ABOVE THE FIRST LINE. The textarea's top edge is the
   composer's content-box top, to within a pixel, in every height the box
   takes: empty at `rows=2`, holding one line, auto-grown by a long draft, and
   auto-grown and then CLEARED again (the state that used to be reported as
   "the box stayed tall" and is the one most likely to regress).

2. THE BUTTONS DID NOT MOVE. The attach button, the notice toggle and the send
   button are measured against the composer's content-box BOTTOM, and against
   the same measurements taken from a BEFORE stylesheet. Passing
   `--before <styles.css>` re-renders the whole fixture with that stylesheet
   and requires every box except the textarea's to be identical, which is a
   stronger statement than "the numbers look right".

3. A NEGATIVE CONTROL. The fixture is re-rendered with `align-self` forced
   back to `auto`, and the gap must reappear — otherwise §1 is measuring
   something that was never at risk and would pass whatever the CSS said.

Run:
    python apps/desktop/renderer/tests/composer_align_probe.py
    python apps/desktop/renderer/tests/composer_align_probe.py --before old.css
    python apps/desktop/renderer/tests/composer_align_probe.py --shot out.png
"""
import argparse
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
CSS_PATH = HERE.parent / "src" / "styles.css"

# desk.tsx's composer: the button stack (notice toggle above attach), the
# textarea, and the send button. The effort control is omitted — it is another
# flex-end control and adds nothing this measures.
COMPOSER = """
  <div class="desk-body prov-claude">
    <div class="cc-composer" id="{cid}">
      <div class="cc-btnstack">
        <button class="cc-notice-toggle">N</button>
        <button class="cc-attach">+</button>
      </div>
      <textarea rows="2" id="{cid}-ta"{style}>{text}</textarea>
      <button class="cc-send">^</button>
    </div>
  </div>
"""

LONG = ("A long draft that the auto-grow has already expanded well past the "
        "height of the button stack, so the textarea is the tallest item in "
        "the row and decides the composer's height by itself.")

HTML = """
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
{css}
body {{ margin:0; padding:24px; font-family:'Segoe UI',system-ui,sans-serif;
        background:var(--bg); color:var(--ink); max-width:620px;
        display:flex; flex-direction:column; gap:24px; }}
</style></head><body>
{composers}
</body></html>
"""

MEASURE = """(cid) => {
  const c = document.getElementById(cid)
  const cs = getComputedStyle(c)
  const cb = c.getBoundingClientRect()
  const contentTop = cb.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
  const contentBottom = cb.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom)
  const q = sel => c.querySelector(sel).getBoundingClientRect()
  const ta = q('textarea'), attach = q('.cc-attach'), toggle = q('.cc-notice-toggle'), send = q('.cc-send')
  const rel = (b, origin) => ({ top: +(b.top - origin).toFixed(2), bottom: +(b.bottom - origin).toFixed(2), h: +b.height.toFixed(2) })
  return {
    alignItems: cs.alignItems,
    taAlignSelf: getComputedStyle(c.querySelector('textarea')).alignSelf,
    composerHeight: +cb.height.toFixed(2),
    // every box expressed RELATIVE to the composer's own content top, so the
    // comparison against a BEFORE run does not depend on page layout above it
    textarea: rel(ta, contentTop), attach: rel(attach, contentTop),
    toggle: rel(toggle, contentTop), send: rel(send, contentTop),
    // the number the complaint is about
    gapAboveText: +(ta.top - contentTop).toFixed(2),
    // the baselines that must not move
    attachToBottom: +(contentBottom - attach.bottom).toFixed(2),
    sendToBottom: +(contentBottom - send.bottom).toFixed(2),
  }
}"""

# `grow()` in desk.tsx: height:auto, then min(scrollHeight, 160). Reproduced
# here rather than approximated, because the cleared-after-grow case is
# exactly the one where a hand-picked height would prove nothing.
GROW = """([cid, text]) => {
  const ta = document.getElementById(cid + '-ta')
  if (!ta) throw new Error('no textarea for ' + cid)
  ta.value = text
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
}"""

CASES = ["empty", "oneline", "grown", "cleared"]


def render(page, css_text: str) -> None:
    composers = "".join(
        COMPOSER.format(cid=cid, style="", text={"oneline": "One line of typed text."}.get(cid, ""))
        for cid in CASES)
    page.set_content(HTML.format(css=css_text, composers=composers))
    page.wait_for_timeout(120)
    # drive the real grow() sequence for the two cases that need it
    page.evaluate(GROW, ["grown", LONG])
    page.evaluate(GROW, ["cleared", LONG])
    page.evaluate(GROW, ["cleared", ""])
    page.wait_for_timeout(60)


def measure_all(page) -> dict:
    return {cid: page.evaluate(MEASURE, cid) for cid in CASES}


def run(before: pathlib.Path | None, shot: str | None) -> dict:
    css_text = CSS_PATH.read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 700, "height": 700})

        render(page, css_text)
        after = measure_all(page)
        if shot:
            page.screenshot(path=shot, full_page=True)

        # §3 negative control: put the textarea back under the container's
        # flex-end and require the gap to come back.
        page.evaluate("""() => {
          for (const ta of document.querySelectorAll('.cc-composer textarea')) ta.style.alignSelf = 'auto'
        }""")
        page.wait_for_timeout(60)
        control = measure_all(page)
        page.evaluate("""() => {
          for (const ta of document.querySelectorAll('.cc-composer textarea')) ta.style.removeProperty('align-self')
        }""")

        prior = None
        if before:
            render(page, before.read_text(encoding="utf-8"))
            prior = measure_all(page)

        browser.close()
    return {"after": after, "control": control, "before": prior}


def main() -> None:
    ap = argparse.ArgumentParser(description="Probe the composer's vertical alignment")
    ap.add_argument("--before", type=pathlib.Path, default=None,
                    help="a styles.css to compare against; every box but the textarea must match")
    ap.add_argument("--shot", type=str, default=None, help="write a screenshot here")
    args = ap.parse_args()

    r = run(args.before, args.shot)
    print(json.dumps(r, indent=2))

    for cid in CASES:
        m = r["after"][cid]
        # §1 the text starts at the top, in every height the box takes
        assert abs(m["gapAboveText"]) < 1.0, \
            f"{cid}: {m['gapAboveText']}px of blank space above the first line"
        assert m["taAlignSelf"] == "flex-start", f"{cid}: textarea align-self is {m['taAlignSelf']}"
        # §2 the controls still sit on the composer's bottom edge
        assert abs(m["attachToBottom"]) < 0.51, f"{cid}: the attach button left the baseline ({m['attachToBottom']})"
        assert abs(m["sendToBottom"]) < 0.51, f"{cid}: the send button left the baseline ({m['sendToBottom']})"
        assert m["alignItems"] == "flex-end", f"{cid}: the composer's own align-items changed"

    # the grown case must genuinely be taller than the button stack, or the
    # 'grown' assertions above are just the short case measured twice
    assert r["after"]["grown"]["textarea"]["h"] > r["after"]["grown"]["toggle"]["h"] * 2, \
        "the 'grown' fixture never actually grew past the button stack"
    # and the cleared case must have come back DOWN to the ungrown height
    assert abs(r["after"]["cleared"]["composerHeight"] - r["after"]["empty"]["composerHeight"]) < 1.0, \
        "clearing a long draft did not return the box to its ungrown height"

    # §3 the control must trip
    assert r["control"]["empty"]["gapAboveText"] > 1.0, \
        "CONTROL FAILURE: removing align-self did not reopen the gap — the §1 assertions are vacuous"

    # §2b nothing but the textarea moved, compared box for box against BEFORE
    if r["before"]:
        for cid in CASES:
            a, b = r["after"][cid], r["before"][cid]
            for part in ("attach", "toggle", "send"):
                assert a[part] == b[part], f"{cid}/{part} moved: {b[part]} -> {a[part]}"
            assert a["composerHeight"] == b["composerHeight"], \
                f"{cid}: the composer changed height {b['composerHeight']} -> {a['composerHeight']}"
            assert a["textarea"]["h"] == b["textarea"]["h"], \
                f"{cid}: the textarea changed SIZE, not just position"
        print("\ncompared against --before: every box but the textarea's position is identical")

    print("\nALL INVARIANTS PASSED")


if __name__ == "__main__":
    main()
