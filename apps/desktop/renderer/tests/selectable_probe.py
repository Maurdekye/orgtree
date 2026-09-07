"""selectable_probe.py — the other half of pan_probe.py.

pan_probe asserts that a canvas pan leaves NO text selection behind. The cure
for that is `user-select: none` on `.viewport` (styles.css), and the obvious
way to get that wrong is to kill selection everywhere and quietly cost the user
the ability to copy a message out of a desk. This probe asserts the opposite
direction: text that SHOULD be selectable still is.

It opens a real desk on the real app and drags across the message text, then
checks the selection actually contains characters.

    python -B frontend/tests/selectable_probe.py --url http://localhost:5184/o/orgtree

Read-only: it focuses a node and drags over text. It clicks no controls.
Exit 0 = selectable. Non-zero = a regression in the re-enable list.
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7360/o/orgtree")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--shot")
    args = ap.parse_args()

    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="msedge", headless=not args.headed)
        page = b.new_page(viewport={"width": 1500, "height": 950})
        page.goto(args.url)
        page.wait_for_selector(".viewport", timeout=20000)
        page.wait_for_timeout(4000)

        # open a desk: click a card, which glides the camera in past Z_DESK
        card = page.query_selector(".sq:not(.user)")
        if not card:
            print("FAIL: no agent card on the canvas to open")
            b.close()
            return 2
        bb = card.bounding_box()
        page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
        page.wait_for_timeout(2500)          # centerOn glide + desk mount

        facts = page.evaluate("""() => {
          const vp = document.querySelector('.viewport');
          const inVp = (s) => { const e = document.querySelector(s);
                                return e ? !!(vp && vp.contains(e)) : null };
          const cs = (s) => { const e = document.querySelector(s);
                              return e ? getComputedStyle(e).userSelect : null };
          return {deskInViewport: inVp('.desk-over'), msgsInViewport: inVp('.msgs'),
                  viewportUserSelect: cs('.viewport'), deskUserSelect: cs('.desk-over'),
                  msgsUserSelect: cs('.msgs')};
        }""")
        print("  DOM/CSS facts:", facts)

        target = page.query_selector(".msgs")
        label = ".msgs"
        if not target:
            print("  no .msgs on this desk; falling back to any desk text")
            target = page.query_selector(".desk-inner")
            label = ".desk-inner"
        if not target:
            print("FAIL: no desk content mounted to test against")
            if args.shot:
                page.screenshot(path=args.shot)
            b.close()
            return 2

        tb = target.bounding_box()
        if not tb or tb["width"] < 20 or tb["height"] < 10:
            print(f"FAIL: {label} has no layout box: {tb}")
            b.close()
            return 2

        # drag across a line of the message body
        y = tb["y"] + min(30, tb["height"] / 2)
        page.mouse.move(tb["x"] + 8, y)
        page.mouse.down()
        for k in range(1, 7):
            page.mouse.move(tb["x"] + 8 + (tb["width"] - 20) * k / 6, y, steps=2)
            page.wait_for_timeout(20)
        page.mouse.up()
        page.wait_for_timeout(120)

        got = page.evaluate("() => (document.getSelection()||{toString:()=>''}).toString()")
        print(f"  dragged across {label}: selected {len(got)} chars -> {got[:80]!r}")
        if args.shot:
            page.screenshot(path=args.shot)
        b.close()

    if len(got.strip()) == 0:
        print("\nFAIL: desk text is no longer selectable — the user cannot copy "
              "a message. Check the user-select re-enable list in styles.css.")
        return 1
    print("\nPASS: desk message text is still selectable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
