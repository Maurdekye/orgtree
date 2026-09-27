"""Small controller controls; never allocates a large fixture."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
import baseline
from baseline_oracle import WriteOracle
from ui_hooks import HookClock, Conditional, WindowDriver, hooks
import sql_counts


class ControllerControls(unittest.TestCase):
    def test_drain_retains_passive_mail_but_refuses_waking_or_unaccounted_mail(self):
        from settlement import settled
        row = dict(mail=1, waking_mail=0, passive_mail=1, delivering=0, inflight=0, busy=0, queued=0)
        self.assertTrue(settled(row))
        self.assertFalse(settled({**row, "waking_mail": 1, "passive_mail": 0}))
        self.assertFalse(settled({**row, "mail": 2}))
        self.assertFalse(settled({**row, "delivering": 1}))
        self.assertFalse(settled({}))
    def test_database_identity_excludes_connection_options(self):
        self.assertEqual(baseline.database_name("postgresql://localhost:5432/orgtree_scale_small?sslmode=disable"),
                         "orgtree_scale_small")

    def test_notification_owner_reads_every_page_and_records_real_urls(self):
        from unittest.mock import Mock
        client = Mock()
        pages = [{"truncated": True, "next_offset": 50}, {"truncated": False}]
        client.get.side_effect = [SimpleNamespace(status_code=200, content=b"{}", num_bytes_downloaded=2,
            headers={}, json=lambda page=page: page, raise_for_status=lambda: None) for page in pages]
        rows = []
        recorder = SimpleNamespace(write=lambda name, row: rows.append(row))
        with patch("httpx.Client", return_value=client):
            driver = WindowDriver("test", "worker", 0, "http://localhost", {}, recorder, threading.Event())
        driver.started = 1
        driver.clock.active["notifications"] = 1
        try:
            driver.fetch(driver.clock.specs["notifications"], 1)
        finally:
            driver.pool.shutdown()
            client.close()
        self.assertEqual([r["url"] for r in rows], ["/api/desktop/notifications", "/api/desktop/notifications?offset=50"])
        self.assertTrue(all(r["err"] is None for r in rows))
        self.assertEqual(driver.clock.active["notifications"], 0)
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

    def test_work_delta_requires_every_ordered_row(self):
        cache = Conditional()
        cache.accept(200, {"etag": "a"}, {"revision": "r1", "items": [{"slug": "one", "value": 1}]})
        cache.accept(200, {"etag": "b"}, {"revision": "r2", "base": "r1", "delta": {
            "items": {"order": ["two"], "upsert": [{"slug": "two", "value": 2}]}}})
        self.assertEqual(cache.body["items"], [{"slug": "two", "value": 2}])
        with self.assertRaisesRegex(ValueError, "missing row"):
            cache.accept(200, {"etag": "c"}, {"revision": "r3", "base": "r2", "delta": {
                "items": {"order": ["missing"], "upsert": []}}})
        self.assertEqual(cache.revision, "r2")

    def test_tree_patch_removes_nodes_and_rejects_unreachable_data(self):
        cache = Conditional()
        cache.accept(200, {"etag": "a"}, {"format": "orgtree.tree/v1", "revision": "r1",
            "tree": {"roots": [{"id": "a", "children": [{"id": "b", "children": []}]}]}})
        patch = {"format": "orgtree.tree/v1", "revision": "r2", "base": "r1",
            "top": {"set": {}, "remove": []}, "nodes": {
                "a": {"set": {"children": []}, "remove": []}}, "removed": []}
        with self.assertRaisesRegex(ValueError, "unreachable"):
            cache.accept(200, {"etag": "b"}, patch)
        patch["removed"] = ["b"]
        cache.accept(200, {"etag": "b", "x-orgtree-sync-rev": "7"}, patch)
        cache.accept(304, {"x-orgtree-sync-rev": "9"}, None)
        self.assertEqual(cache.body, {"roots": [{"id": "a", "children": []}], "sync_rev": 9})

    def test_stream_revision_gap_triggers_tree_without_live_poll_storm(self):
        clock = HookClock(hooks("test", "worker", 0))
        for hook, _ in clock.ready(0):
            clock.complete(hook.name)
        clock.event(dict(type="node_stream", node="worker", kind="delta", rev=1), .1, "worker")
        self.assertEqual(clock.ready(.1), [])
        clock.event(dict(type="node_stream", node="worker", kind="delta", rev=3), .2, "worker")
        self.assertEqual([h.name for h, _ in clock.ready(.2)], ["org_tree"])

    def test_chat_pulse_forces_refresh_while_heartbeat_dedupes(self):
        clock = HookClock(hooks("test", "worker", 1))
        for h, _ in clock.ready(0):
            if h.name != "chat":
                clock.complete(h.name)
        clock.event(dict(type="node_event", node="worker", event="turn_done"), .1, "worker")
        self.assertIn("chat", [h.name for h, _ in clock.ready(.1)])
        self.assertNotIn("chat", [h.name for h, _ in clock.ready(2.5)])
        self.assertEqual(clock.active["chat"], 2)

    def test_work_hooks_use_current_foreground_route_and_reject_wrong_format(self):
        for window in (0, 1, 2):
            hook = next(h for h in hooks("test", "worker", window) if h.name == "work_items")
            self.assertEqual(hook.url, "/api/orgs/test/work-items-foreground?backlogged=0&archive_limit=0")
        cache = Conditional("orgtree.work-foreground/v1")
        with self.assertRaisesRegex(ValueError, "foreground work format"):
            cache.accept(200, {"etag": "wrong"}, {"items": []})
        self.assertIsNone(cache.etag)
        cache.accept(200, {"etag": "right"}, {"format": "orgtree.work-foreground/v1", "items": []})
        cache.accept(304, {}, None)
        self.assertEqual(cache.body["items"], [])

    def test_older_chat_answer_cannot_replace_busy_state_or_hold_new_heartbeat(self):
        clock = HookClock(hooks("test", "worker", 1))
        first = next(h for h, _ in clock.ready(0) if h.name == "chat")
        clock.event(dict(type="node_event", node="worker"), .1, "worker")
        second = next(h for h, _ in clock.ready(.1) if h.name == "chat")
        clock.complete("chat", {"busy": True}, second.request_serial)
        self.assertTrue(clock.busy)
        # The newest request has settled; an older forced fetch cannot keep
        # the heartbeat latched. A later stale answer cannot change busy.
        third = next(h for h, _ in clock.ready(2.5) if h.name == "chat")
        clock.complete("chat", {"busy": False}, first.request_serial)
        self.assertTrue(clock.busy)
        self.assertTrue(clock.chat_inflight)
        clock.complete("chat", {"busy": False}, third.request_serial)
        self.assertFalse(clock.busy)
        self.assertFalse(clock.chat_inflight)


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

    def test_right_id_wrong_body_and_running_state_each_fail_on_their_own_guard(self):
        # Review f2: each case below would PASS if only its one guard were removed.
        oracle = WriteOracle(dict(org="test", pg_url=self.url))
        self.addCleanup(oracle.close)
        self.writer.execute("INSERT INTO org_1.log_d VALUES(1,'mail_log','boss',%s)",
                            (json.dumps(dict(id="m1", body="stored-body")),))
        wrong_body = oracle.check("worker", "orgtree_message", dict(to="boss", body="sent-body"), {"id": "m1"})
        self.assertEqual(wrong_body, dict(passed=False, method="independent committed raw rows"))
        args = dict(status="working", summary="expected")
        self.writer.execute("INSERT INTO org_1.nodes VALUES('worker',%s)", (json.dumps({"last_status": args}),))
        self.assertTrue(oracle.check("worker", "orgtree_status", args, {})["passed"])
        running = oracle.check("worker", "orgtree_status", args, {"state": "running"})
        self.assertFalse(running["passed"])
        self.assertIn("no committed outcome", running["error"])
        self.assertEqual(oracle.counts, dict(acknowledged=3, checked=2, failed=2))

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

    def test_sql_batch_counts_each_statement_and_each_bound_byte(self):
        undo = sql_counts.install()
        self.addCleanup(undo)
        counts = sql_counts.empty()
        token = sql_counts.current.set(counts)
        try:
            with self.writer.cursor() as cursor:
                cursor.executemany("INSERT INTO org_1.nodes VALUES(%s,%s)", [("a", "é"), ("b", "xyz")])
            self.assertEqual(self.writer.execute("SELECT id,val FROM org_1.nodes ORDER BY id").fetchall(),
                             [("a", "é"), ("b", "xyz")])
        finally:
            sql_counts.current.reset(token)
        self.assertEqual(counts["statements"], 3)
        self.assertEqual(counts["rows"], 2)
        self.assertEqual(counts["write_parameter_bytes"], 7)
        self.assertEqual(counts["value_bytes"], 7)
        self.assertEqual(counts["executemany_batches"], 1)
        self.assertEqual(counts["unsupported_operations"], 0)


if __name__ == "__main__":
    unittest.main()
