"""P01 source-coverage guard: real extraction and deliberately unsafe drift.

These fixtures never import the backend. Native/runtime/contact coverage is a
separate gate, not an inference from these static tests.
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("state_operation_inventory", ROOT / "tools/state_operation_inventory.py")
assert SPEC and SPEC.loader
inventory = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inventory
SPEC.loader.exec_module(inventory)


class SourceCoverage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orgtree-state-registry-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = self.root / "engine/backend/orgtree"
        self.backend.mkdir(parents=True)

    def source(self, text, name="api.py", newline=None):
        path = self.backend / name
        path.write_text(text, encoding="utf-8", newline=newline)
        return path

    def scan(self):
        return inventory.scan(self.root)

    def test_route_variants_and_dynamic_selector_are_visible(self):
        self.source('''
@app.get("/items/{key}")
def read(): pass
@router.api_route("/mixed", methods=["GET", "POST"])
def mixed(): pass
@app.websocket("/events")
async def events(): pass
@app.on_event("startup")
def boot(): pass
@app.post(prefix + "/dynamic")
def dynamic(): pass
''')
        rows = self.scan()["registrations"]
        self.assertEqual([r["kind"] for r in rows], ["http", "http", "websocket", "hook", "http"])
        self.assertEqual(rows[1]["methods_expression"], "['GET', 'POST']")
        self.assertEqual(rows[-1]["resolution"], "unresolved")
        self.assertIsNone(rows[-1]["selectors"])
        # An HTTP GET is not classified as a read-only state operation.
        self.assertNotIn("read_only", rows[0])

    def test_tool_actions_and_hidden_dispatch_are_distinct_evidence(self):
        self.source('''
TOOLS = [
 {"name": "orgtree_work", "inputSchema": {"properties": {"action": {"enum": ["get", "update"]}}}},
 {"name": "orgtree_alias", "inputSchema": {"properties": {"action": {"type": "string"}}}},
]
def agent(tool, action):
 if tool == "orgtree_hidden": pass
 if action in ("list", "land"): pass
''', "mcptool.py")
        result = self.scan()
        self.assertEqual(result["registrations"][0]["actions"], ["get", "update"])
        self.assertEqual(result["registrations"][1]["resolution"], "unresolved")
        self.assertTrue(any(r["values"] == ["orgtree_hidden"] for r in result["dispatch_selectors"]))
        self.assertTrue(any(r["values"] == ["list", "land"] for r in result["dispatch_selectors"]))
        self.assertEqual(len(result["registrations"]), 2)

    def test_card_literals_outside_tools_and_card_less_door_verbs_are_entries(self):
        # p01-inventory-misses-the-desktop-relaunch-tool-c: a module-level literal of tool cards is a catalogue
        # whatever it is called, and every name the agent door dispatches on (`body.tool`) is an entry point,
        # through a literal, a set, a starred constant or another module's constant
        self.source('''
from typing import Any
TOOLS = [{"name": "orgtree_listed", "inputSchema": {}}]
_SWAPPED: tuple[dict[str, Any], ...] = ({"name": "orgtree_swapped", "inputSchema": {}},)
''', "mcptool.py")
        self.source('''OP_CALL = "orgtree_wrapped"
''', "receipts.py")
        self.source('''from . import receipts
_EXTRA = frozenset({"orgtree_starred"})
def agent_call(body, dynamic):
    if body.tool == "orgtree_listed": pass
    if body.tool == "orgtree_hidden": pass
    if body.tool in ("orgtree_hidden", *_EXTRA): pass
    if body.tool == receipts.OP_CALL: pass
    if body.tool == dynamic: pass
''')
        result = self.scan()
        cards = sorted(n for r in result["registrations"] if r["kind"] == "tool" for n in r["names"])
        verbs = {r["names"][0]: r["resolution"] for r in result["registrations"] if r["kind"] == "tool_verb"}
        self.assertEqual(cards, ["orgtree_listed", "orgtree_swapped"])
        self.assertEqual(verbs, {"orgtree_hidden": "literal", "orgtree_starred": "constant",
                                 "orgtree_wrapped": "constant"})
        # an operand that is not provably constant is counted, never silently dropped
        self.assertEqual(result["summary"]["unresolved_tool_refs"], 1)

    def test_thread_timer_tasks_and_callback_registration(self):
        self.source('''
from threading import Thread as Worker, Timer
def start():
 Worker(target=receive).start()
 Timer(1, flush).start()
 loop.call_later(1, recover)
 executor.submit(work)
 runner(on_exit=finish)
''')
        rows = self.scan()["registrations"]
        self.assertEqual([r["target"] for r in rows], ["receive", "flush", "recover", "work", "finish"])
        self.assertEqual(rows[0]["mechanism"], "threading.Thread")

    def test_asyncio_to_thread_is_a_task_handoff(self):
        self.source('''
import asyncio
async def remove(key):
 return await asyncio.to_thread(removal.remove_account, key, actor=USER)
async def recover(repair):
 await asyncio.to_thread(repair)
 await asyncio.to_thread(**chosen)
''')
        rows = [r for r in self.scan()["registrations"] if r["kind"] == "task"]
        self.assertEqual([r["mechanism"] for r in rows], ["asyncio.to_thread"] * 3)
        self.assertEqual([r["source"]["symbol"] for r in rows], ["remove", "recover", "recover"])
        self.assertEqual([r["target"] for r in rows], ["removal.remove_account", "repair", None])
        # The dynamic hand-off is kept as an unresolved obligation, not dropped.
        self.assertEqual([r["resolution"] for r in rows],
                         ["expression", "expression", "unresolved"])

    def test_to_thread_target_is_the_handler_cpython_actually_calls(self):
        # `to_thread(func, /, ...)` takes its callable POSITIONAL-ONLY, so
        # `func=` is forwarded to that callable. Rather than restate what this
        # scanner believes, run the real asyncio.to_thread and let CPython say
        # which handler executes, then require the recorded target to be it.
        called = []
        def chosen_handler(**forwarded):
            called.append(("chosen_handler", sorted(forwarded)))
        def other_handler(**forwarded):  # pragma: no cover - must never run
            called.append(("other_handler", sorted(forwarded)))
        asyncio.run(asyncio.to_thread(chosen_handler, func=other_handler))
        self.assertEqual(called, [("chosen_handler", ["func"])])

        self.source("import asyncio\n"
                    "async def hand_off():\n"
                    " await asyncio.to_thread(chosen_handler, func=other_handler)\n")
        row, = [r for r in self.scan()["registrations"] if r["kind"] == "task"]
        self.assertEqual(row["target"], called[0][0])
        self.assertEqual(row["resolution"], "expression")

    def test_to_thread_without_a_determinable_positional_target_stays_unresolved(self):
        self.source('''
import asyncio
async def forms(handlers, chosen, rest):
 await asyncio.to_thread(*handlers)
 await asyncio.to_thread(func=only_a_keyword)
 await asyncio.to_thread(**everything)
 await asyncio.to_thread(chosen, *rest, func=forwarded)
''')
        rows = [r for r in self.scan()["registrations"] if r["kind"] == "task"]
        # An expansion is not a target, and a forwarded `func=` is not one
        # either; only the real positional callable is reported.
        self.assertEqual([r["target"] for r in rows], [None, None, None, "chosen"])
        self.assertEqual([r["resolution"] for r in rows],
                         ["unresolved", "unresolved", "unresolved", "expression"])

    def test_anyio_run_sync_is_not_claimed_as_a_to_thread_task(self):
        # This pass matches call NAMES. `anyio.to_thread.run_sync` is a different
        # name, so it stays unrecognized rather than being silently counted; the
        # module fingerprint is still what makes such a site invalidate a snapshot.
        self.source('''
import anyio
async def read(function):
 return await anyio.to_thread.run_sync(function)
''')
        result = self.scan()
        self.assertEqual([r for r in result["registrations"] if r["kind"] == "task"], [])
        self.assertEqual(result["summary"]["modules"], 1)

    def test_registration_targets_are_endpoints_not_route_names(self):
        self.source('''
app.router.add_event_handler("shutdown", scheduler.stop)
app.add_api_route("/route", endpoint=handler)
app.mount("/static", files)
asyncio.create_task(coro=recover())
loop.run_in_executor(None, copy)
loop.call_soon(callback=resume)
pool.submit(**dynamic)
''')
        rows = self.scan()["registrations"]
        self.assertEqual([r["target"] for r in rows[:6]],
                         ["scheduler.stop", "handler", "files", "recover()", "copy", "resume"])
        self.assertEqual(rows[-1]["resolution"], "unresolved")

    def test_database_alias_and_unknown_connect_are_not_conflated(self):
        self.source('''
import sqlite3 as sql
from sqlite3 import connect as db_open
sql.connect(database)
db_open(other)
socket.connect(address)
''')
        rows = self.scan()["connection_sites"]
        self.assertEqual([r["classification"] for r in rows],
                         ["database_factory", "database_factory", "unresolved_connect_call"])

    def test_no_source_execution_or_import(self):
        target = self.root / "must-not-exist"
        self.source("from pathlib import Path\nPath(" + repr(str(target)) + ").write_text('bad')\nraise RuntimeError('do not import')\n")
        self.assertEqual(self.scan()["summary"]["modules"], 1)
        self.assertFalse(target.exists())

    def test_new_route_fails_existing_coverage(self):
        self.source('@app.get("/one")\ndef one(): pass\n')
        before = self.scan()
        self.source('@app.get("/one")\ndef one(): pass\n@app.post("/two")\ndef two(): pass\n')
        result = inventory.compare(before, self.scan())
        self.assertFalse(result["matches"])
        self.assertIn("registrations", result["changed_sections"])

    def test_unrecognized_registration_still_invalidates_source_coverage(self):
        self.source("def load(): pass\n")
        before = self.scan()
        self.source("plugin_magic.register_indirectly(factory())\n", "dynamic.py")
        result = inventory.compare(before, self.scan())
        self.assertFalse(result["matches"])
        self.assertIn("modules", result["changed_sections"])

    def test_handler_write_change_invalidates_unchanged_route(self):
        self.source('@app.get("/thing")\ndef thing():\n return read()\n')
        before = self.scan()
        self.source('@app.get("/thing")\ndef thing():\n write()\n return read()\n')
        self.assertFalse(inventory.compare(before, self.scan())["matches"])

    def test_omitted_site_is_detected(self):
        self.source('@app.post("/command")\ndef command(): pass\n')
        actual = self.scan()
        mutant = copy.deepcopy(actual)
        mutant["registrations"] = []
        self.assertIn("registrations", inventory.compare(mutant, actual)["changed_sections"])

    def test_no_static_result_can_claim_runtime_or_conversion_approval(self):
        self.source("def f(): pass\n")
        actual = self.scan()
        self.assertFalse(actual["qualification"]["runtime_census"])
        self.assertFalse(actual["qualification"]["conversion_authorized"])
        mutant = copy.deepcopy(actual)
        mutant["qualification"]["conversion_authorized"] = True
        self.assertFalse(inventory.compare(mutant, actual)["matches"])

    def test_nested_symbols_and_repeated_sites_keep_separate_identity(self):
        self.source('''
import threading
def a():
 def run(): pass
 threading.Thread(target=run)
 threading.Thread(target=run)
def b():
 def run(): pass
 threading.Thread(target=run)
''')
        rows = self.scan()["registrations"]
        self.assertEqual(len({r["site_id"] for r in rows}), 3)
        self.assertEqual([r["source"]["symbol"] for r in rows], ["a", "a", "b"])

    def test_windows_newlines_do_not_create_false_drift(self):
        content = '@app.get("/one")\ndef one(): pass\n'
        self.source(content, newline="\n")
        before = self.scan()
        self.source(content, newline="\r\n")
        self.assertTrue(inventory.compare(before, self.scan())["matches"])

    def test_syntax_error_fails_closed_without_overwriting_inventory(self):
        self.source("not valid python !!!\n")
        output = self.root / "inventory.json"
        output.write_text("retained", encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            result = inventory.main(["--repo", str(self.root), "--write", str(output)])
        self.assertEqual(result, 2)
        self.assertEqual(output.read_text(encoding="utf-8"), "retained")

    def test_bad_json_shape_is_explicit_refusal(self):
        self.source("pass\n")
        baseline = self.root / "inventory.json"
        baseline.write_text("[]", encoding="utf-8")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(inventory.main(["--repo", str(self.root), "--check", str(baseline)]), 2)

    def test_committed_inventory_matches_current_backend(self):
        baseline = ROOT / "docs/state-system/operation-inventory.json"
        expected = json.loads(baseline.read_text(encoding="utf-8"))
        self.assertTrue(inventory.compare(expected, inventory.scan(ROOT))["matches"])

    def test_committed_inventory_pins_the_real_to_thread_hand_offs(self):
        # `--check` only proves the snapshot and the source agree. Narrowing the
        # scanner and refreshing the snapshot with itself would still pass it,
        # so the exact group totals and both real hand-off sites are pinned here.
        baseline = json.loads((ROOT / "docs/state-system/operation-inventory.json")
                              .read_text(encoding="utf-8"))
        summary = baseline["summary"]
        # 311 -> 314: P02-A1 adds three operator HTTP routes,
        # GET/POST /api/diagnostics/operation-census and
        # POST /api/diagnostics/operation-census/reset.
        # 314 -> 317: add-agent-tool-and-ui-to-clear-account-limit-mar adds
        # GET /api/accounts/{id}/marks, POST /api/accounts/{id}/marks/clear
        # and the orgtree_account_mark tool card.
        # 317 -> 319: GET/PUT /api/app-settings/charter-template-dirs (docket
        # add-external-agent-charter-templates-folder), both pending.
        # 319 -> 333: the scan covers the engine's top-level modules and engine/winservice
        # (p01-inventory-misses-the-production-routes-mount): engine/launch.py adds 10 routes, its
        # include_router(desktop_import.router) and the server task; process_lifetime.py and service_host.py
        # add one worker each.
        # 333 -> 342: p01-inventory-misses-the-desktop-relaunch-tool-c inventories mcptool's
        # _DESKTOP_RELAUNCH_CARDS (the orgtree_self_relaunch and orgtree_prime_relaunch cards) and the 7 names the
        # agent door dispatches without any card (tool_verb), every body.tool operand resolved
        self.assertEqual(summary["registration_sites"], 342)
        self.assertEqual(summary["registration_kinds"]["task"], 13)
        self.assertEqual((summary["registration_kinds"]["tool"], summary["registration_kinds"]["tool_verb"],
                          summary["unresolved_tool_refs"]), (51, 7, 0))
        # 225 -> 226: P02-A1 adds one `body.tool == "orgtree_operation_census"`
        # branch in api.agent_call, routing the agent read door.
        # 226 -> 227: the same item adds the `orgtree_account_mark` branch.
        self.assertEqual(summary["dispatch_selector_sites"], 227)
        # 15 -> 18: engine/mailhub_runtime.py's hub store migration opens three connections
        self.assertEqual(summary["connection_sites"], 18)
        self.assertEqual([(r["source"]["path"], r["source"]["symbol"], r["target"])
                          for r in baseline["registrations"]
                          if r.get("mechanism") == "asyncio.to_thread"],
                         [("engine/backend/orgtree/api.py", "accounts_remove",
                           "account_removal.remove_account_rebinding_agents"),
                          ("engine/backend/orgtree/startup.py", "Recovery.start.run", "repair")])


    # coordinator ruling on p01-inventory-misses-the-production-routes-mount: nothing added outside the backend
    # package may go unseen. Any engine .py file outside the inventory's module set that has a route, a hook, a
    # router include, a task or worker registration, or a connection site fails here.
    NOT_SCANNED = ("engine/native/", "engine/runtime/")

    def test_no_engine_module_with_sites_is_left_out_of_the_scan(self):
        scanned = {m["path"] for m in inventory.scan(ROOT)["modules"]}
        offenders, checked = [], 0
        for path in sorted((ROOT / "engine").rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            if rel in scanned or any(part in inventory.SKIPPED_PARTS for part in path.parts) \
                    or rel.startswith("engine/runtime/"):
                continue
            checked += 1
            module = inventory.ModuleInventory(rel, path.read_text(encoding="utf-8-sig"))
            module.visit(module.tree)
            if module.registrations or module.storage:
                offenders.append(rel)
        self.assertEqual(offenders, [])
        # the files left out are exactly the offline native oracle generators
        self.assertGreater(checked, 0)
        for rel in scanned:
            self.assertFalse(rel.startswith(self.NOT_SCANNED), rel)

    # p01-inventory-misses-the-desktop-relaunch-tool-c: the two relaunch cards lived in a module-level literal the
    # scanner did not read, and seven dispatchable names had no card at all. These two guards find both shapes by
    # a DIFFERENT method than the scanner (a walk of every node, not the scanner's assignment and resolution rules),
    # so a new card literal anywhere, at any depth, or a new body.tool name, fails here until it is inventoried.
    @staticmethod
    def _trees():
        for m in inventory.scan(ROOT)["modules"]:
            yield m["path"], ast.parse((ROOT / m["path"]).read_text(encoding="utf-8-sig"))

    @staticmethod
    def _inventoried(kinds):
        # what the scanner sees NOW, not the committed snapshot: a scanner that went blind would regenerate a
        # snapshot without the name (test_committed_inventory_matches_current_backend covers the snapshot)
        return {n for r in inventory.scan(ROOT)["registrations"] if r["kind"] in kinds for n in (r.get("names") or [])}

    def test_every_literal_tool_card_in_the_engine_is_inventoried(self):
        found = {}
        for path, tree in self._trees():
            for node in ast.walk(tree):
                if isinstance(node, ast.Dict):
                    keys = {k.value: v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant)}
                    name = keys.get("name")
                    if "inputSchema" in keys and isinstance(name, ast.Constant) and str(name.value).startswith("orgtree_"):
                        found.setdefault(name.value, path)
        self.assertLessEqual({"orgtree_self_relaunch", "orgtree_prime_relaunch", "orgtree_work"}, set(found))
        self.assertEqual(sorted(set(found) - self._inventoried({"tool"})), [])

    def test_every_name_the_agent_door_dispatches_is_inventoried(self):
        constants = {}          # (module file stem, NAME) -> (module file stem, its value)
        trees = dict(self._trees())
        for path, tree in trees.items():
            stem = path.rsplit("/", 1)[-1][:-3]
            for node in tree.body:
                targets = node.targets if isinstance(node, ast.Assign) else \
                    [node.target] if isinstance(node, ast.AnnAssign) and node.value is not None else []
                for t in targets:
                    if isinstance(t, ast.Name):
                        constants[(stem, t.id)] = (stem, node.value)

        def strings(stem, operand, seen=frozenset()):
            # every string literal under the operand, following module constants (and constants of constants,
            # e.g. api.OP_EPOCH = opreceipts.OP_EPOCH) wherever they lead
            out = set()
            for n in ast.walk(operand):
                key = (stem, n.id) if isinstance(n, ast.Name) else \
                    (n.value.id, n.attr) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) else None
                if isinstance(n, ast.Constant) and isinstance(n.value, str):
                    out.add(n.value)
                elif key in constants and key not in seen:
                    out |= strings(constants[key][0], constants[key][1], seen | {key})
            return out
        dispatched = set()
        for path, tree in trees.items():
            for node in ast.walk(tree):
                if isinstance(node, ast.Compare):
                    parts = [node.left, *node.comparators]
                    if any(ast.unparse(p) == "body.tool" for p in parts):
                        for p in parts:
                            dispatched |= {s for s in strings(path.rsplit("/", 1)[-1][:-3], p)
                                           if s.startswith("orgtree_")}
        self.assertLessEqual({"orgtree_self_update", "orgtree_op_epoch", "orgtree_self_relaunch",
                              "orgtree_send_file_once", "orgtree_account_assign"}, dispatched)
        self.assertEqual(sorted(dispatched - self._inventoried({"tool", "tool_verb"})), [])

    def test_the_launcher_routes_and_engine_modules_are_inventoried(self):
        baseline = json.loads((ROOT / "docs/state-system/operation-inventory.json").read_text(encoding="utf-8"))
        paths = [m["path"] for m in baseline["modules"]]
        self.assertLessEqual({"engine/launch.py", "engine/mailhub_runtime.py", "engine/process_lifetime.py",
                              "engine/service_host.py", "engine/winservice/scm.py"}, set(paths))
        routes = sorted((r["method"], r["selectors"][0]) for r in baseline["registrations"]
                        if r["source"]["path"] == "engine/launch.py" and r["kind"] == "http")
        self.assertEqual(routes, [("get", "/api/desktop/hub"), ("get", "/api/desktop/identity"),
                                  ("get", "/api/desktop/import-v1/{slug}/recovery"),
                                  ("get", "/api/desktop/notifications"), ("get", "/api/desktop/status"),
                                  ("post", "/api/desktop/import-v1/{slug}/resolve"),
                                  ("post", "/api/desktop/maintenance/ack"),
                                  ("post", "/api/desktop/maintenance/failure"), ("post", "/api/desktop/shutdown"),
                                  ("put", "/api/desktop/hub")])


if __name__ == "__main__":
    unittest.main()
