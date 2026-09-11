"""Structural controls for the native startup cliff, including real refusals."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix="orgtree-startup-budget-")
ROOT = Path(_temp.name).resolve()
os.environ["ORGTREE_DATA"] = str(ROOT)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import desktop_import, desktop_native as native, store, supervisor
from orgtree.fleet_walk import FleetWalkBudgetExceeded, fleet_walk_budget
from tests.startup_fixture import seed
assert Path(store.DATA_ROOT).resolve() == ROOT


class StartupBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.org = seed(ROOT)
        cls.slug = cls.org.d["slug"]
        cls.projects = ROOT / "profile"
        (cls.projects / "projects").mkdir(parents=True)

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all(cls.slug)

    def setUp(self):
        # Never inspect an operator profile as part of a synthetic probe.
        p = patch.object(supervisor, "_transcript_root", return_value=str(self.projects))
        p.start()
        self.addCleanup(p.stop)

    def test_500_nodes_20k_entries_reconcile_once_and_resolve_every_session(self):
        with fleet_walk_budget("imports-inventory", 1) as imports, fleet_walk_budget("transcript-index", 1) as transcripts, fleet_walk_budget("transcript-search", 0), fleet_walk_budget("workspace-tree", 0):
            started = time.monotonic()
            self.assertEqual(supervisor.reconcile(self.slug, active_only=True), [])
            elapsed = time.monotonic() - started
        self.assertEqual(imports.calls, 1)
        self.assertEqual(transcripts.calls, 1)
        with fleet_walk_budget("imports-inventory", 1) as imports:
            seen = supervisor._transcript_evidence(self.org)
        self.assertEqual(imports.calls, 1)
        self.assertTrue(all(seen.get(n["session_id"], "").startswith(str(ROOT / "imports")) for n in self.org.nodes.values()))
        self.assertEqual(len(self.org.nodes), 500)
        self.assertGreaterEqual(sum(1 for _ in (ROOT / "imports").rglob("*")), 19999)
        self.assertLess(elapsed, 30, f"startup reconcile alone spent {elapsed:.2f}s")
        print(f"500-node/20k-entry reconcile: {elapsed:.3f}s, imports walks={imports.calls}", flush=True)

    def test_other_walk_labels_have_real_filesystem_positive_controls(self):
        folder = self.projects / "projects" / "control"
        folder.mkdir(exist_ok=True)
        transcript = folder / "control.jsonl"
        transcript.write_bytes(b"real content")
        for name, walk in [("transcript-search", lambda: supervisor._project_transcripts(str(folder / "*.jsonl"))),
                           ("workspace-tree", lambda: supervisor._workspace_tree_bytes([str(folder)]))]:
            with fleet_walk_budget(name, 1) as budget:
                self.assertTrue(walk())
            self.assertEqual(budget.calls, 1)
            with self.assertRaises(FleetWalkBudgetExceeded):
                with fleet_walk_budget(name, 0):
                    walk()

    def test_resume_frozen_reuses_inventory_before_spawning_workers(self):
        org = store.load_org(self.slug)
        expected = list(org.nodes)[:8]
        for nid in expected:
            org.node(nid)["frozen"] = {"reason": "usage limit", "resume_texts": ["retained turn"], "limit": True}
        store.save_org(org)
        started = []
        class Worker:
            def __init__(self, *, target, args, daemon):
                self.args = args
            def start(self):
                started.append(self.args)
        try:
            with patch.object(supervisor.threading, "Thread", Worker), fleet_walk_budget("imports-inventory", 1) as budget:
                self.assertEqual(supervisor.resume_frozen(self.slug), expected)
            self.assertEqual(budget.calls, 1)
            self.assertEqual([args[1] for args in started], expected, "eligible freezes must actually dispatch")
            self.assertTrue(all(not store.load_org(self.slug).node(n).get("frozen") for n in expected))
        finally:
            for nid in expected:
                supervisor.state(self.slug, nid)["busy"] = False

    def test_reconcile_replays_interrupted_turns_without_rewalking_at_admission(self):
        org = store.load_org(self.slug)
        expected = list(org.nodes)[:6]
        for nid in expected:
            org.node(nid)["inflight"] = {"text": "retained turn", "view": "original view"}
        store.save_org(org)
        started = []
        class Worker:
            def __init__(self, *, target, args, daemon):
                self.args = args
            def start(self):
                started.append(self.args)
        try:
            with patch.object(supervisor.threading, "Thread", Worker), fleet_walk_budget("imports-inventory", 1) as budget:
                self.assertEqual(supervisor.reconcile(self.slug, active_only=True), [])
            self.assertEqual(budget.calls, 1)
            self.assertEqual([args[1] for args in started], expected)
            self.assertTrue(all("retained turn" in args[2]["text"] for args in started))
        finally:
            for nid in expected:
                supervisor.state(self.slug, nid)["busy"] = False

    def test_positive_control_no_reuse_exceeds_budget_on_second_walk(self):
        # Restore the old behavior, not a fake counter: every snapshot read
        # performs the real checked filesystem walk again.
        with patch.object(native.NativeInventory, "read", lambda _: native._native_inventory()):
            with self.assertRaisesRegex(FleetWalkBudgetExceeded, "imports-inventory: walk 2"):
                with fleet_walk_budget("imports-inventory", 1):
                    supervisor.reconcile(self.slug, active_only=True)

    def test_unscoped_calls_are_fresh_and_snapshot_copies_cannot_be_poisoned(self):
        sid = self.org.node("agent0000")["session_id"]
        snapshot = native.NativeInventory()
        with fleet_walk_budget("imports-inventory", 1) as budget:
            found, conflicts = snapshot.read()
            found.clear()
            conflicts.add(sid)
            self.assertIn(sid, snapshot.read()[0])
            self.assertNotIn(sid, snapshot.read()[1])
        self.assertEqual(budget.calls, 1)
        folder = ROOT / "imports" / self.slug / "native" / "duplicate"
        folder.mkdir(exist_ok=True)
        path = folder / f"{sid}.jsonl"
        path.write_text('{"type":"user"}\n')
        try:
            self.assertIn(sid, native.native_conflicts())
            self.assertIn(sid, native.NativeInventory().read()[1])
            self.assertNotIn(sid, snapshot.read()[1], "the pass keeps its explicit snapshot")
        finally:
            path.unlink()
        self.assertNotIn(sid, native.native_conflicts())

    def test_failed_snapshot_does_not_repeat_refusal_and_next_pass_rechecks(self):
        target = ROOT / "junction-target"
        target.mkdir(exist_ok=True)
        link = ROOT / "imports" / self.slug / "native" / "linked"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(target, target_is_directory=True)
        try:
            with fleet_walk_budget("imports-inventory", 1) as budget:
                snapshot = native.NativeInventory()
                for nid in list(self.org.nodes)[:4]:
                    self.assertIn("failed validation", supervisor._native_context_hold(self.org, nid, inventory=snapshot))
            self.assertEqual(budget.calls, 1)
            with self.assertRaises(desktop_import.ImportRefused):
                native.NativeInventory().read()
        finally:
            if os.name == "nt":
                os.rmdir(link)  # detach this verified junction, never recurse
            else:
                link.unlink()
            self.assertFalse(link.exists())
            self.assertTrue(target.is_dir())
        self.assertIsNone(supervisor._native_context_hold(self.org, "agent0000"))

    def test_budget_is_nested_and_thread_local_with_failure_control(self):
        with fleet_walk_budget("imports-inventory", 1) as outer:
            with fleet_walk_budget("imports-inventory", 1) as inner:
                native._native_inventory()
            self.assertEqual(inner.calls, 1)
            self.assertEqual(outer.calls, 1)
            errors = []
            def other_thread():
                try:
                    native._native_inventory()
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=other_thread)
            thread.start(); thread.join(10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(outer.calls, 1)
            with self.assertRaises(FleetWalkBudgetExceeded):
                native._native_inventory()
        with fleet_walk_budget("imports-inventory", 1) as fresh:
            native._native_inventory()
        self.assertEqual(fresh.calls, 1)


if __name__ == "__main__":
    unittest.main()
