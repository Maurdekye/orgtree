"""pan_probe.py — the regression probe for the canvas-pan bug of 2026-09-03.

WHY THIS EXISTS, AND WHY IT IS NOT A jsdom TEST
-----------------------------------------------
The bug was: a background pan is also a native text-selection drag, so pan #1
left an invisible whole-canvas Range behind; pan #2's press landed inside that
Range, Chromium started a native drag of it, pointer capture was revoked, and
`pointercancel` nulled panRef about 10px into the gesture. Every later pan died
the same way. See the long comment on `.viewport`'s user-select rule in
styles.css for the full mechanism.

Two properties of that bug defeat a jsdom test *by construction*:
  * jsdom implements neither the selection model nor native drag-and-drop, so
    it cannot produce either half of the failure. Two jsdom suites passed green
    while the bug was live in front of the user.
  * The failure needs MORE THAN ONE GESTURE PER PAGE LOAD. A probe that does a
    single drag — which is what every earlier browser probe did — always sees
    the one pan that works.

So this drives a real browser (msedge) with real OS-level mouse events, and it
does FOUR CONSECUTIVE PANS, asserting camera travel on every one. Drag 1 alone
proves nothing; drags 2..N are the test.

USAGE
    # against the live app (real backend, real org — read-only, it only pans)
    python -B frontend/tests/pan_probe.py

    # against a scoped dev server serving a worktree
    npm run dev -- --port 5184 --strictPort
    python -B frontend/tests/pan_probe.py --url http://localhost:5184/o/orgtree

Exit code 0 = all gestures tracked. Non-zero = a gesture died; the printed
event log says which event ended it.
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
  if (!sp) return [null, null];
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(sp.style.transform);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
};
window.__ev = [];
for (const t of ['dragstart', 'pointercancel', 'lostpointercapture', 'selectstart']) {
  window.addEventListener(t, () => window.__ev.push(t), true);
}
// the invisible Range: toString() is '' for it, so length is NOT the signal —
// a non-collapsed range with a real bounding box is.
window.__selBox = () => {
  const s = document.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return null;
  const b = s.getRangeAt(0).getBoundingClientRect();
  return [Math.round(b.width), Math.round(b.height)];
};
"""

# one gesture: 9 steps of (+20,+10) => 270px of total camera travel if it tracks
STEPS, DX, DY = 9, 20, 10
EXPECT_TOTAL = (DX + DY) * STEPS          # 270
EXPECT_LATE = (DX + DY) * (STEPS - 5)     # 120 over the last four steps


def gesture(page, x, y):
    page.evaluate("window.__ev = []")
    c0 = page.evaluate("window.__cam()")
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(20)
    mids = []
    for k in range(1, STEPS + 1):
        page.mouse.move(x + DX * k, y + DY * k, steps=2)
        page.wait_for_timeout(28)
        mids.append(page.evaluate("window.__cam()"))
    page.mouse.up()
    page.wait_for_timeout(80)
    c1 = page.evaluate("window.__cam()")
    if c0[0] is None or c1[0] is None or mids[-1][0] is None:
        return None, None, page.evaluate("window.__ev")
    total = abs(c1[0] - c0[0]) + abs(c1[1] - c0[1])
    # the signature of THIS bug is a gesture that starts and then flatlines, so
    # assert the tail moved too — a total-only check passes on a dead gesture
    # that happened to get one big move in before the cancel.
    late = abs(mids[-1][0] - mids[4][0]) + abs(mids[-1][1] - mids[4][1])
    return total, late, page.evaluate("window.__ev")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7360/o/orgtree")
    ap.add_argument("--drags", type=int, default=4)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--shot")
    # a FOCUSED desk fills the viewport, so every pan then starts on desk
    # chrome and bubbles through .desk-over's guard (desk.tsx) instead of
    # landing on bare canvas. That is a different path to the same handler and
    # it regressed on its own once already — cover it too.
    ap.add_argument("--focus-first", action="store_true",
                    help="open a desk before panning, and pan from its chrome")
    args = ap.parse_args()

    failures = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="msedge", headless=not args.headed)
        page = b.new_page(viewport={"width": 1500, "height": 950})
        page.add_init_script(PROBE)
        page.goto(args.url)
        try:
            page.wait_for_selector(".viewport", timeout=20000)
        except Exception as e:
            print("FAIL: no .viewport —", e)
            b.close()
            return 2
        page.wait_for_timeout(4000)          # let the intro glide settle
        cards = page.evaluate("() => document.querySelectorAll('.sq').length")
        print(f"url={args.url}  cards={cards}")

        box = page.query_selector(".viewport").bounding_box()
        cx, cy = box["x"] + box["width"] * .5, box["y"] + box["height"] * .5

        if args.focus_first:
            card = page.query_selector(".sq:not(.user)")
            if not card:
                print("FAIL: no agent card to focus")
                b.close()
                return 2
            cb = card.bounding_box()
            page.mouse.click(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2)
            page.wait_for_timeout(2500)      # centerOn glide + desk mount
            over = page.query_selector(".desk-over")
            print(f"  focused a desk: .desk-over mounted={bool(over)}")
            if over:
                ob = over.bounding_box()
                # press on the desk's own chrome — just inside its top edge,
                # which is not a control and not .msgs
                cx, cy = ob["x"] + ob["width"] * .5, ob["y"] + 6

        for i in range(args.drags):
            total, late, ev = gesture(page, cx + i * 12, cy + i * 9)
            selbox = page.evaluate("window.__selBox()")
            if total is None:
                ok = False
                detail = "no camera transform to read"
            else:
                ok = total >= EXPECT_TOTAL * .9 and late >= EXPECT_LATE * .9
                detail = (f"travel={total:.0f}px (want >={EXPECT_TOTAL * .9:.0f}) "
                          f"tail={late:.0f}px (want >={EXPECT_LATE * .9:.0f})")
            print(f"  pan {i + 1}: {'ok  ' if ok else 'DEAD'}  {detail}\n"
                  f"          events={ev} selection={selbox}")
            if not ok:
                failures.append(f"pan {i + 1}: {detail}; events={ev}")
            # a Range left on the canvas IS the bug, even if this gesture
            # happened to survive it — fail loudly rather than wait for the
            # next gesture to be the unlucky one.
            if selbox and selbox[0] > 400:
                failures.append(f"pan {i + 1} left a {selbox[0]}x{selbox[1]}px "
                                f"selection on the canvas")

        if args.shot:
            page.screenshot(path=args.shot)
        b.close()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print(f"\nPASS: {args.drags} consecutive pans all tracked, no canvas selection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
