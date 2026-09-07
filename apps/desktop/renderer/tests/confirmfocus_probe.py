"""confirmfocus_probe.py — can a keyboard user actually operate ConfirmModal?

Incremental-UX item 6 (Astra, 2026-09-04). The committed confirmation popup
left keyboard focus on the button that opened it: the next Tab went to a
background control, nothing announced a dialog, and closing it moved focus
nowhere in particular. This probe drives the REAL component — bundled from
../src by `confirmfocus_build.mjs` with the real stylesheet — in Edge, and
asks the BROWSER where focus is after real Tab, Shift+Tab, Enter and Escape
presses. jsdom cannot answer any of that: it has no sequential focus
navigation, so a Tab there goes nowhere whether or not a trap exists.
`confirmfocus.test.tsx` owns the DOM-level contract (roles, ids, the handler
arithmetic); this file owns "does it work with a keyboard in a browser".

    python -B tests/confirmfocus_probe.py                 # the shipped component
    python -B tests/confirmfocus_probe.py --json out.json # ...and keep the observations
    python -B tests/confirmfocus_probe.py --source OLD.tsx
        # the same page against ANOTHER modals.tsx — the red half of red/green
        # (e.g. `git show <commit>:frontend/src/canvas/modals.tsx > OLD.tsx`)
    python -B tests/confirmfocus_probe.py --mutant all    # KNOWN-NEGATIVE CONTROLS
        # every named mutant is applied to the current source in memory and
        # MUST make this probe fail; a mutant that measures clean means the
        # assertion it targets is decorative

WHAT IT CHECKS
  open        clicking the opener puts focus INSIDE the dialog, on cancel (the
              safe control: every caller's confirm is destructive); exactly
              one role=dialog, aria-modal, named by its title, described by
              its body
  trap        Tab and Shift+Tab cycle confirm / [alternate] / cancel and never
              reach the opener or the background control
  escape      Escape still closes; focus RETURNS to the opener; and a Tab
              after that reaches the background control again (the trap is
              gone — no stale document handler)
  keys        Enter on confirm / alternate fires close-then-act, once
  opener gone the opener is removed while the dialog is open: the trap keeps
              working, Escape still closes, focus is not thrown at a stale
              element and nothing throws
  refocus     an action that moves focus itself (the way a hire walks you to
              the new desk) is not overridden on close
  disabled    a button disabled while open drops out of the cycle; re-enabled,
              it is back — the cycle is computed at each keypress
  changed     the alternate button added/removed by a re-render joins/leaves
              the cycle
  backdrop    clicking the overlay still closes (unchanged behaviour)

POSITIVE CONTROLS live inside the checks: the Tab after Escape must MOVE (to
the background control), so a page where Tab does nothing cannot pass; the
--source baseline must fail; the mutants must fail. If any control passes,
the probe is measuring nothing and says so.

Requires playwright with the msedge channel (same dependency as kbdhire_probe).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
MODALS = FRONTEND / "src" / "canvas" / "modals.tsx"
BUILD = HERE / "confirmfocus_build.mjs"

# ----------------------------------------------------------------- mutants
# Each is an exact-once substitution on the CURRENT modals.tsx, applied in
# memory by the build script. Each targets one assertion that passes before
# AND after the patch, or one guard that cannot be seen failing any other way.
MUTANTS: dict[str, tuple[str, str, str]] = {
    # (old, new, which check must go red)
    "no-escape": (
        "  useEsc(close)\n  const boxRef",
        "  const boxRef",
        "escape: Escape no longer closes"),
    "stale-handler": (
        "      document.removeEventListener('keydown', onTab)\n",
        "",
        "escape: Tab after close is still trapped by a leaked document listener"),
    "steal-focus": (
        "      if (!focusLeft && opener && opener.isConnected",
        "      if (opener && opener.isConnected",
        "refocus: the dialog yanks focus back from the action's own target"),
    "no-shift-tab": (
        "      const step = e.shiftKey ? -1 : 1",
        "      const step = 1",
        "trap: Shift+Tab walks forward"),
    "stale-cycle": (
        "    const onTab = (e: KeyboardEvent) => {\n"
        "      if (e.key !== 'Tab' || e.defaultPrevented) return\n"
        "      const items = tabbablesIn(box)\n",
        "    const itemsAtMount = tabbablesIn(box)\n"
        "    const onTab = (e: KeyboardEvent) => {\n"
        "      if (e.key !== 'Tab' || e.defaultPrevented) return\n"
        "      const items = itemsAtMount\n",
        "disabled/changed: the cycle is computed once at mount"),
    "ignore-disabled": (
        "    .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled')\n",
        "    .filter((el) => el.tabIndex >= 0\n",
        "disabled: a disabled button stays in the cycle and Tab sticks on it"),
    "no-label": (
        "        aria-labelledby={titleId}",
        "",
        "open: the dialog has no accessible name"),
    "no-initial-focus": (
        "    ;(cancelRef.current ?? box).focus()\n",
        "",
        "open: focus stays on the opener"),
    "focus-confirm-first": (
        "    ;(cancelRef.current ?? box).focus()\n",
        "    ;(box.querySelector('button') as HTMLElement).focus()\n",
        "open: initial focus is on the destructive button"),
}


def build(outdir: pathlib.Path, source: str | None, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
    if source:
        args += ["--source", source]
    if mutant:
        old, new, _ = MUTANTS[mutant]
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                          encoding="utf-8")
        json.dump([{"old": old, "new": new}], tmp)
        tmp.close()
        args += ["--subst", tmp.name]
    try:
        subprocess.run(["node", *args], check=True, cwd=str(FRONTEND))
    finally:
        if tmp:
            pathlib.Path(tmp.name).unlink(missing_ok=True)
    # the bundle's stylesheet: esbuild writes probe.css beside probe.js
    if not (outdir / "probe.css").exists():
        raise SystemExit("bundle produced no probe.css — styles.css import lost")


# what has focus, named the way a human reads it
WHO = """
() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  if (el.id) return '#' + el.id;
  const box = el.closest('.confirm-box');
  const txt = (el.textContent || '').trim();
  return (box ? 'dialog>' : '') + el.tagName.toLowerCase() + (txt ? ':' + txt : '');
}
"""
DIALOG = """
() => {
  const ds = document.querySelectorAll('[role=dialog]');
  const d = ds[0];
  const byId = (a) => { const id = d && d.getAttribute(a); const el = id && document.getElementById(id); return el ? el.textContent.trim() : null }
  return { count: ds.length, box: document.querySelectorAll('.confirm-box').length,
    modal: d ? d.getAttribute('aria-modal') : null,
    name: byId('aria-labelledby'), desc: byId('aria-describedby'),
    focusInside: !!(d && d.contains(document.activeElement)) }
}
"""


class Page:
    def __init__(self, pg, html: pathlib.Path, errors: list[str]):
        self.pg, self.html, self.errors = pg, html, errors

    def open(self, query: str = "") -> None:
        self.pg.goto(self.html.as_uri() + ("?" + query if query else ""),
                     wait_until="load")
        self.pg.wait_for_selector("#open-confirm", state="attached", timeout=8000)

    def click_opener(self) -> None:
        self.pg.locator("#open-confirm").click()
        self.pg.wait_for_timeout(50)

    def who(self) -> str:
        return self.pg.evaluate(WHO)

    def dialog(self) -> dict:
        return self.pg.evaluate(DIALOG)

    def key(self, k: str) -> str:
        self.pg.keyboard.press(k)
        return self.who()

    def log(self) -> list[str]:
        return self.pg.evaluate("() => window.__probe.log.slice()")


def run(html: pathlib.Path, verbose: bool = True) -> tuple[list[str], dict]:
    fails: list[str] = []
    obs: dict = {}
    errors: list[str] = []

    def bad(msg: str) -> None:
        fails.append(msg)

    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        ctx = b.new_context(viewport={"width": 1200, "height": 800})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        P = Page(pg, html, errors)

        # ---------------------------------------------------------- open
        P.open()
        P.click_opener()
        d = P.dialog()
        o = obs["open"] = {"focus": P.who(), **d}
        if d["count"] != 1 or d["box"] != 1:
            bad(f"open: expected one role=dialog on one .confirm-box, got {d}")
        if d["modal"] != "true":
            bad(f"open: aria-modal is {d['modal']!r}, not 'true'")
        if d["name"] != "Existing confirmation":
            bad(f"open: the dialog's accessible name (aria-labelledby) is {d['name']!r}, "
                f"not its title")
        if d["desc"] != "Fixture only.":
            bad(f"open: aria-describedby resolves to {d['desc']!r}, not the body")
        if o["focus"] != "dialog>button:cancel":
            bad(f"open: focus after opening is on {o['focus']} — it should be inside "
                f"the dialog, on cancel (the safe control)")

        # ---------------------------------------------------------- trap
        seq = [P.key("Tab") for _ in range(3)]
        back = [P.key("Shift+Tab") for _ in range(3)]
        obs["trap"] = {"tab": seq, "shift_tab": back}
        if seq != ["dialog>button:confirm", "dialog>button:cancel", "dialog>button:confirm"]:
            bad(f"trap: Tab from cancel walked {seq}, expected "
                f"confirm -> cancel -> confirm (contained, wrapping)")
        if back != ["dialog>button:cancel", "dialog>button:confirm", "dialog>button:cancel"]:
            bad(f"trap: Shift+Tab walked {back}, expected cancel -> confirm -> cancel")
        for w in seq + back:
            if w in ("#behind-modal", "#open-confirm", "body"):
                bad(f"trap: focus escaped the dialog to {w}")
                break

        # ---------------------------------------------------------- escape
        after_esc = P.key("Escape")
        pg.wait_for_timeout(50)
        after_esc = P.who()
        d2 = P.dialog()
        after_tab = P.key("Tab")
        obs["escape"] = {"focus": after_esc, "dialog": d2, "then_tab": after_tab,
                         "log": P.log()}
        if d2["box"] != 0:
            bad("escape: Escape no longer closes the dialog")
        if after_esc != "#open-confirm":
            bad(f"escape: after Escape focus is on {after_esc}, not back on the opener")
        if after_tab != "#behind-modal":
            bad(f"escape: a Tab after closing went to {after_tab}, not the background "
                f"control — either Tab is dead on this page or a stale handler is "
                f"still trapping it")
        if P.log() != ["close"]:
            bad(f"escape: callbacks were {P.log()}, expected exactly ['close']")

        # ---------------------------------------------------------- keys: confirm
        P.open()
        P.click_opener()
        P.key("Tab")                     # cancel -> confirm
        obs["keys_confirm"] = {"before": P.who()}
        P.key("Enter")
        pg.wait_for_timeout(50)
        obs["keys_confirm"].update({"after": P.who(), "log": P.log(),
                                    "box": P.dialog()["box"]})
        if obs["keys_confirm"]["before"] != "dialog>button:confirm":
            bad(f"keys: Tab from cancel should reach confirm, reached "
                f"{obs['keys_confirm']['before']}")
        if P.log() != ["close", "confirm"]:
            bad(f"keys: Enter on confirm fired {P.log()}, expected ['close', 'confirm']")
        if obs["keys_confirm"]["box"] != 0 or obs["keys_confirm"]["after"] != "#open-confirm":
            bad(f"keys: after confirming by keyboard the dialog/focus state is "
                f"{obs['keys_confirm']}")

        # ---------------------------------------------------------- alternate
        P.open("alt=1")
        P.click_opener()
        seq = [P.key("Tab") for _ in range(4)]
        back = [P.key("Shift+Tab") for _ in range(2)]
        obs["alt"] = {"tab": seq, "shift_tab": back}
        want = ["dialog>button:confirm", "dialog>button:alternate",
                "dialog>button:cancel", "dialog>button:confirm"]
        if seq != want:
            bad(f"alt: Tab cycle with the alternate action was {seq}, expected {want}")
        if back != ["dialog>button:cancel", "dialog>button:alternate"]:
            bad(f"alt: Shift+Tab from confirm walked {back}, expected cancel -> alternate")
        P.key("Enter")                   # on alternate
        pg.wait_for_timeout(50)
        obs["alt"].update({"after": P.who(), "log": P.log(), "box": P.dialog()["box"]})
        if P.log() != ["close", "alt"]:
            bad(f"alt: Enter on the alternate action fired {P.log()}, expected "
                f"['close', 'alt']")
        if obs["alt"]["box"] != 0 or obs["alt"]["after"] != "#open-confirm":
            bad(f"alt: after the alternate action, dialog/focus is {obs['alt']}")

        # ---------------------------------------------------------- opener gone
        P.open()
        P.click_opener()
        pg.evaluate("() => window.__probe.removeOpener()")
        pg.wait_for_timeout(50)
        gone = pg.locator("#open-confirm").count() == 0
        f1 = P.who()
        f2 = P.key("Tab")
        f3 = P.key("Escape")
        pg.wait_for_timeout(50)
        f3 = P.who()
        obs["opener_gone"] = {"opener_removed": gone, "focus": f1, "tab": f2,
                              "after_escape": f3, "box": P.dialog()["box"],
                              "errors": list(errors)}
        if not gone:
            bad("opener gone: the fixture failed to remove the opener (probe bug)")
        if f1 != "dialog>button:cancel" or f2 != "dialog>button:confirm":
            bad(f"opener gone: with the opener removed focus went {f1} -> Tab -> {f2}; "
                f"the dialog should keep focus and the trap should keep working")
        if obs["opener_gone"]["box"] != 0:
            bad("opener gone: Escape did not close the dialog")
        if f3 != "body":
            bad(f"opener gone: after closing, focus landed on {f3}; with no opener "
                f"left it must not be thrown at anything else")
        if errors:
            bad(f"opener gone: the page threw: {errors}")

        # ---------------------------------------------------------- refocus
        P.open("refocus=1")
        P.click_opener()
        P.key("Tab")
        P.key("Enter")
        pg.wait_for_timeout(50)
        obs["refocus"] = {"after": P.who(), "log": P.log()}
        if obs["refocus"]["after"] != "#behind-modal":
            bad(f"refocus: the confirmed action focused the background control itself, "
                f"but after close focus is on {obs['refocus']['after']} — the dialog "
                f"overrode the action's own focus")

        # ---------------------------------------------------------- disabled
        # Three buttons, the FIRST disabled: a cycle that merely tries to focus
        # the disabled one (the browser refuses, focus stays put) reads as a
        # stuck Tab key; skipping it lands on the alternate. With only two
        # buttons the two behaviours are indistinguishable, so this is the
        # case that can actually fail.
        P.open("alt=1")
        P.click_opener()
        pg.evaluate("() => { document.querySelector('.confirm-box button.danger.solid').disabled = true }")
        d1 = P.key("Tab")                # cancel -> (skip confirm) -> alternate
        d2_ = P.key("Shift+Tab")         # alternate -> (skip confirm) -> cancel
        pg.evaluate("() => { document.querySelector('.confirm-box button.danger.solid').disabled = false }")
        d3 = P.key("Tab")                # cancel -> confirm again
        obs["disabled"] = {"tab_while_disabled": d1, "shift_tab_while_disabled": d2_,
                           "tab_after_reenable": d3}
        if d1 != "dialog>button:alternate" or d2_ != "dialog>button:cancel":
            bad(f"disabled: with confirm disabled, Tab from cancel reached {d1} and "
                f"Shift+Tab back reached {d2_}; expected alternate then cancel, "
                f"skipping the disabled button")
        if d3 != "dialog>button:confirm":
            bad(f"disabled: after re-enabling confirm, Tab reached {d3} not confirm — "
                f"the cycle is not recomputed per keypress")
        P.key("Escape")

        # ---------------------------------------------------------- changed
        P.open()
        P.click_opener()
        pg.evaluate("() => window.__probe.setAlt(true)")
        pg.wait_for_timeout(50)
        c1 = [P.key("Tab") for _ in range(3)]
        pg.evaluate("() => window.__probe.setAlt(false)")
        pg.wait_for_timeout(50)
        c2 = [P.key("Shift+Tab"), P.key("Tab")]
        obs["changed"] = {"with_alt": c1, "without_alt": c2}
        if c1 != ["dialog>button:confirm", "dialog>button:alternate", "dialog>button:cancel"]:
            bad(f"changed: after a re-render ADDED the alternate button, Tab walked {c1}")
        if c2 != ["dialog>button:confirm", "dialog>button:cancel"]:
            bad(f"changed: after a re-render REMOVED it, Shift+Tab/Tab walked {c2}")
        P.key("Escape")

        # ---------------------------------------------------------- backdrop
        P.open()
        P.click_opener()
        pg.mouse.click(8, 8)             # the overlay corner, outside the box
        pg.wait_for_timeout(50)
        obs["backdrop"] = {"box": P.dialog()["box"], "focus": P.who(), "log": P.log()}
        if obs["backdrop"]["box"] != 0 or P.log() != ["close"]:
            bad(f"backdrop: clicking the overlay no longer closes: {obs['backdrop']}")
        if obs["backdrop"]["focus"] != "#open-confirm":
            bad(f"backdrop: after a backdrop close focus is on {obs['backdrop']['focus']}, "
                f"not the opener")

        b.close()

    if errors and not any(f.startswith("opener gone: the page threw") for f in fails):
        bad(f"page errors: {errors}")
    obs["errors"] = errors
    if verbose:
        for k, v in obs.items():
            print(f"  {k:<13} {json.dumps(v)}")
    return fails, obs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="another modals.tsx to bundle instead (red baseline)")
    ap.add_argument("--mutant", help="a MUTANTS key, or 'all' — each must FAIL")
    ap.add_argument("--json", help="write the observations here")
    a = ap.parse_args()

    out = FRONTEND / "node_modules" / ".orgtree-confirmfocus"
    html = out / "probe.html"

    if a.mutant:
        names = list(MUTANTS) if a.mutant == "all" else [a.mutant]
        weak = []
        report = {}
        for name in names:
            print(f"\nconfirmfocus_probe: MUTANT {name} — {MUTANTS[name][2]}")
            build(out, None, name)
            fails, obs = run(html, verbose=False)
            report[name] = {"fails": fails, "obs": obs}
            if fails:
                print(f"  rejected ({len(fails)} finding(s)); e.g. {fails[0]}")
            else:
                print("  !! MEASURED CLEAN — the assertion this mutant targets is decorative")
                weak.append(name)
        if a.json:
            pathlib.Path(a.json).write_text(json.dumps(report, indent=2), encoding="utf-8")
        if weak:
            print(f"\n  CONTROL FAILED: {weak} passed the probe.")
            return 1
        print(f"\n  CONTROLS OK — all {len(names)} mutant(s) rejected.")
        return 0

    label = f"--source {a.source}" if a.source else "the shipped component"
    print(f"confirmfocus_probe: measuring {label}")
    build(out, a.source, None)
    fails, obs = run(html)
    if a.json:
        pathlib.Path(a.json).write_text(
            json.dumps({"source": a.source or str(MODALS), "fails": fails, "obs": obs},
                       indent=2), encoding="utf-8")
    if fails:
        print(f"\n  {len(fails)} finding(s):")
        for f in fails:
            print("   - " + f)
        return 1
    print("\n  OK — focus enters the dialog, Tab/Shift+Tab stay inside it, Escape and "
          "Enter\n  work from the keyboard, focus returns to the opener, and the trap "
          "is gone after close.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
