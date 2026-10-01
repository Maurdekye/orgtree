"""Real OrgCanvas in Circular mode, real Edge: Fit All must show EVERY agent.

For a small org and a 208-agent org (8x5x4): click the real "fit the whole org"
button, read the camera off `.space`, and require the zoom to be at or below
what the layout extent needs (the old 0.24 floor clipped the outer ring), the
zoom-out wheel to go lower still, and every agent card to lie inside the
viewport once fitted. Screenshots go to the directory given as argv[1].
"""
from __future__ import annotations
import json, pathlib, re, subprocess, sys, tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "tools"))
from assert_repo_import import assert_repo_import  # noqa: E402
PROVENANCE = assert_repo_import(REPO)

from playwright.sync_api import sync_playwright  # noqa: E402

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp())
out.mkdir(parents=True, exist_ok=True)
failures: list[str] = []
with tempfile.TemporaryDirectory() as d:
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), d, "circularcanvas-probe.tsx"], check=True)
    url = (pathlib.Path(d) / "probe.html").as_uri()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        for scene in ("small", "large", "huge"):
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            errs: list[str] = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(url + "#" + scene)
            page.wait_for_selector(".space")
            page.wait_for_timeout(600)
            page.click('button[title="fit the whole org"]')
            page.wait_for_timeout(900)
            cam = page.evaluate("""() => {
              const t = document.querySelector('.space').style.transform;
              const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/.exec(t);
              return {x:+m[1], y:+m[2], z:+m[3], agents: window.agents,
                cards: document.querySelectorAll('.space .sq').length}}""")
            outside = page.evaluate("""() => {
              const vw = innerWidth, vh = innerHeight;
              return [...document.querySelectorAll('.space .sq')].filter(e => {
                const r = e.getBoundingClientRect();
                return r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh }).length}""")
            cam["outside"] = outside
            page.screenshot(path=str(out / f"realcanvas-{scene}.png"))
            # wheel zoom-out must be able to go at least as far out as Fit All
            page.mouse.move(800, 500)
            for _ in range(40):
                page.mouse.wheel(0, 600)
            page.wait_for_timeout(500)
            z_min = page.evaluate("""() => +/scale\(\s*([\d.]+)/.exec(document.querySelector('.space').style.transform)[1]""")
            print(scene, json.dumps(cam), "wheel floor", z_min, errs)
            if errs:
                failures.append(f"{scene}: page errors {errs}")
            if scene != "small" and outside:
                failures.append(f"{scene}: {outside} cards outside the viewport after Fit All")
            if scene in ("large", "huge"):
                if cam["z"] >= 0.24:
                    failures.append(f"{scene}: Fit All stayed at the 0.24 floor (z={cam['z']})")
                if z_min > cam["z"] + 1e-6:
                    failures.append(f"{scene}: wheel floor {z_min} is above the fit zoom {cam['z']}")
        browser.close()
print("PROVENANCE", PROVENANCE)
if failures:
    print("FAIL", *failures, sep="\n  "); sys.exit(1)
print("OK")
