"""Real Edge render/cascade check for the three-row zoomed-out cards.

The fixture bundles the real NodeSquare and uses the real styles.css. It checks
normal and mini LODs, actual action centers inside their cards, expand routing,
duplicate suppression for pinned cards, left-aligned Row 3, and distinct
computed top accents for working Claude/Codex/Antigravity cards.

Far-zoom shortcut interception (user report 2026-09-10): mini cards mount NO
action row at all — verified by ACTUAL POINTER HIT TARGETS: elementFromPoint
across the card body finds no button, and a real click at the exact position
where the norm card's gear sits reaches the card's drag/focus pipeline
(dragStarts) instead of any shortcut callback. The norm card is the positive
control proving the same detector does find interactive buttons there.
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
BUILD = HERE / "cardlayout-build.mjs"
CARDS = FRONTEND / "src" / "canvas" / "cards.tsx"
CSS = FRONTEND / "src" / "styles.css"


def age_failures(lod: str, row: dict) -> list[str]:
    """The idle age sits BESIDE the state word (user 2026-09-05), and is really
    on screen there. `.sq-workstate` clips, so a time that is present in the DOM
    can still be scrolled out of its own seat by the word beside it — which is
    exactly the "present, plausible and inert" result a DOM test would call a
    pass. Every check here is geometric for that reason.

    A BUSY card shows the ELAPSED TURN TIME beside the working word (the
    jsdom suite pins that contract), so presence is required on both sides —
    the can-this-fail property lives in the geometry checks below and in the
    stray-badge check, which a wrongly-matching selector still trips."""
    who, bad = f"{lod}/{row['id']}", []
    if row["strayAge"]:
        bad.append(f"{who}: the separate age badge is still on the card")
    busy = ".busy" in row["classes"] or " busy" in f" {row['classes']}"
    if busy:
        if not row["time"]:
            bad.append(f"{who}: a busy card lacks the elapsed turn time")
        return bad
    word, time, seat = row["word"], row["time"], row["seat"]
    if not word:
        return [f"{who}: an idle card has no state word"]
    if not time:
        return [f"{who}: the idle age is not beside the word"]
    if time["w"] < 8 or time["h"] < 4:
        bad.append(f"{who}: the age renders {time['w']:.0f}x{time['h']:.0f} — not readable")
    if not (row["timeText"] or "").strip():
        bad.append(f"{who}: the age element is empty")
    # BESIDE: after the word horizontally, and on the same line as it
    if time["x"] < word["x"] + word["w"] - 1:
        bad.append(f"{who}: the age is not after the word")
    if abs(time["y"] + time["h"] / 2 - (word["y"] + word["h"] / 2)) > 6:
        bad.append(f"{who}: the age is on a different line from the word")
    # VISIBLE: inside the seat that clips, with a pixel of tolerance
    if seat and (time["x"] < seat["x"] - 1
                 or time["x"] + time["w"] > seat["x"] + seat["w"] + 1):
        bad.append(f"{who}: the age is clipped out of its own seat")
    return bad


def main() -> int:
    src = CARDS.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    for marker in ("className=\"sq-title\"", "className=\"sq-meta\"",
                   "className=\"expandbtn\"", "aria-label=\"Expand agent window\""):
        if marker not in src:
            raise SystemExit(f"fixture guard: cards.tsx no longer emits {marker}")
    for marker in ("justify-content: flex-start", ".sq.prov-openai.busy:not(.desk)",
                   ".sq.prov-google.busy:not(.desk)"):
        if marker not in css:
            raise SystemExit(f"fixture guard: styles.css no longer contains {marker}")
    with tempfile.TemporaryDirectory(prefix="orgtree-cardlayout-") as tmp:
        out = pathlib.Path(tmp)
        subprocess.run(["node", str(BUILD), str(out)], cwd=FRONTEND, check=True)
        shot = HERE / "gear-browser-evidence.png"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1200, "height": 600}, device_scale_factor=1)
            page.goto((out / "probe.html").as_uri())
            page.wait_for_selector("#normal .sq")
            page.evaluate("() => document.documentElement.style.setProperty('--invzf', '1.818')")
            values = page.evaluate("""() => {
              const read = (root) => [...document.querySelectorAll(`${root} .sq`)].map((card) => {
                const r = card.getBoundingClientRect();
                const rows = [...card.children].filter((e) =>
                  e.matches('.sq-head, .sq-actions, .sq-badges'));
                const b = card.querySelector('.expandbtn');
                const br = b?.getBoundingClientRect();
                const badges = card.querySelector('.sq-badges')?.getBoundingClientRect();
                const actionEl = card.querySelector('.sq-actions');
                const actions = actionEl?.getBoundingClientRect();
                // the idle age: where it sits, and whether it is really visible
                const seatEl = card.querySelector('.sq-workstate');
                const wordEl = card.querySelector('.sq-workstate .sq-idle');
                const timeEl = card.querySelector('.sq-workstate .sq-idle-time');
                const box = (e) => { if (!e) return null; const q = e.getBoundingClientRect();
                  return {x:q.x,y:q.y,w:q.width,h:q.height} };
                return { id: card.querySelector('.sq-title .name')?.textContent.trim(),
                  seat: box(seatEl), word: box(wordEl), time: box(timeEl),
                  timeText: timeEl?.textContent ?? null,
                  strayAge: Boolean(card.querySelector('.turnago')),
                  classes: card.className, top: getComputedStyle(card).borderTopColor,
                  card: {x:r.x,y:r.y,w:r.width,h:r.height},
                  button: br && {x:br.x,y:br.y,w:br.width,h:br.height},
                  badges: badges && {x:badges.x,y:badges.y,w:badges.width,h:badges.height},
                  actions: actions && {x:actions.x,y:actions.y,w:actions.width,h:actions.height},
                  actionOrder: actionEl && [...actionEl.children].map((el) =>
                    [...el.classList].find((name) => name.endsWith('btn')) ?? el.tagName),
                  rows: rows.map((e) => e.className), actionJustify:
                    actionEl ? getComputedStyle(actionEl).justifyContent : null };
              });
              const references = {};
              for (const tier of ['haiku', 'terra', 'sol', 'luna', 'flash']) {
                const ref = document.createElement('div');
                ref.className = `sq norm tier-${tier}`;
                document.body.appendChild(ref);
                references[tier] = getComputedStyle(ref).borderTopColor;
                ref.remove();
              }
              return { normal: read('#normal'), mini: read('#mini'), references,
                pinned: document.querySelector('#pinned .expandbtn') === null,
                pinnedActions: [...document.querySelectorAll('#pinned .sq-actions > button')]
                  .map((el) => [...el.classList].find((name) => name.endsWith('btn')) ?? el.tagName) };
            }""")
            # Capture a real hover state: the existing card design deliberately
            # reveals its action row only while the pointer is over a card.
            page.locator("#normal .sq").nth(1).hover()
            # First fixture has all six production actions and uses the real
            # pointer route for the gear callback.
            page.locator("#normal .sq").nth(0).hover()
            page.locator("#normal .sq").nth(0).locator(".gearbtn").click()
            values["gearConfigured"] = page.evaluate("() => window.configured")
            values["allActionButtons"] = page.evaluate("() => [...document.querySelectorAll('#normal .sq')].map(el => el.querySelectorAll('.sq-actions > button').length)")
            values["allActionGeometry"] = page.evaluate("""() => {
              const card = document.querySelector('#normal .sq');
              const cr = card.getBoundingClientRect();
              return [...card.querySelectorAll('.sq-actions > button')].map(el => {
                const r = el.getBoundingClientRect();
                return {className: el.className, inside: r.left >= cr.left && r.right <= cr.right
                  && r.top >= cr.top && r.bottom <= cr.bottom};
              });
            }""")
            # Negative control: restore the original single-line rule and
            # require this same mounted component to overflow.
            values["originalOverflow"] = page.evaluate("""() => {
              const style = document.createElement('style');
              style.textContent = '.sq-actions { max-width: none !important; flex-wrap: nowrap !important; }';
              document.head.appendChild(style);
              const card = document.querySelector('#normal .sq');
              const cr = card.getBoundingClientRect();
              const gear = card.querySelector('.gearbtn').getBoundingClientRect();
              const ar = card.querySelector('.sq-actions').getBoundingClientRect();
              const actions = card.querySelector('.sq-actions');
              return {gearRight: gear.right, cardRight: cr.right, actionsRight: ar.right,
                buttonWidth: gear.width, scrollWidth: actions.scrollWidth, clientWidth: actions.clientWidth,
                outside: gear.right >= cr.right - .5 && actions.scrollWidth > actions.clientWidth};
            }""")
            # Far-zoom interception: hover a MINI card and sweep ACTUAL hit
            # targets across its body — no point may resolve to a button.
            # The norm card is the positive control: the same detector at the
            # gear's own center MUST find a button, so a sweep that "finds
            # nothing" because the selector or geometry broke cannot pass.
            page.locator("#mini .sq").nth(0).hover()
            values["miniHits"] = page.evaluate("""() => {
              const sweep = (card) => {
                const r = card.getBoundingClientRect();
                const points = [];
                for (const fx of [.15, .5, .85])
                  for (const fy of [.2, .5, .8])
                    points.push([r.left + r.width * fx, r.top + r.height * fy]);
                return points.map(([x, y]) => {
                  const el = document.elementFromPoint(x, y);
                  return { x, y, button: Boolean(el && el.closest('button')),
                           inCard: Boolean(el && el.closest('.sq')) };
                });
              };
              return { mini: sweep(document.querySelector('#mini .sq')),
                       miniActionsMounted: Boolean(document.querySelector('#mini .sq-actions')) };
            }""")
            page.locator("#normal .sq").nth(0).hover()
            values["normHitControl"] = page.evaluate("""() => {
              const gear = document.querySelector('#normal .sq .gearbtn');
              const r = gear.getBoundingClientRect();
              const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return { gearHit: Boolean(el && el.closest('button.gearbtn')),
                       rel: (() => {
                         const c = gear.closest('.sq').getBoundingClientRect();
                         return { dx: r.left + r.width / 2 - c.left, dy: r.top + r.height / 2 - c.top };
                       })() };
            }""")
            # hover-created EDGE HIRE CHIPS (user 2026-09-10: they intercept
            # too): a real pointer at the norm card's bottom edge reveals the
            # bottom hire strip and its chips are hit-targetable just below
            # the border (positive control); the same hover on the mini card
            # reveals NOTHING because the chips are unmounted there.
            norm_box = page.locator("#normal .sq").nth(0).bounding_box()
            page.mouse.move(norm_box["x"] + norm_box["width"] / 2,
                            norm_box["y"] + norm_box["height"] - 3)
            values["normEdgeHire"] = page.evaluate("""() => {
              const card = document.querySelector('#normal .sq');
              const r = card.getBoundingClientRect();
              const el = document.elementFromPoint(r.left + r.width / 2, r.bottom + 8);
              return { hsofCount: card.querySelectorAll('.hsof').length,
                       chipHit: Boolean(el && el.closest('.hsof')) };
            }""")
            mini_box0 = page.locator("#mini .sq").nth(0).bounding_box()
            page.mouse.move(mini_box0["x"] + mini_box0["width"] / 2,
                            mini_box0["y"] + mini_box0["height"] - 3)
            values["miniEdgeHire"] = page.evaluate("""() => {
              const card = document.querySelector('#mini .sq');
              const r = card.getBoundingClientRect();
              const el = document.elementFromPoint(r.left + r.width / 2, r.bottom + 8);
              return { mounted: card.querySelectorAll('.hsof, .hsof-bridge').length,
                       chipHit: Boolean(el && el.closest('.hsof')),
                       buttonHit: Boolean(el && el.closest('button')) };
            }""")
            # A REAL CLICK where the shortcuts used to sit: same card-relative
            # offset as the norm gear, on the mini card. It must reach the
            # card's drag/focus pipeline and fire no shortcut callback.
            values["preClick"] = page.evaluate(
                "() => ({ starts: [...window.dragStarts], ends: [...window.dragEnds],"
                " configured: [...window.configured], opened: [...window.opened] })")
            rel = values["normHitControl"]["rel"]
            mini_box = page.locator("#mini .sq").nth(0).bounding_box()
            page.mouse.click(mini_box["x"] + min(rel["dx"], mini_box["width"] - 2),
                             mini_box["y"] + min(rel["dy"], mini_box["height"] - 2))
            values["postClick"] = page.evaluate(
                "() => ({ starts: [...window.dragStarts], ends: [...window.dragEnds],"
                " configured: [...window.configured], opened: [...window.opened] })")
            page.reload()
            page.wait_for_selector("#normal .sq")
            page.evaluate("() => document.documentElement.style.setProperty('--invzf', '1')")
            page.locator("#normal .sq").nth(0).hover()
            values["normalZoom"] = page.evaluate("""() => {
              const card = document.querySelector('#normal .sq');
              const cr = card.getBoundingClientRect();
              const gear = card.querySelector('.gearbtn').getBoundingClientRect();
              return {inside: gear.left >= cr.left && gear.right <= cr.right
                && gear.top >= cr.top && gear.bottom <= cr.bottom};
            }""")
            page.screenshot(path=str(shot))
            mobile = browser.new_page(viewport={"width": 480, "height": 600}, device_scale_factor=1)
            mobile.goto((out / "probe.html").as_uri())
            mobile.wait_for_selector("#mini .sq")
            mobile.evaluate("() => document.documentElement.classList.add('mobile')")
            values["mobileActionsHidden"] = mobile.evaluate("""() =>
              [...document.querySelectorAll('.sq-actions')]
                .every((el) => getComputedStyle(el).display === 'none')""")
            mobile.close()
            # expand routes from norm only — mini mounts no expand at all
            page.locator("#normal .sq").nth(1).hover()
            page.locator("#normal .expandbtn").nth(1).click()
            opened = page.evaluate("() => window.opened")
            browser.close()
    failures = []
    for lod in ("normal", "mini"):
        rows = values[lod]
        if len(rows) != 7:
            failures.append(f"{lod}: expected 7 cards, got {len(rows)}")
        for row in rows:
            if lod == "mini":
                # far zoom: NO shortcut hit targets at all (user 2026-09-10)
                if row["button"]:
                    failures.append(f"mini/{row['id']}: expand hitbox still mounted")
                if row["actions"] or "sq-actions" in " ".join(row["rows"]):
                    failures.append(f"mini/{row['id']}: action row still mounted")
                if "sq-head" not in row["rows"]:
                    failures.append(f"mini/{row['id']}: head row missing")
                failures += age_failures(lod, row)
                continue
            if not row["button"]:
                failures.append(f"{lod}/{row['id']}: missing expand hitbox")
                continue
            b, c = row["button"], row["card"]
            if not (c["x"] <= b["x"] + b["w"] / 2 <= c["x"] + c["w"]
                    and c["y"] <= b["y"] + b["h"] / 2 <= c["y"] + c["h"]):
                failures.append(f"{lod}/{row['id']}: expand center outside card")
            if row["actionJustify"] != "flex-start":
                failures.append(f"{lod}/{row['id']}: actions justify {row['actionJustify']}")
            if not row["actionOrder"] or row["actionOrder"][0] != "mailbtn":
                failures.append(f"{lod}/{row['id']}: mail action is not leftmost: {row['actionOrder']!r}")
            if "sq-head" not in row["rows"] or "sq-actions" not in row["rows"]:
                failures.append(f"{lod}/{row['id']}: row structure missing")
            for part in (row.get("actions"), row.get("badges")):
                if part and (part["y"] < row["card"]["y"]
                             or part["y"] + part["h"] > row["card"]["y"] + row["card"]["h"]):
                    failures.append(f"{lod}/{row['id']}: row clips outside fixed card")
            failures += age_failures(lod, row)
    # far-zoom pointer truth: the sweep found no button anywhere on the mini
    # card body, the same detector DOES find the norm gear (positive control),
    # and a real click at the old gear position reached the drag/focus
    # pipeline without firing any shortcut callback
    hits = values.get("miniHits") or {}
    if hits.get("miniActionsMounted"):
        failures.append("mini card still mounts .sq-actions")
    sweep = hits.get("mini") or []
    if not sweep:
        failures.append("mini hit sweep produced no samples")
    if any(p["button"] for p in sweep):
        failures.append(f"mini card body resolves to a button: {sweep!r}")
    if not any(p["inCard"] for p in sweep):
        failures.append("mini hit sweep never landed on the card — sweep is vacuous")
    if not (values.get("normHitControl") or {}).get("gearHit"):
        failures.append("positive control failed: norm gear center did not hit the gear button")
    edge = values.get("normEdgeHire") or {}
    if not edge.get("hsofCount"):
        failures.append("positive control failed: norm card mounts no hire chips")
    if not edge.get("chipHit"):
        failures.append(f"positive control failed: hovered norm bottom edge missed the hire strip: {edge!r}")
    medge = values.get("miniEdgeHire") or {}
    if medge.get("mounted"):
        failures.append(f"mini card still mounts hire chips/bridges: {medge!r}")
    if medge.get("chipHit") or medge.get("buttonHit"):
        failures.append(f"mini bottom edge still hit-targets a hire control: {medge!r}")
    # BOTH halves of the click must reach the card with the SAME agent id —
    # endNodeDrag focuses only when the up follows a matching down, and a
    # button's stopPropagation eats the down while the up still bubbles, so
    # pointer-down alone would not establish the focus route
    pre, post = values.get("preClick") or {}, values.get("postClick") or {}
    if len(post.get("starts", [])) <= len(pre.get("starts", [])):
        failures.append(f"mini body click's pointer-down never reached the card: {pre!r} -> {post!r}")
    elif post["starts"][-1] != "claude-agent":
        failures.append(f"mini click's pointer-down routed to the wrong card: {post['starts']!r}")
    if len(post.get("ends", [])) <= len(pre.get("ends", [])):
        failures.append(f"mini body click's pointer-up never reached the card: {pre!r} -> {post!r}")
    elif post["ends"][-1] != "claude-agent":
        failures.append(f"mini click's pointer-up routed to the wrong card: {post['ends']!r}")
    if post.get("configured") != pre.get("configured") or post.get("opened") != pre.get("opened"):
        failures.append(f"mini click fired a shortcut callback: {pre!r} -> {post!r}")
    by_id = {row["id"]: row for row in values["normal"]}
    for node_id, tier in (("claude-agent", "haiku"), ("codex-terra-agent", "terra"),
                          ("codex-sol-agent", "sol"), ("luna-agent", "luna"),
                          ("agy-agent", "flash")):
        if by_id[node_id]["top"] != values["references"][tier]:
            failures.append(f"{node_id}: busy top {by_id[node_id]['top']} != {tier} tier {values['references'][tier]}")
    if by_id["agy-agent"]["top"] != by_id["idle-flash-agent"]["top"]:
        failures.append("AGY busy top differs from idle Flash tier positive control")
    if by_id["luna-agent"]["top"] != by_id["idle-luna-agent"]["top"]:
        failures.append("Luna busy top differs from idle Luna tier positive control")
    if opened != ["codex-terra-agent"]:
        failures.append(f"expand routed to {opened!r}, expected codex-terra only "
                        f"(mini mounts no expand)")
    if not values["pinned"]:
        failures.append("pinned card still exposes duplicate expand action")
    if not values["pinnedActions"] or values["pinnedActions"][0] != "mailbtn":
        failures.append(f"pinned card mail action is not leftmost: {values['pinnedActions']!r}")
    if not values["mobileActionsHidden"]:
        failures.append("mobile card controls are hidden without removing the action row")
    if values.get("gearConfigured") != ["claude-agent"]:
        failures.append(f"real gear pointer callback routed to {values.get('gearConfigured')!r}")
    if values.get("allActionButtons", [0])[0] != 6:
        failures.append(f"all-action fixture rendered {values.get('allActionButtons')!r} buttons")
    if not values.get("allActionGeometry") or not all(b["inside"] for b in values["allActionGeometry"]):
        failures.append(f"all-action control escaped card: {values.get('allActionGeometry')!r}")
    if not values.get("originalOverflow", {}).get("outside"):
        failures.append(f"original no-wrap rule did not overflow: {values.get('originalOverflow')!r}")
    if values.get("normal", [{}])[0].get("button", {}).get("w") != 24:
        failures.append(f"minimum-zoom button did not reach 24px: {values.get('normal', [{}])[0].get('button')!r}")
    if not values.get("normalZoom", {}).get("inside"):
        failures.append("normal-zoom gear escaped card")
    print(json.dumps({"measurements": values, "opened": opened, "screenshot": str(shot)}, indent=2))
    if failures:
        print("FAIL:", " | ".join(failures), file=sys.stderr)
        return 1
    print("PASS: browser rendered normal+mini rows, hit centers, routing, pin suppression, and computed tier accents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
