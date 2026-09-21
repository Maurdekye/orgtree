"""P01 source-coverage guard: real extraction and deliberately unsafe drift.

These fixtures never import the backend. Native/runtime/contact coverage is a
separate gate, not an inference from these static tests.
"""
from __future__ import annotations

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
        self.assertEqual(summary["registration_sites"], 311)
        self.assertEqual(summary["registration_kinds"]["task"], 12)
        self.assertEqual(summary["dispatch_selector_sites"], 225)
        self.assertEqual(summary["connection_sites"], 15)
        self.assertEqual([(r["source"]["path"], r["source"]["symbol"], r["target"])
                          for r in baseline["registrations"]
                          if r.get("mechanism") == "asyncio.to_thread"],
                         [("engine/backend/orgtree/api.py", "accounts_remove",
                           "account_removal.remove_account_rebinding_agents"),
                          ("engine/backend/orgtree/startup.py", "Recovery.start.run", "repair")])


if __name__ == "__main__":
    unittest.main()
