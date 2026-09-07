"""xai_theme_probe.py — is the xAI black theme LEGIBLE on the dark UI?

User ask 2026-09-03: "give xai models a black theme". The canvas is already
dark (#1f1f1f under a #343434 dot grid, #252526 panels), so a black tier
colour used the way every other tier colour is used — as the INK of the chip
— would be a hole: the letter vanishes and the chip loses its edge. shared.ts
therefore renders a dark tier colour FILLED (colour = background, letter in
the strong ink, a lifted grey rim). This probe measures that in Edge over the
real styles.css and the real generated tier stylesheet, at the three zooms
the canvas actually runs at and over the dot grid at each zoom's density.

    python -B tests/xai_theme_probe.py [--shot PNG]
    python -B tests/xai_theme_probe.py --expect-fail      (the control)

The KNOWN-NEGATIVE CONTROL forces the naive treatment (black as ink, the
usual 45% mix as the rim) onto the same markup; the probe must FAIL it, or a
green run proves only that the probe can print OK.

WHAT IT CHECKS, for every xAI chip/card/monogram on the page
  1. the fill IS the black (luminance under .03) — the theme is really there
  2. the letter reads: contrast against the fill ≥ 4.5:1 (WCAG AA text)
  3. the edge reads: the rim lifts off the fill AND off the canvas behind it
     (≥ 1.5:1 both ways), and the border is actually drawn
  4. the node card's top edge carries the black itself
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"

# the naive treatment: black as ink, black mixed into the line as the rim —
# exactly what the light-colour rules would have produced for #0d0d0d
MUTANT = """
.tier.t-or-x-ai-grok-4-6, .hsof button.t-or-x-ai-grok-4-6, .orr-card.dark,
.chip.agents b.t-or-x-ai-grok-4-6 {
  color: #0d0d0d !important; background: var(--input) !important;
  border: 1px solid color-mix(in srgb, #0d0d0d 45%, var(--line)) !important;
}
"""

FRAME = """
body { margin: 0; background: #1f1f1f; color: #e8e8e8; font: 13px system-ui, sans-serif; }
.zrow { position: relative; height: 150px; padding: 18px 24px; border-bottom: 1px solid #333;
  display: flex; align-items: flex-start; gap: 0; }
.canvas-bg { position: absolute; inset: 0; }
.cap { position: absolute; right: 24px; top: 10px; font-size: 12px; color: #9a9a9a; }
.sample { position: relative; display: inline-block; transform-origin: top left;
  width: 124px; height: 124px; flex: none; }
.sample .sq { position: relative !important; width: 124px; height: 124px; box-sizing: border-box; }
/* the real strip is edge-gated (hidden until the cursor nears the card);
   here it is pinned open, so what is measured is also what is in the shot */
.hsof.sample-strip { position: relative !important; left: auto !important; top: auto !important;
  transform: none !important; display: flex !important; opacity: 1 !important;
  visibility: visible !important; pointer-events: auto !important;
  gap: 8px; margin-left: 32px; margin-top: 36px; }
.settings-row { position: relative; padding: 34px 24px 24px; }
.settings-row .orr-list { margin-top: 14px; }
"""

MEASURE = r"""() => {
  const lum = (s) => {
    const nums = (s.match(/-?\d*\.?\d+/g) || []).map(Number)
    if (nums.length < 3) return NaN
    const frac = s.trim().startsWith('color(')
    const lin = (v) => { const c = frac ? v : v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * lin(nums[0]) + 0.7152 * lin(nums[1]) + 0.0722 * lin(nums[2])
  }
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const CANVAS = lum('rgb(31, 31, 31)')
  const bad = []
  const els = [...document.querySelectorAll(
    '.tier.t-or-x-ai-grok-4-6, .hsof button.t-or-x-ai-grok-4-6, .orr-card.dark, ' +
    '.chip.agents b.t-or-x-ai-grok-4-6')]
  if (els.length < 7) bad.push(`only ${els.length} xAI elements found (wanted the chips at 3 zooms, 2 monograms, the inventory)`)
  for (const el of els) {
    const cs = getComputedStyle(el)
    const where = el.closest('[data-zoom]')?.getAttribute('data-zoom') ?? '?'
    const tag = `${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')} @ ${where}`
    const bg = lum(cs.backgroundColor), fg = lum(cs.color), bd = lum(cs.borderTopColor)
    if (!(bg < 0.03)) bad.push(`${tag}: fill is not the black (luminance ${bg.toFixed(3)}, ${cs.backgroundColor})`)
    if (!(ratio(fg, bg) >= 4.5)) bad.push(`${tag}: letter contrast ${ratio(fg, bg).toFixed(1)}:1 < 4.5:1`)
    if (!(ratio(bd, bg) >= 1.5)) bad.push(`${tag}: rim does not lift off the fill (${ratio(bd, bg).toFixed(2)}:1)`)
    if (!(ratio(bd, CANVAS) >= 1.5)) bad.push(`${tag}: rim does not lift off the canvas (${ratio(bd, CANVAS).toFixed(2)}:1)`)
    if (cs.borderTopStyle === 'none' || parseFloat(cs.borderTopWidth) < 1) bad.push(`${tag}: no border drawn`)
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) bad.push(`${tag}: not rendered`)
    // computed styles exist for an invisible element too — the shot and the
    // measurement must be of the same thing
    let e = el, hidden = null
    while (e && e !== document.body) {
      const s = getComputedStyle(e)
      if (parseFloat(s.opacity) < 0.5 || s.visibility === 'hidden' || s.display === 'none') { hidden = e; break }
      e = e.parentElement
    }
    if (hidden) bad.push(`${tag}: not visible (${hidden.tagName.toLowerCase()}.${String(hidden.className).replace(/\s+/g, '.')} hides it)`)
  }
  for (const sq of document.querySelectorAll('.sq.tier-or-x-ai-grok-4-6')) {
    const cs = getComputedStyle(sq)
    if (!(lum(cs.borderTopColor) < 0.03)) bad.push(`node card top edge is not the black: ${cs.borderTopColor}`)
    if (parseFloat(cs.borderTopWidth) < 2) bad.push(`node card top edge too thin: ${cs.borderTopWidth}`)
  }
  return bad
}"""


def dump() -> str:
    with tempfile.TemporaryDirectory(prefix="orgtree-xai-") as tmp:
        out = pathlib.Path(tmp) / "xai.html"
        subprocess.run([
            "node", str(HERE / "xai_dump.mjs"), str(out)],
            cwd=FRONTEND, check=True, capture_output=True)
        return out.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--shot")
    args = ap.parse_args()
    fragment = dump()
    css = CSS.read_text(encoding="utf-8")
    html = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
            f"{MUTANT if args.expect_fail else ''}</style>\n{fragment}")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 760, "height": 640},
                                device_scale_factor=2)
        page.set_content(html)
        page.wait_for_timeout(150)
        bad = page.evaluate(MEASURE)
        if args.shot:
            page.screenshot(path=args.shot, full_page=True)
            print(f"saved {args.shot}")
        browser.close()
    if args.expect_fail:
        if not bad:
            print("CONTROL FAILED — the naive black-as-ink treatment passed the probe")
            return 1
        print("CONTROL OK — the naive treatment is caught: " + "; ".join(bad[:4])
              + (f" … (+{len(bad) - 4})" if len(bad) > 4 else ""))
        return 0
    if bad:
        print("\n".join("FAIL: " + b for b in bad))
        return 1
    print("OK — the xAI black reads at every zoom and in settings: black fill, "
          "letter ≥ 4.5:1, rim lifted off both the fill and the canvas, black top edge")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
