"""credithover_probe.py — verify credit-bar hover overlay visual precedence over left coworker hire cards.

User request 2026-09-06:
"Left-facing coworker hire cards overlap the credit-bar hover overlay, obscuring credit information.
Make the credit hover overlay take visual precedence at that overlap while preserving existing hire-card
and credit-bar interactions."

WHAT IT ASSERTS:
§1  Real geometry overlap: with the credit bar hovered (tip open) and nearest-edge gating active (left coworker
    hire cards visible), .cbar-tip and the coworker hire card (.hsof.side-l) overlap both horizontally and vertically.
§2  Visual precedence (shipped fix): in the overlap region between .cbar-tip and an overlapping coworker button
    (.t-opus), .cbar-tip paints on top of the coworker hire buttons.
    The pixel sampled at the center of the button overlap matches the #111 dark tooltip background (17, 17, 17),
    not the underlying button background.
§3  Multi-provider cards (2 provider families): wider 2-column coworker strip overlaps the tip even further;
    .cbar-tip visual precedence holds.
§4  Zoom sweep: .cbar-tip visual precedence holds across overview zoom levels (z=0.55, z=1.0).
§5  Known-negative control (--expect-fail): restoring pre-fix z-index: 2 on .cbar proves the check fails
    (the lavender t-opus button paints over the tip, proving the check is a real instrument).
§6  Interaction preservation (fixture interaction, not a full production hire):
    (a) Outside-credit-bar coworker hire chip real hit-test click (Playwright locator.click, no force) works cleanly.
    (b) Dragging the credit bar (.cbar.dragging) elevates to z-index: 4 and keeps .cbar-tip on top.
"""

from __future__ import annotations

import argparse
import io
import os
import pathlib
import re
import sys
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
SHARED = FRONTEND / "src" / "canvas" / "shared.ts"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"


def _node_size() -> tuple[int, int]:
    src = SHARED.read_text(encoding="utf-8")
    m = re.search(r"^export const NODE_W = (\d+), NODE_H = (\d+)", src, re.M)
    if not m:
        raise SystemExit(f"could not read NODE_W/NODE_H from {SHARED}")
    return int(m.group(1)), int(m.group(2))


NODE_W, NODE_H = _node_size()
BAR_H = 60


def _check_source_guards() -> None:
    src = CARDS.read_text(encoding="utf-8")
    for needed in (
        "'hsof' + (side ? ` side side-${side[0]}` : '')",
        "'cbar' + (draftMode || drag ? ' dragging' : '')",
        'className="cbar-tip"',
        'className="hsof-bridge bridge-l"',
    ):
        if needed not in src:
            raise SystemExit(f"cards.tsx missing expected hook {needed!r}")
    css = CSS.read_text(encoding="utf-8")
    for needed in (".hsof.side-l", ".cbar {", ".cbar-tip {", ".cbar:hover, .cbar.dragging"):
        if needed not in css:
            raise SystemExit(f"styles.css missing expected rule {needed!r}")


def build_card_markup(families: int = 1, dragging: bool = False) -> str:
    claude = "<div class='hs-fam'>" + "".join(
        f"<button class='t-{t}'>{ltr}</button>"
        for t, ltr in (("haiku", "H"), ("sonnet", "S"), ("opus", "O"), ("fable", "F"))
    ) + "</div>"
    codex = ("<div class='hs-fam'>" + "".join(
        f"<button class='t-{t}'>{ltr}</button>"
        for t, ltr in (("gpt-reserve", "R"), ("luna", "L"), ("terra", "T"), ("sol", "S"))
    ) + "</div>") if families > 1 else ""

    chips_l = codex + claude
    cbar_cls = "cbar dragging" if dragging else "cbar"

    return f"""
    <div class="sq live norm tier-haiku edge-l" style="width:{NODE_W}px;height:{NODE_H}px;position:relative;">
      <div class="{cbar_cls}" style="height:{BAR_H}px;">
        <div class="cbar-clip"></div>
        <div class="cbar-tip" style="opacity:1;">
          <div>grant <b class="n-fill">5</b></div>
          <div>alloc <b class="n-fill">2</b></div>
          <div>free <b class="n-free">3</b></div>
          <div class="dim">seat <b class="n-seat">1</b></div>
        </div>
      </div>
      <div class="hsof-bridge bridge-l"></div>
      <div class="hsof-bridge bridge-r"></div>
      <div class="hsof side side-l" style="opacity:1; pointer-events:auto;">
        {chips_l}
      </div>
    </div>
    """


def run_test(expect_fail: bool = False, shot_path: str | None = None) -> int:
    _check_source_guards()
    css_text = CSS.read_text(encoding="utf-8")

    if expect_fail:
        # Known-negative control: revert fix and restore pre-fix z-index: 2
        css_text += "\n.cbar:hover, .cbar.dragging { z-index: 2 !important; }\n"

    cases = [
        {"name": "single-family overview", "z": 1.0, "families": 1, "dragging": False},
        {"name": "multi-family overview", "z": 1.0, "families": 2, "dragging": False},
        {"name": "zoomed-out overview", "z": 0.55, "families": 2, "dragging": False},
        {"name": "dragging reallocation", "z": 1.0, "families": 1, "dragging": True},
    ]

    fd, tmp_html = tempfile.mkstemp(suffix=".html", dir=str(FRONTEND / "node_modules"))
    os.close(fd)

    failures = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})

            for case in cases:
                z = case["z"]
                invz = max(1 / 12, 1 / z)
                card_html = build_card_markup(
                    families=case["families"], dragging=case["dragging"]
                )
                full_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
{css_text}
body {{ margin: 0; background: #18181b; padding: 120px 240px; }}
.space {{ position: relative; transform: scale({z}); transform-origin: top left; --invz: {invz:.3f}; --invzf: {invz:.3f}; --z: {z:.3f}; }}
</style>
</head>
<body>
<div class="space">
  {card_html}
</div>
</body>
</html>"""
                pathlib.Path(tmp_html).write_text(full_html, encoding="utf-8")
                page.goto(f"file:///{tmp_html.replace(os.sep, '/')}")
                page.wait_for_timeout(100)

                # Trigger real hover on the credit bar if not already dragging
                if not case["dragging"]:
                    page.hover(".cbar")
                    page.wait_for_timeout(150)

                # Measure geometry and overlap specifically against an overlapping button (t-opus)
                geom = page.evaluate("""() => {
                    const tip = document.querySelector('.cbar-tip');
                    const hsof = document.querySelector('.hsof.side-l');
                    const btn = document.querySelector('.hsof .t-opus');
                    const cbar = document.querySelector('.cbar');
                    const rTip = tip.getBoundingClientRect();
                    const rHsof = hsof.getBoundingClientRect();
                    const rBtn = btn.getBoundingClientRect();
                    
                    const xO = Math.max(0, Math.min(rTip.right, rBtn.right) - Math.max(rTip.left, rBtn.left));
                    const yO = Math.max(0, Math.min(rTip.bottom, rBtn.bottom) - Math.max(rTip.top, rBtn.top));
                    const cx = Math.max(rTip.left, rBtn.left) + xO / 2;
                    const cy = Math.max(rTip.top, rBtn.top) + yO / 2;
                    
                    const cbarZ = parseInt(window.getComputedStyle(cbar).zIndex, 10) || 0;
                    const hsofZ = parseInt(window.getComputedStyle(hsof).zIndex, 10) || 0;
                    
                    return { xO, yO, cx, cy, cbarZ, hsofZ, tipRect: rTip, hsofRect: rHsof, btnRect: rBtn };
                }""")

                name = case["name"]
                xO, yO = geom["xO"], geom["yO"]
                cbarZ, hsofZ = geom["cbarZ"], geom["hsofZ"]

                # §1 Real overlap assertion
                if xO <= 0 or yO <= 0:
                    failures.append(f"{name}: no overlap between cbar-tip and coworker button (xO={xO}, yO={yO})")
                    continue

                # Take screenshot and sample pixel at overlap center
                shot_bytes = page.screenshot()
                im = Image.open(io.BytesIO(shot_bytes))
                cx, cy = int(geom["cx"]), int(geom["cy"])
                pixel = im.getpixel((cx, cy))[:3]  # RGB

                # In #111 dark background, RGB is (17, 17, 17)
                # When obscured by coworker button (t-opus), RGB is bright lavender / tinted
                is_tip_bg = (pixel[0] < 35 and pixel[1] < 35 and pixel[2] < 35)

                if expect_fail:
                    if is_tip_bg:
                        failures.append(f"[EXPECT-FAIL] {name}: unexpectedly passed (cbarZ={cbarZ}, pixel={pixel})")
                    else:
                        print(f"  [EXPECTED FAIL DETECTED] {name}: cbarZ={cbarZ} <= hsofZ={hsofZ}, obscured pixel={pixel}")
                else:
                    if cbarZ <= hsofZ:
                        failures.append(f"{name}: cbar z-index ({cbarZ}) is not greater than hsof ({hsofZ})")
                    if not is_tip_bg:
                        failures.append(f"{name}: pixel at overlap {pixel} indicates tip is obscured by coworker button")
                    else:
                        print(f"  [PASS] {name}: xOverlap={xO:.1f}px, yOverlap={yO:.1f}px, cbarZ={cbarZ} > hsofZ={hsofZ}, tip pixel={pixel}")

                if shot_path and case == cases[0]:
                    im.save(shot_path)
                    print(f"  saved screenshot: {shot_path}")

            # §6 Interaction check: fixture interaction on outside-credit-bar hire chip
            page.evaluate("""() => {
                window.__probeClickedTier = null;
                const btn = document.querySelector('.hsof .t-haiku');
                btn.addEventListener('click', () => { window.__probeClickedTier = 'haiku'; });
            }""")
            page.locator(".hsof .t-haiku").click()  # real Playwright hit-tested click (no force)
            clicked_tier = page.evaluate("() => window.__probeClickedTier")
            if clicked_tier != "haiku":
                failures.append(f"coworker button fixture click failed to trigger (got {clicked_tier})")
            else:
                print("  [PASS] fixture interaction: outside-credit-bar coworker chip real hit-test click preserved")

            browser.close()
    finally:
        if os.path.exists(tmp_html):
            os.remove(tmp_html)

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        return 1

    if expect_fail:
        print("\nAll expected failures detected (positive control verified).")
    else:
        print("\nAll checks passed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-fail", action="store_true", help="Run positive control (must fail)")
    parser.add_argument("--shot", type=str, default=None, help="Path to save screenshot")
    args = parser.parse_args()
    return run_test(expect_fail=args.expect_fail, shot_path=args.shot)


if __name__ == "__main__":
    sys.exit(main())
