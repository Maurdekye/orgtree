"""Double-clicking a docket row copies its slug — driven in a real browser.

    node tests/copyslug-build.mjs && python -B tests/copyslug_probe.py

Five planted mutations, each caught by a different check — run any of them
with `--expect-fail`, which REFUSES to report success unless something fails:

    eager-copied      the bubble appears before the write resolves
    copy-rendered     the row's rendered text is copied instead of the slug
    no-control-guard  embedded controls copy too
    flat-top          the bubble ignores the click's Y
    no-ticket         a repeat at the same point does not replay the animation

WHY A BROWSER AND NOT A DOM TEST. The three things the user asked for are all
browser facts: the real clipboard actually holds the slug, the confirmation
appears only after the asynchronous write RESOLVES, and it appears where the
pointer was. jsdom has no clipboard, no layout and no double-click default
behaviour, so a passing DOM test would say nothing about any of them.

What it drives is the production `<DocketModal/>` (tests/copyslug-fixture.tsx)
against the production `styles.css`, with real `dblclick` from Playwright's
mouse and the clipboard read back through the browser's own API.

Checks:
  1. a double-click on a row puts the EXACT slug on the clipboard
  2. "Copied!" appears, sits within the row, and is near the pointer both
     horizontally and vertically — not pinned to a corner or to the row's edge
  3. it goes away on its own, and a repeat at the SAME point restarts both its
     lifetime and its animation rather than showing a half-faded message
  4. a double-click on an EMBEDDED CONTROL (the dismiss badge, the fold arrow)
     copies nothing and shows nothing
  5. a single click still selects the row and copies nothing
  6. TRUTHFULNESS: when the clipboard write REJECTS, no "Copied!" is shown
"""
from __future__ import annotations

import argparse
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parents[1] / "node_modules/.orgtree-copyslug"
SLUG = "copy-me-exactly"


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(
                b'<!doctype html><link rel="stylesheet" href="/copyslug-fixture.css">'
                b'<div id="root"></div>'
                b'<script type="module" src="/copyslug-fixture.js"></script>')
        else:
            super().do_GET()


def row(page, slug: str):
    return page.locator(f".docket-row:has(.docket-rowname:text-is('{slug}'))")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-fail", action="store_true",
                        help="a planted mutation must be caught")
    args = parser.parse_args()
    if not (OUT / "copyslug-fixture.js").is_file():
        print("INERT: build the fixture first (node tests/copyslug-build.mjs)")
        return 2

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(OUT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failures: list[str] = []
    errors: list[str] = []
    try:
        with sync_playwright() as play:
            browser = play.chromium.launch(channel="msedge")
            context = browser.new_context(viewport={"width": 1400, "height": 1000})
            # 127.0.0.1 is a secure context, so the real clipboard is usable
            context.grant_permissions(["clipboard-read", "clipboard-write"])
            context.set_default_timeout(7000)
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{server.server_port}")
            page.locator(".docket-modal .docket-row").first.wait_for()
            # The same production DocketModal can be adopted into a native
            # popout. Give the child document a private clipboard spy and
            # leave the opener's clipboard at a sentinel: this catches the
            # tempting regression that reads module-level navigator instead
            # of the row's ownerDocument navigator.
            page.evaluate("navigator.clipboard.writeText('POPout-MAIN-SENTINEL')")
            with page.expect_popup() as popup_info:
                page.locator(".docket-modal .popout-button").click()
            popup = popup_info.value
            popup.locator(".docket-row").first.wait_for()
            popup.evaluate("""() => {
              window.__childCopy = '';
              navigator.clipboard.writeText = (value) => {
                window.__childCopy = value;
                return Promise.resolve();
              };
            }""")
            popup_target = row(popup, SLUG)
            popup_box = popup_target.bounding_box()
            popup.mouse.dblclick(popup_box["x"] + popup_box["width"] * 0.75,
                                 popup_box["y"] + popup_box["height"] / 2)
            popup_target.locator(".docket-copied").wait_for(state="visible", timeout=2500)
            child_copy = popup.evaluate("window.__childCopy")
            opener_clip = page.evaluate("navigator.clipboard.readText()")
            if child_copy != SLUG:
                failures.append(f"popped-out row did not use its child clipboard: {child_copy!r}")
            if opener_clip != "POPout-MAIN-SENTINEL":
                failures.append(f"popped-out copy touched the opener clipboard: {opener_clip!r}")
            popup.close()
            page.wait_for_timeout(250)
            if page.locator(".docket-modal .docket-row").count() == 0:
                failures.append("closing the docket popout did not return the mounted row")
            page.evaluate("navigator.clipboard.writeText('SENTINEL-NOT-COPIED')")

            # ── 1 and 2: the copy, and where the confirmation lands ────────
            target = row(page, SLUG)
            box = target.bounding_box()
            # click near the RIGHT of the row, so "near the pointer" cannot be
            # satisfied by a bubble that is simply always at the left edge
            at_x = box["x"] + box["width"] * 0.75
            at_y = box["y"] + box["height"] / 2
            page.mouse.dblclick(at_x, at_y)
            bubble = target.locator(".docket-copied")
            try:
                bubble.wait_for(state="visible", timeout=2500)
                shown = True
            except Exception:                                    # noqa: BLE001
                shown = False
            clip = page.evaluate("navigator.clipboard.readText()")
            if clip != SLUG:
                failures.append(f"clipboard holds {clip!r}, expected the exact slug {SLUG!r}")
            if not shown:
                failures.append("no Copied! appeared after a successful copy")
            else:
                bb = bubble.bounding_box()
                centre = bb["x"] + bb["width"] / 2
                if not (box["x"] <= centre <= box["x"] + box["width"]):
                    failures.append(f"Copied! centre {centre:.0f} is outside the row")
                if abs(centre - at_x) > box["width"] * 0.2:
                    failures.append(
                        f"Copied! centre {centre:.0f} is not near the pointer {at_x:.0f}")
                # 3: it is transient
                try:
                    bubble.wait_for(state="detached", timeout=3000)
                except Exception:                                # noqa: BLE001
                    failures.append("Copied! never went away")

            # ── 2b: the bubble follows the click's Y, not just its X ───────
            # Two copies on the SAME row at different heights must put the
            # bubble at different heights. A bubble pinned to the row's top
            # edge passes every check above and fails this one — which is
            # exactly what the first cut of this feature did (root review
            # 2026-09-07 16:32Z).
            def bubble_bottom(fy: float) -> float | None:
                page.mouse.dblclick(box["x"] + box["width"] * 0.5,
                                    box["y"] + box["height"] * fy)
                try:
                    target.locator(".docket-copied").wait_for(state="visible", timeout=2500)
                except Exception:                                # noqa: BLE001
                    return None
                bb = target.locator(".docket-copied").bounding_box()
                page.wait_for_timeout(1100)                      # let it clear
                return None if bb is None else bb["y"] + bb["height"]

            high = bubble_bottom(0.15)
            low = bubble_bottom(0.85)
            if high is None or low is None:
                failures.append("the Copied! bubble did not appear for the vertical control")
            elif low - high < box["height"] * 0.3:
                failures.append(
                    f"Copied! does not follow the click's Y: clicking near the row's bottom put it "
                    f"at {low:.0f} and near the top at {high:.0f}, a difference of {low - high:.0f}px "
                    f"in a {box['height']:.0f}px row")

            # ── 2c: a second copy AT THE SAME POINT restarts the message ───
            # The first cut stored the position as a bare number, so a repeat
            # at the same pixel set an IDENTICAL state: React bailed out, the
            # timer never restarted and the animation never replayed, so the
            # second copy showed nothing and the first timer swallowed it.
            page.mouse.dblclick(at_x, at_y)
            target.locator(".docket-copied").wait_for(state="visible", timeout=2500)
            page.wait_for_timeout(600)
            page.mouse.dblclick(at_x, at_y)                      # same pixel
            page.wait_for_timeout(450)   # now past the FIRST copy's 900ms life
            if not target.locator(".docket-copied").count():
                failures.append(
                    "a second copy at the same point did not restart Copied! - it vanished on the "
                    "first copy's timer")
            page.wait_for_timeout(1100)

            # ── 2d: and the MESSAGE ITSELF restarts, not just its lifetime ──
            # The timer restart above survives a frozen key (the state is a new
            # object either way), so it does not prove the bubble was redrawn.
            # This reads the element's OWN animation clock: after a repeat the
            # animation must be near its beginning, not still running from the
            # first copy, or the second Copied! appears already half-faded.
            page.mouse.dblclick(at_x, at_y)
            target.locator(".docket-copied").wait_for(state="visible", timeout=2500)
            page.wait_for_timeout(600)
            page.mouse.dblclick(at_x, at_y)
            page.wait_for_timeout(60)
            clock = page.evaluate(
                "() => { const el = document.querySelector('.docket-copied');"
                " const a = el && el.getAnimations ? el.getAnimations()[0] : null;"
                " return a ? Number(a.currentTime) : null }")
            if clock is None:
                failures.append("could not read the Copied! animation clock (no animation?)")
            elif clock > 300:
                failures.append(
                    f"the repeated Copied! did not restart its animation: it is {clock:.0f}ms in, "
                    "so the second copy shows a message already fading from the first")
            page.wait_for_timeout(1100)

            # ── 4: embedded controls own their own double-click ────────────
            page.evaluate("navigator.clipboard.writeText('SENTINEL-NOT-COPIED')")
            for slug, control in (("flagged-row", ".docket-dismiss"),
                                  ("parent-row", ".docket-fold")):
                holder = row(page, slug)
                el = holder.locator(control).first
                if el.count() == 0:
                    failures.append(f"INERT: {slug} has no {control} to double-click")
                    continue
                el.dblclick()
                page.wait_for_timeout(250)
                clip = page.evaluate("navigator.clipboard.readText()")
                if clip != "SENTINEL-NOT-COPIED":
                    failures.append(f"a double-click on {control} copied {clip!r}")
                if holder.locator(".docket-copied").count():
                    failures.append(f"a double-click on {control} showed Copied!")

            # ── 5: a single click still selects, and copies nothing ────────
            page.evaluate("navigator.clipboard.writeText('SENTINEL-NOT-COPIED')")
            target.click()
            page.wait_for_timeout(250)
            if "on" not in (target.get_attribute("class") or ""):
                failures.append("a single click no longer selects the row")
            clip = page.evaluate("navigator.clipboard.readText()")
            if clip != "SENTINEL-NOT-COPIED":
                failures.append(f"a single click copied {clip!r}")
            if target.locator(".docket-copied").count():
                failures.append("a single click showed Copied!")

            # ── 6: a REJECTED write must say nothing ───────────────────────
            # `void`, or playwright serialises the assignment's value - the
            # rejecting function itself - and reports its rejection as ours
            page.evaluate(
                "void (navigator.clipboard.writeText ="
                " () => Promise.reject(new Error('denied')))")
            page.mouse.dblclick(at_x, at_y)
            page.wait_for_timeout(600)
            if target.locator(".docket-copied").count():
                failures.append("Copied! appeared although the clipboard write REJECTED")

            browser.close()
    finally:
        server.shutdown()

    if errors:
        failures.append(f"page errors: {errors[:2]}")
    if args.expect_fail:
        if not failures:
            print("NEGATIVE CONTROL FAILED: the planted mutation was NOT caught")
            return 1
        print(f"NEGATIVE CONTROL PASSED: {len(failures)} check(s) caught it")
        for f in failures:
            print("  -", f)
        return 0
    if failures:
        print("FAILURES:")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS - 10 browser checks: main and popped-out rows use their owning document clipboard; "
          "Copied! appears inside the row, near the pointer horizontally AND "
          "vertically, and clears itself; a second copy at the same point "
          "restarts it and replays its animation; embedded controls and single "
          "clicks copy nothing; a "
          "rejected write shows nothing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
