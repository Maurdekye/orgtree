"""pin_probe.py — FR-3 pinned desk windows: drive a REAL browser (msedge via
playwright) and do what the jsdom suite (pins.test.tsx) cannot:

  1. focus a desk, click its pin button, and read the pinned window's box
  2. PAN the canvas four times in a row from bare canvas (the invisible-Range
     pan-killer needs consecutive gestures — see pan_probe.py) and assert the
     window's box did not move while the camera did
  3. wheel-zoom over bare canvas: window still put
  4. drag the window by its title bar: box moves 1:1 with the mouse
  5. wheel over the pinned window: camera does NOT change
  6. select text inside the window (the user-select re-enable), then pan
     again — the pan must still track (the two-list rule)
  7. screenshot

Read-only against the backend: pinning is client-only localStorage state in
this throwaway browser context; the page only GETs.

USAGE
    # against the live app
    python -B frontend/tests/pin_probe.py --url http://127.0.0.1:7360/o/<slug>
    # against a scoped dev server serving a worktree
    npm run dev -- --port 5187 --strictPort
    python -B frontend/tests/pin_probe.py --url http://localhost:5187/o/<slug> --shot out.png
"""
from __future__ import annotations
import argparse
import sys
from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

PROBE = r"""
window.__cam = () => {
  const sp = document.querySelector('.space');
  if (!sp) return null;
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/.exec(sp.style.transform);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
window.__win = () => {
  const w = document.querySelector('.pinwin');
  if (!w) return null;
  const r = w.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};
window.__ev = [];
for (const t of ['dragstart', 'pointercancel', 'selectstart']) {
  window.addEventListener(t, () => window.__ev.push(t), true);
}
window.__selBox = () => {
  const s = document.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return null;
  const b = s.getRangeAt(0).getBoundingClientRect();
  return [Math.round(b.width), Math.round(b.height)];
};
"""

STEPS, DX, DY = 9, 20, 10
EXPECT_TOTAL = (DX + DY) * STEPS


def pan(page, x, y):
    c0 = page.evaluate("window.__cam()")
    w0 = page.evaluate("window.__win()")
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(20)
    for k in range(1, STEPS + 1):
        page.mouse.move(x + DX * k, y + DY * k, steps=2)
        page.wait_for_timeout(28)
    page.mouse.up()
    page.wait_for_timeout(80)
    c1 = page.evaluate("window.__cam()")
    w1 = page.evaluate("window.__win()")
    travel = abs(c1[0] - c0[0]) + abs(c1[1] - c0[1])
    return travel, w0, w1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5187/o/unity")
    ap.add_argument("--shot", default=None)
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    fails: list[str] = []

    def check(ok: bool, msg: str):
        print(("  ok   " if ok else "  FAIL ") + msg)
        if not ok:
            fails.append(msg)

    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="msedge", headless=not args.headed)
        page = b.new_page(viewport={"width": 1500, "height": 950})
        page.add_init_script(PROBE)
        page.goto(args.url)
        page.wait_for_selector(".viewport", timeout=20000)
        page.wait_for_timeout(4000)
        cards = page.evaluate("() => document.querySelectorAll('.sq:not(.user)').length")
        print(f"url={args.url} agent cards={cards}")

        # 1. focus a desk and pin it
        card = page.query_selector(".sq:not(.user)")
        cb = card.bounding_box()
        page.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2)
        page.wait_for_timeout(2500)
        check(bool(page.query_selector(".desk-over")), "a desk focused on the canvas")
        pin_btn = page.query_selector(".desk-over .cc-pin")
        check(bool(pin_btn), "the desk header shows the pin button")
        # the window takes the CARD's footprint (border included); .desk-over
        # is inset inside the card, so measure the card
        desk_box = page.query_selector(".sq.desk").bounding_box()
        pin_btn.click()
        page.wait_for_timeout(600)
        w = page.evaluate("window.__win()")
        check(w is not None, f"a .pinwin exists after the click: {w}")
        check(page.query_selector(".desk-over") is None, "the canvas desk is gone (one live desk)")
        check(bool(page.query_selector(".pin-placeholder")), "the card shows the placeholder")
        check(abs(w[0] - desk_box["x"]) < 6 and abs(w[1] - desk_box["y"]) < 6,
              f"the window sits where the card was (window {w[:2]} vs desk "
              f"{[round(desk_box['x']), round(desk_box['y'])]})")
        n_desks = page.evaluate("() => document.querySelectorAll('.desk-body').length")
        check(n_desks == 1, f"exactly one desk body in the page: {n_desks}")

        # 2. four consecutive pans from bare canvas — find a bare spot: the
        # viewport's bottom-right corner area, away from the window and HUD
        vp = page.query_selector(".viewport").bounding_box()
        # the pinned window may cover the middle; pan from just inside the
        # right edge, upper area
        px, py = vp["x"] + vp["width"] - 120, vp["y"] + 80
        under = page.evaluate(f"() => document.elementFromPoint({px}, {py})?.className")
        print(f"  pan start element: {under!r}")
        for i in range(4):
            travel, w0, w1 = pan(page, px - i * 12, py + i * 9)
            check(travel >= EXPECT_TOTAL * 0.9,
                  f"pan {i + 1} tracked: camera travel {travel:.0f}px (want >= {EXPECT_TOTAL * .9:.0f})")
            check(w0 == w1, f"pan {i + 1}: the window stayed put {w0} -> {w1}")
        sel = page.evaluate("window.__selBox()")
        check(not (sel and sel[0] > 400), f"no canvas-wide selection left behind: {sel}")

        # 3. wheel zoom over bare canvas
        c0 = page.evaluate("window.__cam()"); w0 = page.evaluate("window.__win()")
        page.mouse.move(px, py)
        page.mouse.wheel(0, 600)
        page.wait_for_timeout(300)
        c1 = page.evaluate("window.__cam()"); w1 = page.evaluate("window.__win()")
        check(c1[2] < c0[2], f"wheel on bare canvas zoomed out: z {c0[2]:.2f} -> {c1[2]:.2f}")
        check(w0 == w1, f"zoom: the window stayed put {w0} -> {w1}")

        # 4. drag the window by its title bar
        title = page.query_selector(".pinwin-title").bounding_box()
        tx, ty = title["x"] + 40, title["y"] + title["height"] / 2
        c0 = page.evaluate("window.__cam()"); w0 = page.evaluate("window.__win()")
        page.mouse.move(tx, ty); page.mouse.down()
        page.mouse.move(tx - 150, ty + 60, steps=8)
        page.mouse.up(); page.wait_for_timeout(200)
        c1 = page.evaluate("window.__cam()"); w1 = page.evaluate("window.__win()")
        check(abs((w1[0] - w0[0]) + 150) <= 2 and abs((w1[1] - w0[1]) - 60) <= 2,
              f"title drag moved the window 1:1: {w0[:2]} -> {w1[:2]} (want -150,+60)")
        check(c0 == c1, "title drag did not pan the canvas")
        stored = page.evaluate("() => localStorage.getItem('orgtree-pins-' + location.pathname.split('/')[2])")
        check(stored is not None and '"rect"' in stored, f"persisted: {stored[:120] if stored else None}")

        # 5. wheel over the pinned window
        wb = page.query_selector(".pinwin-body").bounding_box()
        page.mouse.move(wb["x"] + wb["width"] / 2, wb["y"] + wb["height"] / 2)
        c0 = page.evaluate("window.__cam()")
        page.mouse.wheel(0, 600); page.wait_for_timeout(300)
        c1 = page.evaluate("window.__cam()")
        check(c0 == c1, f"wheel over the window did not zoom the canvas: {c0} == {c1}")

        # 6. select text inside the window, then pan the canvas again
        name = page.query_selector(".pinwin .cc-name")
        nb = name.bounding_box()
        page.mouse.move(nb["x"] + 2, nb["y"] + nb["height"] / 2); page.mouse.down()
        page.mouse.move(nb["x"] + nb["width"] - 2, nb["y"] + nb["height"] / 2, steps=4)
        page.mouse.up(); page.wait_for_timeout(100)
        seltxt = page.evaluate("() => document.getSelection()?.toString() ?? ''")
        check(len(seltxt) > 0, f"text inside the window is selectable: {seltxt!r}")
        travel, w0, w1 = pan(page, px, py)
        check(travel >= EXPECT_TOTAL * 0.9, f"pan after a selection still tracks: {travel:.0f}px")
        check(w0 == w1, f"and the window stayed put {w0} -> {w1}")

        # 7. reload: the window comes back at the same place
        w_before = page.evaluate("window.__win()")
        page.reload(); page.wait_for_selector(".viewport", timeout=20000); page.wait_for_timeout(4000)
        w_after = page.evaluate("window.__win()")
        check(w_after == w_before, f"after reload the window is back where it was: {w_before} -> {w_after}")
        c = page.evaluate("window.__cam()")
        print(f"  camera after reload: {c}")

        if args.shot:
            page.screenshot(path=args.shot)
            print(f"  screenshot -> {args.shot}")

        # 8. unpin: the window goes away and the ghost flies
        page.query_selector(".pinwin-unpin").click()
        page.wait_for_timeout(50)
        ghost = page.query_selector(".pinwin-ghost")
        check(ghost is not None, "unpin: a minimise ghost is flying")
        page.wait_for_timeout(500)
        check(page.query_selector(".pinwin") is None, "unpin: the window is gone")
        check(page.query_selector(".pinwin-ghost") is None, "unpin: the ghost is gone")
        stored = page.evaluate("() => localStorage.getItem('orgtree-pins-' + location.pathname.split('/')[2])")
        check(stored is None, f"unpin: storage cleared: {stored}")
        b.close()

    if fails:
        print("\nFAIL:")
        for f in fails:
            print("  -", f)
        return 1
    print("\nPASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
