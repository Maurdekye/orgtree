"""Small controller controls; never allocates a large fixture."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
import baseline
from baseline_oracle import WriteOracle
from ui_hooks import HookClock, Conditional, hooks
import sql_counts


class ControllerControls(unittest.TestCase):
    def test_large_run_needs_explicit_matching_go_before_creating_root(self):
        args = argparse.Namespace(small_control=False, go_file=None)
        with self.assertRaisesRegex(ValueError, "coordinator GO"):
            baseline.require_go(args, "abc")
        with tempfile.TemporaryDirectory() as folder:
            args.go_file = Path(folder) / "go.json"
            baseline.write(args.go_file, dict(go=True, source="wrong", coordinator_message="mail-id"))
            with self.assertRaisesRegex(ValueError, "exact source"):
                baseline.require_go(args, "abc")

    def test_frozen_external_inventory_refuses_changed_or_extra_file(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source"
            source.mkdir()
            (source / "journal.jsonl").write_text("original\n")
            expected = baseline.inventory(source)
            (source / "journal.jsonl").write_text("corrupt\n")
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                baseline.copy_inventory(source, Path(folder) / "copy", expected)

    def test_slow_tree_does_not_suppress_usage_and_has_one_trailing_read(self):
        clock = HookClock(hooks("test", "worker", 0))
        initial = clock.ready(0)
        self.assertEqual(len(initial), 8)
        for h, _ in initial:
            if h.name != "org_tree":
                clock.complete(h.name)
        clock.event({"type": "changed"}, .01, "worker")
        self.assertEqual(clock.ready(.02), [])
        bumped = {h.name for h, _ in clock.ready(.14)}
        self.assertIn("usage", bumped)
        self.assertNotIn("org_tree", bumped)
        clock.complete("org_tree")
        self.assertEqual([h.name for h, _ in clock.ready(.15)], ["org_tree"])
        self.assertEqual(clock.ready(.16), [])

    def test_stream_is_not_busy_chat_or_tree_demand(self):
        clock = HookClock(hooks("test", "worker", 1))
        for h, _ in clock.ready(0):
            clock.complete(h.name, {"busy": False})
        for i in range(1, 10):
            clock.event(dict(type="node_stream", node="worker", kind="delta"), i / 4, "worker")
            self.assertEqual(clock.ready(i / 4), [])
        self.assertEqual([h.name for h, _ in clock.ready(2.5)], ["chat"])
        clock.complete("chat", {"busy": False})
        self.assertEqual(clock.due["chat"], 9.5)

    def test_work_dedupes_but_plain_hooks_overlap(self):
        clock = HookClock(hooks("test", "worker", 2))
        clock.ready(0)
        clock.event({"type": "changed"}, .01, "worker")
        rows = {h.name for h, _ in clock.ready(.14)}
        self.assertNotIn("work_items", rows)
        self.assertIn("inbox", rows)
        self.assertIn("usage", rows)
        self.assertEqual(clock.active["inbox"], 2)

    def test_one_parent_tree_per_surface_and_one_notification_owner(self):
        all_hooks = [h for w in range(4) for h in hooks("test", "worker", w)]
        self.assertEqual(sum(h.name == "org_tree" for h in all_hooks), 4)
        self.assertEqual(sum(h.name == "notifications" for h in all_hooks), 1)
        self.assertEqual(sum(h.name.endswith("usage") for h in all_hooks), 16)

    def test_conditional_rejects_wrong_base_and_accepts_304(self):
        cache = Conditional()
        with self.assertRaisesRegex(ValueError, "without a cached"):
            cache.accept(304, {}, None)
        cache.accept(200, {"etag": "a"}, {"revision": "r1"})
        with self.assertRaisesRegex(ValueError, "cached revision"):
            cache.accept(200, {"etag": "b"}, {"revision": "r2", "base": "wrong", "delta": {}})
        self.assertEqual(cache.etag, "a")
        cache.accept(200, {"etag": "b"}, {"revision": "r2", "base": "r1", "delta": {}})
        cache.accept(304, {}, None)
        self.assertEqual(cache.revision, "r2")


ADMIN = os.environ.get("ORGTREE_TEST_PG_ADMIN_URL")


@unittest.skipUnless(ADMIN, "disposable PG required: NOT RUN")
class StorageControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg.conninfo import make_conninfo
        cls.db = "orgtree_scale_controller_" + str(os.getpid())
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute("CREATE DATABASE " + cls.db)
        cls.url = make_conninfo(ADMIN, dbname=cls.db)
        cls.writer = psycopg.connect(cls.url, autocommit=True)
        cls.writer.execute("CREATE TABLE public.orgs(org_id int,slug text)")
        cls.writer.execute("INSERT INTO public.orgs VALUES(1,'test')")
        cls.writer.execute("CREATE SCHEMA org_1")
        cls.writer.execute("CREATE TABLE org_1.nodes(id text,val text)")
        cls.writer.execute("CREATE TABLE org_1.doc(key text,val text)")
        cls.writer.execute("CREATE TABLE org_1.log_d(seq bigint,sect text,owner text,val text)")

    @classmethod
    def tearDownClass(cls):
        import psycopg
        cls.writer.close()
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute("DROP DATABASE " + cls.db + " WITH (FORCE)")

    def setUp(self):
        for table in ("nodes", "doc", "log_d"):
            self.writer.execute("TRUNCATE org_1." + table)

    def test_reserved_oracle_sees_later_commit_and_refuses_corruption(self):
        oracle = WriteOracle(dict(org="test", pg_url=self.url))
        self.addCleanup(oracle.close)
        args = dict(status="working", summary="expected")
        self.writer.execute("INSERT INTO org_1.nodes VALUES('worker',%s)", (json.dumps({"last_status": args}),))
        with patch("baseline_oracle.psycopg.connect", side_effect=AssertionError("new oracle socket")):
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                checks = list(pool.map(lambda _: oracle.check("worker", "orgtree_status", args, {}), range(4)))
        self.assertTrue(all(c["passed"] for c in checks))
        self.writer.execute("UPDATE org_1.nodes SET val='{}'")
        self.assertFalse(oracle.check("worker", "orgtree_status", args, {})["passed"])
        self.assertEqual(oracle.counts, dict(acknowledged=5, checked=5, failed=1))

    def test_all_append_kinds_and_missing_receipt_fail_closed(self):
        oracle = WriteOracle(dict(org="test", pg_url=self.url))
        self.addCleanup(oracle.close)
        message = dict(to="boss", body="unique-body")
        self.writer.execute("INSERT INTO org_1.log_d VALUES(1,'mail_log','boss',%s)",
                            (json.dumps(dict(id="m1", body="unique-body")),))
        self.assertTrue(oracle.check("worker", "orgtree_message", message, {"id": "m1"})["passed"])
        self.assertFalse(oracle.check("worker", "orgtree_send_notice", message, {"id": "wrong"})["passed"])
        item = dict(title="title", objective="objective", evidence=[dict(ref="r", note="n")])
        self.writer.execute("INSERT INTO org_1.doc VALUES(%s,%s)", ("work_items\x1fone", json.dumps(item)))
        self.assertTrue(oracle.check("worker", "orgtree_work", dict(action="create", title="title",
            objective="objective"), {"created": "one"})["passed"])
        self.assertTrue(oracle.check("worker", "orgtree_work", dict(action="evidence", slug="one",
            ref="r", note="n"), {})["passed"])
        self.assertFalse(oracle.check("worker", "orgtree_work", dict(action="update", slug="one",
            done_so_far=["absent"], working_on_next=[]), {})["passed"])
        self.assertFalse(oracle.check("worker", "orgtree_status", {}, {"state": "running"})["passed"])

    def test_sql_counters_measure_executed_fetch_modes_exactly(self):
        restore = sql_counts.install()
        self.addCleanup(restore)
        counts = sql_counts.empty()
        token = sql_counts.current.set(counts)
        try:
            self.writer.execute("INSERT INTO org_1.nodes VALUES(%s,%s)", ("x", "é"))
            self.writer.execute("SELECT 'abc' UNION ALL SELECT 'de'").fetchall()
            cur = self.writer.execute("SELECT 'abc' UNION ALL SELECT 'de'")
            self.assertEqual(cur.fetchone(), ("abc",))
            self.assertEqual(cur.fetchmany(2), [("de",)])
            self.assertEqual(list(self.writer.execute("SELECT 'abc' UNION ALL SELECT 'de'")), [("abc",), ("de",)])
        finally:
            sql_counts.current.reset(token)
        self.assertEqual(counts["statements"], 4)
        self.assertEqual(counts["rows"], 6)
        self.assertEqual(counts["value_bytes"], 15)
        self.assertEqual(counts["parameter_bytes"], 3)
        self.assertEqual(counts["write_parameter_bytes"], 3)


if __name__ == "__main__":
    unittest.main()
