"""farhire_probe.py — inspect the far-map hire expander in a real browser.

The chip rows deliberately counter-scale and therefore keep a 22px screen size
while cards shrink. A DOM test proves the component stages the dynamic list;
this probe renders the shipped CSS in Edge and proves the visual boundary that
motivates the staging is real.

    python tests/farhire_probe.py --collapsed C:/tmp/collapsed.png \
        --expanded C:/tmp/expanded.png
    python tests/farhire_probe.py --expect-fail

``--expect-fail`` seeds the expanded rows before clicking the arrow. The probe
must fail its "one visible compact control" assertion, or it is unable to see
the regression it claims to guard.
"""

import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
CSS = FRONTEND / "src" / "styles.css"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"


def source_guard() -> str:
    cards = CARDS.read_text(encoding="utf-8")
    for needle in ("HIRE_BUTTON_PX = 22", "FIT_DEADBAND_PX = 4",
                   "widestFamilyPx", "hire-expand", "hasFamilies",
                   "onPointerLeave={() => setExpandedHireEdge(null)}"):
        if needle not in cards:
            raise SystemExit(f"cards.tsx is missing {needle!r}; this fixture no longer "
                             "matches the control it is supposed to inspect")
    css = CSS.read_text(encoding="utf-8")
    for needle in (".hsof.hire-compact .hire-expand",
                   ".hsof.hire-compact.is-expanded .hs-fam",
                   "@keyframes hire-families-down"):
        if needle not in css:
            raise SystemExit(f"styles.css is missing {needle!r}; update the probe")
    return css


def family(name: str, letters: str) -> str:
    return "<div class='hs-fam' data-provider='%s'>%s</div>" % (
        name, "".join(f"<button class='t-{c}'>{c[0].upper()}</button>" for c in letters.split()))


ROWS = "".join((
    family("claude", "haiku sonnet opus fable"),
    family("codex", "gpt-reserve luna terra sol"),
    family("antigravity", "flash pro"),
))


def document(css: str, open_rows: bool) -> str:
    rows = ROWS if open_rows else ""
    expanded = " is-expanded" if open_rows else ""
    return f"""<!doctype html><html><head><style>{css}
body {{ margin: 0; background: #17191c; }}
#scene {{ position: relative; width: 360px; height: 300px; overflow: hidden; }}
#world {{ position: absolute; transform: scale(.55); transform-origin: 0 0;
  --invzf: 1.81818; }}
#scene .sq {{ position: absolute; left: 270px; top: 150px; width: 124px; height: 124px; }}
/* Freeze the hover gate open so this screenshot is precisely the interactive
   hover state, not a pointer-position snapshot. */
#scene .hsof {{ opacity: 1; pointer-events: auto; }}
</style></head><body><div id='scene'><div id='world'>
  <div class='sq edge-b' id='card'>
    <div class='hsof hire-compact{expanded}' id='hire'>
      <button class='hire-expand' id='expand' type='button' aria-expanded='{str(open_rows).lower()}'>↓</button>
      {rows}
    </div>
  </div>
</div></div><script>
const rows = {ROWS!r};
document.querySelector('#expand').addEventListener('click', () => {{
  const hire = document.querySelector('#hire');
  if (hire.classList.toggle('is-expanded')) hire.insertAdjacentHTML('beforeend', rows);
  else document.querySelectorAll('#hire .hs-fam').forEach((el) => el.remove());
  document.querySelector('#expand').setAttribute('aria-expanded', hire.classList.contains('is-expanded'));
}});
</script></body></html>"""


def fit_case(key: str, label: str, zoom: float, compact: bool, rows: str) -> str:
    cls = " hire-compact" if compact else ""
    arrow = "<button class='hire-expand' type='button'>↓</button>" if compact else ""
    body = arrow if compact else rows
    return f"""<section class='fit-case' data-case='{key}'>
      <b class='fit-label'>{label}</b>
      <div class='fit-world' style='transform:scale({zoom}); --invzf:{1 / zoom:.8f}'>
        <div class='sq edge-b fit-card' style='width:124px;height:124px'>
          <div class='hsof{cls}'>{body}</div>
        </div>
      </div>
    </section>"""


def fit_document(css: str) -> str:
    full = ROWS
    codex = family("codex", "gpt-reserve luna terra sol")
    cases = "".join((
        fit_case("full-compact", "full 0.77 · 95.5px card / 100px row · compact", .77, True, full),
        fit_case("full-direct", "full 0.82 · 101.7px card / 100px row · direct", .82, False, full),
        fit_case("codex-compact", "Codex 0.77 · 95.5px card / 100px row · compact", .77, True, codex),
        fit_case("codex-direct", "Codex 0.82 · 101.7px card / 100px row · direct", .82, False, codex),
    ))
    return f"""<!doctype html><html><head><style>{css}
body {{ margin:0; background:#17191c; }}
#fit {{ width:800px; height:520px; display:grid; grid-template-columns:repeat(2, 1fr);
  grid-template-rows:repeat(2, 1fr); padding:20px; box-sizing:border-box; gap:8px; }}
.fit-case {{ position:relative; overflow:visible; border:1px solid #30343a; border-radius:8px; }}
.fit-label {{ position:absolute; left:10px; top:9px; color:#b9c0c9; font:12px var(--mono); }}
.fit-world {{ position:absolute; left:138px; top:62px; width:124px; height:124px; transform-origin:0 0; }}
.fit-card {{ position:absolute; left:0; top:0; }}
.fit-world .hsof {{ opacity:1; pointer-events:auto; }}
</style></head><body><div id='fit'>{cases}</div></body></html>"""


def state(page):
    return page.evaluate("""() => ({
      card: document.querySelector('#card').getBoundingClientRect().height,
      arrows: document.querySelectorAll('.hire-expand').length,
      families: document.querySelectorAll('.hs-fam').length,
      buttons: document.querySelectorAll('.hs-fam button').length,
      expanded: document.querySelector('#hire').classList.contains('is-expanded'),
    })""")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collapsed", type=pathlib.Path)
    parser.add_argument("--expanded", type=pathlib.Path)
    parser.add_argument("--fit-boundary", type=pathlib.Path,
                        help="screenshot the full and reduced sets on both sides of their fit boundary")
    parser.add_argument("--expect-fail", action="store_true")
    args = parser.parse_args()
    css = source_guard()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 360, "height": 300}, device_scale_factor=2)
        page.set_content(document(css, args.expect_fail))
        before = state(page)
        if args.collapsed:
            args.collapsed.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.collapsed))
        errors = []
        if before["arrows"] != 1 or before["families"] or before["buttons"]:
            errors.append(f"collapsed state is not one arrow: {before}")
        if not (67 <= before["card"] <= 69):
            errors.append(f"expected a 68px card at .55 zoom, saw {before['card']:.2f}")
        page.locator("#expand").click()
        after = state(page)
        if args.expanded:
            args.expanded.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.expanded))
        if not after["expanded"] or after["families"] != 3 or after["buttons"] != 10:
            errors.append(f"the full max-provider list did not open: {after}")
        if args.fit_boundary:
            page.set_viewport_size({"width": 840, "height": 560})
            page.set_content(fit_document(css))
            fit = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.fit-case')].map((c) => {
              const card = c.querySelector('.fit-card').getBoundingClientRect();
              return [c.dataset.case, { width:card.width,
                compact:!!c.querySelector('.hire-compact'),
                rows:c.querySelectorAll('.hs-fam').length }]
            }))""")
            expected = {
                "full-compact": (True, 0), "full-direct": (False, 3),
                "codex-compact": (True, 0), "codex-direct": (False, 1),
            }
            for key, (compact, rows) in expected.items():
                got = fit[key]
                if got["compact"] != compact or got["rows"] != rows:
                    errors.append(f"fit boundary {key} wrong: {got}")
            args.fit_boundary.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.fit_boundary))
        browser.close()
    if errors:
        print("farhire_probe: FAIL")
        for error in errors:
            print(" -", error)
        if args.expect_fail:
            print("farhire_probe: known-negative control detected")
        raise SystemExit(1)
    if args.expect_fail:
        raise SystemExit("farhire_probe: known-negative control unexpectedly passed")
    print("farhire_probe: PASS", before, "->", after)


if __name__ == "__main__":
    main()
