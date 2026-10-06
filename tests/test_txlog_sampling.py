"""A slow transaction's log line says where its held time went (orgtree/txlog.py).

Item 3-2-0-engine-transactions-stay-open-for-10-17-s: on alpha.4 turn:run
held its locks 17.5 s on shared locks only and a reservation call sat idle
in transaction 10.5 s, and the line said nothing about what the holder did.
These pin, with no database (the lock points are driven directly, as
orgtx's backends drive them):
  * the hold is split into load_ms / body_ms / commit_ms, plus cpu_ms (a
    sleeping body shows CPU far below its hold);
  * a hold past SAMPLE_AFTER_S carries the holder's sampled stacks, and the
    function doing the work is named in them;
  * a fast hold is not sampled; an attempt ended without a line (discard)
    or one that never reached its locks leaves nothing registered;
  * a nested hold on the same thread is one hold;
  * no value from the body reaches the file (stacks are names only).

Run:  python tools/run-python-verification.py tests/test_txlog_sampling.py
"""
import json
import os
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import txlog

SECRET = "body-" + uuid.uuid4().hex


class FakeTx:
    def __init__(self):
        self.slug = "acme"
        self.log_label = "test:sampling"
        self.log_marks = {}
        self.lock_nodes = frozenset({"n1"})
        self.share_nodes = frozenset()
        self.lock_sections = frozenset()
        self.share_sections = frozenset()
        self.logs = []
        self.all_nodes = False
        self.whole = False
        self.replayed = False


def slow_body_doing_work(seconds, secret):
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        time.sleep(0.01)
    return len(secret)


class Sampling(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="txlog-sampling-")
        self.path = os.path.join(self.dir, "slow-transactions.jsonl")
        for p in (patch.object(txlog, "path", lambda: self.path),
                  patch.object(txlog, "THRESHOLD_MS", 300.0),
                  patch.object(txlog, "SAMPLE_AFTER_S", 0.1),
                  patch.object(txlog, "SAMPLE_S", 0.02)):
            p.start()
            self.addCleanup(p.stop)

    def rows(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                return [json.loads(x) for x in fh if x.strip()]
        except FileNotFoundError:
            return []

    def run_tx(self, load_s, body_s, commit_s, exc=None):
        tx = FakeTx()
        started = time.perf_counter()
        txlog.mark("before_lock", tx)
        txlog.mark("after_lock", tx)
        time.sleep(load_s)
        txlog.mark("loaded", tx)
        slow_body_doing_work(body_s, SECRET)
        txlog.mark("before_commit", tx)
        time.sleep(commit_s)
        txlog.finish([tx], started, exc)
        return tx

    def test_a_slow_hold_is_split_and_sampled(self):
        self.run_tx(0.05, 0.6, 0.05)
        rows = self.rows()
        self.assertEqual(len(rows), 1, rows)
        r = rows[0]
        self.assertGreaterEqual(r["hold_ms"], 650)
        self.assertGreaterEqual(r["body_ms"], 550)
        self.assertLess(r["load_ms"], 400)
        self.assertLess(r["commit_ms"], 400)
        # a sleeping body: the thread's CPU is far below its hold
        self.assertLess(r["cpu_ms"], r["hold_ms"] / 2)
        self.assertGreater(r["samples"], 5)
        self.assertLessEqual(len(r["stacks"]), txlog.TOP_STACKS)
        self.assertTrue(any("slow_body_doing_work" in s["stack"] for s in r["stacks"]),
                        r["stacks"])
        self.assertTrue(all(":" in s["stack"] for s in r["stacks"]))
        self.assertNotIn(SECRET, open(self.path, encoding="utf-8").read())
        self.assertEqual(txlog._HOLDS, {})

    def test_a_fast_hold_is_not_logged_or_sampled(self):
        self.run_tx(0.0, 0.01, 0.0)
        self.assertEqual(self.rows(), [])
        self.assertEqual(txlog._HOLDS, {})

    def test_a_failure_carries_the_split_too(self):
        self.run_tx(0.0, 0.02, 0.0, exc=RuntimeError(SECRET))
        r = self.rows()[0]
        self.assertEqual(r["outcome"], "RuntimeError")
        self.assertIn("body_ms", r)
        self.assertNotIn(SECRET, open(self.path, encoding="utf-8").read())

    def test_discard_and_unlocked_attempts_leave_nothing_registered(self):
        tx = FakeTx()
        txlog.mark("after_lock", tx)
        self.assertEqual(len(txlog._HOLDS), 1)
        txlog.discard([tx])
        self.assertEqual(txlog._HOLDS, {})
        # an attempt that never reached after_lock must not end another hold
        outer = FakeTx()
        txlog.mark("after_lock", outer)
        txlog.finish([FakeTx()], time.perf_counter(), RuntimeError("before lock"))
        self.assertEqual(len(txlog._HOLDS), 1)
        txlog.discard([outer])
        self.assertEqual(txlog._HOLDS, {})

    def test_a_multi_org_attempt_unregisters_every_org(self):
        # review-sol: transaction_many marks after_lock once per org
        a, b = FakeTx(), FakeTx()
        b.slug = "beta"
        started = time.perf_counter()
        txlog.mark("after_lock", a)
        txlog.mark("after_lock", b)
        slow_body_doing_work(0.4, SECRET)
        txlog.finish([a, b], started, None)
        self.assertEqual(txlog._HOLDS, {})
        rows = self.rows()
        self.assertEqual({r["org"] for r in rows}, {"acme", "beta"})
        self.assertTrue(all(r.get("stacks") for r in rows), rows)
        # a refused (discarded) multi-org attempt too
        c, d = FakeTx(), FakeTx()
        txlog.mark("after_lock", c)
        txlog.mark("after_lock", d)
        txlog.discard([c, d])
        self.assertEqual(txlog._HOLDS, {})

    def test_a_multi_org_attempt_nested_in_another_hold(self):
        outer = FakeTx()
        started = time.perf_counter()
        txlog.mark("after_lock", outer)
        a, b = FakeTx(), FakeTx()
        txlog.mark("after_lock", a)
        txlog.mark("after_lock", b)
        txlog.discard([a, b])
        self.assertEqual(len(txlog._HOLDS), 1, "the outer hold must survive")
        slow_body_doing_work(0.4, SECRET)
        txlog.finish([outer], started, None)
        self.assertEqual(txlog._HOLDS, {})
        self.assertTrue(self.rows()[0].get("stacks"))

    def test_a_nested_hold_is_one_hold(self):
        outer, inner = FakeTx(), FakeTx()
        started = time.perf_counter()
        txlog.mark("after_lock", outer)
        txlog.mark("after_lock", inner)
        txlog.discard([inner])
        self.assertEqual(len(txlog._HOLDS), 1)
        slow_body_doing_work(0.4, SECRET)
        txlog.finish([outer], started, None)
        self.assertEqual(txlog._HOLDS, {})
        r = self.rows()[0]
        self.assertTrue(any("slow_body_doing_work" in s["stack"] for s in r["stacks"]))


if __name__ == "__main__":
    unittest.main()
