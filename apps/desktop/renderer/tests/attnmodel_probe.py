"""attnmodel_probe.py — does the Attention view show an agent's NEW model as
soon as a new tree arrives? (docket v3-changing-an-agent-s-model-does-not-show-at-on;
user 2026-09-29: changed an agent's model, the Attention view kept the old one.)

The page (attnmodel-probe.tsx) is the Attention view composed as App.tsx
composes it. `__retier` delivers a fresh tree in which coordinator's tier is
sonnet instead of opus, which is what a tree refresh after the settings save
delivers. The tier chip (`.tier.t-<tier>`) is read before and after in:

  D. the desk in the right panel (header chip)
  A. the agents list row
Each is first checked to read opus (the control: the selector found the chip).
Measured 2026-09-29 at v3 6ce97dc: both switch at once. The Attention view is
not the stale part; the tree READ after a save was (apptreestale.test.tsx).

    cd apps/desktop/renderer
    python tests/attnmodel_probe.py <outdir>

Requires playwright with the msedge channel. No backend. Exit 0 only when
every check passes.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
REPO = HERE.parents[3]
# the repo-import guard (tools/assert_repo_import.py): proves this checkout is
# the one on sys.path before anything else is imported, and stamps provenance
sys.path.insert(0, str(REPO / "tools"))
from assert_repo_import import assert_repo_import  # noqa: E402
PROVENANCE = assert_repo_import(REPO)

from playwright.sync_api import sync_playwright  # noqa: E402

CHIPS = """(sel) => [...document.querySelectorAll(sel)].map(e =>
  [...e.classList].find(c => c.startsWith('t-')) || '?')"""


def main() -> int:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "attnmodel-out").resolve()
    build = out / "build"
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), str(build), "attnmodel-probe.tsx"],
                   check=True, cwd=str(FRONTEND))
    page_url = (build / "probe.html").as_uri()
    res: dict = {}
    checks: dict[str, bool] = {}
    where = {
        "desk": '.attn-desk .tier[data-copy-agent-name="coordinator"]',
        "list": '.attn-agents .tier[data-copy-agent-name="coordinator"]',
    }
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": 1600, "height": 900})
        for scene, parts in (("attention", ("desk", "list")),):
            p = ctx.new_page()
            p.on("pageerror", lambda e, s=scene: res.setdefault("pageerrors", []).append(f"{s}: {e}"))
            p.goto(page_url + "#" + scene)
            p.wait_for_timeout(1500)
            before = {k: p.evaluate(CHIPS, where[k]) for k in parts}
            p.evaluate("() => window.__retier('coordinator', 'sonnet')")
            p.wait_for_timeout(800)
            after = {k: p.evaluate(CHIPS, where[k]) for k in parts}
            p.screenshot(path=str(out / f"{scene}-after.png"))
            res[scene] = {"before": before, "after": after}
            for k in parts:
                checks[f"{k}_drawn_as_opus_first"] = bool(before[k]) and all(t == "t-opus" for t in before[k])
                checks[f"{k}_shows_sonnet_after_the_change"] = bool(after[k]) and all(t == "t-sonnet" for t in after[k])
            p.close()
        browser.close()
    res["checks"] = checks
    res["import_provenance"] = PROVENANCE.as_dict()
    (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    for k, v in checks.items():
        print(("PASS " if v else "FAIL ") + k)
    print(json.dumps(res["attention"]))
    if res.get("pageerrors"):
        print("page errors:", res["pageerrors"][:3])
    return 0 if checks and all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
