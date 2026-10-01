"""Real Edge check: the far-zoom name overlay sits exactly where the original
in-card reveal did, and is painted above every card. Reuses the minihire fixture.
    python tests/farname_probe.py
"""
from __future__ import annotations
import pathlib, subprocess, sys, tempfile
REPO = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "tools"))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
BUILD = HERE / "minihire-build.mjs"
GEOM = """(inCard) => { const r = (s) => { const e = document.querySelector(s); if (!e) return null;
  const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height] };
  return { name: inCard ? r('[data-probe=centre] .sq-far-name') : r('.sq-far-ghost .sq-far-name'),
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
            cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
            samples = (30, 90, 160, 600)
            def run(hide_overlay: bool):
                page.mouse.move(5, 5); page.wait_for_timeout(700)
                page.add_style_tag(content=".sq-far-ghost{display:none !important} .sq.mini.far-ghosted .sq-far-tier{visibility:visible !important}") if hide_overlay else None
                page.mouse.move(cx, cy)
                rows, last = [], 0
                for t in samples:
                    page.wait_for_timeout(t - last); last = t
                    rows.append(page.evaluate(GEOM, hide_overlay))
                return rows
            new_rows = run(False)
            anim = page.evaluate("() => document.querySelector('.sq-far-ghost .sq-far-tier')?.getAnimations().length ?? -1")
            new = new_rows[-1]
            if not new["ghost"]:
                fails.append(f"z={z}: overlay did not mount on hover")
            if new_rows[0]["name"] is None or new_rows[0]["name"][2] >= new_rows[-1]["name"][2] - 1:
                fails.append(f"z={z}: name was not still growing at 30ms (no reveal motion): {new_rows[0]['name']}")
            nx, ny, nw, nh = new["name"]
            page.add_style_tag(content=".sq-far-ghost .sq-far-name{pointer-events:auto !important}")
            owner = page.evaluate("([x, y]) => document.elementFromPoint(x, y)?.className", [nx + nw / 2, ny + nh / 2])
            if "sq-far-name" not in str(owner) or page.evaluate("([x, y]) => !document.elementFromPoint(x, y)?.closest('.sq-far-ghost')", [nx + nw / 2, ny + nh / 2]):
                fails.append(f"z={z}: name is painted under {owner!r}")
            old_rows = run(True)
            print(f"z={z} overlay transitions still running at 160ms: {anim} (informational)")
            for i, t in enumerate(samples):
                for k in ("name", "chip"):
                    n_, o_ = new_rows[i][k], old_rows[i][k]
                    d = max(abs(a - c) for a, c in zip(n_, o_))
                    print(f"z={z} t={t}ms {k}: overlay={[round(v,1) for v in n_]} original={[round(v,1) for v in o_]} maxdiff={d:.2f}")
                    if t >= 90 and d > (12 if t == 90 else 1.5):
                        fails.append(f"z={z}: {k} differs by {d:.2f}px at {t}ms")
            page.close()
        b.close()
    print("FAIL" if fails else "PASS", *fails, sep="\n")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
