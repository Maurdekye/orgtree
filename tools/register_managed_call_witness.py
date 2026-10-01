"""Register toolwait.managed_call's `body.tool == 'orgtree_op_call'` dispatch
selector in docs/state-system/operation-contracts.json (pending, beside its
sibling toolwait.tool_name row, P01 W8), then re-pin every boundary fixture to
the registry's new digest (the a11e4af procedure).

Refuses unless: the witness is in the current scan and not registered, exactly
one toolwait selector row is registered today (tool_name's), and every
boundary fixture binds the current digest. Run with engine/runtime/python.exe. (A copy of artifacts/register_managed_call_witness.py.)

usage: register_managed_call_witness.py <tree> [--write]
"""
import json
from pathlib import Path
import sys
import importlib.util

tree = Path(sys.argv[1])
write = "--write" in sys.argv
spec = importlib.util.spec_from_file_location("soc", tree / "tools" / "state_operation_contracts.py")
C = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(tree / "tools"))
spec.loader.exec_module(C)
assert sys.version_info[:2] == C.REQUIRED_PYTHON, sys.version
REG = tree / "docs/state-system/operation-contracts.json"
doc = json.loads(REG.read_text(encoding="utf-8"))
old_digest = C.digest(doc)
scan = C.inventory.scan(tree)
registered = {row["id"] for row in doc["dispatch"]}

mine = [s for s in scan["dispatch_selectors"]
        if s["source"]["path"] == "engine/backend/orgtree/toolwait.py"
        and s["source"]["symbol"] == "managed_call"]
assert len(mine) == 1, mine
sel = mine[0]
assert (sel["kind"], sel["selector"], sel["operator"], sel["values"]) == \
    ("tool", "body.tool", "Eq", ["orgtree_op_call"]), sel
new_id = C.witness_id("dispatch", sel)
assert new_id not in registered, "already registered"
sibling = [s for s in scan["dispatch_selectors"]
           if s["source"]["path"] == "engine/backend/orgtree/toolwait.py"
           and s["source"]["symbol"] == "tool_name"]
assert len(sibling) == 1
sib_id = C.witness_id("dispatch", sibling[0])
index = next(i for i, row in enumerate(doc["dispatch"]) if row["id"] == sib_id)
assert doc["dispatch"][index]["disposition"] == "pending"
fixtures = sorted((tree / "docs/state-system").glob("*-boundary.json"))
unbound = [f.name for f in fixtures if old_digest not in f.read_text(encoding="utf-8")]
assert not unbound, ("fixtures not bound at base", unbound)

row = {
    "id": new_id,
    "disposition": "pending",
    "contracts": [],
    "reason": ("Stays pending (P01 W8), beside toolwait.tool_name: toolwait.managed_call "
               "unwraps orgtree_op_call to the arguments it carries, and at the agent door "
               "that decides whether a managed-wait tool's call journals in the tool_waits "
               "sidecar. A managed tool's read-only action (toolwait.READ_ACTIONS: "
               "orgtree_watchdog list) takes the ordinary path instead "
               "(orgtree-watchdog-list-pays-the-managed-wait-jour, 2026-09-28). It is shared "
               "by every POST /api/agent call, and the door stays pending by precedent "
               "(S3 decision 1). Owner: P01 (the agent door)."),
    "source_refs": [],
}
doc["dispatch"].insert(index + 1, row)
# the witness must now validate as registered: no error names it
result = C.validate(doc, scan, tree)
new_digest = C.digest(doc)
print("registered", new_id, "after", sib_id[:12])
print("registry digest", old_digest[:16], "->", new_digest[:16])
print("errors", len(result["errors"]))
if write:
    CRLF = chr(13) + chr(10)
    REG.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline=CRLF)
    for f in fixtures:
        t = f.read_text(encoding="utf-8")
        f.write_text(t.replace(old_digest, new_digest), encoding="utf-8", newline=CRLF)
    print("re-pinned", len(fixtures), "boundary fixtures")
