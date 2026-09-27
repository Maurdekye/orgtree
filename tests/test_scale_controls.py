"""Qualification controls must expose missed demand and preserve workload identity."""
import random
import threading
import unittest
from tools.scale.control import BoundedPool, Feed, Workload, memory_breach, capability_probe


class ScaleControlTests(unittest.TestCase):
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

    def test_launch_audit_accepts_only_capability_probes(self):
        self.assertTrue(capability_probe('C:/no-cli/claude.exe --version'))
        self.assertTrue(capability_probe('C:/agy.exe --log-file probe.log models'))
        self.assertFalse(capability_probe('C:/claude.exe -p --output-format stream-json'))
        self.assertFalse(capability_probe('C:/codex.exe exec prompt'))
        self.assertFalse(capability_probe('C:/unknown.exe anything'))

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
