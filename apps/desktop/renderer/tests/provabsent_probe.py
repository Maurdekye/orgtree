"""Real-Edge probe: a provider this machine lacks appears NOWHERE (D-202).

THE RULING (user, 2026-08-30): "if codex isnt installed at all, then codex
shouldnt appear anywhere in the ui whatsoever; it should be entirely absent.
same with antigravity. with claude, since orgtree is built around it, do show that
its not installed on the accounts page, but make it a very small piece of ui."

D-199 proved the HIRE strips obey that. This probe exists because the strips
were never the whole story: the same machine still said "Codex" in the accounts
panel, in the model-switch dropdown, in the usage modal and in the usage
button's tooltip. Those surfaces are read here SEPARATELY, in a real browser,
on a backend whose CLIs are genuinely absent — not mocked payloads, the same
env-override resolution a real install uses.

  SCENARIO claude-only  — Claude present and signed in; Codex and Antigravity
                          resolved to paths that do not exist. The common case
                          for a new user, and the one the ruling is about:
                          the words "Codex" and "Antigravity" must not appear in
                          ANY of the four surfaces.
  SCENARIO codex-signed-out
                        — Codex INSTALLED but not signed in. The user
                          confirmed this state separately ("if it is installed
                          but not configured, thats when it appears in the ui
                          with greyed out hire tokens"), so Codex must be
                          PRESENT here. This is the control that stops the
                          probe passing on a build that simply deletes Codex.
  SCENARIO bare         — nothing installed. Claude's exception is the whole
                          check: exactly one small line on the accounts page,
                          and still no Codex or Antigravity anywhere.

`--expect-fail` is the negative control. It does not assert the opposite; it
PLANTS the pre-fix markup in the live page — a Codex accounts section and a
Codex optgroup in the model dropdown, which is what this build emitted before
D-202 — and requires the healthy assertions to fire. An instrument that cannot
tell the fixed page from the broken one proves nothing.

    python frontend/tests/provabsent_probe.py
    python frontend/tests/provabsent_probe.py --expect-fail
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PORT = 7457
BASE = f"http://127.0.0.1:{PORT}"

CODEX_TIERS = ["gpt-reserve", "luna", "terra", "sol"]
ANTIGRAVITY_TIERS = ["flash", "pro"]

# The pre-D-202 markup, recreated live for the control: the accounts panel's
# Codex section and the model dropdown's Codex optgroup, both of which this
# build rendered unconditionally before the fix.
PLANT_ACCOUNTS = """() => {
  const panel = document.querySelector('.acct-panel')
  if (!panel) return 'no accounts panel'
  const head = document.createElement('div')
  head.className = 'acct-provider-head prov-openai'
  head.textContent = 'Codex · Codex CLI'
  const note = document.createElement('div')
  note.className = 'dim acct-prov-note'
  note.textContent = 'not installed on this machine'
  panel.appendChild(head)
  panel.appendChild(note)
  return 'planted'
}"""

PLANT_MODEL = """() => {
  const sel = document.querySelector('select.model-switch')
  if (!sel) return 'no model select'
  const g = document.createElement('optgroup')
  g.label = 'Codex'
  for (const t of ['luna', 'terra', 'sol']) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t + ' · seat 1'
    g.appendChild(o)
  }
  sel.appendChild(g)
  return 'planted'
}"""


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def start_backend(tmp: str, *, claude: bool, codex: bool, codex_auth: bool,
                  antigravity: bool):
    """A throwaway install whose CLIs are present or absent to order.

    `codex_auth` is the axis D-202 turns on: a Codex that is INSTALLED but not
    signed in must stay visible, so the probe can tell "absent" from "not
    configured" rather than lumping both under "unavailable".
    """
    data = os.path.join(tmp, "data")
    home = os.path.join(tmp, "home")
    codex_home = os.path.join(tmp, "codex-home")
    for d in (data, home, codex_home):
        os.makedirs(d, exist_ok=True)
    with open(os.path.join(data, "defaults.json"), "w", encoding="utf-8") as f:
        json.dump({"net_hub_address": "http://127.0.0.1:9"}, f)
    if claude:
        # `accounts.live_identity()` reads ~/.claude.json for `oauthAccount`,
        # and the hire gate needs a SIGNED-IN Claude, not merely an installed
        # one. Writing it here is what lets this probe seed a real agent card
        # through the ledger's own door instead of poking the org doc.
        with open(os.path.join(home, ".claude.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"oauthAccount": {"accountUuid": "probe-uuid",
                                        "emailAddress": "probe@example.test"}},
                      f)
    if codex and codex_auth:
        # the existence of auth.json IS the connect detection (the same fake
        # the codex suites use)
        with open(os.path.join(codex_home, "auth.json"), "w",
                  encoding="utf-8") as f:
            f.write('{"tokens": {}}')
    fake_codex = os.path.join(REPO, "backend", "tests", "fakecodex.py")
    fake_cli = os.path.join(REPO, "backend", "tests", "fakecli.js")
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": data, "USERPROFILE": home, "HOME": home,
        "CODEX_HOME": codex_home,
        "ORGTREE_CODEX": (fake_codex if codex
                          else os.path.join(data, "no", "codex.exe")),
        "ORGTREE_ANTIGRAVITY": (fake_antigravity if antigravity
                           else os.path.join(data, "no", "gem.exe")),
        "ANTIGRAVITY_HOME": os.path.join(data, "ghome"),
        "ORGTREE_CLAUDE": (fake_cli if claude
                           else os.path.join(data, "no", "claude.exe")),
        "ORGTREE_PORT": str(PORT), "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_PUBLIC_PORT": "0", "ORGTREE_EXPOSE_ADMIN": "0",
        "PYTHONPATH": os.path.join(REPO, "backend"),
        "PYTHONIOENCODING": "utf-8",
        "ORGTREE_CLAUDE_CLI": fake_cli,
    })
    log = open(os.path.join(tmp, "backend.log"), "w", encoding="utf-8")
    py = os.path.join(REPO, ".venv", "Scripts" if os.name == "nt" else "bin",
                      "python.exe" if os.name == "nt" else "python")
    if not os.path.exists(py):
        py = sys.executable
    proc = subprocess.Popen([py, "-m", "orgtree.api"],
                            cwd=os.path.join(REPO, "backend"), env=env,
                            stdout=log, stderr=log, text=True)
    for _ in range(200):
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


def read_surfaces(page, *, plant: bool) -> dict:
    """The four surfaces D-202 touched, each read on its own terms.

    Read SEPARATELY and reported separately: a pass on one proves nothing
    about the others, which is exactly how the hire strips diverged before
    D-199.
    """
    out: dict = {}

    # ⚠ THE TWO SURFACE GROUPS LIVE ON DIFFERENT PAGES, and assuming otherwise
    # is what made the first run of this probe time out for 20s against a
    # button that was never going to appear. `orgPanel` — the h1 owning the
    # usage button and the accounts button — renders on the WELCOME page and
    # in the mobile drawer, NOT in the org view, whose header carries a
    # different usage button of its own. So the model dropdown is read in the
    # org view and the other three on the home page, which is also where a
    # real user reaches each of them.

    # ── surface 1: the model-switch dropdown, inside a node's config ──────
    card = page.locator('.sq:has(.name:text-is("agent"))').first
    if card.count():
        card.hover()
        page.wait_for_timeout(200)
        card.locator(".gearbtn").first.evaluate("el => el.click()")
        page.locator(".settings select.model-switch").wait_for(timeout=10000)
        if plant:
            got = page.evaluate(PLANT_MODEL)
            if got != "planted":
                raise RuntimeError(f"model plant failed: {got}")
        out["model dropdown"] = page.locator(
            ".settings select.model-switch").inner_text()
        out["model optgroups"] = page.locator(
            ".settings select.model-switch optgroup").evaluate_all(
                "els => els.map(e => e.label)")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    else:
        out["model dropdown"] = ""
        out["model optgroups"] = []

    # ── the home page, for the remaining three ────────────────────────────
    page.goto(BASE + "/")
    usage_btn = page.locator("button.h1-usage").first
    usage_btn.wait_for(timeout=20000)
    page.wait_for_timeout(900)          # let /api/providers land here too

    # ── surface 2: the usage button's tooltip (a string, no panel) ────────
    out["usage tooltip"] = usage_btn.get_attribute("title") or ""

    # ── surface 3: the accounts panel ─────────────────────────────────────
    page.locator('button[title="Claude accounts"]').first.click()
    page.locator(".acct-panel").wait_for(timeout=10000)
    page.wait_for_timeout(600)          # let /api/providers land
    if plant:
        got = page.evaluate(PLANT_ACCOUNTS)
        if got != "planted":
            raise RuntimeError(f"accounts plant failed: {got}")
    out["accounts panel"] = page.locator(".acct-panel").inner_text()
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)

    # ── surface 4: the usage modal ────────────────────────────────────────
    page.locator("button.h1-usage").first.click()
    page.locator(".usage-modal").wait_for(timeout=10000)
    page.wait_for_timeout(600)
    out["usage modal"] = page.locator(".usage-modal").inner_text()
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    return out


def scenario(tmp: str, *, claude: bool, codex: bool, codex_auth: bool,
             antigravity: bool, plant: bool) -> tuple[dict, dict]:
    proc, log = start_backend(tmp, claude=claude, codex=codex,
                              codex_auth=codex_auth, antigravity=antigravity)
    try:
        pay = api("GET", "/api/providers")
        pstate = {p["id"]: p for p in pay["providers"]}
        made = api("POST", "/api/orgs", {"name": "prov absent probe"})
        slug = made.get("slug") or made["org"]["slug"]
        # an agent card to open a config panel on. Hired at whatever tier this
        # machine can actually run, through the ledger's own door.
        tier = "haiku" if claude else "luna" if (codex and codex_auth) else None
        if tier:
            try:
                api("POST", f"/api/orgs/{slug}/ops", {
                    "op": "hire", "actor": "@user", "parent": None,
                    "tier": tier, "grant": 10, "name": "agent", "add_dirs": [],
                    "tools": {"bash": False, "web": False, "edit": False,
                              "subagents": False, "mcp": []},
                    "org_visibility": "team"})
            except Exception as e:                             # noqa: BLE001
                print(f"  (hire refused, reading the rest: {e})")
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.goto(f"{BASE}/o/{slug}")
            page.locator(".sq.user").first.wait_for(timeout=20000)
            page.wait_for_timeout(900)      # let /api/providers land
            out = read_surfaces(page, plant=plant)
            browser.close()
        return pstate, out
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


def mentions(text: str, word: str) -> bool:
    return re.search(rf"\b{word}\b", text, re.I) is not None


def judge_absent(out: dict, words: list[str]) -> list[str]:
    """No surface may name a provider this machine does not have."""
    fail = []
    for label, val in out.items():
        text = val if isinstance(val, str) else " ".join(val)
        for w in words:
            if mentions(text, w):
                fail.append(f"{label}: names {w!r} on a machine without it "
                            f"— {text.strip()[:200]!r}")
    # the tier words are a second, independent way to catch the same leak: a
    # dropdown could drop the "Codex" label and still list Codex tiers.
    # Guarded because callers pass a SUBSET of the surfaces when they only
    # mean to ask about one of them.
    if "model dropdown" in out:
        text = " ".join(out.get("model optgroups", [])) + " " \
            + out["model dropdown"]
        for t in CODEX_TIERS + ANTIGRAVITY_TIERS:
            if mentions(text, t):
                fail.append(f"model dropdown: offers tier {t!r}")
    return fail


def judge_claude_line(out: dict, *, absent: bool) -> list[str]:
    """Claude's exception: reported when missing, silent when present, and
    never more than a line."""
    text = out["accounts panel"]
    said = bool(re.search(r"not installed", text, re.I))
    if absent and not said:
        return ["accounts panel: Claude is NOT installed here and the panel "
                "says nothing — the one exception the user asked for"]
    if not absent and said:
        return ["accounts panel: Claude IS installed, yet the panel carries "
                "an install nag"]
    if absent:
        hits = [ln for ln in text.splitlines()
                if re.search(r"not installed", ln, re.I)]
        if len(hits) != 1:
            return [f"accounts panel: the Claude notice must be ONE small "
                    f"line, saw {len(hits)}: {hits}"]
    return []


def judge_present(out: dict, word: str) -> list[str]:
    """The control leg: an INSTALLED provider must still be everywhere it was.
    Without this the probe would pass on a build that deleted the provider."""
    fail = []
    for label in ("accounts panel", "model optgroups"):
        val = out[label]
        text = val if isinstance(val, str) else " ".join(val)
        if not mentions(text, word):
            fail.append(f"{label}: {word} IS installed here (signed out) and "
                        f"must still appear, greyed out — it is absent")
    return fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true",
                    help="plant the pre-D-202 markup; the checks must fire")
    args = ap.parse_args()
    plant = args.expect_fail
    problems: list[str] = []

    print("=" * 70)
    print("SCENARIO claude-only — codex and antigravity genuinely not installed")
    print("=" * 70)
    with tempfile.TemporaryDirectory(prefix="orgtree-d202-a-") as tmp:
        pstate, out = scenario(tmp, claude=True, codex=False, codex_auth=False,
                               antigravity=False, plant=plant)
        for pid in ("claude", "openai", "google"):
            st = pstate[pid]["status"]
            print(f"  server: {pid:7s} installed={st.get('installed')} "
                  f"connected={st.get('connected')}")
        for label, val in out.items():
            print(f"  {label}: {val if isinstance(val, str) else val}"[:900])
        fails = judge_absent(out, ["Codex", "Antigravity"])
        fails += judge_claude_line(out, absent=False)
        problems += [f"[claude-only] {f}" for f in fails]

    print()
    print("=" * 70)
    print("SCENARIO codex-signed-out — INSTALLED but not configured")
    print("=" * 70)
    with tempfile.TemporaryDirectory(prefix="orgtree-d202-b-") as tmp:
        pstate, out = scenario(tmp, claude=True, codex=True, codex_auth=False,
                               antigravity=False, plant=False)
        st = pstate["openai"]["status"]
        print(f"  server: openai installed={st.get('installed')} "
              f"connected={st.get('connected')}")
        for label, val in out.items():
            print(f"  {label}: {val if isinstance(val, str) else val}"[:900])
        # the user-confirmed middle state: present, greyed, with its reason
        fails = judge_present(out, "Codex")
        fails += judge_absent({"accounts panel": out["accounts panel"]},
                              ["Antigravity"])
        problems += [f"[codex-signed-out] {f}" for f in fails]

    print()
    print("=" * 70)
    print("SCENARIO bare — nothing installed at all")
    print("=" * 70)
    with tempfile.TemporaryDirectory(prefix="orgtree-d202-c-") as tmp:
        pstate, out = scenario(tmp, claude=False, codex=False,
                               codex_auth=False, antigravity=False, plant=False)
        for label, val in out.items():
            print(f"  {label}: {val if isinstance(val, str) else val}"[:900])
        fails = judge_absent(out, ["Codex", "Antigravity"])
        fails += judge_claude_line(out, absent=True)
        problems += [f"[bare] {f}" for f in fails]

    print()
    print("=" * 70)
    if plant:
        if problems:
            print(f"CONTROL OK — the planted pre-D-202 markup was DETECTED "
                  f"({len(problems)} finding(s)):")
            for p in problems[:8]:
                print(f"  · {p}")
            return 0
        print("CONTROL FAILED — the probe could not tell the broken page from "
              "the fixed one. Every pass it reports is worthless.")
        return 1
    if problems:
        print(f"FAIL — {len(problems)} finding(s):")
        for p in problems:
            print(f"  x {p}")
        return 1
    print("PASS — an uninstalled provider is absent from every surface read, "
          "an installed-but-signed-out one is still present, and Claude's "
          "absence is reported in exactly one line.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
