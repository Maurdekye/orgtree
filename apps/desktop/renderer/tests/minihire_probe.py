"""Real Edge hit-test check for the FAR-MAP HIRE TOKENS (user report 2026-09-11:
"at maximum zoom the hire tokens disappear and only come back when the card
quick actions do").

WHY A BROWSER. Every question here is a hit test on a scaled page: the tokens
are counter-scaled to a constant SCREEN size while the cards shrink with the
world, so who owns a given pixel is decided by layout and paint order, and
jsdom has neither. tests/minihire.test.tsx holds the half that does not need
them (what is mounted, that the hire route fires, that the rules are in the
stylesheet); this file measures the geometry.

WHAT IT ESTABLISHES, at the desktop wheel's zoom-out clamp (z=.24, where a
124px card is 29.8px on screen):

  §1 the tokens are THERE — four strips and their hover bridges
  §2 and USABLE — the hovered edge's token owns the open canvas beside the
     card, and clicking through it really hires (window.spawned)
  §3 the card's own body owns every point of itself, so the press that focuses
     an agent is untouched (the 2026-09-10 report)
  §4 and so does every NEIGHBOUR: a token that reaches over the card below or
     beside it is painted under that card and takes none of its clicks
  §5 an OPEN tier menu is the exception, and it is reachable in full — without
     the raise, two of its ten buttons sit under the card below
  §6 at normal zoom nothing moved: the hover raise is still 6 (it is there to
     clear an open desk), the tokens are still above their own card's
     furniture, and the same checks pass

⚠ THE NEGATIVE CONTROL IS THE POINT (§4 would pass against almost anything —
a token that failed to render, a hover that never landed, a selector typo).
So the same detector is re-run on the same page with the two stacking rules
overridden back to their pre-fix values, and it MUST then report the neighbour
losing its body. A run where the control does not fire is a FAILED run, not a
clean one.

    python tests/minihire_probe.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
BUILD = HERE / "minihire-build.mjs"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"
CSS = FRONTEND / "src" / "styles.css"

# the pre-fix stacking, reinstated for the negative control
UNDO_FIX = """
.space > .sq { z-index: auto !important; }
.sq.mini:hover { z-index: 6 !important; }
"""

TAG_CARDS = """() => { for (const el of document.querySelectorAll('.space > .sq'))
  el.dataset.probe = el.querySelector('.sq-title .name')?.textContent?.trim() ?? '?' }"""

BOXES = """() => Object.fromEntries([...document.querySelectorAll('[data-probe]')].map((el) => {
  const r = el.getBoundingClientRect();
  return [el.dataset.probe, { x: r.x, y: r.y, w: r.width, h: r.height }];
}))"""

# who owns this pixel: which card, and is it that card's body or a token
OWNER = """([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'none';
  const card = el.closest('[data-probe]')?.dataset.probe ?? '-';
  const strip = el.closest('.hsof');
  return `${card}/${strip ? 'token' : 'card'}${el.closest('button') ? '+button' : ''}`;
}"""

# centre is PLACES[0] and every other card comes after it in DOM order; `right`
# is last. Hovering both directions is deliberate — the pre-fix behaviour was
# order-dependent, and a one-direction check would have called it fixed.
#
# Every point below is SCANNED rather than guessed at a fixed offset: the strip
# rect, the neighbour rect and the clearances all move with zoom, and a fixed
# offset lands in a different thing at every scale (the first cut of this file
# kept hitting the NEIGHBOUR's own hover bridge and calling it a failure).
EDGES = [
    # label, strip selector, cursor spot on the card, outward axis+direction,
    # the neighbour it grows toward
    ("bottom", ".hsof:not(.side)", ("cx", "bottom-1"), ("y", +1), "below"),
    ("top", ".hsof.side-t", ("cx", "top+1"), ("y", -1), "above"),
    ("left", ".hsof.side-l", ("left+1", "cy"), ("x", -1), "left"),
    ("right", ".hsof.side-r", ("right-1", "cy"), ("x", +1), "right"),
]

# The token must not merely exist out here — it must present a run of pixels
# big enough to aim at. MEASURED at the zoom clamp: the bottom and top tokens
# keep ~18px of their 22, and the two side columns ~8px. A side column loses
# the difference to the NEIGHBOUR's own left/right hover bridge, which is
# transparent hit area that is live whether or not its card is hovered — a
# pre-existing quirk of `.hsof-bridge`, not something this change introduced,
# and not touched here because the bridges' hover reach is what keeps the
# columns usable at every other zoom. 6 leaves a little headroom under the
# measured 8 while still failing outright if a token becomes unaimable.
MIN_REACHABLE_PX = 6


def spot(spec, box):
    """Resolve a ('left+1', 'cy')-style cursor spec against a measured box."""
    def axis(token):
        base = {"cx": box["x"] + box["w"] / 2, "cy": box["y"] + box["h"] / 2,
                "left": box["x"], "right": box["x"] + box["w"],
                "top": box["y"], "bottom": box["y"] + box["h"]}
        name, sign, delta = token, 0, 0.0
        for op in ("+", "-"):
            if op in token:
                name, num = token.split(op, 1)
                sign, delta = (1 if op == "+" else -1), float(num)
                break
        return base[name] + sign * delta
    return axis(spec[0]), axis(spec[1])


def longest_run(owners: list[str], want: str) -> int:
    best = run = 0
    for owner in owners:
        run = run + 1 if owner == want else 0
        best = max(best, run)
    return best


def sweep_body(page, box):
    """Every interior point of a card must belong to that card, not a button."""
    out = []
    for fx in (0.15, 0.5, 0.85):
        for fy in (0.2, 0.5, 0.8):
            x, y = box["x"] + box["w"] * fx, box["y"] + box["h"] * fy
            out.append(page.evaluate(OWNER, [x, y]))
    return out


def measure(page, z: float, failures: list[str]) -> dict:
    tag = f"z={z}"
    page.evaluate(TAG_CARDS)
    boxes = page.evaluate(BOXES)
    centre = boxes["centre"]
    report: dict = {"boxes": boxes, "edges": {}}

    strips = page.evaluate("""() => {
      const card = document.querySelector('[data-probe=centre]');
      return { strips: [...card.querySelectorAll('.hsof')].map((s) => s.className),
               bridges: card.querySelectorAll('.hsof-bridge').length,
               actions: Boolean(card.querySelector('.sq-actions')) };
    }""")
    report["mounted"] = strips
    if len(strips["strips"]) != 4:
        failures.append(f"{tag}: {len(strips['strips'])} hire tokens mounted, expected 4")
    if not strips["bridges"]:
        failures.append(f"{tag}: no hover bridges — the side columns cannot be reached")

    for label, selector, hover, (axis, direction), neighbour in EDGES:
        nb = boxes[neighbour]
        page.mouse.move(*spot(hover, centre))
        page.wait_for_timeout(60)
        strip = page.evaluate("""(sel) => { const s =
            document.querySelector(`[data-probe=centre] ${sel}`);
          if (!s) return null; const r = s.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height }; }""", selector)
        if not strip:
            failures.append(f"{tag}/{label}: no {selector} on the hovered card")
            continue

        # §2 walk the strip outward from the card edge, 1px at a time, and ask
        # who owns each pixel. The token has to hold a usable RUN of them.
        far = strip["y"] + strip["h"] if direction > 0 else strip["y"]
        near = strip["y"] if direction > 0 else strip["y"] + strip["h"]
        if axis == "x":
            far = strip["x"] + strip["w"] if direction > 0 else strip["x"]
            near = strip["x"] if direction > 0 else strip["x"] + strip["w"]
        fixed = (centre["x"] + centre["w"] / 2 if axis == "y"
                 else centre["y"] + centre["h"] / 2)
        walk = []
        steps = int(abs(far - near))
        for i in range(steps):
            moving = near + direction * (i + 0.5)
            xy = [fixed, moving] if axis == "y" else [moving, fixed]
            walk.append(page.evaluate(OWNER, xy))
        reach = longest_run(walk, "centre/token+button")

        # §4 the neighbour keeps its whole body: sample the band of it nearest
        # this card, which is the only part a token can reach
        band = []
        size = nb["h"] if axis == "y" else nb["w"]
        edge0 = (nb["y"] if direction > 0 else nb["y"] + nb["h"]) if axis == "y" \
            else (nb["x"] if direction > 0 else nb["x"] + nb["w"])
        for i in range(int(min(12, size - 2))):
            moving = edge0 + direction * (i + 1.5)
            xy = [fixed, moving] if axis == "y" else [moving, fixed]
            band.append(page.evaluate(OWNER, xy))

        body = sweep_body(page, centre)
        report["edges"][label] = {"strip": strip, "reachablePx": reach,
                                  "walk": walk, "neighbourBand": band, "body": body}
        if reach < MIN_REACHABLE_PX:
            failures.append(f"{tag}/{label}: only {reach}px of the token can be "
                            f"clicked (need {MIN_REACHABLE_PX}): {walk!r}")
        stolen = [hit for hit in band if hit != f"{neighbour}/card"]
        if stolen:
            failures.append(f"{tag}/{label}: {neighbour} lost part of its own body to "
                            f"{sorted(set(stolen))!r} — a token is taking a click "
                            "meant for a card")
        if not band:
            failures.append(f"{tag}/{label}: the neighbour band is empty — vacuous")
        # §3 nothing interactive over the card itself
        if any("+button" in hit for hit in body):
            failures.append(f"{tag}/{label}: a button sits over the card body: {body!r}")
        if not any(hit.startswith("centre/card") for hit in body):
            failures.append(f"{tag}/{label}: the body sweep never landed on the card "
                            f"— it is vacuous: {body!r}")

    # the other direction in DOM order: `right` is last, `centre` first
    right = boxes["right"]
    page.mouse.move(right["x"] + 1, right["y"] + right["h"] / 2)
    page.wait_for_timeout(60)
    report["rightOverCentre"] = page.evaluate(
        OWNER, [centre["x"] + centre["w"] - 2, centre["y"] + centre["h"] / 2])
    if report["rightOverCentre"] != "centre/card":
        failures.append(f"{tag}: a card hovered LATER in DOM order still covers an "
                        f"earlier neighbour ({report['rightOverCentre']})")

    # the hover raise itself: 0 out here, 6 up close (it clears an open desk,
    # and there is no desk below Z_DESK)
    page.mouse.move(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] / 2)
    page.wait_for_timeout(60)
    report["hoverZ"] = page.evaluate(
        "() => getComputedStyle(document.querySelector('[data-probe=centre]')).zIndex")
    want = "0" if z < 0.55 else "6"
    if report["hoverZ"] != want:
        failures.append(f"{tag}: hovered card z-index {report['hoverZ']}, expected {want}")
    return report


def open_menu(page, failures: list[str]) -> dict:
    """§5 — the compact token's tier menu, opened for real and clicked."""
    boxes = page.evaluate(BOXES)
    centre = boxes["centre"]
    page.mouse.move(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] - 1)
    page.mouse.click(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] + 6)
    page.wait_for_timeout(300)
    before = page.evaluate("() => window.spawned.slice()")
    if before:
        failures.append(f"opening the menu already hired something: {before!r}")
    tiers = page.evaluate("""() => {
      const s = document.querySelector('[data-probe=centre] .hsof:not(.side)');
      if (!s || !s.classList.contains('is-expanded')) return null;
      return [...s.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { cls: b.className, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    }""")
    if not tiers:
        failures.append("the compact token's arrow did not open its tier menu")
        return {"tiers": None}
    unreachable = []
    for t in tiers:
        owner = page.evaluate(OWNER, [t["x"], t["y"]])
        if owner != "centre/token+button":
            unreachable.append((t["cls"], owner))
    if unreachable:
        failures.append(f"tier buttons are covered and cannot be clicked: {unreachable!r}")
    target = next((t for t in tiers if t["cls"].endswith("t-opus")), None)
    if target is None:
        failures.append(f"no opus tier button in the open menu: {[t['cls'] for t in tiers]!r}")
        return {"tiers": tiers, "unreachable": unreachable}
    page.mouse.click(target["x"], target["y"])
    page.wait_for_timeout(150)
    spawned = page.evaluate("() => window.spawned.slice()")
    if spawned != ["centre:b:opus"]:
        failures.append(f"clicking a far-zoom tier hired {spawned!r}, expected "
                        "['centre:b:opus'] — the token is visible but dead")
    # ...and leaving the card puts it back down
    page.mouse.move(5, 5)
    page.wait_for_timeout(200)
    page.mouse.move(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] - 1)
    page.wait_for_timeout(250)
    still_open = page.evaluate(
        "() => Boolean(document.querySelector('[data-probe=centre] .hsof.is-expanded'))")
    if still_open:
        failures.append("the tier menu stayed open after the pointer left the card, "
                        "so the raise never comes back down")
    below = page.evaluate(BOXES)["below"]
    owner = page.evaluate(OWNER, [centre["x"] + centre["w"] / 2, below["y"] + 2])
    if owner != "below/card":
        failures.append(f"after the menu closed the neighbour did not get its body "
                        f"back: {owner}")
    return {"tiers": [t["cls"] for t in tiers], "unreachable": unreachable,
            "spawned": spawned, "reclosed": not still_open}


def control(page, failures: list[str]) -> dict:
    """The negative control: put the pre-fix stacking back and require the same
    detector to report the neighbour losing its body."""
    page.add_style_tag(content=UNDO_FIX)
    boxes = page.evaluate(BOXES)
    centre, below, left = boxes["centre"], boxes["below"], boxes["left"]
    page.mouse.move(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] - 1)
    page.wait_for_timeout(80)
    taken_below = page.evaluate(OWNER, [centre["x"] + centre["w"] / 2, below["y"] + 2])
    page.mouse.move(centre["x"] + 1, centre["y"] + centre["h"] / 2)
    page.wait_for_timeout(80)
    taken_left = page.evaluate(OWNER, [left["x"] + left["w"] - 2, centre["y"] + centre["h"] / 2])
    out = {"below": taken_below, "left": taken_left}
    if not taken_below.startswith("centre/token") or not taken_left.startswith("centre/token"):
        failures.append("NEGATIVE CONTROL DID NOT FIRE: with the stacking rules undone "
                        f"the neighbours kept their bodies anyway ({out!r}) — this run "
                        "proves nothing about the rules that ship")
    return out


def main() -> int:
    src = CARDS.read_text(encoding="utf-8")
    if "hireChips" in src:
        raise SystemExit("fixture guard: cards.tsx gates the hire strips again")
    css = CSS.read_text(encoding="utf-8")
    for marker in (".sq.mini:hover { z-index: 0; }", ".space > .sq { z-index: 1; }",
                   ".sq.mini:hover:has(> .hsof.is-expanded) { z-index: 6; }"):
        if marker not in css:
            raise SystemExit(f"fixture guard: styles.css no longer contains {marker}")

    failures: list[str] = []
    values: dict = {}
    shot = HERE / "minihire-browser-evidence.png"
    with tempfile.TemporaryDirectory(prefix="orgtree-minihire-") as tmp:
        out = pathlib.Path(tmp)
        subprocess.run(["node", str(BUILD), str(out)], cwd=FRONTEND, check=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True)
            for z in (0.24, 0.8):
                page = browser.new_page(viewport={"width": 1200, "height": 900},
                                        device_scale_factor=1)
                page.goto((out / "probe.html").as_uri() + f"?z={z}")
                page.wait_for_selector(".space .sq")
                lod = page.evaluate("() => window.probeMeta.lod")
                if lod != ("mini" if z < 0.55 else "norm"):
                    failures.append(f"z={z}: fixture derived lod {lod!r} — it is not "
                                    "reproducing the view it claims to")
                values[f"z{z}"] = measure(page, z, failures)
                values[f"z{z}"]["lod"] = lod
                if z == 0.24:
                    values["menu"] = open_menu(page, failures)
                    centre = page.evaluate(BOXES)["centre"]
                    page.mouse.move(centre["x"] + centre["w"] / 2, centre["y"] + centre["h"] - 1)
                    page.wait_for_timeout(250)
                    page.screenshot(path=str(shot),
                                    clip={"x": 20, "y": 20, "width": 200, "height": 190})
                    values["control"] = control(page, failures)
                page.close()
            browser.close()
    print(json.dumps({"measurements": values, "screenshot": str(shot)}, indent=2))
    if failures:
        print("FAIL:", " | ".join(failures), file=sys.stderr)
        return 1
    print("PASS: far-map hire tokens are mounted, own their own canvas, hire on click, "
          "and take no click from any card — with the pre-fix control firing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
