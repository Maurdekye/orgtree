"""Measure orgtree_work get/list payload sizes on a genuinely large item.

    python tools/docket-payload-probe.py

Builds one item with six acceptance conditions, twelve updates, twelve
evidence rows and twelve decisions — all carrying long notes — plus four
ordinary items and eight backlogged ones, then prints the byte count of every
projection `get` and `list` can serve, and the size of each group.

Storage is bound to a throwaway ORGTREE_DATA before the first orgtree import
and the binding is asserted, so this never touches a live docket.
"""
import json
import os
import tempfile

_DATA = tempfile.mkdtemp(prefix="docket-payload-probe-")
os.environ["ORGTREE_DATA"] = _DATA
os.environ["ORGTREE_V2_TOKEN"] = "docket-payload-probe"

from engine.backend.orgtree import ledger, store  # noqa: E402

assert os.path.realpath(str(store.DATA_ROOT)) == os.path.realpath(_DATA), (
    f"ORGTREE_DATA did not take effect: store.DATA_ROOT={store.DATA_ROOT!r}")

HIRE = dict(add_dirs=[], tools={"bash": False, "web": False, "edit": False,
                                "subagents": False, "mcp": []},
            org_visibility="self", charter="probe")

LONG = ("This is a deliberately long note of the kind agents actually write "
        "on a docket item that has been worked for two days. ") * 40


def build():
    org = ledger.Org.create("probe")
    mgr = str(org.hire(ledger.USER, None, "haiku", 3, "mgr", **HIRE)["node"])
    obj = "\n\n".join([
        "The problem, stated at length so the description is realistic. " * 20,
        "## Requirements\n" + ("- a requirement that matters\n" * 30),
        "## Edge cases\n" + ("- an edge case nobody thought of\n" * 30)])
    big = org.work_create(mgr, "A genuinely large item", obj,
                          acceptance=[f"acceptance condition number {i}"
                                      for i in range(6)])
    slug = str(big["slug"])
    for i in range(6):
        org.work_check(mgr, slug, i, evidence_ref=f"tests/run-{i}.log",
                       note=LONG)
    for i in range(12):
        org.work_update(mgr, slug, [f"did step {i}"], [f"next step {i}"])
        org.work_evidence(mgr, slug, kind="note", ref=f"ref-{i}", note=LONG)
        org.work_decision(mgr, slug, f"ruling {i}: {LONG}")
    org.work_update(mgr, slug, ["objective grew"], ["keep going"],
                    objective=obj + "\n\nAn appended paragraph.")
    for i in range(4):
        org.work_create(mgr, f"Ordinary item {i}", "something to do")
    for i in range(8):
        org.work_create(mgr, f"Backlogged item {i}", "not started",
                        status="backlogged")
    return org, mgr, slug


def size(obj):
    return len(json.dumps(obj, default=str))


PLATE = ["slug", "title", "status", "owner"]


def main():
    org, mgr, slug = build()
    print(f"data root = {store.DATA_ROOT}\n")
    print("--- get (one genuinely large item) ---")
    for label, kw in (("projection=full (default)", {}),
                      ("projection=compact", {"projection": "compact"}),
                      ("projection=summary", {"projection": "summary"}),
                      ("fields=slug,title,status,owner", {"fields": PLATE})):
        print(f"  {label:<36} {size(org.work_get(mgr, slug, **kw)):>9,} chars")

    print("\n--- list (13 readable items, 8 of them backlogged) ---")
    for label, kw in (
            ("projection=full", {"projection": "full"}),
            ("projection=compact", {"projection": "compact"}),
            ("projection=summary (agent default)", {"projection": "summary"}),
            ("fields=slug,title,status,owner", {"fields": PLATE}),
            ("summary + include_backlogged", {"projection": "summary",
                                              "include_backlogged": True})):
        r = org.work_list(mgr, **kw)
        print(f"  {label:<36} {size(r):>9,} chars  "
              f"items={len(r['items'])} "
              f"backlogged={len(r.get('backlogged') or [])}")

    r = org.work_list(mgr, projection="summary", include_backlogged=True)
    print(f"\n  groups head: {json.dumps(r['groups'])[:300]}")

    full = org.work_get(mgr, slug)
    print(f"\n  folded duplicates: {json.dumps(full['folded'])}")
    acc = full["acceptance"][0]
    print(f"  acceptance[0]: checked={'yes' if acc.get('checked') else 'no'} "
          f"check_history={len(acc['check_history'])} of "
          f"{acc['check_history_count']} "
          f"newest_same_as={acc.get('check_history_newest_same_as')}")


def breakdown():
    org, mgr, slug = build()
    full = org.work_get(mgr, slug)
    rows = sorted(((size(v), k) for k, v in full.items()), reverse=True)
    total = size(full)
    print(f"\n--- get field breakdown (total {total:,}) ---")
    for n, k in rows[:12]:
        print(f"  {k:<24} {n:>9,}  {100*n/total:5.1f}%")


if __name__ == "__main__":
    main()
