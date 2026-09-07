"""Real-browser verification for the two audience-holder folds.

Run after `npm run build` from frontend:
    python frontend/tests/audiencefold_probe.py [--port 7408]
    python frontend/tests/audiencefold_probe.py --expect-fail [--port 7408]

The probe owns an isolated backend/data directory and never contacts the live
deployment.  It deliberately creates seven and eight holders: seven is the
last full list, while eight is the first collapsed list.  Fourteen holders is
also checked and screenshotted because that is the busy-org case that prompted
the feature.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7408
BASE = f"http://127.0.0.1:{PORT}"
EXPECT_FAIL = "--expect-fail" in sys.argv
TMP = tempfile.mkdtemp(prefix="orgtree-audiencefold-")
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

PROC: subprocess.Popen | None = None
RESULTS: list[tuple[str, bool, str]] = []
ORGS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def start_backend() -> None:
    global PROC
    # D-199's provider gate intentionally needs both an installed CLI path and
    # a connected identity.  This fixture supplies inert equivalents before the
    # child imports its configuration.
    with open(os.path.join(HOME, ".claude.json"), "w", encoding="utf-8") as f:
        json.dump({"oauthAccount": {"accountUuid": "probe", "emailAddress": "probe@test"}}, f)
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump({"default": {"replyText": "ack"}}, f)
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": DATA, "USERPROFILE": HOME, "HOME": HOME,
        "ORGTREE_PORT": str(PORT), "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_CLAUDE": os.path.join(REPO, "backend", "tests", "fakecli.js"),
        "ORGTREE_CLAUDE_CLI": os.path.join(REPO, "backend", "tests", "fakecli.js"),
        "FAKECLI_CONFIG": CFG, "PYTHONPATH": os.path.join(REPO, "backend"),
        "PYTHONIOENCODING": "utf-8", "ORGTREE_STEER_HOOK": "0",
        "ORGTREE_PUBLIC_PORT": "0",
    })
    log = open(LOG, "a", encoding="utf-8")
    PROC = subprocess.Popen([sys.executable, "-m", "orgtree.api"],
                            cwd=os.path.join(REPO, "backend"), env=env,
                            stdout=log, stderr=log, text=True)
    for _ in range(200):
        if PROC.poll() is not None:
            raise RuntimeError(open(LOG, encoding="utf-8").read()[-3000:])
        try:
            urllib.request.urlopen(BASE + "/api/orgs", timeout=1).read()
            return
        except Exception:
            time.sleep(.1)
    raise RuntimeError("backend never became ready")


def stop_backend() -> None:
    if PROC is None:
        return
    PROC.terminate()
    try:
        PROC.wait(timeout=10)
    except subprocess.TimeoutExpired:
        PROC.kill()


def make_org(n: int, tag: str) -> str:
    made = api("POST", "/api/orgs", {"name": f"audience fold {tag}"})
    slug = made.get("slug") or made["org"]["slug"]
    ORGS.append(slug)
    for i in range(n):
        nid = f"holder{i + 1:02d}"
        api("POST", f"/api/orgs/{slug}/ops", {
            "op": "hire", "actor": "@user", "parent": None, "tier": "haiku",
            "grant": 1, "name": nid, "charter": "probe holder",
            "tools": {"bash": False, "web": False, "edit": False, "subagents": False, "mcp": []},
            "org_visibility": "team", "add_dirs": []})
        api("POST", f"/api/orgs/{slug}/audiences", {"action": "grant", "node": nid})
        api("POST", f"/api/orgs/{slug}/audiences", {"action": "grant", "node": nid, "target": "extern"})
    return slug


def open_org(pg, slug: str) -> None:
    pg.goto(f"{BASE}/o/{slug}")
    pg.wait_for_selector(".ask-bell", timeout=15000)
    pg.wait_for_timeout(800)


def open_user_inbox(pg) -> None:
    pg.locator(".ask-bell:visible").click()
    pg.wait_for_selector(".settings:has-text('your inbox')", timeout=10000)
    pg.wait_for_timeout(1200)  # independent inbox + audiences polls both settle


def open_org_inbox(pg) -> None:
    pg.locator(".sq.orginbox").click()
    pg.wait_for_selector(".settings:has-text('The org inbox')", timeout=10000)
    pg.wait_for_timeout(700)


def fold_state(pg) -> dict:
    return pg.evaluate("""() => ({
      folds: [...document.querySelectorAll('[data-audience-fold]')].map((e) => ({
        text: e.textContent.trim(), expanded: e.getAttribute('aria-expanded'),
        alert: e.classList.contains('alert'),
      })),
      chips: [...document.querySelectorAll('.badge')].map((e) => e.textContent.trim()),
    })""")


def main() -> int:
    if not os.path.exists(os.path.join(REPO, "frontend", "dist", "index.html")):
        print("frontend/dist is absent — run npm run build first")
        return 2
    try:
        start_backend()
        # `--expect-fail` is a VALUE replacement: the supposed seven-holder
        # one-row fixture is given eight real holders. Its no-fold assertion
        # must go red, proving that this probe can distinguish both sides of
        # the boundary rather than report an empty selector as "fine".
        under_count = 8 if EXPECT_FAIL else 7
        seven, eight, fourteen = (make_org(n, tag)
                            for n, tag in ((under_count, "under"), (8, "at"), (14, "busy")))
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            try:
                # ---- below threshold: no fold control at all ----------------
                open_org(page, seven)
                open_user_inbox(page)
                below_user = fold_state(page)
                check("§1a seven user-audience holders stay fully visible",
                      not below_user["folds"] and len(below_user["chips"]) == 7,
                      str(below_user))
                page.screenshot(path=os.path.join(HERE, "audiencefold-user-seven.png"))
                page.goto(f"{BASE}/o/{seven}")
                open_org_inbox(page)
                below_org = fold_state(page)
                check("§1b seven org-inbox holders stay fully visible",
                      not below_org["folds"] and len(below_org["chips"]) == 7,
                      str(below_org))

                # ---- exactly at threshold: both surfaces start folded -------
                open_org(page, eight)
                open_user_inbox(page)
                user_at = fold_state(page)
                check("§2a eight user-audience holders arrive collapsed with a count",
                      len(user_at["folds"]) == 1
                      and user_at["folds"][0]["expanded"] == "false"
                      and "8 audience holders" in user_at["folds"][0]["text"], str(user_at))
                page.locator("[data-audience-fold]").click()
                user_open = fold_state(page)
                check("§2b the user summary expands to all eight holders",
                      len(user_open["chips"]) == 9  # eight holders + fold button
                      and user_open["folds"][0]["expanded"] == "true", str(user_open))
                page.screenshot(path=os.path.join(HERE, "audiencefold-user-eight-expanded.png"))

                open_org(page, eight)
                open_org_inbox(page)
                org_at = fold_state(page)
                check("§3a eight org-inbox holders use the same default fold",
                      len(org_at["folds"]) == 1 and org_at["folds"][0]["expanded"] == "false"
                      and "8 org inbox audience holders" in org_at["folds"][0]["text"], str(org_at))
                check("§3b the external-mail anomaly stays visible while folded",
                      org_at["folds"][0]["alert"] and "⚠" in org_at["folds"][0]["text"], str(org_at))
                page.locator("[data-audience-fold]").click()
                org_open = fold_state(page)
                check("§3c the org summary expands to all eight revoke chips",
                      len(org_open["chips"]) == 9 and org_open["folds"][0]["expanded"] == "true", str(org_open))
                page.screenshot(path=os.path.join(HERE, "audiencefold-org-eight-expanded.png"))

                # ---- realistic busy org: capture each primary summary -------
                open_org(page, fourteen)
                open_user_inbox(page)
                page.screenshot(path=os.path.join(HERE, "audiencefold-user-fourteen-collapsed.png"))
                page.locator("[data-audience-fold]").click()
                page.screenshot(path=os.path.join(HERE, "audiencefold-user-fourteen-expanded.png"))
                open_org(page, fourteen)
                open_org_inbox(page)
                fourteen_org = fold_state(page)
                check("§4 a fourteen-holder org inbox remains an explicit warning",
                      len(fourteen_org["folds"]) == 1 and fourteen_org["folds"][0]["alert"]
                      and "14 org inbox audience holders" in fourteen_org["folds"][0]["text"], str(fourteen_org))
                page.screenshot(path=os.path.join(HERE, "audiencefold-org-fourteen-collapsed.png"))
                page.locator("[data-audience-fold]").click()
                page.screenshot(path=os.path.join(HERE, "audiencefold-org-fourteen-expanded.png"))
            finally:
                browser.close()
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        for slug in ORGS:
            try:
                api("DELETE", f"/api/orgs/{slug}")
            except Exception:
                pass
        stop_backend()
    failures = [name for name, ok, _ in RESULTS if not ok]
    print(f"{len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    if EXPECT_FAIL:
        if any(name.startswith("§1") for name in failures):
            print("CONTROL OK: value-replaced eight-holder fixture was detected as folded")
            return 0
        print("CONTROL FAILED: the below-threshold check did not notice eight holders")
        return 1
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
