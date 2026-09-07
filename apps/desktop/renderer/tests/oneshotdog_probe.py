"""oneshotdog_probe.py — inspect D-200's finite watchdog treatment in Edge.

This shows a persistent dog beside armed/paused one-shot dogs and a spent
one-shot tombstone.  The latter is the real spark origin's visual state: it
must read as departing, not failed, while the canvas draws its outgoing spark.

    python tests/oneshotdog_probe.py --screenshot C:/tmp/one-shot-dogs.png
    python tests/oneshotdog_probe.py --expect-fail

The known-negative control removes the `oneshot` class from the armed finite
dog.  The probe must notice that its border no longer differs from a persistent
dog, or the visual assertion would be unable to catch the regression it claims.
"""

import argparse
import pathlib

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
CSS = HERE.parent / "src" / "styles.css"
CANVAS = HERE.parent / "src" / "canvas" / "OrgCanvas.tsx"
MODALS = HERE.parent / "src" / "canvas" / "modals.tsx"
CARDS = HERE.parent / "src" / "canvas" / "cards.tsx"


def source_guard() -> str:
    canvas = CANVAS.read_text(encoding="utf-8")
    modals = MODALS.read_text(encoding="utf-8")
    cards = CARDS.read_text(encoding="utf-8")
    for needle in ("w.once ? ' oneshot'", "w.spent ? ' spent'", "aria-label=\"one-shot dog\"",
                   "departing after its spark"):
        if needle not in canvas:
            raise SystemExit(f"OrgCanvas.tsx is missing {needle!r}; update this probe")
    for needle in ("one-shot dog", "spark is travelling", "!dog.spent"):
        if needle not in modals:
            raise SystemExit(f"modals.tsx is missing {needle!r}; spent controls may have regressed")
    if "oneShotDogs" not in cards or "map-dogs' +" not in cards:
        raise SystemExit("cards.tsx no longer exposes one-shot dogs in compact-map counts")
    css = CSS.read_text(encoding="utf-8")
    for needle in (".wd-chip.oneshot", ".wd-chip.oneshot.paused", ".wd-chip.spent",
                   "@keyframes wd-depart", ".map-dogs.oneshot"):
        if needle not in css:
            raise SystemExit(f"styles.css is missing {needle!r}; update this probe")
    return css


def document(css: str, negative: bool) -> str:
    armed_cls = "wd-chip armed" if negative else "wd-chip armed oneshot"
    return f"""<!doctype html><html class='mobile'><head><style>{css}
body {{ margin:0; min-height:100vh; background:#17191c; color:#d8dee9; }}
#scene {{ padding:30px; width:820px; box-sizing:border-box; }}
h1 {{ margin:0 0 5px; font:600 18px var(--mono); }}
p {{ margin:0 0 18px; color:#8d96a3; font:12px var(--mono); }}
.dogs {{ display:flex; align-items:flex-start; gap:24px; }}
.dog-case {{ width:145px; }}
.dog-label {{ display:block; margin-bottom:8px; color:#adb5c1; font:11px var(--mono); }}
/* The canvas normally positions these through a world transform. Freeze that
   placement only for an easily readable side-by-side visual comparison. */
.dog-case .wd-chip {{ position:relative; transform:none !important; width:128px !important;
  height:42px !important; font-size:12px; gap:5px; padding:0 7px; }}
.dog-case .wd-chip .wd-glyph {{ font-size:14px; }}
.dog-case .wd-chip .wd-name {{ font-size:11px; }}
.dog-case .wd-once {{ min-width:21px; height:17px; font-size:10px; }}
.dog-case .wd-chip.spent {{ animation-delay:-1.8s; }}
.legend {{ margin-top:24px; padding-top:14px; border-top:1px solid #30343a;
  color:#aeb7c3; font:12px var(--mono); }}
.map-dogs {{ display:inline-flex; margin-left:12px; padding:3px 5px;
  border:1px solid #3b414a; border-radius:5px; }}
</style></head><body><main id='scene'>
  <h1>Watchdogs</h1><p>Solid = keeps watching. Dashed 1× = one-shot dog.</p>
  <div class='dogs'>
    <section class='dog-case'><span class='dog-label'>persistent · armed</span>
      <button class='wd-chip armed'><span class='wd-glyph'>◉</span><span class='wd-name'>keep-watch</span></button></section>
    <section class='dog-case'><span class='dog-label'>one-shot dog · armed</span>
      <button id='armed-once' class='{armed_cls}'><span class='wd-glyph'>◉</span><span class='wd-once'>1×</span><span class='wd-name'>send-once</span></button></section>
    <section class='dog-case'><span class='dog-label'>one-shot dog · paused</span>
      <button class='wd-chip paused oneshot'><span class='wd-glyph'>◫</span><span class='wd-once'>1×</span><span class='wd-name'>paused-once</span></button></section>
    <section class='dog-case'><span class='dog-label'>one-shot dog · departing</span>
      <button class='wd-chip spent oneshot'><span class='wd-glyph'>↗</span><span class='wd-once'>1×</span><span class='wd-name'>spark-source</span></button></section>
  </div>
  <p class='legend'>Compact map count: <span class='map-dogs oneshot'>◉3<small>1×1</small></span> includes one one-shot dog.</p>
</main></body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshot", type=pathlib.Path)
    parser.add_argument("--expect-fail", action="store_true")
    args = parser.parse_args()
    css = source_guard()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 820, "height": 240}, device_scale_factor=2)
        page.set_content(document(css, args.expect_fail))
        state = page.evaluate("""() => {
          const get = (name) => getComputedStyle(document.querySelector(name));
          return {
            persistent: get('.wd-chip:not(.oneshot)').borderStyle,
            armed: get('#armed-once').borderStyle,
            paused: { border: get('.wd-chip.paused.oneshot').borderStyle,
              chipOpacity: get('.wd-chip.paused.oneshot').opacity,
              markerOpacity: get('.wd-chip.paused.oneshot .wd-once').opacity },
            spent: { animation: get('.wd-chip.spent').animationName,
              opacity: Number(get('.wd-chip.spent').opacity) },
            markerCount: document.querySelectorAll('.wd-once').length,
            compactMark: document.querySelector('.map-dogs.oneshot small')?.textContent,
          };
        }""")
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.screenshot))
        browser.close()
    errors = []
    if state["persistent"] != "solid" or state["armed"] != "dashed":
        errors.append(f"persistent/one-shot borders do not differ: {state}")
    if state["paused"]["border"] != "dashed" or state["paused"]["chipOpacity"] != "1":
        errors.append(f"paused one-shot loses its finite identity: {state}")
    if state["spent"]["animation"] != "wd-depart" or state["spent"]["opacity"] <= 0:
        errors.append(f"spent tombstone does not visibly depart: {state}")
    if state["markerCount"] != 3 or state["compactMark"] != "1×1":
        errors.append(f"one-shot markers are missing: {state}")
    if errors:
        print("oneshotdog_probe: FAIL")
        for error in errors:
            print(" -", error)
        if args.expect_fail:
            print("oneshotdog_probe: known-negative control detected")
        raise SystemExit(1)
    if args.expect_fail:
        raise SystemExit("oneshotdog_probe: known-negative control unexpectedly passed")
    print("oneshotdog_probe: PASS", state)


if __name__ == "__main__":
    main()
