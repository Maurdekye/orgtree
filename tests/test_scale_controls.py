"""Qualification controls must expose missed demand and preserve workload identity."""
import random
import threading
import unittest
import subprocess
import sys
from unittest.mock import patch

import psutil

from tools.scale.control import BoundedPool, Feed, Workload, guarded_wait, memory_breach
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


class ScaleControlTests(unittest.TestCase):
    def test_feed_receipts_preserve_first_arrival_and_ignore_retired_markers(self):
        feed = Feed(1)
        feed.emit(7, 10)
        self.assertEqual(feed.receive(0, 7, 10.5),
                         {'w': 0, 'm': 7, 'emit': 10, 'receive': 10.5})
        self.assertIsNone(feed.receive(0, 7, 11))
        feed.acknowledge([7], True)
        feed.retire(16)
        self.assertIsNone(feed.receive(0, 7, 17))
        self.assertEqual(list(feed.latencies[0]), [500])

    def test_saturated_producer_is_bounded_and_records_rejected_demand(self):
        release, entered = threading.Event(), threading.Event()
        calls = []
        def work(n):
            entered.set()
            release.wait(5)
            calls.append(n)
        pool = BoundedPool(1)
        try:
            self.assertTrue(pool.submit(work, 1))
            self.assertTrue(entered.wait(2), "worker must actually execute")
            self.assertTrue(pool.submit(work, 2))
            self.assertFalse(pool.submit(work, 3))
            self.assertEqual(pool.counts["peak_outstanding"], 2)
            self.assertEqual(pool.counts["rejected"], 1)
        finally:
            release.set()
            pool.shutdown()
        self.assertIn(1, calls)
        self.assertNotIn(3, calls)
        self.assertEqual(pool.counts["completed"] + pool.counts["cancelled"], 2)

    def test_async_worker_failure_is_not_success(self):
        pool = BoundedPool(1)
        entered = threading.Event()
        def fail():
            entered.set()
            raise ValueError("executed negative control")
        try:
            pool.submit(fail)
            self.assertTrue(entered.wait(2))
        finally:
            pool.shutdown()
        self.assertEqual(pool.counts["worker_errors"], 1)

    def test_guarded_wait_survives_a_child_that_exits_during_children(self):
        # mem-leak-probe's heavy repro (2026-09-28): the seed child exited
        # between poll() and children(), and NoSuchProcess escaped.
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"])
        def gone(self, recursive=False):
            raise psutil.NoSuchProcess(proc.pid)
        with patch.object(psutil.Process, "children", gone),                 patch("tools.scale.control.free_commit_gb", return_value=100.0):
            self.assertEqual(guarded_wait(proc), 0)

    def test_guarded_wait_survives_a_child_already_gone(self):
        proc = subprocess.Popen([sys.executable, "-c", "raise SystemExit(3)"])
        proc.wait()
        real = psutil.Process
        def process(pid=None):
            if pid == proc.pid:
                raise psutil.NoSuchProcess(pid)
            return real() if pid is None else real(pid)
        with patch("psutil.Process", process),                 patch("tools.scale.control.free_commit_gb", return_value=100.0):
            self.assertEqual(guarded_wait(proc), 3)

    def test_low_commit_and_combined_size_stop_even_with_small_engine(self):
        gb = 2 ** 30
        self.assertIsNone(memory_breach(10, 4 * gb, 3 * gb))
        self.assertIsNotNone(memory_breach(9.99, gb, gb))
        self.assertIsNotNone(memory_breach(None, gb, gb))
        self.assertIsNotNone(memory_breach(20, 6 * gb, 0))
        self.assertIsNotNone(memory_breach(20, 4 * gb, 5 * gb))

    def test_feed_counts_delivery_miss_and_excludes_failed_injection(self):
        feed = Feed(2)
        for marker in (1, 2, 3):
            feed.emit(marker, 10)
        feed.receive(0, 1, 10.3)
        feed.receive(1, 1, 11.5)
        feed.receive(0, 1, 12)  # repeated snapshot must not move first receipt
        feed.acknowledge([1, 2], True)
        feed.acknowledge([3], False)
        feed.retire(16)
        self.assertEqual(len(feed.pending), 0)
        self.assertEqual(feed.failed, 1)
        for window in range(2):
            self.assertEqual(feed.counts[window]["due"], 2)
            self.assertEqual(feed.counts[window]["missing"], 1)
        self.assertAlmostEqual(feed.latencies[0][0], 300)
        self.assertEqual(feed.counts[1]["over_1s"], 1)
        feed.receive(0, 2, 17)  # already past the documented 5-second horizon
        feed.retire(20)
        self.assertEqual(feed.counts[0]["missing"], 1)

    def test_feed_waits_for_injection_outcome_before_retiring(self):
        feed = Feed(1)
        feed.emit(1, 0)
        feed.receive(0, 1, .5)
        feed.retire(10)
        self.assertEqual(feed.counts[0]["due"], 0)
        feed.acknowledge([1], True)
        feed.retire(10)
        self.assertEqual(feed.counts[0]["missing"], 0)
        self.assertEqual(feed.counts[0]["due"], 1)

    def test_late_arrival_remains_a_miss_when_retirement_is_delayed(self):
        feed = Feed(2)
        feed.emit(1, 10)
        feed.receive(0, 1, 29.4)
        feed.receive(1, 1, 15)  # exactly five seconds meets the accounting horizon
        feed.acknowledge([1], True)
        feed.retire(30)
        self.assertEqual(feed.counts[0]["missing"], 1)
        self.assertEqual(feed.counts[1]["missing"], 0)
        self.assertAlmostEqual(feed.latencies[0][0], 19400)
        self.assertEqual(feed.counts[0]["over_1s"], 1)

    def test_requests_use_real_parents_and_owners_and_report_capacity_limits(self):
        metadata = dict(parents={"top": None, "a": "top", "b": "top"},
                        active_items=200,
                        items=[dict(slug="task", owner="b", evidence=49)])
        load = Workload(metadata, list(metadata["parents"]))
        rng = random.Random(1)
        for _ in range(5):
            me, tool, args = load.select("top", "orgtree_message", {"to": "invalid"}, rng)
            self.assertIn(me, ("a", "b"))
            self.assertEqual(args["to"], "top")
        me, _, args = load.select("a", "orgtree_work", dict(action="evidence"), rng)
        self.assertEqual((me, args["slug"], args["action"]), ("b", "task", "evidence"))
        _, _, args = load.select("a", "orgtree_work", dict(action="evidence"), rng)
        self.assertEqual(args["action"], "update")
        _, _, args = load.select("a", "orgtree_work", dict(action="create"), rng)
        self.assertEqual(args["action"], "update")
        self.assertEqual(load.substitutions, dict(evidence_capacity=1, create_capacity=1))
        subset = Workload(metadata, ["b"])
        me, _, args = subset.select("b", "orgtree_message", {"to": "invalid"}, rng)
        self.assertEqual((me, args["to"]), ("b", "top"))
        self.assertEqual(len(subset.items), 1)
        with self.assertRaises(ValueError):
            Workload(metadata, ["missing"])


if __name__ == "__main__":
    unittest.main()
