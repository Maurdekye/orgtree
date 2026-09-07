"""keyloss_probe.py — D-204: the advanced-org modal destroys an unsaved
one-time secret when you leave the tab it was typed into.

    python -B tests/keyloss_probe.py                  # asserts CORRECT behaviour
    python -B tests/keyloss_probe.py --expect-fail    # asserts the BUG is present

THE BEHAVIOUR UNDER TEST
------------------------
`AdvancedOrgModal` (App.tsx) renders exactly one tab's content:

    {tabs ? tabs[Math.min(tab, tabs.length - 1)]?.content : children}

so the inactive tabs are UNMOUNTED, not hidden. Any state held *inside* a tab
component therefore dies the moment you click another tab. `AutonomyTab` holds
a pasted API key in `const [key, setKey] = useState('')` and does not write it
anywhere until the user presses "set". One tab click and it is gone, with no
warning and no way back.

WHY THIS IS A DEFECT AND NOT A PREFERENCE
-----------------------------------------
The repo already ruled on this exact hazard, in the sibling panel, at
canvas/accounts.tsx:

    ⚠ NO CLIENT-SIDE FORMAT VALIDATION, DELIBERATELY. The CLI shows a minted
    token exactly once ("you won't be able to see it again"), so anything that
    could reject the paste before it is durable would destroy the only copy.

`AutonomyTab` destroys the paste on a tab click. Same class of secret, opposite
handling, ~200 lines apart in the same file tree.

WHAT "FAILING" LOOKS LIKE AND WHY §1/§2 EXIST
---------------------------------------------
Every claim in §3-§5 is an ABSENCE claim: "the value the user typed is no
longer there". An absence claim is worthless from a probe that cannot
demonstrate PRESENCE first — "the field is empty" and "this probe cannot read
that field" produce identical output. So:

§1  RIG. The panel opens, the advanced modal opens, a tab strip really exists,
    the autonomy tab is really reachable, the API-key input is really found,
    and a typed value really READS BACK while still on that tab. If any of
    this fails, §3-§5 are refused rather than reported.

§2  CONTROL — and this is the load-bearing half. The SAME gesture (leave the
    tab, come back) is applied to a field whose state is HOISTED above the tab
    strip: the general tab's fable-policy select, which rides SettingsPanel's
    own `edit` buffer. That value MUST survive. If the control is green while
    the subject is red, the difference is the bug — not the selector, not the
    timing, not the probe's ability to read a field after re-navigation.
    A run where §2 is ALSO red measures nothing and says so.

§3  SUBJECT A — tab switch. Paste a key on autonomy, click general, click
    autonomy. The value must still be there.
§4  SUBJECT B — modal close/reopen. Paste a key on autonomy, press "done",
    reopen "advanced…", return to autonomy. The value must still be there.
§5  SIBLING — the same defect in `NetTab`'s unsaved "add a remote mailserver"
    address. Lower stakes (retypeable), same mechanism; it is here so the fix
    is evaluated against the shape of the bug rather than one field.

§6  OBSERVATION, not a pass/fail claim: whether reopening the modal restores
    the tab you were on. Recorded because it changes what the user sees after
    §4 and would otherwise be mistaken for the fix failing.

EXIT SEMANTICS
--------------
Default: this asserts the CORRECT behaviour, so on today's code it EXITS
NON-ZERO. That red IS the demonstration that the probe fails current code; it
should go green on the D-204 fix and stay green.

`--expect-fail`: asserts the bug is present EXACTLY as described — §1 and §2
green, §3 and §4 red. Exits 0 only on that pattern. This is the mode that
proves the probe discriminates rather than being red for its own reasons. It
is the known-negative control, and it is a state-of-the-product control (an
unfixed build), not a code edit and not a syntax break.

HARD CONSTRAINTS OBSERVED
-------------------------
- Binds ONLY port 7408 by default (--port to override). Never 7360/7361/7362
  (the live deployment), never 7401 (the backend test rig), never 7407
  (crowdtoggle_probe).
- Own ORGTREE_DATA/HOME under a temp dir, ORGTREE_BRIDGE_PORT=0, fakecli — no
  real model call. Deletes the org it creates.
- ⚠ It does NOT build. Run `npm run build` first or you measure a stale `dist`.
- ⚠ NO REAL KEY IS EVER TYPED. The sentinel below is not a credential and the
  probe never presses "set", so nothing is ever sent to the server.
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

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 7408
EXPECT_FAIL = "--expect-fail" in sys.argv
HEADED = "--headed" in sys.argv
BASE = f"http://127.0.0.1:{PORT}"

# ⚠ NOT A CREDENTIAL. Shaped like the placeholder so it exercises the same
# input, deliberately invalid, and never submitted — the probe reads it back
# and never presses "set".
SENTINEL = "sk-ant-PROBE-D204-not-a-real-key-0000"
HUB_SENTINEL = "http://probe-d204.invalid:7370"

TMP = tempfile.mkdtemp(prefix="orgtree-keyloss-")
HOME = os.path.join(TMP, "home")
DATA = os.path.join(TMP, "data")
CFG = os.path.join(TMP, "fakecli.json")
LOG = os.path.join(TMP, "backend.log")
os.makedirs(HOME, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

PROC: subprocess.Popen | None = None
RESULTS: list[tuple[str, bool, str]] = []
NOTES: list[str] = []
_ORGS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def note(text: str) -> None:
    """An OBSERVATION — recorded, never scored. Kept separate from check() so
    nothing here can quietly turn a run green."""
    NOTES.append(text)
    print(f"  note  {text}")


def red(prefix: str) -> list[str]:
    return [n for n, ok, _ in RESULTS if not ok and n.startswith(prefix)]


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


def make_org() -> str:
    """A PLAIN org — deliberately not a kiosk. The autonomy tab is rendered
    only `{!kk && ...}`, so a kiosk org has no subject to test and the probe
    would pass by having nothing to look at.

    ⚠ NO AGENT IS HIRED, deliberately. The subject is a settings modal, which
    is reachable from the orgbar on an empty org — and hiring would drag in
    `provider_hire_gate`, which since D-199 requires a real installed Claude
    CLI *and* a signed-in account. Under this probe's own temp HOME there is
    no login, so a hire 422s and the probe would die in setup having measured
    nothing. (That is not hypothetical: it is why the first run of this probe
    failed, and crowdtoggle_probe.py has the same gap.)"""
    r = api("POST", "/api/orgs", {"name": "zz keyloss probe"})
    slug = r.get("slug") or r.get("org", {}).get("slug")
    _ORGS.append(slug)
    return slug


def drop_orgs() -> None:
    for slug in list(_ORGS):
        try:
            api("DELETE", f"/api/orgs/{slug}")
        except Exception as e:                                    # noqa: BLE001
            print(f"  (cleanup) failed to delete {slug}: {e}")


# ------------------------------------------------------------ browser helpers
#
# ⚠ ESCAPE IS NOT USED ANYWHERE IN THIS PROBE. Both SettingsPanel and
# AdvancedOrgModal call useEsc(close), so a single Escape can close the modal
# AND the panel behind it. A probe that navigated with Escape would be
# measuring its own key handling. Every close here goes through the button the
# user would actually press.

# ⚠ THE CHILD COMBINATOR IS LOAD-BEARING. The advanced modal renders INSIDE
# SettingsPanel's tree, so `.settings:has(.adv-tabs)` matches BOTH the inner
# modal and the outer panel that contains it, and `.first` then resolves to
# the OUTER one. That cost a run: `{ADV} select` picked the outer panel's
# "default thinking effort" select, which has no 'opus' option, and the
# control leg timed out looking for a value that was never on that element.
# `:has(> .adv-tabs)` matches only the element whose OWN child is the strip.
ADV = ".settings:has(> .adv-tabs)"        # the advanced modal (the inner .settings)
KEYFIELD = f'{ADV} input[placeholder*="sk-ant"]'
HUBFIELD = f'{ADV} input[placeholder*="add a remote mailserver"]'
POLICY = f'{ADV} select'                  # first select on the general tab


def open_settings(pg) -> None:
    # ⚠ `:visible` is load-bearing — the orgbar also carries a HIDDEN
    # mobile-only ellipsis button, and a plain has-text() match resolves to
    # that one and then sits there until the timeout.
    pg.locator('.orgbar button:visible:has-text("settings")').first.click()
    pg.wait_for_selector(".settings", timeout=10000)
    pg.wait_for_timeout(250)


def close_settings(pg) -> None:
    pg.locator('.settings >> text="cancel"').last.click()
    pg.wait_for_timeout(400)


def open_advanced(pg) -> None:
    pg.locator(".settings button.disclosure").first.click()
    pg.wait_for_selector(ADV, timeout=10000)
    pg.wait_for_timeout(250)


def close_advanced(pg) -> None:
    """The modal's own 'done' — AdvancedOrgModal has no save of its own, so
    this is the ordinary way a user leaves it."""
    pg.locator(f'{ADV} button:has-text("done")').first.click()
    pg.wait_for_timeout(400)


def tab_labels(pg) -> list[str]:
    return [t.strip() for t in
            pg.locator(f"{ADV} .adv-tabs button.adv-tab").all_inner_texts()]


def active_tab(pg) -> str:
    loc = pg.locator(f"{ADV} .adv-tabs button.adv-tab.on")
    return loc.first.inner_text().strip() if loc.count() else "(none)"


def click_tab(pg, label: str) -> bool:
    """Select a tab BY LABEL, never by index: the tab array is built
    conditionally (`...(tree.net != null ? [...] : [])`), so an index means a
    different tab on a different org."""
    loc = pg.locator(f"{ADV} .adv-tabs button.adv-tab", has_text=label)
    if loc.count() != 1:
        return False
    loc.first.click()
    pg.wait_for_timeout(300)
    return True


def field_value(pg, selector: str) -> str | None:
    """None means THE FIELD IS NOT THERE; "" means it is there and empty. The
    distinction is the whole point — collapsing them is how an absence check
    starts lying."""
    loc = pg.locator(selector)
    return loc.first.input_value() if loc.count() else None


def run(pg) -> None:
    # ================================================= §1 RIG =================
    open_settings(pg)
    check("§1a the org settings panel opens",
          pg.locator(".settings").count() >= 1)

    open_advanced(pg)
    labels = tab_labels(pg)
    check("§1b the advanced modal opens with a tab strip",
          len(labels) >= 2, f"tabs: {labels}")
    check("§1c an 'autonomy' tab exists (org is not a kiosk)",
          any("autonomy" in t for t in labels), f"tabs: {labels}")
    if not any("autonomy" in t for t in labels):
        check("§1 RIG — refusing to report §3-§5", False,
              "no autonomy tab; every later claim would be vacuous")
        return

    check("§1d the autonomy tab can be selected", click_tab(pg, "autonomy"))
    before = field_value(pg, KEYFIELD)
    check("§1e the API-key input exists on the autonomy tab",
          before is not None,
          "not found — the org may already have a key set" if before is None
          else f"empty={before == ''}")
    if before is None:
        check("§1 RIG — refusing to report §3-§4", False,
              "no key field to lose; §3/§4 would pass by having nothing to check")
        return

    pg.locator(KEYFIELD).first.fill(SENTINEL)
    pg.wait_for_timeout(200)
    typed = field_value(pg, KEYFIELD)
    check("§1f a typed value READS BACK while still on the tab",
          typed == SENTINEL,
          f"read {typed!r}")
    if typed != SENTINEL:
        check("§1 RIG — refusing to report §3-§4", False,
              "cannot read the field it is about to claim was emptied")
        return

    # ============================== §2 CONTROL (the load-bearing half) ========
    # The SAME gesture on a field whose state is HOISTED into SettingsPanel's
    # `edit` buffer, above the tab strip. This one MUST survive. If it does
    # not, the probe's read-after-renavigation is broken and §3/§4 mean
    # nothing — so §2 red refuses the subjects exactly like a red §1.
    # Selected BY VALUE, not by visible label: the label carries decoration
    # ("halt (default)") that a label match has to guess at, while the value
    # is the thing `fablePolicy` actually holds. The first select on the
    # general tab is the fable weekly-limit policy (halt/opus/dissolve), and
    # 'opus' is chosen because it differs from the 'halt' default — a control
    # set to the value it already had would survive trivially and prove
    # nothing.
    ctl_ok = click_tab(pg, "general")
    vals = pg.locator(f"{POLICY} option").evaluate_all(
        "els => els.map(e => e.value)") if ctl_ok else []
    if not ctl_ok or "opus" not in vals:
        check("§2 CONTROL — a hoisted field survives the same gesture", False,
              f"could not set up the control (tab={ctl_ok}, values={vals})")
        return
    pg.locator(POLICY).first.select_option("opus")
    pg.wait_for_timeout(200)
    ctl_before = field_value(pg, POLICY)
    if ctl_before != "opus":
        check("§2 CONTROL — a hoisted field survives the same gesture", False,
              f"the control would not even take the value (read {ctl_before!r})")
        return
    click_tab(pg, "org type")
    click_tab(pg, "general")
    ctl_after = field_value(pg, POLICY)
    check("§2 CONTROL — a hoisted field survives leaving and re-entering a tab",
          ctl_after == ctl_before and ctl_before is not None,
          f"{ctl_before!r} -> {ctl_after!r}")
    if ctl_after != ctl_before:
        check("§2 CONTROL failed — refusing to report §3-§5", False,
              "the probe cannot show that ANY value survives this gesture, so "
              "a lost value proves nothing about where state lives")
        return

    # ================================= §3 SUBJECT A — tab switch =============
    # Re-arm: the control leg above already left and re-entered tabs, so the
    # sentinel typed in §1 is (per the defect) long gone.
    click_tab(pg, "autonomy")
    pg.locator(KEYFIELD).first.fill(SENTINEL)
    pg.wait_for_timeout(200)
    armed = field_value(pg, KEYFIELD)
    check("§3a re-armed: the sentinel is in the field before the tab switch",
          armed == SENTINEL, f"read {armed!r}")

    click_tab(pg, "general")
    click_tab(pg, "autonomy")
    after_switch = field_value(pg, KEYFIELD)
    check("§3b an unsaved pasted key SURVIVES a tab switch away and back",
          after_switch == SENTINEL,
          f"read {after_switch!r} — expected the pasted value")

    # ============================ §4 SUBJECT B — modal close/reopen ==========
    pg.locator(KEYFIELD).first.fill(SENTINEL)
    pg.wait_for_timeout(200)
    armed2 = field_value(pg, KEYFIELD)
    check("§4a re-armed: the sentinel is in the field before the modal closes",
          armed2 == SENTINEL, f"read {armed2!r}")

    close_advanced(pg)
    open_advanced(pg)
    landed = active_tab(pg)
    note(f"§6 OBSERVATION — reopening 'advanced…' lands on {landed!r} "
         f"(the tab you left was 'autonomy')")
    if not any("autonomy" in t for t in tab_labels(pg)):
        check("§4b an unsaved pasted key SURVIVES closing and reopening the modal",
              False, "the autonomy tab is gone after reopen")
    else:
        click_tab(pg, "autonomy")
        after_reopen = field_value(pg, KEYFIELD)
        check("§4b an unsaved pasted key SURVIVES closing and reopening the modal",
              after_reopen == SENTINEL,
              f"read {after_reopen!r} — expected the pasted value")

    # ================================= §5 SIBLING — NetTab.adding ============
    if not any("mailserver" in t for t in tab_labels(pg)):
        note("§5 SKIPPED — this org has no mailserver tab (tree.net is null). "
             "NOT a pass: the sibling field was never exercised.")
    else:
        click_tab(pg, "mailserver")
        hub_before = field_value(pg, HUBFIELD)
        if hub_before is None:
            note("§5 SKIPPED — the add-mailserver input was not found. NOT a pass.")
        else:
            pg.locator(HUBFIELD).first.fill(HUB_SENTINEL)
            pg.wait_for_timeout(200)
            check("§5a re-armed: the address is in the field",
                  field_value(pg, HUBFIELD) == HUB_SENTINEL)
            click_tab(pg, "general")
            click_tab(pg, "mailserver")
            hub_after = field_value(pg, HUBFIELD)
            check("§5b an unsaved mailserver address SURVIVES a tab switch",
                  hub_after == HUB_SENTINEL,
                  f"read {hub_after!r} — expected the typed address")

    close_advanced(pg)
    close_settings(pg)


def main() -> int:
    print(f"keyloss_probe — D-204 · temp={TMP}")
    if not os.path.isdir(os.path.join(_REPO, "frontend", "dist")):
        print("!! frontend/dist is missing — run `npm run build` first; "
              "this probe does NOT build.")
        return 2
    start_backend()
    slug = None
    try:
        slug = make_org()
        with sync_playwright() as p:
            # The browser-start retry is scoped STRICTLY to constructing the
            # browser/context/page (a cold Edge start dies roughly 1 run in 7).
            # No check has run at this point, so it cannot mask a finding.
            last: Exception | None = None
            br = ctx = pg = None
            for attempt in range(3):
                try:
                    br = p.chromium.launch(channel="msedge", headless=not HEADED)
                    ctx = br.new_context(viewport={"width": 1600, "height": 1000})
                    pg = ctx.new_page()
                    break
                except Exception as e:                            # noqa: BLE001
                    last = e
                    print(f"  (browser start attempt {attempt + 1} failed: {e})")
                    time.sleep(2)
            if pg is None:
                raise RuntimeError(f"could not start a browser: {last}")
            try:
                pg.goto(f"{BASE}/o/{slug}")
                # the ORGBAR, not `.sq`: this org has no agents on purpose
                # (see make_org), so there is no agent card to wait for.
                pg.wait_for_selector(".orgbar", timeout=15000)
                pg.wait_for_timeout(2000)          # let the intro fit settle
                run(pg)
            finally:
                ctx.close()
                br.close()
    except Exception:                                             # noqa: BLE001
        traceback.print_exc()
        check("probe completed without an exception", False, "see traceback")
    finally:
        drop_orgs()
        stop_backend()

    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{passed}/{total} checks passed")
    for n in NOTES:
        print(f"  note  {n}")

    rig_red = red("§1") + red("§2")
    subj_red = red("§3b") + red("§4b")

    if EXPECT_FAIL:
        # The known-negative control: the bug must be present EXACTLY as
        # described — rig and control green, both subjects red. A run where the
        # rig is red proves nothing, and a run where the subjects are GREEN
        # means the defect is not there and this mode should not be used.
        ok = not rig_red and len(subj_red) == 2
        print("\n--expect-fail: " + ("CONFIRMED — " if ok else "NOT CONFIRMED — ")
              + f"rig/control red={rig_red or 'none'}, subjects red={subj_red or 'none'}")
        if not ok:
            print("  Expected: §1 and §2 all green, §3b and §4b both red.")
        return 0 if ok else 1

    if rig_red:
        print(f"\n⚠ THE RIG OR CONTROL IS RED ({rig_red}). The absence claims in "
              "§3-§5 are NOT trustworthy in this run — a green there would mean "
              "nothing.")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())

