"""A large imported fleet, with real eligible bindings and no provider turns."""
import json
from pathlib import Path


def seed(root: Path, nodes=500, entries=20000):
    from orgtree import ledger, store
    assert Path(store.DATA_ROOT).resolve() == root.resolve(), store.DATA_ROOT
    org = store.create_org("startup-budget")
    for i in range(nodes):
        nid = f"agent{i:04d}"
        # A Claude binding MUST have a Claude tier, or native_hold_reason
        # bails out before the inventory and the fixture measures nothing.
        org.hire(ledger.USER, None, "haiku", 0, nid)
        node = org.node(nid)
        sid = node["session_id"]
        relative = Path("imports") / org.d["slug"] / "native" / nid / f"{sid}.jsonl"
        folder = root / relative.parent
        folder.mkdir(parents=True)
        (root / relative).write_text(json.dumps({"type": "user"}) + "\n", encoding="utf-8")
        node["desktop_import"] = {"native_continuity": {
            "status": "ready", "provider": "claude", "session_id": sid,
            "storage_node": nid, "path": str(relative)}}
        node["cost_usd"] = 1
        # Real direct children: this walker deliberately doesn't descend into
        # native output subtrees. Hidden nested ballast would be a free test.
        for j in range(max(0, entries // nodes - 2)):
            (folder / f"output-{j}.txt").write_bytes(b"x")
    store.save_org(org)
    return org
