"""crowdtoggle_probe.py — D-198: collapsing active agents into a stack is an
optional, app-wide, off-by-default preference.

    python -B tests/crowdtoggle_probe.py
    python -B tests/crowdtoggle_probe.py --expect-fail     # known-negative

THE BEHAVIOUR UNDER TEST
------------------------
The CROWD pile (OrgCanvas.tsx, "CROWD pile (user spec 2026-07-31)"): an agent
with more than eight ACTIVE reports collapses the reports that have none of
their own into a single stacked card. That is the only thing in the app that
stacks *active* agents — the retired pile stacks archived ones and is a
separate behaviour this probe deliberately leaves alone.

User ruling 2026-08-29: it "should be an optional toggle and off by default",
and (verbatim, on the follow-up) "app wide, not org wide".

So there are four claims here, and three of them are about ABSENCE, which is
why they need a probe that has been shown to detect PRESENCE first:
  1. off by default — a reader who has never touched the setting sees every
     active agent, and "never touched" must mean no stored value at all
  2. it can be turned on, and turning it on collapses the canvas live
  3. it can be turned back off, live, with agents on screen
  4. it is app-wide: it survives switching org, and it is not filed per-org

WHY A REAL BROWSER
------------------
The claim is about what a reader sees on the canvas after clicking a real
checkbox, and about localStorage keys surviving a real navigation between two
real orgs. jsdom would let this pass with the layout never having run and the
preference never having round-tripped through a page load.

RUN IT WITH the plain `python` on PATH (playwright + fastapi + uvicorn +
websockets). ⚠ It does NOT build — run `npm run build` first or you measure a
stale `dist`.

HARD CONSTRAINTS OBSERVED
-------------------------
- Binds ONLY port 7407 by default (--port to override). Never 7360/7361/7362
  (the live deployment) and never 7401 (the backend test rig).
- Own ORGTREE_DATA/HOME under a temp dir, ORGTREE_BRIDGE_PORT=0, fakecli —
  no real model call. Deletes both orgs it creates.

WHAT IT ASSERTS
---------------
§1  RIG IS LOADED. With the preference ON, a crowd stack really appears and
    the visible agent count really drops. A run where the canvas never
    collapsed at all FAILS here rather than sailing through §2 — "no stack on
    screen" and "this probe cannot see a stack" are indistinguishable
    otherwise, and §2 is an absence check standing directly on this.
§2  DEFAULT OFF. A browser context with empty localStorage shows no crowd
    stack and every hired agent's own card.
§3  DEFAULT OFF MEANS *UNSET*. Before the settings panel is ever opened there
    is no stored value at all — so existing users, who have no value either,
    take the same branch rather than some undefined-behaves-as-on path.
§4  TURN IT ON through the real settings checkbox: the canvas collapses with
    no reload.
§5  TURN IT BACK OFF, live: every agent card returns, with no reload.
§6  PERSISTS across a page reload.
§7  APP-WIDE. With it on, navigate to a SECOND org — still collapsed there —
    and no localStorage key holding this preference carries a slug.

THE KNOWN-NEGATIVE CONTROL
--------------------------
`--expect-fail` seeds `orgtree-crowd-piles = '1'` into the context before the
first page load — a VALUE replacement (the stored preference), not a syntax
break and not a code edit. It makes the canvas arrive collapsed, so §2 and §3
must go RED. That is the pair that proves those two absence checks actually
discriminate a collapsed canvas from an uncollapsed one, rather than passing
because they are looking at nothing.

(The probe was ALSO run against the pre-fix build, where the toggle does not
exist and crowd piles are unconditional — see the commit message.)
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

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7407
EXPECT_FAIL = "--expect-fail" in sys.argv
BASE = f"http://127.0.0.1:{PORT}"

KEY = "orgtree-crowd-piles"
# The crowd pile needs MORE THAN EIGHT active reports under one parent, of
# which at least two are leaves. Ten leaf agents clears both with margin, and
# leaves a visible count that changes unmistakably when they collapse.
N_AGENTS = 10
NAMES = [f"leaf{i:02d}" for i in range(N_AGENTS)]

TMP = tempfile.mkdtemp(prefix="orgtree-crowdtoggle-")
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)
with open(os.path.join(HOME, ".claude.json"), "w", encoding="utf-8") as _f:
    json.dump({"oauthAccount": {"accountUuid": "crowdtoggle-probe",
                                "emailAddress": "probe@example.test"}}, _f)

PROC: subprocess.Popen | None = None
RESULTS: list[tuple[str, bool, str]] = []
_ORGS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def api(method: str, path: str, body=None, timeout: float = 30):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def _log_tail(n: int = 3000) -> str:
    try:
        return open(LOG, encoding="utf-8", errors="replace").read()[-n:]
    except OSError:
        return "(no log)"


def start_backend() -> None:
    global PROC
    env = dict(os.environ)
    env.update({
        "ORGTREE_DATA": DATA, "USERPROFILE": HOME, "HOME": HOME,
        "ORGTREE_PORT": str(PORT),
        "FAKECLI_CONFIG": CFG,
        "ORGTREE_MAX_TURNS": "16",
        "ORGTREE_STEER_HOOK": "0",
        "ORGTREE_TURN_TIMEOUT": "60",
        "PYTHONPATH": os.path.join(_REPO, "backend"),
        "PYTHONIOENCODING": "utf-8",
        "ORGTREE_BRIDGE_PORT": "0",
        "ORGTREE_CLAUDE": os.path.join(_REPO, "backend", "tests", "fakecli.js"),
        "ORGTREE_CLAUDE_CLI": os.path.join(_REPO, "backend", "tests", "fakecli.js"),
    })
    env.pop("ORGTREE_PUBLIC_PORT", None)
    env.pop("ORGTREE_EXPOSE_ADMIN", None)
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump({"default": {"replyText": "ack."}}, f)
    log = open(LOG, "a", encoding="utf-8")
    PROC = subprocess.Popen(
        [sys.executable, "-m", "orgtree.api"], cwd=os.path.join(_REPO, "backend"),
        env=env, stdout=log, stderr=log, text=True)
    for _ in range(200):
        if PROC.poll() is not None:
            raise RuntimeError(f"backend exited with {PROC.returncode}:\n" + _log_tail())
        try:
            urllib.request.urlopen(BASE + "/api/orgs", timeout=1).read()
            print(f"backend up on :{PORT}")
            return
        except Exception:                                        # noqa: BLE001
            time.sleep(0.1)
    raise RuntimeError(f"backend did not come up on {PORT}:\n" + _log_tail())


def stop_backend() -> None:
    global PROC
    if PROC is None:
        return
    PROC.terminate()
    try:
        PROC.wait(timeout=10)
    except subprocess.TimeoutExpired:
        PROC.kill()
    PROC = None


def make_org(label: str, names: list[str]) -> str:
    r = api("POST", "/api/orgs", {"name": f"zz crowdtoggle {label}"})
    slug = r.get("slug") or r.get("org", {}).get("slug")
    _ORGS.append(slug)
    for nm in names:
        api("POST", f"/api/orgs/{slug}/ops", {
            "op": "hire", "actor": "@user", "parent": None, "tier": "haiku",
            "grant": 1, "name": nm, "charter": "a crowdtoggle-probe agent",
            "tools": {"bash": False, "web": False, "edit": False,
                      "subagents": False, "mcp": []},
            "org_visibility": "team", "add_dirs": []})
    return slug


def drop_orgs() -> None:
    for slug in list(_ORGS):
        try:
            api("DELETE", f"/api/orgs/{slug}")
        except Exception as e:                                    # noqa: BLE001
            print(f"  (cleanup) failed to delete {slug}: {e}")


# ------------------------------------------------------------ browser helpers

def canvas_state(pg) -> dict:
    """What the reader can actually see. Buried pile members are not in the DOM
    as their own card at all, so counting cards BY NAME is a direct measure of
    'this agent is visible', not a proxy for it."""
    return pg.evaluate(
        """(names) => {
          const shown = names.filter((n) => [...document.querySelectorAll('.sq .name')]
            .some((e) => e.textContent.trim() === n));
          return {
            crowdStacks: document.querySelectorAll('.pile-stack.crowd').length,
            retiredStacks: document.querySelectorAll('.pile-stack:not(.crowd)').length,
            shown: shown.length,
            missing: names.filter((n) => !shown.includes(n)),
            stored: localStorage.getItem('%s'),
          };
        }""" % KEY, NAMES)


def open_org(pg, slug: str) -> None:
    pg.goto(f"{BASE}/o/{slug}")
    pg.wait_for_selector(".sq", timeout=15000)
    pg.wait_for_timeout(2500)                     # let the intro fit settle


def set_toggle(pg, want: bool) -> str:
    """Drive the REAL settings checkbox. Returns a description of what it did."""
    # D-203 moved this app-wide preference out of the per-org panel. Keep the
    # canvas alive and drive App settings in a second page, so the check below
    # requires the storage event to update an already-rendered org live.
    settings_pg = pg.context.new_page()
    settings_pg.goto(BASE)
    settings_pg.locator('button[title="App settings"]:visible').click()
    settings_pg.wait_for_selector(".settings.acct-panel", timeout=10000)
    settings_pg.get_by_role("tab", name="Display this browser").click()
    # ⚠ Wait for the PANEL, then look for the toggle without throwing. Waiting
    # on the toggle's own selector makes "the toggle does not exist" an
    # EXCEPTION rather than a finding, which is exactly what the pre-fix
    # control looks like — and a control that dies is not a control.
    box = settings_pg.locator(
        '.settings label.checkline:has-text("collapse teams with more than 8 active agents")'
    ).locator("input[type=checkbox]")
    for _ in range(20):
        if box.count() == 1:
            break
        settings_pg.wait_for_timeout(100)
    if box.count() != 1:
        settings_pg.close()
        return f"NO TOGGLE IN THE SETTINGS PANEL ({box.count()} matches)"
    was = box.is_checked()
    if was != want:
        box.click()
    settings_pg.wait_for_timeout(300)
    now = box.is_checked()
    settings_pg.close()
    pg.wait_for_timeout(600)
    return f"checkbox {was} -> {now}"


def run(pg, slug2: str) -> None:
    # ---- §2/§3 the default, on a context that has never stored anything ----
    st = canvas_state(pg)
    print(f"  default: {st}")
    check("§2a default OFF — no crowd stack on the canvas",
          st["crowdStacks"] == 0, f"{st['crowdStacks']} crowd stack(s)")
    check("§2b default OFF — every active agent has its own card",
          st["shown"] == N_AGENTS,
          f"{st['shown']}/{N_AGENTS} visible; missing={st['missing']}")
    check("§3 default OFF means UNSET — nothing stored before the panel is opened",
          st["stored"] is None, f"stored value = {st['stored']!r}")

    # ---- §4 turn it on, live -------------------------------------------
    did = set_toggle(pg, True)
    on = canvas_state(pg)
    print(f"  after ON  ({did}): {on}")
    # ⚠ the "toggle was actually operated" clause is load-bearing. On a build
    # with NO toggle the canvas is already collapsed, so "turning it on
    # collapses the canvas" holds vacuously — a check that passes when the
    # control it depends on does not exist is a check that can lie.
    check("§4a turning it on collapses the canvas with no reload",
          on["crowdStacks"] == 1 and "NO TOGGLE" not in did,
          f"{on['crowdStacks']} crowd stack(s); {did}")
    check("§4b turning it on hides the stacked agents' own cards",
          on["shown"] < N_AGENTS and "NO TOGGLE" not in did,
          f"{on['shown']}/{N_AGENTS} still visible; {did}")
    check("§4c the stored value reads on",
          on["stored"] == "1", f"stored = {on['stored']!r}")

    # ---- §1 THE RIG. Everything above about absence rests on this: the
    #        probe has now been shown to detect a stack when one exists.
    check("§1 RIG — this probe can see a crowd stack at all (else §2 is vacuous)",
          on["crowdStacks"] == 1 and on["shown"] < N_AGENTS,
          f"collapsed view: {on['crowdStacks']} stack, "
          f"{N_AGENTS - on['shown']} of {N_AGENTS} agents folded away")

    # ---- §6 persists across a reload ------------------------------------
    pg.reload()
    pg.wait_for_selector(".sq", timeout=15000)
    pg.wait_for_timeout(2500)
    rl = canvas_state(pg)
    check("§6 the setting survives a page reload",
          rl["crowdStacks"] == 1 and rl["stored"] == "1",
          f"{rl['crowdStacks']} stack(s), stored={rl['stored']!r}")

    # ---- §7 app-wide, not org-wide --------------------------------------
    open_org(pg, slug2)
    other = pg.evaluate("""() => ({
      crowdStacks: document.querySelectorAll('.pile-stack.crowd').length,
      stored: localStorage.getItem('%s'),
      slugKeys: Object.keys(localStorage).filter((k) => k.includes('crowd')),
    })""" % KEY)
    check("§7a the setting still applies in a DIFFERENT org (app-wide)",
          other["crowdStacks"] == 1 and other["stored"] == "1",
          f"second org: {other['crowdStacks']} stack(s), stored={other['stored']!r}")
    check("§7b the preference is stored under exactly one key, with no slug in it",
          other["slugKeys"] == [KEY], f"keys = {other['slugKeys']}")

    # ---- §5 turn it back off, live, with agents on screen ----------------
    open_org(pg, _ORGS[0])
    did = set_toggle(pg, False)
    off = canvas_state(pg)
    print(f"  after OFF ({did}): {off}")
    check("§5a turning it back off removes the stack with no reload",
          off["crowdStacks"] == 0 and "NO TOGGLE" not in did,
          f"{off['crowdStacks']} crowd stack(s); {did}")
    check("§5b every agent card returns",
          off["shown"] == N_AGENTS,
          f"{off['shown']}/{N_AGENTS} visible; missing={off['missing']}")


def main() -> int:
    print(f"crowdtoggle_probe — {'CONTROL (--expect-fail)' if EXPECT_FAIL else 'shipped build'}")
    if not os.path.isdir(os.path.join(_REPO, "frontend", "dist")):
        print("!! frontend/dist is missing — run `npm run build` first.")
        return 2
    start_backend()
    try:
        slug1 = make_org("a", NAMES)
        slug2 = make_org("b", NAMES)
        print(f"  two orgs, {N_AGENTS} leaf agents each: {slug1}, {slug2}")
        with sync_playwright() as p:
            # ⚠ RETRY THE BROWSER, NEVER A CHECK. Measured ~1 run in 7,
            # `ctx.new_page()` dies on a cold Edge start. The retry is scoped
            # strictly to constructing the browser/context/page — no assertion
            # has run at this point, so it cannot mask a product failure, only
            # a rig that never got off the ground. If it still fails, the probe
            # goes RED (0/1) rather than reporting an empty green.
            br = ctx = pg = None
            for attempt in range(3):
                try:
                    br = p.chromium.launch(channel="msedge", headless=True)
                    ctx = br.new_context(viewport={"width": 1600, "height": 950})
                    if EXPECT_FAIL:
                        # VALUE replacement: the preference arrives already
                        # stored as on, so the canvas is collapsed before
                        # anything is clicked. §2 and §3 must detect that.
                        # Installed BEFORE the first page exists, so it is in
                        # place for the very first navigation.
                        ctx.add_init_script(
                            "try { localStorage.setItem('%s', '1') } catch (e) {}" % KEY)
                    pg = ctx.new_page()
                    break
                except Exception as e:                            # noqa: BLE001
                    print(f"  (browser start attempt {attempt + 1} failed: {e})")
                    if br is not None:
                        try:
                            br.close()
                        except Exception:                         # noqa: BLE001
                            pass
                    br = ctx = pg = None
            if pg is None:
                raise RuntimeError("could not start a browser after 3 attempts")
            try:
                open_org(pg, slug1)
                run(pg, slug2)
            finally:
                shot = os.path.join(_HERE, "crowdtoggle-%s.png"
                                    % ("control" if EXPECT_FAIL else "fixed"))
                try:
                    pg.screenshot(path=shot)
                    print(f"  screenshot: {shot}")
                except Exception:                                 # noqa: BLE001
                    pass
                br.close()
    except Exception:                                             # noqa: BLE001
        traceback.print_exc()
        check("probe ran to completion", False, "exception above")
    finally:
        drop_orgs()
        stop_backend()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    if EXPECT_FAIL:
        if not RESULTS:
            print("CONTROL INCONCLUSIVE: the run produced no checks at all.")
            return 1
        want = {"§2a", "§2b", "§3"}
        hit = {n.split()[0] for n, ok, _ in RESULTS if not ok}
        if want & hit:
            print(f"CONTROL OK: the seeded-on preference was detected by "
                  f"{sorted(want & hit)} — those absence checks can go red.")
            return 0
        print("CONTROL FAILED: a canvas that arrives COLLAPSED was not detected "
              "by §2/§3. Their green means nothing until that is fixed.")
        return 1
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
