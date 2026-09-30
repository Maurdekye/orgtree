"""Real Edge check: the far-zoom name overlay sits exactly where the original
in-card reveal did, and is painted above every card. Reuses the minihire fixture.
    python tests/farname_probe.py
"""
from __future__ import annotations
import pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
BUILD = HERE / "minihire-build.mjs"
GEOM = """(inCard) => { const r = (s) => { const e = document.querySelector(s); if (!e) return null;
  const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height] };
  return { name: inCard ? r('[data-probe=centre] .sq-far-name') : r('.sq-far-ghost-name'),
           chip: inCard ? r('[data-probe=centre] .sq-far-tier .tier') : r('.sq-far-ghost .tier'),
           ghost: !!document.querySelector('.sq-far-ghost') } }"""

def main() -> int:
    out = pathlib.Path(tempfile.mkdtemp(prefix="farname-"))
    subprocess.run(["node", str(BUILD), str(out)], check=True, cwd=HERE.parent)
    fails: list[str] = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        for z in ("0.24", "0.15"):
            page = b.new_page(viewport={"width": 1200, "height": 900})
            page.goto((out / "probe.html").as_uri() + f"?z={z}")
            page.evaluate("() => { document.querySelector('.space > .sq').dataset.probe = 'centre' }")
            box = page.evaluate("() => { const r = document.querySelector('[data-probe=centre]').getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }")
            page.mouse.move(box[0] + box[2] / 2, box[1] + box[3] / 2)
            page.wait_for_timeout(600)
            new = page.evaluate(GEOM, False)
            if not new["ghost"]:
                fails.append(f"z={z}: overlay did not mount on hover")
            # what sits on top at the label's centre: must be the overlay's own element, not a card
            nx, ny, nw, nh = new["name"]
            top = page.evaluate("([x, y]) => { const els = document.elementsFromPoint(x, y); return els.map(e => e.className || e.tagName).slice(0, 3) }", [nx + nw / 2, ny + nh / 2])
            # the overlay is click-through, so paint order is checked with pointer-events forced on
            page.add_style_tag(content=".sq-far-ghost-name{pointer-events:auto !important}")
            owner = page.evaluate("([x, y]) => document.elementFromPoint(x, y)?.className", [nx + nw / 2, ny + nh / 2])
            if "sq-far-ghost-name" not in str(owner):
                fails.append(f"z={z}: name is painted under {owner!r}")
            # original reveal, overlay switched off
            page.add_style_tag(content=".sq-far-ghost{display:none !important} .sq.mini.far-ghosted .sq-far-tier{visibility:visible !important}")
            page.wait_for_timeout(600)
            old = page.evaluate(GEOM, True)
            for k in ("name", "chip"):
                d = max(abs(a - c) for a, c in zip(new[k], old[k]))
                print(f"z={z} {k}: overlay={[round(v,1) for v in new[k]]} original={[round(v,1) for v in old[k]]} maxdiff={d:.2f}")
                if d > 1.5:
                    fails.append(f"z={z}: {k} geometry differs by {d:.2f}px")
            page.close()
        b.close()
    print("FAIL" if fails else "PASS", *fails, sep="\n")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
