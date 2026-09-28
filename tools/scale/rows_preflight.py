"""Fail fast when per-request PG rows grow with the number of agents.

The N1000 attempt 3 (2026-09-28) spent 25 minutes of readiness before its
primer showed that every request read ~4133 rows / 60 MB (a whole-org load)
and one ordinary message read ~16.5k rows / 197 MB. This preflight seeds tiny
N=10 and N=100 orgs on the controller's own PG cluster, serves each with SQL
counters on, sends the same calls, and refuses to continue when a judged call
reads more than THRESHOLD times the rows at N=100 than at N=10.

Judged (PRODUCT routes only): one ordinary orgtree_message POST (the primer's
call) and reads that ui_hooks polls: the desk chat, the docket foreground, the
desktop notifications (every 5 s in window 0) and the org list.
Recorded, not judged: the harness routes /scale/tokens, /scale/workload and
/scale/settlement (serve.py; they load the whole org on purpose), and the
foreground tree, whose payload covers the visible agents by design.

TWO JUDGED STEPS, each changing ONE axis (scale-ui-astra, 2026-09-28):
  * agents: N=10 -> N=100, both at ITEMS[0] active docket items;
  * items:  ITEMS[0] -> ITEMS[1] active items (the N=1000 recipe), both at
    N=100 -- the N=100 arm at ITEMS[0] is shared with the agents step.
Mixing the axes hides which one grew: the N=1000 message read 985 rows
because every load listed all 180 active items, which a 20-item preflight
could not see (message-send-reads-grow-above-n-100-985-rows-1-2). Same rules
(rows 2x, bytes 3x above the floor, no lazy fallbacks) on both steps, except
that the item step records but does not judge the docket view (it shows every
active item by design; ITEM_JUDGED). Each arm's item count is recorded in its
receipt.
"""
import json
import os
import sys
import time

import httpx

SIZES = (10, 100)
#: active docket items for the item step at N=SIZES[1]: the preflight's own
#: seed, then the N=1000 seed's (seed.py --active-items default)
ITEMS = (20, 180)
THRESHOLD = 2.0
#: Value bytes may grow when rows do not (a whole-org read hidden behind a
#: large per-node log, e.g. node_chat), so bytes are judged too, more loosely.
BYTES_THRESHOLD = 3.0
#: ...but only when the N=100 read is big enough to matter: a 8 KB -> 29 KB read
#: is 3.5x yet costs nothing. Every whole-org load seen so far read >= 3 MB at
#: N=100 (notifications 5.2, chat 6.1, org list 3.3). 256 KB (coordinator
#: 2026-09-28 04:28Z) caps a hidden bytes-only growth at ~2.5 MB per request
#: at N=1000.
BYTES_FLOOR = 256_000
JUDGED = ("work_items", "chat", "notifications", "org_list", "message")
#: The item step judges every call except the docket view itself, which shows
#: every active item (product cap 200) by design, so its reads follow the item
#: count; it is still recorded. Anything else that follows the docket size fails.
ITEM_JUDGED = tuple(c for c in JUDGED if c != "work_items")
KIND = "rows-preflight"


def verdict(results, threshold=THRESHOLD, steps=SIZES, calls=JUDGED):
    """results: {n: {call: {"rows": int, ...}}} -> (passed, per-call rows ratios)."""
    small, large = (results[n] for n in steps)
    ratios = {}
    for call in calls:
        if call not in small or call not in large or not small[call]["rows"]:
            raise ValueError(f"rows preflight did no measurable work for {call}")
        ratios[call] = large[call]["rows"] / small[call]["rows"]
    return all(r <= threshold for r in ratios.values()), ratios


def bytes_verdict(results, threshold=BYTES_THRESHOLD, floor=BYTES_FLOOR, steps=SIZES,
                  calls=JUDGED):
    """(passed, per-call value-byte ratios N=100/N=10); refuses zero-byte calls.
    A call fails only if its ratio exceeds `threshold` AND its N=100 read is at
    least `floor` bytes."""
    small, large = (results[n] for n in steps)
    ratios, failed = {}, []
    for call in calls:
        if not small[call].get("value_bytes"):
            raise ValueError(f"rows preflight read no value bytes for {call}")
        ratios[call] = large[call]["value_bytes"] / small[call]["value_bytes"]
        if ratios[call] > threshold and large[call]["value_bytes"] >= floor:
            failed.append(call)
    return not failed, ratios


def fallbacks(results, steps=SIZES, calls=JUDGED):
    """Judged calls that had to decode every node row (ORGTREE_LAZY_ROWS
    fallbacks). A fallback is a whole-org read: any at all fails."""
    return {f"{n}:{call}": results[n][call].get("lazy_fallbacks", 0)
            for n in steps for call in calls if results[n][call].get("lazy_fallbacks", 0)}


def judge(results, steps=SIZES, calls=JUDGED):
    """The whole decision for one step: rows (2x) AND value bytes (3x) AND no
    lazy-rows fallbacks. Returns (passed, rows ratios, byte ratios, fallbacks)."""
    rows_passed, ratios = verdict(results, steps=steps, calls=calls)
    bytes_passed, byte_ratios = bytes_verdict(results, steps=steps, calls=calls)
    fell = fallbacks(results, steps=steps, calls=calls)
    return rows_passed and bytes_passed and not fell, ratios, byte_ratios, fell


def calls(desc):
    """The fixed call sequence; returns the call labels in order."""
    headers = {"X-Orgtree-Desktop-Token": desc["token"], "X-Scale-Kind": KIND}
    labels = []
    with httpx.Client(base_url=desc["origin"], headers=headers, timeout=120) as client:
        tokens = client.get("/scale/tokens").raise_for_status().json(); labels.append("tokens")
        parents = client.get("/scale/workload").raise_for_status().json()["parents"]; labels.append("workload")
        client.get("/scale/settlement").raise_for_status(); labels.append("settlement")
        base, target = f"/api/orgs/{desc['org']}", sorted(desc["live_agents"])[0]
        for label, url in (("foreground_tree", base + "/foreground-tree"),
                           ("work_items", base + "/work-items-foreground?backlogged=0&archive_limit=0"),
                           ("chat", f"{base}/nodes/{target}/chat?last=8"),
                           ("notifications", "/api/desktop/notifications"),
                           ("org_list", "/api/orgs")):
            client.get(url).raise_for_status(); labels.append(label)
        actor = parents.get(target) or next(n for n, p in parents.items() if p == target)
        client.post("/api/agent", json=dict(org=desc["org"], node=actor, tool="orgtree_message",
            args=dict(to=target, kind="message", body="[rows-preflight] synthetic readiness message.")),
            headers={"X-Orgtree-Agent-Token": tokens[actor]}).raise_for_status()
        labels.append("message")
    return labels


def seeded_items(descriptor, requested):
    """The ACTIVE item count the seed actually wrote (its descriptor's
    seed.summary), refusing an arm that did not seed what it was asked to:
    the receipt proves the item axis, it does not merely request it."""
    actual = descriptor.get("seed", {}).get("summary", {}).get("work_items")
    if actual != requested:
        raise RuntimeError(f"preflight seed wrote {actual!r} active items, not {requested}")
    return actual


def decide(steps):
    """steps: {name: step summary}. Every step must pass; returns (passed,
    names of the failing steps) -- one failing step alone fails the preflight."""
    failed = [name for name, step in steps.items() if not step["passed"]]
    return not failed, failed


def arm(ctrl, admin, n, items=ITEMS[0]):
    from baseline import REPO, read, write, database_name
    name = f"preflight-{n}" if items == ITEMS[0] else f"preflight-{n}-items{items}"
    root = ctrl.root / name
    ctrl.script("seed.py", name + "-seed", "--root", root, "--agents", n, "--active-items", items,
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", 1,
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(root / "scale-descriptor.json")
    try:
        ctrl.script("prepare_steady.py", name + "-prepare", "--root", root, "--seconds", .25, "--output-bytes", 256)
        ctrl.phase = name + "-serve"
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
            "--root", str(root), "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1",
            "--env", "ORGTREE_SCALE_SQL_COUNTS=1",
            *(a for k in ("ORGTREE_LAZY_ROWS", "ORGTREE_CHAT_RUNTIME_VIEW", "ORGTREE_SCALE_SQL_STATEMENTS")
              if k in os.environ
              for a in ("--env", f"{k}={os.environ[k]}"))], name + "-serve")
        try:
            deadline = time.monotonic() + 300
            while True:
                ctrl.check()
                if server.poll() is not None:
                    raise RuntimeError(f"{name} server exited during startup")
                desc = read(root / "scale-descriptor.json")
                ctrl.engine_pid = desc.get("serve", {}).get("pid")
                if desc.get("serve", {}).get("state") == "ready":
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"{name} startup deadline expired")
                time.sleep(.2)
            labels = calls(desc)
        finally:
            ctrl.kill(server)
            ctrl.engine_pid = None
        if (root / "metrics/qualification-invalid.json").exists():
            raise RuntimeError(f"{name}: unexpected process launch")
        rows = [json.loads(line) for line in (root / "metrics/sql-counts.jsonl").read_text(
            encoding="utf-8").splitlines()]
        rows = [r for r in rows if r["kind"] == KIND]
        if len(rows) != len(labels):
            raise RuntimeError(f"{name}: {len(rows)} counted requests for {len(labels)} calls")
        # Boundary rows are appended at response end; the calls are sequential.
        result = {label: row for label, row in zip(labels, sorted(rows, key=lambda r: r["at"]))}
        actual = seeded_items(read(root / "scale-descriptor.json"), items)
        write(ctrl.root / "receipts" / f"{name}.json",
              dict(result, _seed=dict(agents=n, active_items_requested=items,
                                      active_items=actual)))
        return result
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))


def _step(results, steps, label, calls=JUDGED):
    passed, ratios, byte_ratios, fell = judge(results, steps=steps, calls=calls)
    # Absolute larger-arm size beside each ratio: a flat but huge read stays visible.
    large = results[steps[1]]
    judged = {call: dict(rows_ratio=round(ratios[call], 2), bytes_ratio=round(byte_ratios[call], 2),
                         rows_large=large[call]["rows"],
                         mb_large=round(large[call]["value_bytes"] / 1e6, 2)) for call in calls}
    # recorded, not judged (ITEM_JUDGED): the size is still visible
    recorded = {call: dict(rows_large=large[call]["rows"], mb_large=round(large[call]["value_bytes"] / 1e6, 2))
                for call in JUDGED if call not in calls}
    print(f"rows preflight ({label}):")
    for call, row in judged.items():
        print(f"  {call:14} rows x{row['rows_ratio']:<5} ({row['rows_large']} rows)  "
              f"bytes x{row['bytes_ratio']:<5} ({row['mb_large']} MB)")
    return dict(passed=passed, steps=steps, ratios=ratios, byte_ratios=byte_ratios, judged=judged,
                recorded=recorded, lazy_fallbacks=fell,
                rows={n: {k: v["rows"] for k, v in r.items()} for n, r in results.items()},
                value_bytes={n: {k: v["value_bytes"] for k, v in r.items()} for n, r in results.items()})


def preflight(ctrl, admin):
    by_n = {n: arm(ctrl, admin, n) for n in SIZES}
    by_items = {ITEMS[0]: by_n[SIZES[1]], ITEMS[1]: arm(ctrl, admin, SIZES[1], ITEMS[1])}
    agents = _step(by_n, SIZES, f"N={SIZES[1]} vs N={SIZES[0]}, {ITEMS[0]} items")
    work = _step(by_items, ITEMS, f"{ITEMS[1]} vs {ITEMS[0]} active items, N={SIZES[1]}",
                 calls=ITEM_JUDGED)
    passed, failed_steps = decide({"agents": agents, "items": work})
    summary = dict(passed=passed, failed_steps=failed_steps, threshold=THRESHOLD,
                   bytes_threshold=BYTES_THRESHOLD,
                   sizes=SIZES, items=ITEMS, lazy_rows=os.environ.get("ORGTREE_LAZY_ROWS", ""),
                   agents_step=agents, items_step=work,
                   # the agents step's fields at top level, as before
                   ratios=agents["ratios"], byte_ratios=agents["byte_ratios"], judged=agents["judged"],
                   lazy_fallbacks={**agents["lazy_fallbacks"], **{
                       f"items{k}": v for k, v in work["lazy_fallbacks"].items()}})
    from baseline import write
    write(ctrl.root / "receipts" / "rows-preflight.json", summary)
    if not passed:
        raise RuntimeError(f"rows preflight: per-request reads grow (agents step: {agents['judged']}; "
                           f"items step: {work['judged']}; rows limit x{THRESHOLD}, bytes limit "
                           f"x{BYTES_THRESHOLD}) or judged calls fell back to whole reads "
                           f"({summary['lazy_fallbacks']})")
    return summary
