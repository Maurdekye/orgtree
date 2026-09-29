"""attentionlayout_probe.py — the user's 2026-09-29 v3 layout reports, measured
and photographed in a real browser (dockets
v3-attention-view-layout-effort-tag-text-and-app and
v3-agents-list-desk-panel-reuse-the-pinned-agent).

jsdom computes no layout and applies no cascade, so none of these can be a
unit test: every claim below is a pixel or a computed style.

  A. Attention mode HIDES the canvas instead of shrinking it: the viewport's
     box is the same in both views, and the world inside it is invisible.
  B. The two Attention panels FILL their slots and follow the divider.
  C. The effort card reads just the level ("high"), not "Effort high".
  D. Every App settings tab title sits on one line; General is gone, About is
     first, and the startup choice is a plain dropdown under Display.
  E. The Attention view's desk panel uses the pinned desk's type and button
     metrics (same font size and padding for the same buttons).
  F. The desk shows one jump card per watchdog of ITS agent, and a card opens
     that watchdog's detail modal.
  G. A desk restored from the last session shows on the canvas but not over
     the Attention view.
  H. The agents list is a drawer: hover opens nothing, a click opens it, the
     desk behind is darkened, nothing inside the desk (whatever its z-index)
     draws over it, and the scrim, Escape and the button close it.
  I. Both Attention panels use compact padding.

    cd apps/desktop/renderer
    python tests/attentionlayout_probe.py <outdir>      # JSON + screenshots

Requires playwright with the msedge channel, like the other browser probes
here. No backend: the page answers every feed with an empty document.
Exit status is 0 only when every check passes.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
VP_W, VP_H = 1600, 900

BOX = """(sel) => { const e = document.querySelector(sel); if (!e) return null;
  const r = e.getBoundingClientRect();
  return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} }"""

BUTTONS = """(sel) => { const root = document.querySelector(sel); if (!root) return null;
  const out = {};
  for (const b of root.querySelectorAll('button')) {
    const t = (b.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!t || t in out || b.offsetParent === null) continue;
    const s = getComputedStyle(b);
    out[t] = {fontSize: s.fontSize, padding: s.padding, h: Math.round(b.getBoundingClientRect().height)};
  }
  return out }"""

TABS = """() => [...document.querySelectorAll('.app-settings-tab')].map(t => {
  const s = getComputedStyle(t); const r = t.getBoundingClientRect();
  const inner = r.height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
    - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
  const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
  const range = document.createRange(); range.selectNodeContents(t);
  const lines = new Set([...range.getClientRects()].map(q => Math.round(q.top))).size;
  return {label: t.textContent.trim(), h: Math.round(r.height), lines,
          byHeight: Math.round(inner / lh), right: Math.round(r.right)} })"""


def main() -> int:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "attentionlayout-out").resolve()
    build = out / "build"
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), str(build)],
                   check=True, cwd=str(FRONTEND))
    page_url = (build / "probe.html").as_uri()
    res: dict = {}
    checks: dict[str, bool] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": VP_W, "height": VP_H})

        def open_scene(name: str):
            page = ctx.new_page()
            page.on("pageerror", lambda e: res.setdefault("pageerrors", []).append(f"{name}: {e}"))
            page.goto(page_url + "#" + name)
            page.wait_for_timeout(1500)
            return page

        # ---- canvas: the reference geometry, and the effort card
        p = open_scene("canvas")
        res["canvas_viewport"] = p.evaluate(BOX, ".viewport")
        res["effort_cards"] = p.eval_on_selector_all(
            ".effort-level", "els => els.map(e => e.textContent.trim())")
        p.screenshot(path=str(out / "canvas.png"))
        card = p.query_selector(".effort-level")
        if card:
            p.screenshot(path=str(out / "effort-card.png"),
                         clip=_grow(card.bounding_box(), 160, 40))
        checks["C_effort_cards_present"] = bool(res["effort_cards"])
        checks["C_effort_is_just_the_level"] = bool(res["effort_cards"]) and all(
            t in ("low", "medium", "high", "xhigh", "max") for t in res["effort_cards"])
        p.close()

        # ---- attention: A and B
        p = open_scene("attention")
        vp = res["attention_viewport"] = p.evaluate(BOX, ".viewport")
        res["attention_stage"] = p.evaluate(BOX, ".attn-stage")
        res["world_visibility"] = p.evaluate(
            "() => { const s = document.querySelector('.space'); return s && getComputedStyle(s).visibility }")
        cv = res["canvas_viewport"]
        checks["A_canvas_keeps_its_size"] = bool(vp and cv) and vp["h"] == cv["h"] and vp["w"] == cv["w"]
        checks["A_canvas_world_hidden"] = res["world_visibility"] == "hidden"
        st = res["attention_stage"]
        checks["A_stage_covers_the_canvas"] = bool(st and vp) and st["h"] >= vp["h"] - 4 and st["w"] >= vp["w"] - 4

        def panels():
            return {k: p.evaluate(BOX, s) for k, s in (
                ("queue_slot", ".attn-slot-queue"), ("queue_panel", ".attn-panel-queue"),
                ("desk_slot", ".attn-slot-desk"), ("desk_panel", ".attn-panel-desk"),
                ("divider", ".attn-divider"))}
        before = res["panels_before_drag"] = panels()
        p.screenshot(path=str(out / "attention.png"))

        def fills(b):
            ok = True
            for s, pn in (("queue_slot", "queue_panel"), ("desk_slot", "desk_panel")):
                sl, pa = b[s], b[pn]
                ok = ok and bool(sl and pa) and pa["w"] >= sl["w"] - 20 and pa["h"] >= sl["h"] - 20
            return ok
        checks["B_panels_fill_their_slots"] = fills(before)
        d = before["divider"]
        if d and st:
            y = d["y"] + d["h"] // 2
            p.mouse.move(d["x"] + d["w"] // 2, y)
            p.mouse.down()
            p.mouse.move(st["x"] + int(st["w"] * 0.62), y, steps=8)
            p.mouse.up()
            p.wait_for_timeout(300)
        after = res["panels_after_drag"] = panels()
        p.screenshot(path=str(out / "attention-dragged.png"))
        checks["B_divider_resizes_the_panels"] = bool(before["queue_panel"] and after["queue_panel"]) \
            and after["queue_panel"]["w"] - before["queue_panel"]["w"] > 150 \
            and before["desk_panel"]["w"] - after["desk_panel"]["w"] > 150
        checks["B_panels_still_fill_after_drag"] = fills(after)
        res["attention_desk_buttons"] = p.evaluate(BUTTONS, ".attn-desk")
        res["attention_desk_font"] = p.evaluate(
            "() => { const e = document.querySelector('.attn-desk .desk-body') || document.querySelector('.attn-desk');"
            " return e && getComputedStyle(e).fontSize }")
        res["attention_desk_inset"] = _inset(p, ".attn-panel-desk", ".attn-desk .desk-body")
        # F: the desk's watchdog cards (docket v3-desk-jump-cards-add-a-card-per-watchdog-that)
        res["dog_cards"] = p.eval_on_selector_all(
            ".attn-desk .desk-dog-chip", "els => els.map(e => e.textContent.trim())")
        checks["F_desk_has_a_card_per_own_watchdog"] = res["dog_cards"] == ["◉build-done", "◫1×ci-red"]
        card = p.query_selector(".attn-desk .desk-dog-chip")
        if card:
            card.scroll_into_view_if_needed()
            p.screenshot(path=str(out / "dog-cards.png"), clip=_grow(card.bounding_box(), 240, 60))
            card.click()
            p.wait_for_timeout(300)
            # SEEN, not merely mounted: the dialog must paint and be the thing
            # under the pointer — the canvas's dialogs used to open inside its
            # hidden layer, invisible over the Attention view
            res["dog_modal"] = p.evaluate(
                "() => { const h = [...document.querySelectorAll('h3')].find(e => e.textContent.includes('build-done'));"
                " if (!h) return null; const r = h.getBoundingClientRect();"
                " const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);"
                " return {text: h.textContent.trim(), visibility: getComputedStyle(h).visibility,"
                "         onTop: !!top && (top === h || h.contains(top))} }")
            p.screenshot(path=str(out / "dog-modal.png"))
        m = res.get("dog_modal") or {}
        checks["F_card_opens_the_watchdog_modal"] = bool(m) and m.get("visibility") == "visible"             and m.get("onTop") is True
        p.close()

        # ---- G: a desk restored from last session belongs to the CANVAS: it
        # shows there (the control) and is put away under the Attention view
        seen = {}
        for scene in ("canvas-restored", "attention-restored"):
            p = open_scene(scene)
            seen[scene] = p.evaluate("""() => { const e = document.querySelector('.restored-desk');
              if (!e) return 'absent'; const r = e.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return getComputedStyle(e).visibility === 'visible' && !!top && e.contains(top)
                ? 'visible' : 'hidden' }""")
            p.screenshot(path=str(out / f"{scene}.png"))
            p.close()
        res["restored_desk"] = seen
        checks["G_restored_desk_shows_on_canvas"] = seen["canvas-restored"] == "visible"
        checks["G_restored_desk_not_over_attention"] = seen["attention-restored"] in ("hidden", "absent")             and seen["canvas-restored"] == "visible"

        # ---- pinned: E's reference
        p = open_scene("pinned")
        res["pinned_desk_buttons"] = p.evaluate(BUTTONS, ".pinwin-body")
        res["pinned_desk_font"] = p.evaluate(
            "() => { const e = document.querySelector('.pinwin-body .desk-body') || document.querySelector('.pinwin-body');"
            " return e && getComputedStyle(e).fontSize }")
        res["pinned_desk_inset"] = _inset(p, ".pinwin", ".pinwin-body .desk-body")
        p.screenshot(path=str(out / "pinned.png"))
        p.close()
        a, b = res["attention_desk_buttons"] or {}, res["pinned_desk_buttons"] or {}
        common = sorted(set(a) & set(b))
        res["desk_button_diffs"] = {t: {"attention": a[t], "pinned": b[t]} for t in common
                                    if (a[t]["fontSize"], a[t]["padding"]) != (b[t]["fontSize"], b[t]["padding"])}
        res["desk_buttons_compared"] = common
        checks["E_desk_buttons_compared"] = len(common) >= 4
        checks["E_desk_buttons_match_pinned"] = len(common) >= 4 and not res["desk_button_diffs"]
        checks["E_desk_font_matches_pinned"] = res["attention_desk_font"] == res["pinned_desk_font"]

        # ---- attention: H, the agents drawer, and I, the compact spacing
        # (docket v3-attention-view-agents-list-becomes-a-click-on)
        p = open_scene("attention")
        res["spacing"] = p.evaluate("""() => { const pad = (sel) => { const e = document.querySelector(sel);
            if (!e) return null; const s = getComputedStyle(e);
            return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat) };
          return {slot: pad('.attn-slot-queue'), queue: pad('.attn-panel-queue'), desk: pad('.attn-panel-desk')} }""")
        sp = res["spacing"]
        checks["I_slot_padding_at_most_4px"] = bool(sp["slot"]) and max(sp["slot"]) <= 4
        checks["I_queue_panel_padding_at_most_8px"] = bool(sp["queue"]) and max(sp["queue"]) <= 8
        checks["I_desk_panel_padding_at_most_5px"] = bool(sp["desk"]) and max(sp["desk"]) <= 5
        # a stand-in for the desk's "↑ you" jump chip: something inside the desk
        # with an absurd z-index, right where the drawer will be
        p.evaluate("""() => { const d = document.querySelector('.attn-desk'); if (!d) return;
          const x = document.createElement('div'); x.id = 'probe-high-z';
          Object.assign(x.style, {position: 'absolute', left: '0', top: '40px', width: '400px',
            height: '30px', zIndex: '99999', background: 'red'});
          d.style.position = d.style.position || ''; d.appendChild(x) }""")
        drawer_state = """() => { const w = document.querySelector('.attn-agents-wrap');
          const a = document.querySelector('.attn-agents'), s = document.querySelector('.attn-agents-scrim');
          const r = a && a.getBoundingClientRect();
          return {open: !!w && w.classList.contains('list-open'),
            visibility: a && getComputedStyle(a).visibility,
            box: r && {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)},
            scrimOpacity: s ? getComputedStyle(s).opacity : null } }"""
        tog = p.query_selector(".attn-agents-toggle")
        tb = tog.bounding_box() if tog else None
        if tb:
            p.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            p.wait_for_timeout(400)
        res["drawer_after_hover"] = p.evaluate(drawer_state)
        h = res["drawer_after_hover"]
        checks["H_hovering_the_button_opens_nothing"] = bool(tb) and not h["open"] and h["visibility"] == "hidden"
        if tb:
            p.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            p.wait_for_timeout(400)
        o = res["drawer_after_click"] = p.evaluate(drawer_state)
        checks["H_click_opens_the_drawer"] = o["open"] and o["visibility"] == "visible" \
            and bool(o["box"]) and o["box"]["w"] >= 200
        p.screenshot(path=str(out / "attention-drawer.png"))
        desk = p.evaluate(BOX, ".attn-desk")
        # what the pointer actually hits: inside the drawer over the high-z
        # stand-in, and on the desk to the right of the drawer
        hit = """([x, y]) => { const e = document.elementFromPoint(x, y);
          return e ? (e.closest('.attn-agents') ? 'drawer' : e.classList.contains('attn-agents-scrim') ? 'scrim'
            : e.id === 'probe-high-z' ? 'desk-high-z' : 'other:' + e.className) : null }"""
        if o["box"] and desk:
            in_drawer = [o["box"]["x"] + o["box"]["w"] - 10, desk["y"] + 55]
            on_desk = [o["box"]["x"] + o["box"]["w"] + 150, desk["y"] + desk["h"] // 2]
            res["hit_in_drawer"] = p.evaluate(hit, in_drawer)
            res["hit_on_desk"] = p.evaluate(hit, on_desk)
            checks["H_nothing_in_the_desk_draws_over_the_drawer"] = res["hit_in_drawer"] == "drawer"
            checks["H_desk_is_darkened"] = res["hit_on_desk"] == "scrim" and o["scrimOpacity"] == "1"
            p.mouse.move(*on_desk)
            p.wait_for_timeout(400)
            checks["H_pointer_on_the_desk_keeps_it_open"] = p.evaluate(drawer_state)["open"]
            p.mouse.click(*on_desk)
            p.wait_for_timeout(400)
            checks["H_scrim_click_closes"] = not p.evaluate(drawer_state)["open"]
            closed = p.evaluate(drawer_state)
            checks["H_closed_scrim_is_clear"] = closed["scrimOpacity"] == "0" and closed["visibility"] == "hidden"
            p.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            p.wait_for_timeout(300)
            res["drawer_before_escape"] = p.evaluate(drawer_state)
            res["focus_before_escape"] = p.evaluate("() => document.activeElement && document.activeElement.className")
            p.keyboard.press("Escape")
            p.wait_for_timeout(300)
            checks["H_escape_closes"] = not p.evaluate(drawer_state)["open"]
            p.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            p.wait_for_timeout(300)
            p.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            p.wait_for_timeout(300)
            checks["H_button_again_closes"] = not p.evaluate(drawer_state)["open"]
        else:
            checks["H_drawer_measured"] = False
        p.close()

        # ---- settings: D
        for tab in ("about", "display"):
            p = open_scene("settings-" + tab)
            tabs = res[f"tabs_{tab}"] = p.evaluate(TABS)
            # informational: whether the strip fits or scrolls sideways
            res[f"tabstrip_{tab}"] = p.evaluate(
                "() => { const s = document.querySelector('.app-settings-tabs');"
                " return s && {scrollWidth: s.scrollWidth, clientWidth: s.clientWidth} }")
            if tab == "display":
                # the startup row is at the bottom of a long tab: bring it on
                # screen for the picture (the tab strip must survive that)
                p.evaluate("() => document.querySelector('select[aria-label=\"On startup\"]')"
                           "?.scrollIntoView({block: 'center'})")
                p.wait_for_timeout(200)
            p.screenshot(path=str(out / f"settings-{tab}.png"))
            if tab == "display":
                res["startup_select"] = p.evaluate(
                    "() => { const s = document.querySelector('select[aria-label=\"On startup\"]');"
                    " return s && [...s.options].map(o => o.textContent.trim()) }")
                res["fancy_startup_left"] = p.evaluate("() => !!document.querySelector('.shell-startup')")
            p.close()
        tabs = res["tabs_about"]
        checks["D_every_tab_one_line"] = all(
            bool(res[f"tabs_{t}"]) and all(x["lines"] == 1 and x["byHeight"] == 1 for x in res[f"tabs_{t}"])
            for t in ("about", "display"))
        checks["D_no_general_tab"] = bool(tabs) and all(t["label"] != "General" for t in tabs)
        checks["D_tab_order_is_the_users"] = [t["label"] for t in tabs] == [
            "Providers", "Runtime", "Display", "Default org settings", "Mail hub", "Developer", "About"]
        checks["D_startup_is_a_dropdown_in_display"] = bool(res.get("startup_select")) \
            and not res.get("fancy_startup_left")
        browser.close()

    res["checks"] = checks
    (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps(res, indent=2))
    failed = [k for k, v in checks.items() if not v]
    print("FAILED: " + ", ".join(failed) if failed else "ALL CHECKS PASS")
    return 1 if failed else 0


def _grow(box, dx, dy):
    return {"x": max(0, box["x"] - dx), "y": max(0, box["y"] - dy),
            "width": box["width"] + 2 * dx, "height": box["height"] + 2 * dy}


def _inset(page, outer: str, inner: str):
    """how far the desk's content starts from its window's edge, left and top"""
    return page.evaluate("""([o, i]) => { const a = document.querySelector(o), b = document.querySelector(i);
      if (!a || !b) return null; const r = a.getBoundingClientRect(), q = b.getBoundingClientRect();
      return {left: Math.round(q.left - r.left), right: Math.round(r.right - q.right)} }""", [outer, inner])


if __name__ == "__main__":
    raise SystemExit(main())
