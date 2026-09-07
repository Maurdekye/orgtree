"""Real-Edge probe: only the harnesses this machine has are offered (D-199).

The user's question (2026-08-30): "if a user has codex cli set up but *not*
claude code, will they only see codex hire tokens? or will they see both codex
and claude tokens, even if claude is not configured?" Before D-199 the answer
was "both" — measured with this probe, which is why it exists.

It drives the ACTUAL machine states rather than reasoning about them, by
pointing each CLI's resolution at a real or absent path in a throwaway root:

  SCENARIO codex-only  — Codex installed + signed in, Claude's CLI resolved to
                         a path that does not exist, Antigravity likewise. The
                         reported case. Claude and Antigravity must be ABSENT from
                         every strip; Codex must be offered.
  SCENARIO bare        — nothing installed at all. The state a brand-new user
                         on a fresh machine hits FIRST, and the easiest one to
                         never test: no tier token may render, and the strip
                         must SAY so rather than be empty (an empty hover strip
                         is indistinguishable from a broken one).

Both surfaces that carry chips are read separately — the node card and the
eye/user card — because they diverged before D-199 and a pass on one proves
nothing about the other.

`--expect-fail` is the negative control, and it plants the WRONG STATE rather
than asserting the opposite: it injects enabled Claude tokens into the live
strip of the codex-only scenario, exactly the markup the pre-fix build emitted.
The healthy assertions must then fire. A probe that cannot tell the fixed page
from the broken one proves nothing.

    python frontend/tests/hireavail_probe.py
    python frontend/tests/hireavail_probe.py --expect-fail
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
PORT = 7453
BASE = f"http://127.0.0.1:{PORT}"

CLAUDE = ["haiku", "sonnet", "opus", "fable"]
CODEX = ["gpt-reserve", "luna", "terra", "sol"]
ANTIGRAVITY = ["flash", "pro"]
ALL = CLAUDE + CODEX + ANTIGRAVITY

# The pre-fix markup, re-created in the live page for the control: four
# enabled Claude tokens in the first strip, which is exactly what this probe
# measured on `main` before D-199.
PLANT = """() => {
  const strip = document.querySelector('.hsof')
  if (!strip) return 'no strip'
  const row = document.createElement('div')
  row.className = 'hs-fam'
  for (const t of ['haiku', 'sonnet', 'opus', 'fable']) {
    const b = document.createElement('button')
    b.className = 't-' + t
    b.textContent = t[0].toUpperCase()
    row.appendChild(b)
  }
  strip.appendChild(row)
  return 'planted'
}"""


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def tier_of(cls: str) -> str | None:
    toks = cls.split()
    for t in ALL:
        if "t-" + t in toks:
            return t
    return None


def read_strip(page, sel: str) -> dict:
    """One strip's tokens, plus whether it carries the no-harness badge."""
    rows = page.locator(f"{sel} button").evaluate_all(
        """(els) => els.map(b => ({
             cls: b.className, disabled: b.disabled, title: b.title || '',
             text: (b.textContent || '').trim(),
           }))""")
    tiers: dict[str, bool] = {}
    none_badge = None
    for r in rows:
        t = tier_of(r["cls"])
        if t:
            tiers[t] = r["disabled"]
        elif "hs-none" in r["cls"].split():
            none_badge = r
    return {"tiers": tiers, "none": none_badge}


def start_backend(tmp: str, *, claude: bool, codex: bool, antigravity: bool):
    """A throwaway install whose three CLIs are present or absent to order."""
    data = os.path.join(tmp, "data")
    home = os.path.join(tmp, "home")
    codex_home = os.path.join(tmp, "codex-home")
    for d in (data, home, codex_home):
        os.makedirs(d, exist_ok=True)
    with open(os.path.join(data, "defaults.json"), "w", encoding="utf-8") as f:
        json.dump({"net_hub_address": "http://127.0.0.1:9"}, f)
    if codex:
        # existence of auth.json IS the connect detection (same fake the codex
        # suites use); the CLI resolves to the repo's test double
        with open(os.path.join(codex_home, "auth.json"), "w",
                  encoding="utf-8") as f:
            f.write('{"tokens": {}}')
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": data, "USERPROFILE": home, "HOME": home,
        "CODEX_HOME": codex_home,
        "ORGTREE_CODEX": (os.path.join(REPO, "backend", "tests", "fakecodex.py")
                          if codex else os.path.join(data, "no", "codex.exe")),
        "ORGTREE_ANTIGRAVITY": (os.path.join(REPO, "backend", "tests", "fakecodex.py")
                           if antigravity else os.path.join(data, "no", "gem.exe")),
        "ANTIGRAVITY_HOME": os.path.join(data, "ghome"),
        # THE FIELD UNDER TEST. Claude resolves through the same override as
        # the others, so pointing it at nothing is a real not-installed machine
        # rather than a mocked payload.
        "ORGTREE_CLAUDE": (os.path.join(REPO, "backend", "tests", "fakecli.js")
                           if claude else os.path.join(data, "no", "claude.exe")),
        "ORGTREE_PORT": str(PORT), "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_PUBLIC_PORT": "0", "ORGTREE_EXPOSE_ADMIN": "0",
        "PYTHONPATH": os.path.join(REPO, "backend"),
        "PYTHONIOENCODING": "utf-8",
        "ORGTREE_CLAUDE_CLI": os.path.join(REPO, "backend", "tests", "fakecli.js"),
    })
    log = open(os.path.join(tmp, "backend.log"), "w", encoding="utf-8")
    py = os.path.join(REPO, ".venv", "Scripts" if os.name == "nt" else "bin",
                      "python.exe" if os.name == "nt" else "python")
    if not os.path.exists(py):
        py = sys.executable
    proc = subprocess.Popen([py, "-m", "orgtree.api"],
                            cwd=os.path.join(REPO, "backend"), env=env,
                            stdout=log, stderr=log, text=True)
    for _ in range(150):
        try:
            api("GET", "/api/orgs")
            return proc, log
        except Exception:
            if proc.poll() is not None:
                log.flush()
                with open(log.name, encoding="utf-8", errors="replace") as f:
                    raise RuntimeError("backend exited:\n" + f.read()[-3000:])
            time.sleep(.1)
    raise RuntimeError("backend did not start")


def scenario(tmp: str, *, claude: bool, codex: bool, antigravity: bool,
             plant: bool) -> tuple[dict, dict]:
    proc, log = start_backend(tmp, claude=claude, codex=codex, antigravity=antigravity)
    try:
        pay = api("GET", "/api/providers")
        pstate = {p["id"]: p for p in pay["providers"]}
        made = api("POST", "/api/orgs", {"name": "hire avail probe"})
        slug = made.get("slug") or made["org"]["slug"]
        # the org needs an agent card to hover; hire it through the ledger's
        # own door only when a provider is actually available, else seed the
        # doc directly is unnecessary — a bare machine still renders the eye
        seeded = False
        if claude or codex:
            tier = "haiku" if claude else "luna"
            try:
                api("POST", f"/api/orgs/{slug}/ops", {
                    "op": "hire", "actor": "@user", "parent": None,
                    "tier": tier, "grant": 10, "name": "agent", "add_dirs": [],
                    "tools": {"bash": False, "web": False, "edit": False,
                              "subagents": False, "mcp": []},
                    "org_visibility": "team"})
                seeded = True
            except Exception as e:      # the gate itself may refuse — fine
                print(f"  (hire refused, reading the eye only: {e})")
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.goto(f"{BASE}/o/{slug}")
            page.locator(".sq.user").first.wait_for(timeout=15000)
            page.wait_for_timeout(700)     # let /api/providers land
            out: dict[str, dict] = {}
            if seeded:
                card = page.locator('.sq:has(.name:text-is("agent"))').first
                card.wait_for(timeout=15000)
                card.hover()
                page.wait_for_timeout(300)
                if plant:
                    got = page.evaluate(PLANT)
                    if got != "planted":
                        raise RuntimeError(f"control plant failed: {got}")
                out["node card"] = read_strip(
                    page, '.sq:has(.name:text-is("agent")) .hsof')
            out["eye/user card"] = read_strip(page, ".sq.user .hsof")
            browser.close()
        return pstate, out
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


def judge_codex_only(out: dict) -> list[str]:
    fail: list[str] = []
    for label, s in out.items():
        got = s["tiers"]
        for t in CLAUDE:
            if t in got:
                fail.append(f"{label}: Claude Code is NOT installed here, yet "
                            f"the {t} token still renders "
                            f"({'disabled' if got[t] else 'ENABLED'})")
        for t in ANTIGRAVITY:
            if t in got:
                fail.append(f"{label}: Antigravity is not installed, yet {t} renders")
        live = [t for t in CODEX if got.get(t) is False]
        if len(live) != len(CODEX):
            fail.append(f"{label}: Codex IS set up; expected all of {CODEX} "
                        f"offered, got {sorted(got)}")
        if s["none"]:
            fail.append(f"{label}: a harness IS set up — the no-harness badge "
                        f"must not show")
    return fail


def judge_bare(out: dict) -> list[str]:
    fail: list[str] = []
    for label, s in out.items():
        if s["tiers"]:
            fail.append(f"{label}: nothing is installed, yet these render: "
                        f"{sorted(s['tiers'])}")
        if not s["none"]:
            fail.append(f"{label}: no harness and no badge — an empty strip is "
                        f"indistinguishable from a broken one")
        elif "install or sign in" not in s["none"]["title"]:
            fail.append(f"{label}: the badge does not say what to do: "
                        f"{s['none']['title']!r}")
    return fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="orgtree-hireavail-a-") as t1:
        print("SCENARIO codex-only (the reported case)")
        pstate, out = scenario(t1, claude=False, codex=True, antigravity=False,
                               plant=args.expect_fail)
        for pid in ("claude", "openai", "google"):
            p = pstate.get(pid, {})
            st = p.get("status", {})
            print(f"  server: {p.get('label', pid):7} "
                  f"hire_enabled={p.get('hire_enabled')!r:6} "
                  f"installed={st.get('installed')!r}")
        for label, s in out.items():
            shown = {t: ("disabled" if d else "ENABLED")
                     for t, d in s["tiers"].items()}
            print(f"  {label}: {shown or 'no tier tokens'}"
                  + ("  + [no harness]" if s["none"] else ""))
        fail = judge_codex_only(out)

    if args.expect_fail:
        if not fail:
            print("\nCONTROL FAILED — planted pre-fix Claude tokens went "
                  "undetected")
            return 1
        print("\nCONTROL OK — the probe sees the planted wrong state:")
        for x in fail:
            print("  " + x)
        return 0

    with tempfile.TemporaryDirectory(prefix="orgtree-hireavail-b-") as t2:
        print("\nSCENARIO bare (a fresh machine, nothing installed)")
        _p2, out2 = scenario(t2, claude=False, codex=False, antigravity=False,
                             plant=False)
        for label, s in out2.items():
            print(f"  {label}: {sorted(s['tiers']) or 'no tier tokens'}"
                  + ("  + [no harness]" if s["none"] else ""))
        fail += judge_bare(out2)

    print()
    if fail:
        for x in fail:
            print("FAIL: " + x)
        return 1
    print("OK - only configured harnesses are offered; a bare machine says so")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
