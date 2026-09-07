"""Real-Edge probe for the lineage panel's rehire tier picker (D-197).

"The option appears" and "the option is offered as usable" are different
claims, and the component test can only make the first one about a jsdom
select. This opens a REAL browser on the built app, makes a REAL knowledge
bearer (hire → cheap_compact), opens the lineage panel from its own stack
badge, and reads the native `<option>` state the user would actually see.

Two orgs are driven, because the bug had two halves and one org can only show
one of them:

  · a CLAUDE bearer  — every claude tier offered INCLUDING fable (the option
    the hard-coded ['haiku','sonnet','opus'] list never had), the five
    codex/antigravity tiers present-but-disabled with a written reason;
  · a CODEX bearer   — the mirror image: its own family enabled, the claude
    tiers disabled, and its seats rendering as NUMBERS (this panel's seat
    table was claude-only, so a sol bearer read "as sol · seat undefined").

`--expect-fail` is the negative control. It restores the exact pre-fix
behaviour in the loaded page — the original three-tier list, and the
claude-only seat lookup — and the healthy assertions must then fire. A probe
that cannot tell the fixed panel from the broken one proves nothing; this is
the check that it can.

    python frontend/tests/bearerrehire_probe.py
    python frontend/tests/bearerrehire_probe.py --expect-fail
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
PORT = 7452
BASE = f"http://127.0.0.1:{PORT}"

CLAUDE = ["haiku", "sonnet", "opus", "fable"]
CODEX = ["gpt-reserve", "luna", "terra", "sol"]
ANTIGRAVITY = ["flash", "pro"]
SEATS = {"haiku": 1, "sonnet": 2, "opus": 5, "fable": 10,
         "gpt-reserve": 1, "luna": 1, "terra": 2, "sol": 5,
         "flash": 1, "pro": 2}

# The pre-fix panel, re-created in the live page for the control: the literal
# tier list this bug was reported about, and the claude-only seat table.
PREFIX_PATCH = """() => {
  const sel = document.querySelector('.lin-row select')
  if (!sel) return 'no select'
  const OLD = ['haiku', 'sonnet', 'opus']
  const CLAUDE_ONLY = { haiku: 1, sonnet: 2, opus: 5, fable: 10 }
  for (const o of [...sel.options]) {
    if (o.value === '') {          // the "as <tier> · seat N" default row
      const t = o.textContent.match(/as (\\S+)/)[1]
      o.textContent = `as ${t} \\u00b7 seat ${CLAUDE_ONLY[t]}`
      continue
    }
    if (!OLD.includes(o.value)) { o.remove(); continue }
    o.disabled = false
    o.textContent = `as ${o.value} \\u00b7 seat ${CLAUDE_ONLY[o.value]}`
  }
  return 'patched'
}"""


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def findings(tier: str, rows: list[dict]) -> list[str]:
    """What the panel must show for a bearer that ran on `tier`."""
    fail: list[str] = []
    fam = (CODEX if tier in CODEX else ANTIGRAVITY if tier in ANTIGRAVITY else CLAUDE)
    label = ("Codex" if tier in CODEX
             else "Antigravity" if tier in ANTIGRAVITY else "Claude")
    by = {r["value"]: r for r in rows}

    # ① every tier is LISTED — the omission is what read as a quirk
    missing = [t for t in SEATS if t != tier and t not in by]
    if missing:
        fail.append(f"tiers omitted from the picker entirely: {missing!r}")

    # ② the bearer's own family is offered
    for t in fam:
        if t == tier or t not in by:
            continue
        if by[t]["disabled"]:
            fail.append(f"{t} shares {tier}'s provider but is disabled")

    # ③ ...and the others are shown, disabled, each saying why
    for t in SEATS:
        if t == tier or t in fam or t not in by:
            continue
        if not by[t]["disabled"]:
            fail.append(f"{t} crosses providers but is selectable")
        elif "cannot resume it" not in by[t]["text"]:
            fail.append(f"{t} is disabled without a reason: {by[t]['text']!r}")

    # ④ seats are real numbers on every family, never "undefined"
    for t, seat in SEATS.items():
        if t not in by:
            continue
        got = by[t]["seat"]
        if got is None or int(got) != seat:
            fail.append(
                f"{t} seat renders {got!r}, want {seat} "
                f"(text {by[t]['text']!r})")
    dflt = by.get("")
    if dflt is None:
        fail.append("no default 'as <tier>' row")
    elif dflt["text"] != f"as {tier} · seat {SEATS[tier]}":
        fail.append(f"default row reads {dflt['text']!r}")

    # ⑤ the specific option the user reported missing, when it applies
    if tier in CLAUDE and "fable" in by and by["fable"]["disabled"]:
        fail.append("fable is a claude tier and must be selectable")
    if label != "Claude" and "opus" in by \
            and label.lower() not in by["opus"]["text"].lower():
        fail.append(f"opus's reason does not name {label}: "
                    f"{by['opus']['text']!r}")
    return fail


def read_panel(page, slug: str, agent: str, patch: bool) -> list[dict]:
    page.goto(f"{BASE}/o/{slug}")
    card = page.locator(f'.sq:has(.name:text-is("{agent}"))').first
    card.wait_for(timeout=15000)
    # the stack badge is the real opener for the lineage panel
    badge = card.locator(".stackbadge")
    badge.wait_for(timeout=15000)
    badge.evaluate("el => el.click()")
    page.locator(".lineage-panel .lin-row select").first.wait_for(timeout=15000)
    if patch:
        got = page.evaluate(PREFIX_PATCH)
        if got != "patched":
            raise RuntimeError(f"control patch did not apply: {got}")
    return page.locator(".lineage-panel .lin-row select option").evaluate_all(
        """opts => opts.map(o => ({
             value: o.value,
             disabled: o.disabled,
             text: o.textContent.trim(),
             seat: (o.textContent.match(/seat (\\d+)\\b/) || [0, null])[1],
           }))""")


def make_bearer(slug_name: str, tier: str) -> tuple[str, str]:
    """A real archived knowledge bearer: hire, then cheap-compact."""
    made = api("POST", "/api/orgs", {"name": slug_name})
    slug = made.get("slug") or made["org"]["slug"]
    api("POST", f"/api/orgs/{slug}/ops", {
        "op": "hire", "actor": "@user", "parent": None, "tier": tier,
        "grant": 10, "name": "agent", "add_dirs": [],
        "tools": {"bash": False, "web": False, "edit": False,
                  "subagents": False, "mcp": []},
        "org_visibility": "team"})
    api("POST", f"/api/orgs/{slug}/ops",
        {"op": "cheap_compact", "actor": "@user", "node": "agent"})
    return slug, "agent"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="orgtree-bearerrehire-") as tmp:
        data = os.path.join(tmp, "data")
        home = os.path.join(tmp, "home")
        codex_home = os.path.join(tmp, "codex-home")
        os.makedirs(data); os.makedirs(home); os.makedirs(codex_home)
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
        # A codex bearer needs a codex HIRE, and hiring is gated on a connected
        # provider — the same gate D-197 just extended to rehire. Fake the
        # connect state exactly as test_codex_dispatch does: the CLI resolved
        # to the existing test double, and an auth.json whose EXISTENCE (never
        # its content) is what detection reads.
        with open(os.path.join(codex_home, "auth.json"), "w",
                  encoding="utf-8") as f:
            f.write('{"tokens": {}}')
        env = dict(os.environ)
        env.update({
            "ORGTREE_DATA": data, "USERPROFILE": home, "HOME": home,
            "CODEX_HOME": codex_home,
            "ORGTREE_CODEX": os.path.join(
                REPO, "backend", "tests", "fakecodex.py"),
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
                        with open(log.name, encoding="utf-8",
                                  errors="replace") as f:
                            tail = f.read()[-4000:]
                        raise RuntimeError("throwaway backend exited:\n" + tail)
                    time.sleep(.1)
            else:
                raise RuntimeError("throwaway backend did not start")

            claude_slug, a1 = make_bearer("bearer rehire claude", "opus")
            codex_slug, a2 = make_bearer("bearer rehire codex", "sol")

            fail: list[str] = []
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1500, "height": 900})
                for slug, agent, tier in ((claude_slug, a1, "opus"),
                                          (codex_slug, a2, "sol")):
                    rows = read_panel(page, slug, agent, args.expect_fail)
                    fail += [f"[{tier} bearer] {x}"
                             for x in findings(tier, rows)]
                browser.close()

            if args.expect_fail:
                if not fail:
                    print("CONTROL FAILED — the pre-fix panel (the original "
                          "three-tier list + claude-only seats) escaped "
                          "detection")
                    return 1
                print("CONTROL OK — pre-fix panel detected:\n  "
                      + "\n  ".join(fail[:8]))
                return 0
            if fail:
                print("\n".join("FAIL: " + x for x in fail))
                return 1
            print("OK — a real claude bearer offers all four claude tiers "
                  "(fable included) and a real codex bearer offers "
                  "gpt-reserve/luna/terra/sol, each cross-provider tier shown "
                  "disabled with a reason, "
                  "every seat a number")
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
