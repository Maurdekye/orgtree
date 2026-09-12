"""Real-browser input-to-paint latency for the Desk transcript.

WHAT THE USER REPORTED (2026-09-12): typed text appears seconds after the key;
visible state changes lag several seconds; at worst the UI showed nothing new
for 20-30 seconds while CSS animations kept running. Animations continuing
through a text freeze means the compositor was alive and the renderer's MAIN
THREAD was not, so the quantity to measure is the cost of one re-render of the
transcript list.

A keystroke is exactly that re-render: `desk.tsx` keeps the composer's `text`
state in the same component that maps the transcript rows, so every character
re-renders every row. This probe types real keys into a real composer beside the
real `Msg` rows and reports, per keystroke, the delay until the frame that shows
the character.

Run with `--tree <path>` to point at another checkout; the same probe source is
built against v2.0.9 and against the fix branch, and the two reports are
compared. `--json <file>` writes the raw numbers for the docket.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import statistics
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

# The workloads. Sizes come from the live coordinator Desk this regression was
# reported on: ordinary agent mail runs a few kB, and a single `orgtree_work
# list` reply was ~700k tokens of JSON.
WORKLOADS: dict[str, dict] = {
    # the default window: convo.ts renders CHAT_WINDOW = 8 rows
    "window8": {"rows": [
        {"kind": "assistant", "bytes": 3000},
        {"kind": "mail", "bytes": 4000},
        {"kind": "assistant", "bytes": 2000},
        {"kind": "tool", "bytes": 20000},
        {"kind": "mail", "bytes": 6000},
        {"kind": "assistant", "bytes": 3000},
        {"kind": "mail", "bytes": 2000},
        {"kind": "assistant", "bytes": 1500},
    ]},
    # a scrolled-back Desk: `loadOlder` grows `win` well past CHAT_WINDOW
    "window40": {"rows": [
        {"kind": k, "bytes": b}
        for _ in range(10)
        for k, b in (("assistant", 3000), ("mail", 4000), ("tool", 20000), ("mail", 6000))
    ]},
    # ONE giant received mail, the ~700k-token event the coordinator saw
    "giantmail": {"rows": [
        {"kind": "assistant", "bytes": 3000},
        {"kind": "mail", "bytes": 2_800_000},
        {"kind": "assistant", "bytes": 3000},
    ]},
    # the same volume as a COLLAPSED tool result, which is how a big tool reply
    # is supposed to arrive — the control for the giant-mail case
    "gianttool": {"rows": [
        {"kind": "assistant", "bytes": 3000},
        {"kind": "tool", "bytes": 2_800_000},
        {"kind": "assistant", "bytes": 3000},
    ]},
    # WHAT THE USER ACTUALLY SAT IN FRONT OF: a Desk that has accumulated
    # several large forwarded mail bodies rather than one record-breaking one.
    # This is the workload that reaches the reported 20-30 second freeze.
    "manylarge": {"rows": [
        {"kind": k, "bytes": b}
        for _ in range(8)
        for k, b in (("mail", 700_000), ("assistant", 3000))
    ]},
}

KEYSTROKES = 8

# THE CONTRACT THIS PROBE ENFORCES.
#
# A keystroke in the composer re-renders every transcript row. Re-measuring a
# fold costs a `Range.getClientRects()` query per text node, so the only safe
# number of rect queries caused by typing a character that changed no message
# body is ZERO. On the unfixed path one 2.8 MB forwarded mail body produced
# 55,440 of them per keystroke and eight 700 KB bodies produced 111,676 — which
# is the defect, stated as a number rather than as a duration that would move
# with the machine.
MAX_RECTS_PER_KEYSTROKE = 0
# A generous ceiling on the duration, kept only so a future defect that blocks
# the thread some OTHER way is still caught. The measured value after the fix is
# ~13 ms on the worst workload; the bound is loose because a loaded machine is
# allowed to be slower without failing the suite.
MAX_KEYSTROKE_MS = 120


def build(tree: pathlib.Path, out: pathlib.Path) -> None:
    script = tree / "apps" / "desktop" / "renderer" / "tests" / "desklag-build.mjs"
    if not script.exists():
        raise SystemExit(f"no desklag-build.mjs in {tree} — copy the probe there first")
    subprocess.run(["node", str(script), str(out)], cwd=tree, check=True, shell=False)


def measure(page, name: str, spec: dict) -> dict:
    mount = page.evaluate("spec => window.__desklag.mount(spec)", spec)
    page.evaluate("() => window.__desklag.reset()")
    box = page.locator("#composer")
    box.click()
    # Real keys, one at a time, each given room to settle: what is being measured
    # is the delay of a single character, not the throughput of a paste.
    for i in range(KEYSTROKES):
        box.press("a")
        page.wait_for_timeout(120)
    report = page.evaluate("() => window.__desklag.report()")
    latencies = [s["latency"] for s in report["strokes"]]
    return {
        "workload": name,
        "mount_ms": round(mount["mountMs"], 1),
        "mount_rect_calls": mount["rectCalls"],
        "mount_rect_ms": round(mount["rectMs"], 1),
        "dom_nodes": mount["nodes"],
        "keystrokes": len(latencies),
        "latency_ms_median": round(statistics.median(latencies), 1) if latencies else None,
        "latency_ms_max": round(max(latencies), 1) if latencies else None,
        "latency_ms_all": [round(v, 1) for v in latencies],
        "rect_calls_per_keystroke": round(
            statistics.median([s["rectCalls"] for s in report["strokes"]]), 1) if latencies else None,
        "rect_ms_per_keystroke": round(
            statistics.median([s["rectMs"] for s in report["strokes"]]), 1) if latencies else None,
        "long_tasks": [round(v) for v in report["longTasks"]],
        "long_task_total_ms": round(report["longTaskTotal"]),
    }


def remeasure_check(page) -> list[str]:
    """A content change must still re-fold.

    The fix stops re-measuring on every render and drives the measurement from a
    ResizeObserver plus a MutationObserver instead. That is only correct if a
    real change to a body is still noticed, so this grows a SHORT mail body into
    a long one and requires the fold control to appear with the right count, then
    shrinks it back and requires the control to go away again. It fails if the
    observers are removed, and it fails if `children` is restored as the trigger
    and then the observers are dropped as redundant.
    """
    spec = {"rows": [{"kind": "mail", "bytes": 120}]}
    page.evaluate("spec => window.__desklag.mount(spec)", spec)
    fails: list[str] = []
    before = page.evaluate("() => window.__desklag.folds()")
    if not before or before[0]["expandable"]:
        fails.append(f"a 120-character mail body should need no fold control: {before}")
    page.evaluate("() => window.__desklag.grow(0, 40000)")
    page.wait_for_timeout(400)
    after = page.evaluate("() => window.__desklag.folds()")
    if not after or not after[0]["expandable"] or not after[0]["folded"]:
        fails.append(f"a body grown to 40 kB was not re-measured — the fold never appeared: {after}")
    elif not (after[0]["label"] or "").startswith("click to expand"):
        fails.append(f"the re-measured fold has no expand label: {after}")
    page.evaluate("() => window.__desklag.grow(0, 120)")
    page.wait_for_timeout(400)
    back = page.evaluate("() => window.__desklag.folds()")
    if back and back[0]["expandable"]:
        fails.append(f"a body shrunk back to 120 characters kept its fold control: {back}")
    return fails


def run(tree: pathlib.Path, workloads: list[str], assertive: bool) -> tuple[list[dict], list[str]]:
    results, fails = [], []
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "probe"
        build(tree, out)
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge")
            try:
                for name in workloads:
                    page = browser.new_page(viewport={"width": 1280, "height": 900})
                    page.goto((out / "probe.html").as_uri())
                    page.wait_for_function("() => !!window.__desklag")
                    record = measure(page, name, WORKLOADS[name])
                    results.append(record)
                    if assertive:
                        rects = record["rect_calls_per_keystroke"] or 0
                        if rects > MAX_RECTS_PER_KEYSTROKE:
                            fails.append(
                                f"{name}: typing one character caused {rects:,.0f} layout rect "
                                f"queries (allowed {MAX_RECTS_PER_KEYSTROKE}) — the transcript is "
                                f"re-measuring bodies that did not change")
                        if (record["latency_ms_median"] or 0) > MAX_KEYSTROKE_MS:
                            fails.append(
                                f"{name}: median keystroke latency {record['latency_ms_median']} ms "
                                f"exceeds {MAX_KEYSTROKE_MS} ms")
                    page.close()
                if assertive:
                    page = browser.new_page(viewport={"width": 1280, "height": 900})
                    page.goto((out / "probe.html").as_uri())
                    page.wait_for_function("() => !!window.__desklag")
                    fails += remeasure_check(page)
                    page.close()
            finally:
                browser.close()
    return results, fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=str(HERE.parent.parent.parent.parent))
    ap.add_argument("--label", default="")
    ap.add_argument("--workloads", default=",".join(WORKLOADS))
    ap.add_argument("--json", default="")
    ap.add_argument("--report-only", action="store_true",
                    help="measure without enforcing the contract (for baselines)")
    args = ap.parse_args()
    tree = pathlib.Path(args.tree).resolve()
    names = [w for w in args.workloads.split(",") if w]
    for n in names:
        if n not in WORKLOADS:
            raise SystemExit(f"unknown workload {n}; have {', '.join(WORKLOADS)}")
    results, fails = run(tree, names, assertive=not args.report_only)
    label = args.label or tree.name
    print(f"\n=== {label} :: {tree} ===")
    for r in results:
        print(f"{r['workload']:>10} | mount {r['mount_ms']:>8.1f} ms | "
              f"keystroke median {r['latency_ms_median']:>8} ms max {r['latency_ms_max']:>8} ms | "
              f"rects/key {r['rect_calls_per_keystroke']:>8} ({r['rect_ms_per_keystroke']} ms) | "
              f"nodes {r['dom_nodes']:>6} | longtasks {r['long_task_total_ms']:>6} ms")
    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps({"label": label, "tree": str(tree), "results": results,
                        "failures": fails}, indent=1),
            encoding="utf-8")
    if fails:
        print("\ndesklag: FAILED")
        for f in fails:
            print(f"  - {f}")
        return 1
    if not args.report_only:
        print("\ndesklag: typing re-measures nothing that did not change, and a changed body "
              "still re-folds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
