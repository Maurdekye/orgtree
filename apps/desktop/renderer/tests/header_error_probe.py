"""header_error_probe.py — measure whether the header connectivity chip ever
shifts the canvas. Drives the REAL bundle against a live vite dev server
(`npm run dev -- --port 5199 --strictPort`), mocking the backend so the app
behaves deterministically.

Usage:
    python -B header_error_probe.py [--width 900] [--shot out.png]

Strategy: load the app with a mocked org, screenshot/measure the canvas
top-left position and the orgbar's bounding box with NO error present, then
flip the mocked tree-fetch route to fail so the app's own error state (the
`error` string set by `fetchErr`, requires ERROR_STREAK=2 consecutive
failures) turns on, wait for it to actually appear in the DOM, and re-measure
the exact same boxes. Asserts they are byte-identical. Also asserts with an
absurdly long message.
"""
from __future__ import annotations
import argparse
import json
import sys
from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

PORT = 5199
URL = f"http://localhost:{PORT}/o/mine"

TREE = {
    "slug": "mine", "name": "mine", "workspace": None, "dirs": [], "max_top_grant": 1000,
    "default_top_grant": 50, "compact_at": 0, "default_tools": None,
    "default_visibility": "team", "default_effort": "", "credit_requests": [],
    "tiers": {"haiku": 1, "sonnet": 3, "opus": 5, "fable": 10}, "audiences": [],
    "roots": [], "cost_usd_total": 0,
    "audit": {"live_nodes": 2, "top_level_holds": 0, "no_overdraft": True, "problems": []},
    "user_inbox_count": 0, "user_inbox_newest": None, "fable_lock": None,
    "spend_frozen": False, "storage_blocked": False, "auto_resume": False,
    "fable_limit_policy": "freeze", "fable_filter_policy": "halt",
    "cascade_hire": False, "cascade_alloc": True, "sandboxed": False,
    "audience_requests": [], "org_inbox": None, "net": None,
    "disk": None, "public": False, "headless": False,
}


def mk_node(nid):
    return {
        "id": nid, "title": nid, "tier": "haiku", "model_id": "haiku", "state": "live",
        "seat": 1, "grant": 0, "free": 0, "ui_order": 0, "cost_usd": 0, "occupancy": None,
        "context_window": None, "charter": None, "mail_pending": 0, "limit_locked": False,
        "last_status": None, "prev_status": None, "inflight_at": None, "last_denials": [],
        "turns": [], "frozen": None, "audiences_held": [], "bearer_state": None,
        "generation": 0, "children": [], "lineage": [],
        "scope": {"permission_mode": "default", "add_dirs": [], "tools": {}, "org_visibility": "team"},
    }


TREE["roots"] = [mk_node("ceo"), mk_node("cto"), mk_node("cfo")]

LONG_MESSAGE = (
    "failed to fetch: TypeError: NetworkError when attempting to fetch "
    "resource — the backend at http://127.0.0.1:8000 refused the connection "
    "after 3 retries, last seen healthy 42 seconds ago, giving up until the "
    "next scheduled poll in 6 seconds (this is a deliberately long message "
    "to prove truncation, not wrapping, is what happens to it)"
)


def measure(page):
    return page.evaluate(
        """() => {
            const bar = document.querySelector('.orgbar')
            const vp = document.querySelector('.viewport')
            const chip = document.querySelector('.conn-chip')
            const b = bar ? bar.getBoundingClientRect() : null
            const v = vp ? vp.getBoundingClientRect() : null
            return {
                barHeight: b ? b.height : null,
                barBottom: b ? b.bottom : null,
                vpTop: v ? v.top : null,
                vpHeight: v ? v.height : null,
                chipVisible: chip ? getComputedStyle(chip).display !== 'none' : false,
                chipText: chip ? chip.textContent : null,
                chipRect: chip ? chip.getBoundingClientRect() : null,
            }
        }"""
    )


def run(width: int, height: int, shot_prefix: str | None) -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": width, "height": height})

        state = {"fail": False, "message": "backend unreachable"}

        def fulfill_json(route, payload):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

        def org_route(route):
            if state["fail"]:
                route.fulfill(status=500, content_type="application/json",
                               body=json.dumps({"detail": state["message"]}))
            else:
                fulfill_json(route, TREE)

        page.route("**/api/**", lambda r: fulfill_json(r, {}))
        page.route("**/api/orgs", lambda r: fulfill_json(r, [{"slug": "mine", "name": "mine"}]))
        page.route("**/api/orgs/mine", org_route)
        page.route("**/api/orgs/mine/inbox", lambda r: fulfill_json(r, {"items": [], "count": 0}))
        page.route("**/api/orgs/mine/audiences", lambda r: fulfill_json(r, []))
        page.route("**/api/host", lambda r: fulfill_json(r, {"build": "test"}))
        page.route("**/api/defaults", lambda r: fulfill_json(r, {}))
        page.route("**/api/mcp-servers", lambda r: fulfill_json(r, []))
        page.route("**/api/charters", lambda r: fulfill_json(r, []))
        page.route("**/api/providers", lambda r: fulfill_json(r, {"providers": []}))
        page.route("**/api/usage*", lambda r: fulfill_json(r, {}))
        # kill the websocket path so ws-driven reconnect timers don't add
        # noise; the app already falls back to setInterval polling of
        # refreshTree, which is all this probe needs
        page.route("**/ws/**", lambda r: r.abort())

        page.on("pageerror", lambda e: print("[pageerror]", e))
        page.goto(URL)
        page.wait_for_selector(".orgbar", timeout=15000)
        page.wait_for_timeout(500)

        before = measure(page)
        print(f"[{width}px] before (no error):", before)
        assert before["chipVisible"] is False, "chip must be invisible with no error"
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}_{width}_before.png")

        # flip to failing responses and let TWO consecutive poll failures
        # accumulate (ERROR_STREAK=2, TREE_POLL_MS=6000) — plus the ws
        # connect() retry loop also calls refreshTree, so this lands fast
        state["fail"] = True
        state["message"] = "short"
        page.wait_for_function(
            "document.querySelector('.conn-chip') && "
            "getComputedStyle(document.querySelector('.conn-chip')).display !== 'none'",
            timeout=20000,
        )
        page.wait_for_timeout(200)
        after = measure(page)
        print(f"[{width}px] after (short error):", after)
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}_{width}_short.png")

        assert after["chipVisible"] is True
        assert after["barHeight"] == before["barHeight"], \
            f"orgbar height changed: {before['barHeight']} -> {after['barHeight']}"
        assert after["vpTop"] == before["vpTop"], \
            f"canvas top moved: {before['vpTop']} -> {after['vpTop']}"
        assert after["vpHeight"] == before["vpHeight"], \
            f"canvas height changed: {before['vpHeight']} -> {after['vpHeight']}"

        # now the long message — same assertions, plus confirm truncation
        # (rendered chip width must stay bounded, not grow/wrap the row)
        state["message"] = LONG_MESSAGE
        page.evaluate("window.dispatchEvent(new Event('__noop'))")  # no-op, just a barrier
        page.wait_for_timeout(6500)  # next poll cycle picks up the new message
        page.wait_for_function(
            "document.querySelector('.conn-chip')?.textContent?.includes('deliberately long')",
            timeout=20000,
        )
        long_state = measure(page)
        print(f"[{width}px] after (long error):", long_state)
        if shot_prefix:
            page.screenshot(path=f"{shot_prefix}_{width}_long.png")

        assert long_state["barHeight"] == before["barHeight"], \
            f"orgbar height changed with LONG message: {before['barHeight']} -> {long_state['barHeight']}"
        assert long_state["vpTop"] == before["vpTop"], \
            f"canvas top moved with LONG message: {before['vpTop']} -> {long_state['vpTop']}"
        assert long_state["vpHeight"] == before["vpHeight"], \
            f"canvas height changed with LONG message: {before['vpHeight']} -> {long_state['vpHeight']}"
        chip_w = long_state["chipRect"]["width"]
        assert chip_w < width, f"chip ({chip_w}px) not bounded at viewport width {width}px"

        # recover: errors clear, chip goes back to invisible, still no shift
        state["fail"] = False
        page.wait_for_function(
            "document.querySelector('.conn-chip') && "
            "getComputedStyle(document.querySelector('.conn-chip')).display === 'none'",
            timeout=20000,
        )
        page.wait_for_timeout(200)
        recovered = measure(page)
        print(f"[{width}px] after recovery:", recovered)
        assert recovered["barHeight"] == before["barHeight"]
        assert recovered["vpTop"] == before["vpTop"]

        browser.close()
        print(f"[{width}px] OK — no shift across empty -> short -> long -> recovered")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, action="append")
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--shot")
    args = ap.parse_args()
    widths = args.width or [900]
    for w in widths:
        rc = run(w, args.height, args.shot)
        if rc:
            return rc
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
