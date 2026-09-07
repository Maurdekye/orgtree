"""Real-browser contract for D-196's cross-provider confirmation.

    python -B tests/crossprovider_probe.py
    python -B tests/crossprovider_probe.py --expect-fail
    python -B tests/crossprovider_probe.py --shot out.png

WHAT THIS PROVES, and what it does not. `crossprovider.test.tsx` drives the
REAL component in jsdom: it proves the dialog appears, blocks the switch, and
that cancelling applies nothing. jsdom does no layout, so it cannot prove the
dialog is actually VISIBLE or that it covers the panel behind it — a box with
`display:none` or zero height would satisfy every one of those assertions.

This probe closes exactly that gap, against the app's REAL styles.css:
  1. the overlay covers the whole viewport (it is what blocks the click)
  2. the confirm box is on screen with real size
  3. both buttons are HIT-TESTABLE at their centre — the element at that point
     is the button itself, not something painted over it
  4. the copy is not clipped by the fixed 430px box

The known-negative control (--expect-fail) restores a plausible-but-wrong
style: an overlay that does not cover. The probe must SEE that, or it is not
measuring coverage at all.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CSS = pathlib.Path(__file__).resolve().parents[1] / "src" / "styles.css"

# the dialog's real markup (ConfirmModal) with the real D-196 copy
HTML = """
<div class="overlay">
  <div class="settings confirm-box">
    <h3>move multi-provider-fix from Codex to Claude?</h3>
    <div class="confirm-body">multi-provider-fix is running on Codex and opus
      runs on Claude. Its conversation CANNOT move between providers, so it
      will be reset and it will not remember this conversation. Its scratch
      files, breadcrumbs.md and mail all survive, and it is told to read them
      to pick up where it left off.</div>
    <div class="row">
      <button class="danger solid" id="go">switch to opus and reset the
        conversation</button>
      <button id="cancel">cancel</button>
    </div>
  </div>
</div>
"""

# a plausible regression: the overlay stops covering, so it no longer blocks
CONTROL = """
.overlay { position: static !important; inset: auto !important;
           width: 0 !important; height: 0 !important; }
"""


def measure(extra_css: str) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_content(
            f"<style>{CSS.read_text(encoding='utf-8')}{extra_css}</style>"
            f"<body class='dark'>{HTML}</body>")
        page.wait_for_timeout(120)
        out = page.evaluate("""() => {
          const ov = document.querySelector('.overlay')
          const bx = document.querySelector('.confirm-box')
          const go = document.querySelector('#go')
          const ca = document.querySelector('#cancel')
          const body = document.querySelector('.confirm-body')
          const r = (e) => { const b = e.getBoundingClientRect()
            return { w: Math.round(b.width), h: Math.round(b.height),
                     x: Math.round(b.x), y: Math.round(b.y) } }
          const hit = (e) => { const b = e.getBoundingClientRect()
            const t = document.elementFromPoint(b.x + b.width / 2,
                                                b.y + b.height / 2)
            return !!t && (t === e || e.contains(t)) }
          return {
            overlay: r(ov), box: r(bx), go: r(go), cancel: r(ca),
            goHit: hit(go), cancelHit: hit(ca),
            // does the body text overflow its own box?
            clipped: body.scrollHeight > body.clientHeight + 1,
            vw: window.innerWidth, vh: window.innerHeight,
          } }""")
        shot = page.screenshot() if ARGS.shot else None
        browser.close()
        return out, shot


def check(m: dict) -> list[str]:
    bad = []
    if not (m["overlay"]["w"] >= m["vw"] and m["overlay"]["h"] >= m["vh"]):
        bad.append(f"overlay does not cover the viewport: {m['overlay']} "
                   f"vs {m['vw']}x{m['vh']} — it cannot block the panel")
    if m["box"]["w"] < 300 or m["box"]["h"] < 80:
        bad.append(f"confirm box is not really on screen: {m['box']}")
    if not m["goHit"]:
        bad.append("the confirm button is not hit-testable at its centre")
    if not m["cancelHit"]:
        bad.append("the CANCEL button is not hit-testable at its centre — "
                   "the user could not refuse")
    if m["clipped"]:
        bad.append("the dialog copy is clipped: the user cannot read what "
                   "they are about to spend")
    return bad


ap = argparse.ArgumentParser()
ap.add_argument("--expect-fail", action="store_true",
                help="run the known-negative control; the probe must SEE it")
ap.add_argument("--shot", metavar="PNG", help="write a screenshot")
ARGS = ap.parse_args()

m, shot = measure(CONTROL if ARGS.expect_fail else "")
if shot:
    pathlib.Path(ARGS.shot).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(ARGS.shot).write_bytes(shot)
    print(f"screenshot → {ARGS.shot}")
problems = check(m)

if ARGS.expect_fail:
    if problems:
        print("known-negative DETECTED (the probe can see a broken dialog):")
        for b in problems:
            print(f"  ✓ {b}")
        sys.exit(0)
    print("✗ the control was NOT detected — this probe proves nothing")
    sys.exit(1)

if problems:
    for b in problems:
        print(f"  ✗ {b}")
    sys.exit(1)
print(f"overlay {m['overlay']['w']}x{m['overlay']['h']} covers "
      f"{m['vw']}x{m['vh']} · box {m['box']['w']}x{m['box']['h']} · "
      f"confirm and cancel both hit-testable · copy not clipped")
print("real-browser dialog contract OK")
