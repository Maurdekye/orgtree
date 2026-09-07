"""Real-Edge probe for the settings model switch against the built app.

Runs a throwaway backend on 7451, opens a real agent settings panel, and
reads the native select/option state. `--expect-fail` replaces the provider
availability value with a disconnected state; the healthy assertions must
then fire, proving the probe distinguishes an available Codex family from a
disabled one rather than merely finding a select element.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PORT = 7451
BASE = f"http://127.0.0.1:{PORT}"


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def provider_payload(enabled: bool) -> dict:
    """The stubbed `/api/providers`, stating ALL THREE families.

    ⚠ IT USED TO STATE ONLY CODEX, and that stopped being harmless twice.
    D-189 added a Antigravity optgroup to the panel and nobody updated `want`, so
    this probe has been red since then for a reason that has nothing to do
    with its subject. Then D-202 made an unstated provider mean "unknown", and
    unknown deliberately SHOWS — so a one-provider stub silently exercised the
    optimistic fallback instead of the machine state the probe means to
    describe.

    A real payload always speaks for every family, so this one does too:
    Claude present, Codex present with `enabled` as the axis under test, and
    Antigravity genuinely not installed on this throwaway root — which under D-202
    is why the Antigravity optgroup is absent from `want`, rather than the omission
    being an oversight the way it was before.
    """
    return {"providers": [{
        "id": "claude", "label": "Claude", "cli": "Claude Code",
        "tiers": [
            {"tier": t, "provider": "claude", "seat": s, "model": t,
             "letter": t[0].upper()}
            for t, s in (("haiku", 1), ("sonnet", 2), ("opus", 5),
                         ("fable", 10))
        ],
        "status": {"installed": True, "connected": True, "kind": "chatgpt"},
        "hire_enabled": True, "reason": None,
    }, {
        "id": "openai", "label": "Codex", "cli": "Codex CLI",
        "tiers": [
            {"tier": "gpt-reserve", "provider": "openai", "seat": 0.2,
             "model": "gpt-reserve", "letter": "R"},
            {"tier": "luna", "provider": "openai", "seat": 0.2,
             "model": "gpt-5.6-luna", "letter": "L"},
            {"tier": "terra", "provider": "openai", "seat": 2,
             "model": "gpt-5.6-terra", "letter": "T"},
            {"tier": "sol", "provider": "openai", "seat": 5,
             "model": "gpt-5.6-sol", "letter": "S"},
        ],
        "status": {"installed": True, "connected": enabled,
                   "kind": "chatgpt" if enabled else None},
        "hire_enabled": enabled,
        "reason": None if enabled else "CONTROL: Codex is disconnected",
    }, {
        # NOT installed — so D-202 hides the family entirely. This is the leg
        # that keeps `want` honest: the Antigravity rows are absent because the
        # machine has no Antigravity, and the probe now says so out loud.
        "id": "google", "label": "Antigravity", "cli": "Antigravity CLI",
        "tiers": [
            {"tier": "flash", "provider": "google", "seat": 1,
             "model": "antigravity-flash", "letter": "F"},
            {"tier": "pro", "provider": "google", "seat": 2,
             "model": "antigravity-pro", "letter": "P"},
        ],
        "status": {"installed": False, "connected": False, "kind": None},
        "hire_enabled": False,
        "reason": "Antigravity CLI not installed",
    }]}


def findings(rows: list[dict]) -> list[str]:
    fail: list[str] = []
    want = [
        ("haiku", "Claude", 1), ("sonnet", "Claude", 2),
        ("opus", "Claude", 5), ("fable", "Claude", 10),
        ("gpt-reserve", "Codex", 0.2),
        ("luna", "Codex", 0.2), ("terra", "Codex", 2),
        ("sol", "Codex", 5),
    ]
    got = [(r["value"], r["group"], r["seat"]) for r in rows]
    if got != want:
        fail.append(f"tier/group/seat rows differ: {got!r}")
    disabled = [r["value"] for r in rows if r["disabled"]]
    if disabled:
        fail.append(f"available-provider options disabled: {disabled!r}")
    return fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="orgtree-modelswitch-") as tmp:
        data = os.path.join(tmp, "data")
        home = os.path.join(tmp, "home")
        os.makedirs(data); os.makedirs(home)
        # ⚠ D-199 FIXTURE (regression 2026-08-30). An isolated HOME means no
        # detected Claude, and since D-199 the hire gate REFUSES a Claude tier
        # on a machine with no Claude — so this probe's setup started 422ing.
        # That is the feature working; the fixture was written for the world
        # where Claude was assumed present. Two truths are needed and they come
        # from different places: ORGTREE_CLAUDE is INSTALLED (the CLI file
        # detection resolves), ~/.claude.json's oauthAccount is CONNECTED
        # (`accounts.live_identity`). ORGTREE_CLAUDE_CLI alone is neither — it
        # only says what to SPAWN once a hire is already allowed.
        # ⚠ Written BEFORE the backend starts: LIVE_CONFIG is
        # `expanduser("~/.claude.json")` evaluated at import IN THE CHILD. And
        # on Windows expanduser reads USERPROFILE, so both it and HOME must
        # point here or this file is written somewhere nobody reads.
        with open(os.path.join(home, ".claude.json"), "w",
                  encoding="utf-8") as _f:
            json.dump({"oauthAccount": {
                "accountUuid": "probe-uuid-0000",
                "emailAddress": "probe@example.test",
            }}, _f)
        with open(os.path.join(data, "defaults.json"), "w", encoding="utf-8") as f:
            json.dump({"net_hub_address": "http://127.0.0.1:9"}, f)
        env = dict(os.environ)
        env.update({
            "ORGTREE_DATA": data, "USERPROFILE": home, "HOME": home,
            "ORGTREE_PORT": str(PORT), "ORGTREE_BRIDGE_PORT": "0",
            "ORGTREE_PUBLIC_PORT": "0", "ORGTREE_EXPOSE_ADMIN": "0",
            "PYTHONPATH": os.path.join(REPO, "backend"),
            "PYTHONIOENCODING": "utf-8",
            "ORGTREE_CLAUDE": os.path.join(
                REPO, "backend", "tests", "fakecli.js"),
            "ORGTREE_CLAUDE_CLI": os.path.join(
                REPO, "backend", "tests", "fakecli.js"),
        })
        log = open(os.path.join(tmp, "backend.log"), "w", encoding="utf-8")
        backend_python = os.path.join(
            REPO, ".venv", "Scripts" if os.name == "nt" else "bin",
            "python.exe" if os.name == "nt" else "python")
        if not os.path.exists(backend_python):
            backend_python = sys.executable
        proc = subprocess.Popen(
            [backend_python, "-m", "orgtree.api"],
            cwd=os.path.join(REPO, "backend"), env=env,
            stdout=log, stderr=log, text=True)
        try:
            for _ in range(150):
                try:
                    api("GET", "/api/orgs")
                    break
                except Exception:
                    if proc.poll() is not None:
                        log.flush()
                        with open(log.name, encoding="utf-8", errors="replace") as f:
                            tail = f.read()[-4000:]
                        raise RuntimeError("throwaway backend exited:\n" + tail)
                    time.sleep(.1)
            else:
                raise RuntimeError("throwaway backend did not start")

            made = api("POST", "/api/orgs", {"name": "model switch probe"})
            slug = made.get("slug") or made["org"]["slug"]
            api("POST", f"/api/orgs/{slug}/ops", {
                "op": "hire", "actor": "@user", "parent": None,
                "tier": "haiku", "grant": 10, "name": "agent",
                "add_dirs": [], "tools": {"bash": False, "web": False,
                    "edit": False, "subagents": False, "mcp": []},
                "org_visibility": "team",
            })

            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1500, "height": 900})
                payload = provider_payload(not args.expect_fail)
                page.route("**/api/providers", lambda route:
                    route.fulfill(status=200, content_type="application/json",
                                  body=json.dumps(payload)))
                page.goto(f"{BASE}/o/{slug}")
                card = page.locator('.sq:has(.name:text-is("agent"))').first
                card.wait_for(timeout=10000)
                # The overview gear is intentionally hover-only. Trigger its real
                # React click handler without making probe success depend on CSS
                # hover timing or the browser's current pointer position.
                card.locator(".gearbtn").evaluate("el => el.click()")
                page.locator(".settings.cfg select.model-switch").wait_for(timeout=10000)
                rows = page.locator("select.model-switch option").evaluate_all("""opts =>
                  opts.map(o => ({
                    value: o.value,
                    group: o.parentElement.label,
                    disabled: o.disabled,
                    text: o.textContent.trim(),
                    seat: Number((o.textContent.match(/seat (\\d+)/) || [0, 0])[1]),
                  }))
                """)
                browser.close()

            fail = findings(rows)
            if args.expect_fail:
                if not fail:
                    print("CONTROL FAILED — disconnected provider escaped detection")
                    return 1
                print("CONTROL OK — disconnected provider detected: " + "; ".join(fail))
                return 0
            if fail:
                print("\n".join("FAIL: " + x for x in fail))
                return 1
            print("OK — real settings panel lists Claude + Codex with correct seats and enabled Codex choices")
            return 0
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            log.close()


if __name__ == "__main__":
    raise SystemExit(main())
