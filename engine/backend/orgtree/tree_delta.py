"""Lossless org-tree wire deltas. No renderer field is projected away.

The content validator deliberately excludes the two replay watermarks. They
describe when a snapshot was taken, not what it shows. Deltas still carry the
new watermarks, so websocket patches retain their conservative replay order.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

FORMAT = "orgtree.tree/v1"
WATERMARKS = frozenset(("sync_rev", "org_rev"))


def encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"), sort_keys=True).encode("utf-8")


def revision(tree: dict[str, Any]) -> str:
    content = {k: v for k, v in tree.items() if k not in WATERMARKS}
    return hashlib.sha256(encode(content)).hexdigest()[:32]


def flatten(tree: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    todo = list(tree.get("roots", []))
    while todo:
        node = todo.pop()
        children = node.get("children", [])
        rows[node["id"]] = {**node, "children": [n["id"] for n in children]}
        todo.extend(children)
    return rows


def equal(before: Any, after: Any) -> bool:
    # Python considers True == 1, including nested dicts/lists; JSON consumers
    # do not. No field may disappear from a delta through that coercion.
    if type(before) is not type(after):
        return False
    if isinstance(before, dict):
        return before.keys() == after.keys() and all(equal(v, after[k]) for k, v in before.items())
    if isinstance(before, list):
        return len(before) == len(after) and all(equal(a, b) for a, b in zip(before, after))
    return before == after


def changed(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    return {"set": {k: v for k, v in after.items() if k not in before or not equal(before[k], v)},
            "remove": [k for k in before if k not in after]}


def full(tree: dict[str, Any], token: str) -> dict[str, Any]:
    return {"format": FORMAT, "revision": token, "tree": tree}


def delta(before: dict[str, Any], after: dict[str, Any], base: str,
          token: str) -> dict[str, Any]:
    old, new = flatten(before), flatten(after)
    top_old = {**before, "roots": [n["id"] for n in before.get("roots", [])]}
    top_new = {**after, "roots": [n["id"] for n in after.get("roots", [])]}
    return {"format": FORMAT, "revision": token, "base": base,
            "top": changed(top_old, top_new),
            "nodes": {nid: changed(old.get(nid, {}), node)
                      for nid, node in new.items() if not equal(old.get(nid), node)},
            "removed": [nid for nid in old if nid not in new]}
