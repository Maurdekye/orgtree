"""attnsettings_probe.py — the desk buttons that open something, clicked in a
real browser on a desk that is NOT a canvas card (docket
v3-attention-view-agent-settings-button-on-the-d; user 2026-09-29: "i cant
open agent settings from the attention view desk, the button doesnt work").

Those desks were handed no `onConfig`/`onLineage`, so the gear and the `gen N`
badge were live buttons wired to nothing; and the Attention desk's jump cards
moved the camera of the canvas the Attention view hides. "Opened" here means
SEEN: the panel's title computes `visibility: visible` AND is the element under
the pointer at its own centre, because a dialog mounted under a hidden layer
or behind the stage is exactly the failure being fixed.

  S. Attention desk: the settings gear opens that agent's configuration.
  L. Attention desk: the `gen N` badge opens that agent's lineage.
  J. (RECORDED, NOT CHECKED) Attention desk: does a report's jump card show
     that report's desk? It moves the hidden canvas today; p01's
     v3-attention-view-show-the-full-ticket-detail-vi routes it through the
     Attention view's shared focus path, so this probe only reports it.
  R. A desk restored from the last session: its settings gear opens the
     configuration too (the same missing prop, on the canvas).

    cd apps/desktop/renderer
    python tests/attnsettings_probe.py <outdir>      # JSON + screenshots

Requires playwright with the msedge channel, like the other browser probes
here. No backend. Exit status is 0 only when every check passes.
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

# the innermost element whose own text is exactly the title, and whether it
# paints and is what the pointer would hit
SEEN = """(title) => {
  const all = [...document.querySelectorAll('body *')].filter(e => e.textContent.trim() === title);
  const e = all.find(x => ![...x.children].some(c => c.textContent.trim() === title)) || all[all.length - 1];
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {visibility: getComputedStyle(e).visibility, w: Math.round(r.width), h: Math.round(r.height),
          onTop: !!top && (top === e || e.contains(top) || top.contains(e))} }"""


# the configuration panel's own section heading: the panel's title row is the
# agent name alone, which the desk behind it shows too
CONFIG = "folder access"


def seen(page, title: str) -> bool:
    m = page.evaluate(SEEN, title)
    return bool(m) and m["visibility"] == "visible" and m["w"] > 0 and m["onTop"] is True


def main() -> int:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "attnsettings-out").resolve()
    build = out / "build"
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), str(build), "attnsettings-probe.tsx"],
                   check=True, cwd=str(FRONTEND))
    page_url = (build / "probe.html").as_uri()
    res: dict = {}
    checks: dict[str, bool] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": 1600, "height": 900})

        def open_scene(name: str):
            page = ctx.new_page()
            page.on("pageerror", lambda e: res.setdefault("pageerrors", []).append(f"{name}: {e}"))
            page.goto(page_url + "#" + name)
            page.wait_for_timeout(1500)
            return page

        def click(page, sel: str, key: str) -> bool:
            el = page.query_selector(sel)
            res[key + "_button"] = bool(el)
            if not el:
                return False
            el.click()
            page.wait_for_timeout(400)
            return True

        # ---- the Attention view's desk (coordinator)
        p = open_scene("attention")
        res["desk_agent_before"] = bool(p.query_selector('.attn-desk [aria-label="settings for coordinator"]'))
        if click(p, '.attn-desk [aria-label="settings for coordinator"]', "S"):
            res["S_config"] = p.evaluate(SEEN, CONFIG)
            p.screenshot(path=str(out / "attention-settings.png"))
        checks["S_attention_gear_opens_settings"] = seen(p, CONFIG)
        p.keyboard.press("Escape")
        p.wait_for_timeout(300)
        checks["S_control_settings_closed_again"] = not seen(p, CONFIG)

        if click(p, ".attn-desk .stackbadge", "L"):
            res["L_lineage"] = p.evaluate(SEEN, "coordinator — lineage")
            p.screenshot(path=str(out / "attention-lineage.png"))
        checks["L_attention_gen_badge_opens_lineage"] = seen(p, "coordinator — lineage")
        p.keyboard.press("Escape")
        p.wait_for_timeout(300)

        if click(p, ".attn-desk .desk-nav-chip[data-copy-agent-name=builder]", "J"):
            p.screenshot(path=str(out / "attention-jump.png"))
        res["J_desk_now_builder"] = bool(p.query_selector('.attn-desk [aria-label="settings for builder"]'))
        res["J_jump_card_shows_that_desk"] = res["desk_agent_before"] and res["J_desk_now_builder"]
        p.close()

        # ---- a desk restored from the last session, on the canvas (reviewer)
        p = open_scene("canvas-restored")
        if click(p, '.restored-desk [aria-label="settings for reviewer"]', "R"):
            res["R_config"] = p.evaluate(SEEN, CONFIG)
            p.screenshot(path=str(out / "restored-settings.png"))
        checks["R_restored_gear_opens_settings"] = seen(p, CONFIG)
        p.close()
        browser.close()

    res["checks"] = checks
    (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)
    if res.get("pageerrors"):
        print("page errors:", res["pageerrors"])
    return 0 if checks and all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
