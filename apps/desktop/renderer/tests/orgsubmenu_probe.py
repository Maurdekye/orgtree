"""orgsubmenu_probe.py — the ☰ menu's "Open organization…" submenu, measured
and photographed in a real browser (docket
v3-menu-open-organization-opens-a-submenu-to-the; user 2026-09-29, image-21).

  A. Hovering the row opens the organization list BESIDE the menu: to the
     right of the panel, level with the row, and the main menu does not grow.
  B. Near the window's right edge the submenu flips to the LEFT of the panel
     and stays inside the window.
  C. The rows keep their content (name, count, "Already open"), and choosing
     one opens that organization.
  D. Moving the pointer away closes a hover-opened submenu.

    cd apps/desktop/renderer
    python tests/orgsubmenu_probe.py <outdir>

Requires playwright with the msedge channel. Exit 0 only when every check
passes.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
VP_W, VP_H = 1200, 700

BOX = """(sel) => { const e = document.querySelector(sel); if (!e) return null;
  const r = e.getBoundingClientRect();
  return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          r: Math.round(r.right), b: Math.round(r.bottom)} }"""


def main() -> int:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "orgsubmenu-out").resolve()
    build = out / "build"
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), str(build),
                    "orgsubmenu-probe.tsx"], check=True, cwd=str(FRONTEND))
    url = (build / "probe.html").as_uri()
    res: dict = {}
    checks: dict[str, bool] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": VP_W, "height": VP_H})
        for scene in ("left", "right"):
            p = ctx.new_page()
            p.on("pageerror", lambda e: res.setdefault("pageerrors", []).append(str(e)))
            p.goto(url + "#" + scene)
            p.wait_for_timeout(500)
            p.click(".shell-menu-button")
            p.wait_for_timeout(150)
            panel0 = p.evaluate(BOX, ".shell-menu-panel")
            row = p.locator(".shell-menu-subrow")
            row.hover()
            p.wait_for_timeout(250)
            panel1 = p.evaluate(BOX, ".shell-menu-panel")
            sub = p.evaluate(BOX, ".shell-menu-sub")
            rowb = p.evaluate(BOX, ".shell-menu-subrow")
            rows = p.eval_on_selector_all(".shell-menu-sub .shell-menu-org", """els => els.map(e => ({
                name: e.querySelector('.shell-menu-label').textContent,
                value: e.querySelector('.shell-menu-value').textContent.trim()}))""")
            p.screenshot(path=str(out / f"submenu-{scene}.png"))
            res[scene] = {"panel_before": panel0, "panel_open": panel1, "sub": sub, "row": rowb, "rows": rows}
            ok = bool(panel0 and panel1 and sub and rowb)
            checks[f"{scene}_opens_on_hover"] = bool(sub)
            checks[f"{scene}_main_menu_unchanged"] = ok and panel0 == panel1
            checks[f"{scene}_level_with_row"] = ok and abs(sub["y"] - rowb["y"]) <= 8
            checks[f"{scene}_inside_window"] = ok and sub["x"] >= 0 and sub["r"] <= VP_W and sub["b"] <= VP_H
            if scene == "left":
                checks["A_right_of_the_panel"] = ok and sub["x"] >= panel1["r"] - 1
                checks["C_rows_keep_content"] = rows == [
                    {"name": "Maurdekye Works", "value": "0/3"},
                    {"name": "Orgtree", "value": "Already open"},
                    {"name": "Resonite", "value": "0/1"},
                    {"name": "Unity", "value": "0/1"}]
                # D: move off both the row and the submenu, onto empty page
                p.mouse.move(VP_W - 20, VP_H - 20)
                p.wait_for_timeout(500)
                checks["D_pointer_away_closes_it"] = p.evaluate(BOX, ".shell-menu-sub") is None \
                    and p.evaluate(BOX, ".shell-menu-panel") is not None
                # C: choose an organization from the submenu
                row.hover()
                p.wait_for_timeout(250)
                p.locator(".shell-menu-sub .shell-menu-org", has_text="Resonite").click()
                p.wait_for_timeout(150)
                checks["C_choosing_opens_it"] = p.evaluate("() => window.opened") == ["resonite"] \
                    and p.evaluate(BOX, ".shell-menu-panel") is None
            else:
                checks["B_flips_left_near_the_edge"] = ok and sub["r"] <= panel1["x"] + 1
            p.close()
        browser.close()
    res["checks"] = checks
    (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps(res, indent=2))
    failed = [k for k, v in checks.items() if not v]
    print("FAILED: " + ", ".join(failed) if failed else "ALL CHECKS PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
