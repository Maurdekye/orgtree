"""palette_probe.py — the whole OpenRouter vendor palette, rendered and measured.

The brand palette (2026-09-03): `_VENDOR_HUE` carries brand-sourced hues
(brand-colors-2 research — each vendor's own site CSS / logo SVG /
theme-color), the six near-identical brand blues are spread in brand order
with Google's lane as the fixed point, and the three DARK vendors (xAI black,
MiniMax navy, Z.AI grey) are filled and rimmed — the last two with a vendor
ACCENT, so three dark vendors are not one dark chip. The only way to judge a
palette is to look at it, so this probe mints every row with the backend
(`openrouter.color_for` / `accent_for` / `letter_for`), renders them through
the real `<ModelCard/>` and the real generated stylesheet in Edge over
styles.css, screenshots the page, and measures what a screenshot cannot
promise on its own.

    python -B tests/palette_probe.py [--shot PNG]
    python -B tests/palette_probe.py --expect-fail      (the control)

The KNOWN-NEGATIVE CONTROL forces the accent-less treatment onto the dark
cards (rim = fill) and drops the accent from the chips; the probe must FAIL
it, or a green run proves only that the probe can print OK.

WHAT IT CHECKS
  1. every dark card / chip: the letter reads (≥ 4.5:1 on the fill), the rim
     lifts off the fill and off the canvas (≥ 1.5:1 both ways), a border is
     drawn, and where the vendor serves an accent the rim IS chromatic
  2. the three dark fills are three different fills (xAI ≠ MiniMax ≠ Z.AI)
  3. every light card is still ink-on-panel (never inverted)
  4. (backend, no browser) the closest pair inside the blue family per band,
     printed so the number is on the record — see `_VENDOR_HUE` for why the
     adjacent pairs are NOT promised distinguishable by colour alone
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import subprocess
import sys
import tempfile
from itertools import combinations

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
sys.path.insert(0, str(FRONTEND.parent / "backend"))
from orgtree import openrouter as orr  # noqa: E402

BANDS = (0.5, 2.0, 5.0, 9.0)

# vendor · a representative catalog id · the researched brand hex (None = the
# desk theme for a CLI lane, or "no first-party value" for a placeholder) ·
# the note the render prints. Brand hexes: brand-colors-2, brand-colors.json.
GROUPS: list[tuple[str, list[tuple[str, str, str | None, str]]]] = [
    ("CLI lanes — fixed on the desk themes", [
        ("anthropic", "anthropic/claude-sonnet-5", None, "desk terracotta 40°"),
        ("openai", "openai/gpt-5.6-sol", None, "desk teal 175°"),
        ("google", "google/gemini-3.5-pro", None, "desk blue-violet 262° — the blue family's fixed point"),
    ]),
    ("brand-sourced (brand-colors-2, 2026-09-03)", [
        ("mistralai", "mistralai/mistral-large", "#FA500F", "orange-red ramp; minted at its #ff8204 step (37° is Claude's)"),
        ("nvidia", "nvidia/nemotron-4-ultra", "#76B900", "exact"),
        ("perplexity", "perplexity/sonar-pro", "#20808D", "True Turquoise, muted (chroma ×.7)"),
        ("reka", "reka/reka-flash-3", "#00BFFF", "cyan, exact"),
        ("meta-llama", "meta-llama/llama-4-maverick", "#0082FB", "blue cluster: 255° → 238° (soft)"),
        ("moonshotai", "moonshotai/kimi-k3", "#1783FF", "blue cluster: 256° → 246°"),
        ("amazon", "amazon/nova-pro-v2", "#0066FF", "blue cluster: 261° → 254° (plus)"),
        ("cohere", "cohere/command-a", "#4C6EE6", "blue cluster: 268° → 272° (soft)"),
        ("deepseek", "deepseek/deepseek-v4", "#4D6BFE", "blue cluster: 270° → 282°"),
        ("qwen", "qwen/qwen4-plus", "#615CED", "violet, NOT Alibaba orange: 279° → 292° (plus)"),
        ("ibm-granite", "ibm-granite/granite-4-h-small", "#8A3FFC", "Carbon Purple-60, not Blue-60 #0F62FE (= Nova = Gemini hue, same G glyph)"),
    ]),
    ("dark — filled, rimmed", [
        ("x-ai", "x-ai/grok-4.6", "#0d0d0d", "user ask: black; no accent, black is the identity"),
        ("minimax", "minimax/minimax-m3", "#181E25", "near-black navy, deepened; rim #FF5530 (accent, third-party corroborated)"),
        ("z-ai", "z-ai/glm-5.2", "#2D2D2D", "neutral mark, no chromatic identity; rim #00d4ff (site cyan — deliberate, not a mark colour)"),
    ]),
    ("placeholders — NOT researched (no first-party value found)", [
        ("ai21", "ai21/jamba-2-large", None, "placeholder 80°"),
        ("microsoft", "microsoft/phi-5", None, "placeholder 190°"),
        ("liquid", "liquid/lfm-3", None, "placeholder 160°"),
        ("stability-ai", "stability-ai/stable-lm-3", None, "not in the table: hashed hue"),
    ]),
]
BLUES = ["reka", "meta-llama", "moonshotai", "amazon", "google", "cohere", "deepseek",
         "qwen", "ibm-granite"]
DARKS = ["x-ai", "minimax", "z-ai"]


def tier(mid: str, price: float) -> dict[str, object]:
    return {
        "tier": orr.tier_id(mid) + f"-{str(price).replace('.', '-')}",
        "provider": "openrouter", "seat": orr.seat_for(price), "model": mid,
        "letter": orr.letter_for(mid), "color": orr.color_for(mid, price),
        "accent": orr.accent_for(mid), "name": orr.model_label(mid),
        "label": orr.model_label(mid), "vendor": orr.vendor_of(mid),
        "prompt": price, "completion": price * 4, "context": 200000,
    }


def palette() -> dict[str, object]:
    ids = {v: mid for _, rows in GROUPS for v, mid, _, _ in rows}
    return {
        "groups": [{"title": title, "rows": [
            {"vendor": v, "brand": brand, "note": note,
             "tiers": [tier(mid, p) for p in BANDS]}
            for v, mid, brand, note in rows]} for title, rows in GROUPS],
        "blues": [tier(ids[v], 5.0) for v in BLUES],
        "blues_pale": [tier(ids[v], 0.5) for v in BLUES],
        "darks": [tier(ids[v], p) for p in (0.5, 9.0) for v in DARKS],
    }


def oklab(h: str) -> tuple[float, float, float]:
    def lin(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(int(h[i:i + 2], 16)) for i in (1, 3, 5))
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_)


def cluster_report() -> None:
    ids = {v: mid for _, rows in GROUPS for v, mid, _, _ in rows}
    for p in BANDS:
        labs = {v: oklab(orr.color_for(ids[v], p)) for v in BLUES}
        pairs = sorted((math.dist(labs[a], labs[b]), a, b) for a, b in combinations(labs, 2))
        d, a, b = pairs[0]
        print(f"  blue family ${p:<4} closest pair {a}/{b} ΔE(OKLab) {d:.3f}; "
              f"ends reka/ibm {math.dist(labs['reka'], labs['ibm-granite']):.3f}")


# the control: the accent-less treatment — rim = fill on the cards, and the
# chips lose their accent rims too (what the palette looked like before)
MUTANT = """
.orr-card.dark { border-color: var(--orr-c) !important; }
.hsof button[class*="t-or-minimax"], .hsof button[class*="t-or-z-ai"],
.tier[class*="t-or-minimax"], .tier[class*="t-or-z-ai"],
.chip.agents b[class*="t-or-minimax"], .chip.agents b[class*="t-or-z-ai"] {
  border-color: color-mix(in srgb, var(--ink) 40%, var(--line)) !important; }
"""

FRAME = """
body { margin: 0; background: #1f1f1f; color: #e8e8e8; font: 13px system-ui, sans-serif; }
.pal { padding: 14px 22px 26px; width: 1180px; box-sizing: border-box; }
.cap-main { font-size: 12px; color: #9a9a9a; margin-bottom: 6px; }
h2 { font-size: 12px; font-weight: 600; color: #b9b9b9; margin: 16px 0 6px; letter-spacing: .02em; }
.prow { display: grid; grid-template-columns: 96px 118px 178px 44px 150px 1fr;
  align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid #2a2a2a; }
.vname { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #e0e0e0; }
.brand { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #bdbdbd;
  display: inline-flex; align-items: center; }
.brand-sw { display: inline-block; width: 24px; height: 24px; border-radius: 6px;
  border: 1px solid #4a4a4a; margin-right: 7px; flex: none; }
.dim { color: #777; }
.cards { display: inline-flex; gap: 6px; align-items: center; }
.note { font-size: 11px; color: #8d8d8d; line-height: 1.3; }
.tchip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.tchip .lbl { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: #cfcfcf; }
/* the real strip is edge-gated (hidden until the cursor nears the card);
   here it is pinned open, so what is measured is also what is in the shot */
.hsof.sample-strip { position: relative !important; left: auto !important; top: auto !important;
  transform: none !important; display: flex !important; flex-direction: row !important;
  opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
  gap: 8px; margin: 0; }
.zrow { position: relative; padding: 30px 22px 18px; margin-top: 8px; border-top: 1px solid #333; }
.canvas-bg { position: absolute; inset: 0; }
.cap { position: absolute; left: 22px; top: 8px; font-size: 12px; color: #9a9a9a; }
.stack { position: relative; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
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
  const chroma = (s) => {
    const nums = (s.match(/-?\d*\.?\d+/g) || []).map(Number)
    if (nums.length < 3) return NaN
    const frac = s.trim().startsWith('color(')
    const v = nums.slice(0, 3).map((x) => frac ? x * 255 : x)
    return Math.max(...v) - Math.min(...v)
  }
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  const CANVAS = lum('rgb(31, 31, 31)')
  const bad = []
  const tag = (el) => `${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')}`
  const darkSel = '.orr-card.dark, .hsof button[class*="t-or-x-ai"], .hsof button[class*="t-or-minimax"], ' +
    '.hsof button[class*="t-or-z-ai"], .tier[class*="t-or-x-ai"], .tier[class*="t-or-minimax"], ' +
    '.tier[class*="t-or-z-ai"], .chip.agents b[class*="t-or-minimax"], .chip.agents b[class*="t-or-z-ai"]'
  const darks = [...document.querySelectorAll(darkSel)]
  if (darks.length < 24) bad.push(`only ${darks.length} dark elements found (wanted ≥ 24)`)
  const fills = { 'x-ai': new Set(), minimax: new Set(), 'z-ai': new Set() }
  for (const el of darks) {
    const cs = getComputedStyle(el)
    const t = tag(el)
    const bg = lum(cs.backgroundColor), fg = lum(cs.color), bd = lum(cs.borderTopColor)
    if (!(bg < 0.03)) bad.push(`${t}: fill is not dark (${cs.backgroundColor})`)
    if (!(ratio(fg, bg) >= 4.5)) bad.push(`${t}: letter contrast ${ratio(fg, bg).toFixed(1)}:1 < 4.5:1`)
    if (!(ratio(bd, bg) >= 1.5)) bad.push(`${t}: rim does not lift off the fill (${ratio(bd, bg).toFixed(2)}:1)`)
    if (!(ratio(bd, CANVAS) >= 1.5)) bad.push(`${t}: rim does not lift off the canvas (${ratio(bd, CANVAS).toFixed(2)}:1)`)
    if (cs.borderTopStyle === 'none' || parseFloat(cs.borderTopWidth) < 1) bad.push(`${t}: no border drawn`)
    const cls = String(el.className)
    const title = el.getAttribute('title') || ''
    const vendor = /minimax/.test(cls + title) ? 'minimax' : /z-ai/.test(cls + title) ? 'z-ai'
      : /x-ai/.test(cls + title) ? 'x-ai' : null
    if (vendor) fills[vendor].add(cs.backgroundColor)
    if (vendor === 'minimax' || vendor === 'z-ai') {
      if (!(chroma(cs.borderTopColor) >= 80)) bad.push(`${t}: ${vendor} rim is not the accent (${cs.borderTopColor})`)
    }
    if (vendor === 'x-ai' && !(chroma(cs.borderTopColor) < 12)) bad.push(`${t}: the xAI rim should stay grey (${cs.borderTopColor})`)
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) bad.push(`${t}: not rendered`)
  }
  for (const [a, b] of [['x-ai', 'minimax'], ['x-ai', 'z-ai'], ['minimax', 'z-ai']]) {
    for (const f of fills[a]) if (fills[b].has(f)) bad.push(`${a} and ${b} share a fill: ${f}`)
  }
  for (const el of document.querySelectorAll('.orr-card:not(.dark)')) {
    const cs = getComputedStyle(el)
    if (lum(cs.color) < 0.03) bad.push(`${tag(el)}: a light card with dark ink (${cs.color})`)
    if (lum(cs.backgroundColor) > 0.12) bad.push(`${tag(el)}: a light card inverted (${cs.backgroundColor})`)
  }
  return bad
}"""


def dump(pal: dict[str, object]) -> str:
    with tempfile.TemporaryDirectory(prefix="orgtree-palette-") as tmp:
        js = pathlib.Path(tmp) / "palette.json"
        js.write_text(json.dumps(pal), encoding="utf-8")
        out = pathlib.Path(tmp) / "palette.html"
        subprocess.run(["node", str(HERE / "palette_dump.mjs"), str(out), str(js)],
                       cwd=FRONTEND, check=True, capture_output=True)
        return out.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    ap.add_argument("--shot")
    args = ap.parse_args()
    print("the blue family, minted (backend, no browser):")
    cluster_report()
    fragment = dump(palette())
    css = CSS.read_text(encoding="utf-8")
    html = (f"<!doctype html><meta charset='utf-8'><style>{css}\n{FRAME}\n"
            f"{MUTANT if args.expect_fail else ''}</style>\n{fragment}")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1180, "height": 900},
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
            print("CONTROL FAILED — the accent-less treatment passed the probe")
            return 1
        print("CONTROL OK — the accent-less treatment is caught: " + "; ".join(bad[:4])
              + (f" … (+{len(bad) - 4})" if len(bad) > 4 else ""))
        return 0
    if bad:
        print("\n".join("FAIL: " + b for b in bad))
        return 1
    print("OK — every dark card and chip reads (letter ≥ 4.5:1, rim lifted off fill and canvas), "
          "MiniMax and Z.AI rims are their accents, the xAI rim is grey, the three dark fills differ, "
          "no light card is inverted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
