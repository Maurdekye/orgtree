"""focusspace_probe.py — w14aace89 in a REAL browser: does the switchboard's
actual painted box, and a focused agent desk's, fit inside the free rectangle
the pins leave?

WHY THIS EXISTS. `focusspace.test.tsx` runs under jsdom, which does no layout.
It can only read back what the component WRITES — the `.space` transform and
the eye's inline width — so it can show that the camera aims at the region and
that `eyeW` follows the region's aspect. It cannot show that the surface
actually FITS, and there are two concrete reasons it might not:

  * `focusView` floors the zoom at Z_DESK (2.1) on purpose, so a region too
    small for a readable desk gets a readable desk that OVERFLOWS it.
  * the eye's width is `Math.max(eyeW, USER_W)`, so a region narrower than the
    plain square cannot be honoured by aspect alone.

Matching aspect is therefore NOT the same claim as fitting, and the review
asked for the fitting one. Only a browser can answer it.

WHAT IS MEASURED. Real `getBoundingClientRect()` of `.eye-desk` (the
switchboard) and `.sq.desk:not(.user)` (a focused agent desk), against the
free region computed from the same pin rectangles. Overflow is reported per
edge, in pixels, so a failure says WHERE it escaped rather than just that it
did.

§G/§H add the EDGE JUMP CARDS (user bug 2026-09-05: they vanished when pins
took space). Those need a browser for a second reason: jsdom reports every
rect as 0x0, so `edgeJumps` bails on `!vp.width` and no card exists to look
at under jsdom at all. And a rectangle is not the claim — the cards are
z-index 7 under pins at 10-16, so §H also runs `document.elementFromPoint` at
each card's own centre and requires the card itself to come back.

⚠ ANTI-VACUITY — A RED BASELINE, NOT AN INSPECTION. `--mutant viewport-centre`
rebuilds the SAME page from an OrgCanvas whose `focusView` centres on the
whole viewport again (the pre-w14aace89 camera), and `--mutant no-eye-region`
restores the viewport-aspect `eyeW`. The suite must FAIL against those and
pass against the real one. A probe that has only ever seen the fixed build is
evidence about the probe.

    cd frontend
    python tests/focusspace_probe.py               # green: the shipped canvas
    python tests/focusspace_probe.py --mutant viewport-centre   # must FAIL
    python tests/focusspace_probe.py --list-mutants

Requires playwright with the msedge channel (same dependency as the other
browser probes here). No backend, no live provider: the page is a local file.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "focusspace_build.mjs"

VP_W, VP_H = 1280, 900
GAP = 12          # clearRect.PIN_GAP
PIN_MIN_W, PIN_MIN_H = 320, 240   # pins.tsx sizeFloor — fixtures respect it

#: Each mutant is (old, new, why it must go red). These are exact-match
#: substitutions applied to OrgCanvas.tsx inside the bundler.
MUTANTS: dict[str, tuple[str, str, str]] = {
    "viewport-centre": (
        "      x: r.x + r.w / 2 - (p.x + NODE_W / 2) * zz,\n"
        "      y: r.y + r.h / 2 - (p.y + NODE_H / 2) * zz,",
        "      x: vp.width / 2 - (p.x + NODE_W / 2) * zz,\n"
        "      y: vp.height / 2 - (p.y + NODE_H / 2) * zz,",
        "the camera centres on the whole viewport again — the desk lands "
        "under the pin"),
    "eye-height-only": (
        "      ? Math.min(Z_MAX, (r.h - 48) / USER_H, (r.w - 48) / eyeWorldW(r))",
        "      ? Math.min(Z_MAX, (r.h - 48) / USER_H)",
        "the eye fits on HEIGHT alone again — in a tall/narrow region the "
        "USER_W floor makes the cell relatively wider than the region is, so "
        "the switchboard overflows sideways (the §D defect this probe found)"),
    "no-region-gate": (
        "      const fillR = vp ? regionOf(vp).rect : null",
        "      const fillR = vp ? { w: vp.width, h: vp.height } : null",
        "the eye-focus gate measures screen-filling against the whole "
        "viewport again — the switchboard cannot open with a pin up"),
    "jump-screen-edge": (
        "    const reg = regionOf(vp)\n"
        "    const free = reg.status === 'blocked'\n"
        "      ? { x: 0, y: 0, w: vp.width, h: vp.height }\n"
        "      : reg.rect",
        "    const free = { x: 0, y: 0, w: vp.width, h: vp.height }",
        "the edge jump cards hug the WINDOW edge again (user bug "
        "2026-09-05) — a pin docked on that edge paints over them at "
        "z-index 10-16 and the card is simply gone"),
}


def build(outdir: pathlib.Path, mutant: str | None) -> None:
    args = [str(BUILD), str(outdir)]
    tmp = None
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
    if not (outdir / "probe.css").exists():
        raise SystemExit("bundle produced no probe.css — styles.css import lost")


# ---------------------------------------------------------------- geometry
def obstacle(pin: dict, vp: dict) -> dict | None:
    """clip to the viewport, THEN grow by the gap — clearRect.obstacleOf"""
    x0, y0 = max(pin["x"], 0), max(pin["y"], 0)
    x1 = min(pin["x"] + pin["w"], vp["w"])
    y1 = min(pin["y"] + pin["h"], vp["h"])
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": max(0, x0 - GAP), "y": max(0, y0 - GAP),
            "r": min(vp["w"], x1 + GAP), "b": min(vp["h"], y1 + GAP)}


def clear_region(pins: list[dict], vp: dict) -> dict | None:
    """The expected free region, computed INDEPENDENTLY of the TypeScript so a
    shared bug cannot agree with itself. Largest by area; ties to the nearest
    viewport centre, then smaller x, then smaller y."""
    obs = [o for o in (obstacle(p, vp) for p in pins) if o]
    if not obs:
        return {"x": 0, "y": 0, "w": vp["w"], "h": vp["h"]}
    xs = sorted({0, vp["w"]} | {o["x"] for o in obs} | {o["r"] for o in obs})
    ys = sorted({0, vp["h"]} | {o["y"] for o in obs} | {o["b"] for o in obs})
    xs = [v for v in xs if 0 <= v <= vp["w"]]
    ys = [v for v in ys if 0 <= v <= vp["h"]]
    best = None
    for i, x0 in enumerate(xs):
        for x1 in xs[i + 1:]:
            for j, y0 in enumerate(ys):
                for y1 in ys[j + 1:]:
                    if any(x0 < o["r"] and o["x"] < x1
                           and y0 < o["b"] and o["y"] < y1 for o in obs):
                        continue
                    w, h = x1 - x0, y1 - y0
                    drift = ((x0 + w / 2) - vp["w"] / 2) ** 2 \
                        + ((y0 + h / 2) - vp["h"] / 2) ** 2
                    key = (-(w * h), drift, x0, y0)
                    if best is None or key < best[0]:
                        best = (key, {"x": x0, "y": y0, "w": w, "h": h})
    return best[1] if best else None


def overflow(box: dict, region: dict, tol: float = 1.0) -> dict:
    """how far `box` escapes `region` on each edge, in real px"""
    return {
        "left": max(0.0, region["x"] - box["x"] - tol),
        "top": max(0.0, region["y"] - box["y"] - tol),
        "right": max(0.0, box["x"] + box["width"] - (region["x"] + region["w"]) - tol),
        "bottom": max(0.0, box["y"] + box["height"] - (region["y"] + region["h"]) - tol),
    }


BOX = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
"""


class Page:
    def __init__(self, pg, html: pathlib.Path):
        self.pg = pg
        self.html = html

    def open(self) -> None:
        self.pg.goto(self.html.as_uri(), wait_until="load")
        self.pg.wait_for_selector(".viewport", state="attached", timeout=8000)
        self.pg.wait_for_timeout(400)   # let the opening glide settle

    def reset(self, pins: list[dict] | None = None) -> None:
        """⚠ EVERY SCENARIO STARTS FROM A FRESH PAGE. Focusing a card turns it
        into a desk, and its `.name` element goes away — so a second
        `click_agent` for the same agent silently finds nothing, does nothing,
        and leaves the PREVIOUS scenario's camera in place. That is exactly how
        the first cut of this probe "measured" a viewport-centred camera and
        reported a bug that was not there. A reload also drops any focus, any
        open desk and any leftover pin, so each section's numbers belong to it
        alone."""
        self.open()
        self.clear_pins()
        if pins:
            self.set_pins(pins)
        self.pg.wait_for_timeout(200)

    def set_pins(self, pins: list[dict]) -> None:
        self.pg.evaluate("(ps) => window.__probe.setPins(ps)", pins)
        self.pg.wait_for_timeout(150)

    def clear_pins(self) -> None:
        self.pg.evaluate("() => window.__probe.clearPins()")
        self.pg.wait_for_timeout(150)

    def click_eye(self) -> bool:
        """Open the switchboard via the HUD eye button.

        ⚠ DISPATCHED DIRECTLY, NOT AS A HIT-TESTED MOUSE CLICK, and that is a
        deliberate concession rather than a shortcut. `.hud-eye` sits at the
        bottom-left of the viewport (measured: 30x28 at 11,765), so a pinned
        window occupying the lower band genuinely COVERS it —
        `document.elementFromPoint` at its centre returns the pin's content.
        That is correct UI behaviour, not a defect: a pin is supposed to be on
        top. But it means a real mouse click lands on the pin and the
        switchboard never opens, which the first cut of this probe reported as
        "the eye-focus gate is broken" when nothing was broken. Bypassing hit
        testing keeps the subject of the measurement the switchboard's
        GEOMETRY, which is what this probe is for. Reaching the button around
        a covering pin is a separate question and is not claimed here."""
        n = self.pg.evaluate(
            "() => { const e = document.querySelector('.hud-eye');"
            " if (!e) return 0; e.click(); return 1 }")
        if not n:
            return False
        self.pg.wait_for_timeout(1200)
        return True

    def click(self, sel: str) -> bool:
        # ⚠ NOT `.sq.user`. The eye card lives at world x=6000 and is normally
        # panned off-screen, so playwright refuses to click it ("outside of the
        # viewport"). `.hud-eye` is the button the UI itself offers for
        # "jump to the switchboard", and it calls the same camera path.
        loc = self.pg.locator(sel).first
        if loc.count() == 0:
            return False
        loc.click(force=True)
        self.pg.wait_for_timeout(900)   # the glide, and the desk it opens
        return True

    def click_agent(self, name: str, direct: bool = False) -> bool:
        """Focus `name`. `direct=True` dispatches the pointer pair on the card
        element itself instead of clicking its screen position.

        ⚠ WHY THAT IS NOT CHEATING, in the one section that uses it. When pins
        cover most of the viewport the agent's CARD can itself be underneath
        one, so a hit-tested click lands on the pin and nothing focuses — the
        same way `.hud-eye` is covered in §C/§D. Focusing an obscured agent is
        still perfectly reachable in the product (the agent tray, a mail link,
        the focusAgent prop all call the same camera path without touching the
        card), so dispatching directly models a real route rather than
        inventing one. §A/§B use a REAL mouse click, where the card is visible
        and fidelity is worth more."""
        # ⚠ THE CARD'S NAME, NOT THE CARD'S GEOMETRIC CENTRE. Clicking the
        # centre was a safe proxy for "click the card" until `.sq-actions`
        # moved into the middle of it: measured 2026-09-05, a click at the
        # exact centre lands on `BUTTON.retirebtn` inside `.sq-actions` and
        # opens the RETIRE CONFIRMATION instead of focusing — and whether it
        # does depends on the fit camera, which varies with whatever ran
        # before, so §A passed and §B/§G failed in the same run off the same
        # code. That is a fragile rig, not a product regression, and this is
        # the fix: aim at the affordance a reader actually aims at.
        js = """
        (name) => {
          const c = [...document.querySelectorAll('.sq')].find(
            (e) => e.querySelector('.name')?.textContent?.trim() === name);
          if (!c) return false;
          const n = c.querySelector('.name') ?? c;
          const r = n.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        """
        at = self.pg.evaluate(js, name)
        if not at:
            return False
        if direct:
            hit = self.pg.evaluate("""
            (name) => {
              const c = [...document.querySelectorAll('.sq')].find(
                (e) => e.querySelector('.name')?.textContent?.trim() === name);
              if (!c) return 0;
              for (const t of ['pointerdown', 'pointerup']) {
                c.dispatchEvent(new PointerEvent(t, { bubbles: true,
                  cancelable: true, pointerId: 1, pointerType: 'mouse',
                  isPrimary: true, button: 0, buttons: 1,
                  clientX: 0, clientY: 0 }));
              }
              return 1;
            }
            """, name)
            if not hit:
                return False
        else:
            self.pg.mouse.click(at["x"], at["y"])
        self.pg.wait_for_timeout(900)
        return True

    def box(self, sel: str) -> dict | None:
        return self.pg.evaluate(BOX, sel)

    def jump_cards(self) -> list[dict]:
        """Every rendered edge jump card: its REAL laid-out box, and whether a
        REAL hit test at its own centre actually reaches it.

        ⚠ `reached` is the whole point. A card's box being outside the pins is
        an arithmetic claim; `document.elementFromPoint` at its centre coming
        back as the card itself is the claim the user actually made — that they
        can see and click it. Pins paint in z-index band 10-16 and a card is 7,
        so a covered card still has a perfectly good rectangle and is still
        invisible. Measuring only the rectangle would miss exactly the reported
        bug."""
        return self.pg.evaluate("""
        () => [...document.querySelectorAll('.edge-jump')].map((e) => {
          const r = e.getBoundingClientRect();
          const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          return {
            side: e.classList.contains('l') ? 'l' : 'r',
            title: e.getAttribute('title'),
            x: r.x, y: r.y, width: r.width, height: r.height,
            reached: !!(hit && hit.closest('.edge-jump') === e),
            covered_by: !hit ? null
              : hit.closest('.pinwin') ? 'a pinned window'
              : (hit.className || hit.tagName),
          };
        })
        """)

    def toasts(self) -> list[str]:
        return self.pg.evaluate("() => window.__probe.toasts.slice()")

    def viewport_box(self) -> dict:
        b = self.box(".viewport")
        assert b, "no .viewport"
        return b


def run(html: pathlib.Path, verbose: bool = True) -> tuple[list[str], dict]:
    fails: list[str] = []
    obs: dict = {}
    errors: list[str] = []

    def bad(msg: str) -> None:
        fails.append(msg)
        if verbose:
            print(f"  FAIL  {msg}")

    def ok(msg: str) -> None:
        if verbose:
            print(f"  ok    {msg}")

    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        ctx = b.new_context(viewport={"width": VP_W, "height": VP_H})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        P = Page(pg, html)
        P.open()

        vpbox = P.viewport_box()
        vp = {"w": vpbox["width"], "h": vpbox["height"]}
        obs["viewport"] = vp
        if vp["w"] < 400 or vp["h"] < 400:
            bad(f"the canvas viewport measured {vp} — the page did not lay out, "
                "so nothing below would mean anything")
            return fails, obs

        # ---- §A the rig can see a real desk box at all (positive control)
        P.reset()
        if not P.click_agent("cto"):
            bad("§A no card for cto — the fixture did not render")
            return fails, obs
        bare_desk = P.box(".sq.desk:not(.user)")
        obs["bare_desk"] = bare_desk
        if not bare_desk or bare_desk["width"] < 50:
            bad(f"§A the focused agent desk has no real box ({bare_desk}) — "
                "every fit assertion below would be vacuous")
            return fails, obs
        ok(f"§A a focused agent desk paints a real box: "
           f"{bare_desk['width']:.0f}x{bare_desk['height']:.0f}")

        # ---- §B an ASYMMETRICAL clear zone: agent desk inside the region
        # a tall pin down the left AND a short one across the bottom-right
        pins_asym = [
            {"id": "qa", "x": 0, "y": 0, "w": 360, "h": vp["h"]},
            {"id": "ops", "x": vp["w"] - 420, "y": vp["h"] - 300, "w": 420, "h": 300},
        ]
        P.reset(pins_asym)
        P.click_agent("cto")
        reg = clear_region(pins_asym, vp)
        obs["asym_region"] = reg
        desk = P.box(".sq.desk:not(.user)")
        obs["asym_desk"] = desk
        if not reg:
            bad("§B no free region computed for the asymmetrical fixture")
        elif not desk:
            bad("§B the agent desk did not open in an asymmetrical clear zone — "
                "the nearest-card search may still be measuring from the "
                "viewport centre")
        else:
            ov = overflow(desk, reg)
            obs["asym_desk_overflow"] = ov
            centre = desk["x"] + desk["width"] / 2
            rcentre = reg["x"] + reg["w"] / 2
            if abs(centre - rcentre) > 12:
                bad(f"§B the desk centre is at x={centre:.0f} but the free "
                    f"region's centre is x={rcentre:.0f}")
            else:
                ok(f"§B the agent desk centres in the asymmetrical free region "
                   f"(x={centre:.0f} vs {rcentre:.0f})")
            if any(v > 0 for v in ov.values()):
                bad(f"§B the agent desk overflows the free region by {ov} px")
            else:
                ok("§B …and its painted box fits inside it")

        # ---- §C the SWITCHBOARD's real box, short/wide region
        # a bottom band leaves a WIDE, SHORT region
        pins_wide = [{"id": "qa", "x": 0, "y": vp["h"] - 340, "w": vp["w"], "h": 340}]
        P.reset(pins_wide)
        P.click_eye()
        reg_w = clear_region(pins_wide, vp)
        sw = P.box(".eye-desk")
        obs["wide_region"], obs["wide_switchboard"] = reg_w, sw
        if not sw:
            bad("§C the switchboard did not open in a wide/short free region — "
                "the eye-focus gate must measure screen-filling against the "
                "region, not the viewport")
        elif reg_w:
            ov = overflow(sw, reg_w)
            obs["wide_overflow"] = ov
            if any(v > 0 for v in ov.values()):
                bad(f"§C the switchboard's painted box overflows the free "
                    f"region by {ov} px (region {reg_w}, box "
                    f"{sw['width']:.0f}x{sw['height']:.0f} at "
                    f"{sw['x']:.0f},{sw['y']:.0f})")
            else:
                ok(f"§C the switchboard fits a wide/short region "
                   f"({sw['width']:.0f}x{sw['height']:.0f} inside "
                   f"{reg_w['w']}x{reg_w['h']})")

        # ---- §D the SWITCHBOARD's real box, tall/narrow region
        pins_tall = [{"id": "qa", "x": vp["w"] - 520, "y": 0, "w": 520, "h": vp["h"]}]
        P.reset(pins_tall)
        P.click_eye()
        reg_t = clear_region(pins_tall, vp)
        sw2 = P.box(".eye-desk")
        obs["tall_region"], obs["tall_switchboard"] = reg_t, sw2
        if not sw2:
            bad("§D the switchboard did not open in a tall/narrow free region")
        elif reg_t:
            ov = overflow(sw2, reg_t)
            obs["tall_overflow"] = ov
            if any(v > 0 for v in ov.values()):
                bad(f"§D the switchboard's painted box overflows the free "
                    f"region by {ov} px (region {reg_t}, box "
                    f"{sw2['width']:.0f}x{sw2['height']:.0f} at "
                    f"{sw2['x']:.0f},{sw2['y']:.0f})")
            else:
                ok(f"§D the switchboard fits a tall/narrow region "
                   f"({sw2['width']:.0f}x{sw2['height']:.0f} inside "
                   f"{reg_t['w']}x{reg_t['h']})")

        # ---- §F THE DELIBERATE OVERFLOW, stated as a measurement rather than
        # a caveat. `focusView` floors the zoom at Z_DESK so that a region too
        # small for a readable desk still gets a READABLE one — overflowing on
        # purpose, because a focus gesture that cannot focus is worse. §B-§E
        # therefore prove fitting only ABOVE that floor, and this section marks
        # exactly where the guarantee stops: below it the desk is expected to
        # escape, and the UI is expected to SAY so rather than silently
        # producing a picture the user cannot account for.
        pins_slot = [
            {"id": "qa", "x": 0, "y": 0, "w": 540, "h": vp["h"]},
            {"id": "ops", "x": 740, "y": 0, "w": 540, "h": vp["h"]},
        ]
        P.reset(pins_slot)
        P.click_agent("cto", direct=True)
        reg_s = clear_region(pins_slot, vp)
        desk_s = P.box(".sq.desk:not(.user)")
        obs["slot_region"], obs["slot_desk"] = reg_s, desk_s
        if not reg_s or not desk_s:
            bad(f"§F nothing to measure (region={reg_s}, desk={desk_s}) — the "
                "readable-floor limit is unverified")
        else:
            ov = overflow(desk_s, reg_s)
            obs["slot_overflow"] = ov
            if not any(v > 0 for v in ov.values()):
                bad(f"§F the desk FIT a {reg_s['w']}px region at the Z_DESK "
                    "floor — then either the floor moved or this fixture is "
                    "no longer below it, and the limitation stated in the "
                    "item is not the one the code has")
            else:
                ok(f"§F below the readable floor the desk deliberately "
                   f"overflows a {reg_s['w']}px region by "
                   f"{max(ov.values()):.0f}px — fitting is guaranteed only "
                   "above Z_DESK")
            said = [t for t in P.toasts() if "too little room" in t]
            if not said:
                bad("§F …but nothing told the user why: the obstruction "
                    f"message never fired (toasts={P.toasts()})")
            else:
                ok(f"§F …and it says why: {said[-1]!r}")

        # ---- §E no pins: the region is the viewport and nothing is cramped
        P.reset()
        P.click_eye()
        sw3 = P.box(".eye-desk")
        obs["bare_switchboard"] = sw3
        if not sw3:
            bad("§E the switchboard did not open with NO pins at all — the "
                "unpinned path must be untouched")
        else:
            ov = overflow(sw3, {"x": 0, "y": 0, "w": vp["w"], "h": vp["h"]})
            if any(v > 0 for v in ov.values()):
                bad(f"§E unpinned, the switchboard escapes the viewport by {ov}")
            else:
                ok("§E unpinned, the switchboard fits the whole viewport")

        # ---- §G POSITIVE CONTROL for the jump-card instrument (no pins)
        # Everything §H asserts is of the form "the card is not covered". That
        # is worth nothing until this section shows a card CAN be found and CAN
        # be reached by a real hit test — otherwise a selector typo, a card
        # that never rendered, or an elementFromPoint that always returns null
        # would report the same clean sheet as a working fix.
        P.reset()
        P.click_agent("cto")
        bare_cards = P.jump_cards()
        obs["bare_jump_cards"] = bare_cards
        if not bare_cards:
            bad("§G no edge jump card rendered with NO pins at all — the "
                "instrument below cannot see anything, so §H is vacuous")
        else:
            unreached = [c for c in bare_cards if not c["reached"]]
            if unreached:
                bad(f"§G unpinned, a jump card is not reachable by hit test: "
                    f"{unreached}")
            else:
                ok(f"§G unpinned, {len(bare_cards)} jump card(s) render and a "
                   "real hit test reaches each one: "
                   + ", ".join(f"{c['side']}@{c['x']:.0f},{c['y']:.0f}"
                               for c in bare_cards))

        # ---- §H THE REPORTED BUG: pins docked on the sides, asymmetrically.
        # A tall pin down the LEFT and a squat one BOTTOM-RIGHT, so the two
        # sides are obstructed differently and a fix applied to one side, or a
        # symmetric inset, does not pass.
        P.reset(pins_asym)
        P.click_agent("cto")
        reg_j = clear_region(pins_asym, vp)
        cards = P.jump_cards()
        obs["pinned_jump_cards"], obs["jump_region"] = cards, reg_j
        if not cards:
            bad("§H NO jump card rendered at all with pins up — this is the "
                "reported symptom: the proxies to the off-screen coworkers "
                "disappear when pinned windows take space")
        elif not reg_j:
            bad("§H no free region computed for the pinned fixture")
        else:
            for c in cards:
                where = (f"{c['side']} card '{c['title']}' at "
                         f"{c['x']:.0f},{c['y']:.0f} "
                         f"{c['width']:.0f}x{c['height']:.0f}")
                under = [i for i, p in enumerate(pins_asym)
                         if c["x"] < p["x"] + p["w"] and c["x"] + c["width"] > p["x"]
                         and c["y"] < p["y"] + p["h"] and c["y"] + c["height"] > p["y"]]
                if under:
                    bad(f"§H the {where} overlaps pin(s) {under}")
                else:
                    ok(f"§H the {where} clears every pin")
                ov = overflow(c, reg_j)
                if any(v > 0 for v in ov.values()):
                    bad(f"§H the {where} escapes the free region by {ov} px "
                        f"(region {reg_j})")
                else:
                    ok(f"§H …and sits inside the free region {reg_j['w']}x"
                       f"{reg_j['h']} at {reg_j['x']},{reg_j['y']}")
                if not c["reached"]:
                    bad(f"§H the {where} is NOT reachable — a hit test at its "
                        f"own centre lands on {c['covered_by']!r}")
                else:
                    ok(f"§H …and a real hit test at its centre reaches it")
            # the left card is the one the left pin used to swallow; if it is
            # missing the section above quietly checked only the right one
            if not any(c["side"] == "l" for c in cards):
                bad("§H no LEFT jump card — the side the tall pin covers is "
                    "the side this section exists to check, so its absence is "
                    "the bug, not a pass")

        # ---- §I THE PINNED TITLE'S NAME, with the REAL mouse and the REAL
        # keyboard. jsdom (pins.test.tsx §B12) can show the logic but not the
        # gesture: no pointer capture, no hit testing, and no browser-
        # synthesised click after a press-move-release.
        #
        # TWO INSTRUMENTS, because neither alone is enough:
        #   * the PULSE (`.pinwin.flash`) is produced only by `showPin`, so it
        #     separates "navigated" from "merely raised by a pointerdown";
        #   * the VISIBLE STACKING ORDER, hit-tested at a point where two pins
        #     overlap, is what the reader actually gets. A pulse without the
        #     window coming to the front would be a proxy, not the thing.
        PIN_A = {"id": "cto", "x": 120, "y": 120, "w": 380, "h": 280}
        PIN_B = {"id": "qa", "x": 300, "y": 220, "w": 380, "h": 280}
        OVER = (420, 330)      # inside both rectangles
        P.reset()
        P.set_pins([PIN_A, PIN_B])

        def on_top() -> str | None:
            return pg.evaluate(
                "([x, y]) => document.elementFromPoint(x, y)"
                "?.closest('.pinwin')?.getAttribute('data-id') ?? null",
                list(OVER))

        def pulsed(ms: int = 260) -> bool:
            pg.wait_for_timeout(ms)
            return pg.evaluate(
                "() => !!document.querySelector('.pinwin[data-id=\"cto\"].flash')")

        def settle_pulse() -> None:
            pg.wait_for_timeout(800)

        def name_el():
            return pg.query_selector('.pinwin[data-id="cto"] .pinwin-title '
                                     '.cc-name.pinwin-name')

        def raise_other() -> None:
            t = pg.query_selector('.pinwin[data-id="qa"] .pinwin-title')
            b = t.bounding_box()
            pg.mouse.click(b["x"] + 40, b["y"] + b["height"] / 2)
            pg.wait_for_timeout(700)

        def enter_on_name() -> None:
            pg.evaluate("() => document.querySelector("
                        "'.pinwin[data-id=\"cto\"] .pinwin-title .cc-name.pinwin-name')"
                        "?.focus()")
            pg.keyboard.press("Enter")

        nm = name_el()
        obs["pin_title_name"] = bool(nm)
        if not nm:
            bad("§I the pinned window's title has no name control")
        elif on_top() != "qa":
            bad(f"§I precondition: the OTHER pin is not on top ({on_top()}), so "
                "a raise would not be observable")
        else:
            ok("§I two pins overlap and the other one is in front")
            settle_pulse()

            # (1) KEYBOARD: Enter on the focused name must navigate — and the
            # window must actually COME TO THE FRONT, not merely flash.
            enter_on_name()
            flash1 = pulsed()
            top1 = on_top()
            obs["pin_kbd"] = {"pulsed": flash1, "top": top1}
            if not flash1:
                bad("§I Enter on the title name did not navigate (no pulse)")
            elif top1 != "cto":
                bad(f"§I Enter pulsed but the window did not come to the front "
                    f"({top1} is still hit-tested on top) — the pulse is a "
                    "proxy, not the raise")
            else:
                ok("§I Enter navigates: the window pulses AND is hit-tested in front")
            settle_pulse()

            # (2) MOUSE DRAG with no click delivered by the capture: the window
            # moves and nothing navigates.
            raise_other()
            box = name_el().bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            r0 = P.box('.pinwin[data-id="cto"]')
            pg.mouse.move(cx, cy); pg.mouse.down()
            pg.mouse.move(cx + 150, cy + 120, steps=8)
            pg.mouse.up()
            flash2 = pulsed()
            r1 = P.box('.pinwin[data-id="cto"]')
            moved = r0 and r1 and (abs(r1["x"] - r0["x"]) > 5 or abs(r1["y"] - r0["y"]) > 5)
            obs["pin_drag"] = {"before": r0, "after": r1, "pulsed": flash2}
            if not moved:
                bad(f"§I positive control: the drag did not move the window "
                    f"({r0} -> {r1}), so the next assertion is about a gesture "
                    "that never happened")
            elif flash2:
                bad("§I a DRAG on the title name also NAVIGATED")
            else:
                ok("§I dragging the title name repositions it and navigates nowhere")
            settle_pulse()

            # (3) ENTER AFTER THAT DRAG — the reviewed blocker: a flag left set
            # by a click pointer capture never delivered would eat this.
            raise_other()
            enter_on_name()
            flash3 = pulsed()
            top3 = on_top()
            obs["pin_kbd_after_drag"] = {"pulsed": flash3, "top": top3}
            if not flash3 or top3 != "cto":
                bad(f"§I Enter AFTER A DRAG did not navigate (pulse={flash3}, "
                    f"top={top3}) — a gesture left something behind that ate "
                    "the keyboard activation")
            else:
                ok("§I Enter still navigates after a drag whose click was never delivered")
            settle_pulse()

            # (4) ESCAPE-CANCELLED gesture, then ENTER
            raise_other()
            box = name_el().bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            pg.mouse.move(cx, cy); pg.mouse.down()
            pg.mouse.move(cx + 120, cy + 90, steps=6)
            pg.keyboard.press("Escape")
            pg.mouse.up()
            pg.wait_for_timeout(400)
            raise_other()
            enter_on_name()
            flash4 = pulsed()
            top4 = on_top()
            if not flash4 or top4 != "cto":
                bad(f"§I Enter after an Escape-cancelled gesture did not "
                    f"navigate (pulse={flash4}, top={top4})")
            else:
                ok("§I Enter still navigates after an Escape-cancelled gesture")
            settle_pulse()

            # (5) a real MOUSE CLICK on the name: press and release in place.
            # ⚠ NO `raise_other()` HERE. The two windows overlap and the drag in
            # (2) moved this one, so raising the other can leave it COVERING
            # this name — and then the click lands on the wrong window and the
            # failure reads as "did not navigate" when the gesture never
            # reached the control. The instrument for this case is the pulse,
            # which does not need a stacking precondition; what it does need is
            # for the click to actually hit the name, so that is checked.
            box = name_el().bounding_box()
            cx5, cy5 = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            hit5 = pg.evaluate(
                "([x, y]) => { const e = document.elementFromPoint(x, y);"
                " return e ? (e.closest('.pinwin-name') ? 'name'"
                " : e.closest('.pinwin')?.getAttribute('data-id') ?? 'other')"
                " : 'nothing' }", [cx5, cy5])
            r2 = P.box('.pinwin[data-id="cto"]')
            if hit5 != "name":
                bad(f"§I the click point does not reach the title name "
                    f"({hit5!r}) — this case never ran")
                flash5 = False
                r3 = r2
            else:
                pg.mouse.click(cx5, cy5)
                flash5 = pulsed()
                r3 = P.box('.pinwin[data-id="cto"]')
            if hit5 != "name":
                pass
            elif not flash5:
                bad("§I a CLICK on the title name did not navigate")
            elif r2 and r3 and (abs(r3["x"] - r2["x"]) > 2 or abs(r3["y"] - r2["y"]) > 2):
                bad(f"§I the click also repositioned the window ({r2} -> {r3})")
            else:
                ok("§I clicking the title name navigates and does not reposition it")

        ctx.close()
        b.close()

    # the fixture is a local file with no backend, so the app's own /api fetches
    # fail by design. Those are NOT defects and must not drown a real one; any
    # OTHER page error still counts.
    real = [e for e in errors if "CORS" not in e and "Failed to load resource" not in e
            and "/api/" not in e and "Failed to fetch" not in e]
    if real:
        obs["page_errors"] = real[:10]
        bad(f"the page logged {len(real)} unexpected error(s): {real[:3]}")
    return fails, obs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mutant", choices=sorted(MUTANTS))
    ap.add_argument("--list-mutants", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    if a.list_mutants:
        for k, (_, _, why) in sorted(MUTANTS.items()):
            print(f"{k:20s} {why}")
        return 0

    out = pathlib.Path(tempfile.mkdtemp(prefix="focusspace-probe-"))
    build(out, a.mutant)
    html = out / "probe.html"
    if a.mutant:
        print(f"RED BASELINE — mutant {a.mutant!r}: {MUTANTS[a.mutant][2]}")
    fails, obs = run(html)
    report = {"mutant": a.mutant, "fails": fails, "observed": obs}
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not a.keep:
        import shutil
        shutil.rmtree(out, ignore_errors=True)

    print()
    if a.mutant:
        # a mutant MUST break something, or the probe proves nothing
        if fails:
            print(f"EXPECTED RED: {len(fails)} failure(s) against mutant "
                  f"{a.mutant!r} — the probe can see this break.")
            return 0
        print(f"⚠ MUTANT {a.mutant!r} PASSED — this probe does NOT actually "
              "test what it claims to.")
        return 1
    if fails:
        print(f"{len(fails)} FAILURE(S)")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
