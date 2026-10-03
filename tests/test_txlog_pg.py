"""Slow, org-wide and failed org transactions are recorded (orgtree/txlog.py).

Item engine-logging-persist-the-engine-s-output-and-r: during the
2026-10-03 lock jam nothing said which transaction held the org-wide lock.
On actual PostgreSQL (disposable, via test_pgstore) these pin:
  * a transaction that holds its locks past the threshold writes one line
    with its caller label, plan summary, wait/hold ms and outcome; a fast
    one writes nothing;
  * a nodes=ALL transaction is recorded however fast it is;
  * a body that fails is recorded with its error; a refusal (LedgerError)
    is not;
  * a lock timeout names the blocking session: its pid and its caller label
    (every org transaction tags its session's application_name);
  * no message body written by a transaction reaches the file.

Run:  python tools/run-python-verification.py tests/test_txlog_pg.py
"""
import json
import os
import threading
import time
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
from orgtree import orgtx, store, txlog
from orgtree.ledger import LedgerError

SECRET = "body-" + uuid.uuid4().hex


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class TxLog(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass
    raw = lazy.LazyRows.raw
    epoch = lazy.LazyRows.epoch

    def setUp(self):
        lazy.LazyRows.setUp(self)
        p = patch.object(txlog, "THRESHOLD_MS", 300.0)
        p.start()
        self.addCleanup(p.stop)
        # the first whole load heals (its own org-wide transaction) and
        # stamps the epoch; done before the log is cleared
        lazy.LazyRows.stamp(self)
        try:
            os.remove(txlog.path())
        except FileNotFoundError:
            pass

    def rows(self):
        try:
            with open(txlog.path(), encoding="utf-8") as fh:
                return [json.loads(x) for x in fh if x.strip()]
        except FileNotFoundError:
            return []

    def mine(self):
        return [r for r in self.rows() if r["org"] == self.slug]

    def test_a_slow_hold_is_recorded_and_a_fast_one_is_not(self):
        with orgtx.org_tx(self.slug, nodes=['n1'], sections=['notices']):
            pass
        self.assertEqual(self.mine(), [])
        with orgtx.org_tx(self.slug, nodes=['n1', 'n2'], share_nodes=['n3'],
                          sections=['notices'], logs=['events']) as tx:
            tx.d['notices']['n1'] = [{'id': 'x', 'body': SECRET}]
            time.sleep(0.4)
        rows = self.mine()
        self.assertEqual(len(rows), 1, rows)
        r = rows[0]
        self.assertEqual(r["outcome"], "committed")
        self.assertGreaterEqual(r["hold_ms"], 300)
        self.assertIn("test_txlog_pg.test_a_slow_hold_is_recorded", r["label"])
        self.assertEqual((r["plan"]["nodes"], r["plan"]["node_ids"], r["plan"]["share_node_ids"],
                          r["plan"]["sections"], r["plan"]["logs"]),
                         (2, ['n1', 'n2'], ['n3'], ['notices'], ['events']))
        self.assertFalse(r["plan"]["all_nodes"])
        self.assertNotIn(SECRET, open(txlog.path(), encoding="utf-8").read())

    def test_an_all_nodes_transaction_is_always_recorded(self):
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL):
            pass
        rows = self.mine()
        self.assertEqual(len(rows), 1, rows)
        self.assertTrue(rows[0]["plan"]["all_nodes"])
        self.assertEqual(rows[0]["plan"]["nodes"], 30)
        self.assertEqual(len(rows[0]["plan"]["node_ids"]), txlog.MAX_IDS)

    def test_a_failure_is_recorded_and_a_refusal_is_not(self):
        with self.assertRaises(LedgerError):
            with orgtx.org_tx(self.slug, nodes=['n1']):
                raise LedgerError("refused as usual")
        self.assertEqual(self.mine(), [])
        with self.assertRaises(RuntimeError):
            with orgtx.org_tx(self.slug, nodes=['n1']):
                raise RuntimeError("something broke: " + SECRET)
        rows = self.mine()
        self.assertEqual([r["outcome"] for r in rows], ["RuntimeError"])
        # review f1: where it was raised, never the message (it can carry values)
        self.assertIn("test_txlog_pg.py:", rows[0]["raised_at"])
        self.assertNotIn("error", rows[0])
        text = open(txlog.path(), encoding="utf-8").read()
        self.assertNotIn(SECRET, text)
        self.assertNotIn("something broke", text)

    def _fail_at(self, point, exc, times, retries):
        """Raise `exc` at the lock point `point` on the first `times` attempts."""
        seen = []

        def hook(at, tx):
            if at == point and len(seen) < times:
                seen.append(at)
                raise exc("injected: " + SECRET)
        with patch.dict(os.environ, ORGTREE_ORGTX_TEST_HOOKS="1"):
            orgtx.set_pause_hook(hook)
            try:
                with orgtx.org_tx(self.slug, nodes=['n1'], retries=retries):
                    pass
            finally:
                orgtx.set_pause_hook(None)

    def test_a_failed_attempt_is_recorded_even_when_retried_or_fast(self):
        # review f2: Retryable failures took the retry branch unrecorded
        with self.assertRaises(orgtx.SerializationFailure):
            self._fail_at("before_lock", orgtx.SerializationFailure, 1, 0)
        with self.assertRaises(orgtx.DeadlockDetected):
            self._fail_at("before_commit", orgtx.DeadlockDetected, 1, 0)
        self.assertEqual([r["outcome"] for r in self.mine()],
                         ["SerializationFailure", "DeadlockDetected"])
        os.remove(txlog.path())
        # a retry that then succeeds: the failed attempt is still one line,
        # with its own lock plan; the fast successful retry is not logged
        self._fail_at("before_lock", orgtx.SerializationFailure, 1, 2)
        rows = self.mine()
        self.assertEqual([r["outcome"] for r in rows], ["SerializationFailure"], rows)
        self.assertEqual(rows[0]["plan"]["node_ids"], ["n1"])
        self.assertNotIn(SECRET, open(txlog.path(), encoding="utf-8").read())

    def test_a_lock_timeout_names_the_blocking_session(self):
        held, done = threading.Event(), threading.Event()

        def holder_of_n5():
            with orgtx.org_tx(self.slug, nodes=['n5']):
                held.set()
                done.wait(10)
        t = threading.Thread(target=holder_of_n5)
        t.start()
        try:
            self.assertTrue(held.wait(10))
            with self.assertRaises(orgtx.LockTimeout):
                with orgtx.org_tx(self.slug, nodes=['n5'], lock_timeout=0.3, retries=0):
                    pass
        finally:
            done.set()
            t.join(10)
        rows = [r for r in self.mine() if r["outcome"] == "LockTimeout"]
        self.assertEqual(len(rows), 1, self.mine())
        r = rows[0]
        self.assertGreaterEqual(r["wait_ms"], 250)
        self.assertIsInstance(r["blockers"], list, r["blockers"])
        names = [b["label"] for b in r["blockers"] if b["holds_advisory"]]
        self.assertTrue(any("holder_of_n5" in n for n in names), r["blockers"])
        self.assertTrue(all(n.startswith(txlog.APP_PREFIX) for n in names), names)

    def test_the_holder_is_named_ahead_of_older_unrelated_sessions(self):
        # review f3: blockers were the MAX_BLOCKERS oldest advisory sessions,
        # so older unrelated ones pushed the actual holder out of the list
        import contextlib
        from orgtree import pgstore
        held, done = threading.Event(), threading.Event()

        def holder_behind_older_sessions():
            with orgtx.org_tx(self.slug, nodes=['n5']):
                held.set()
                done.wait(10)
        with contextlib.ExitStack() as stack:
            for i in range(txlog.MAX_BLOCKERS + 2):
                c = stack.enter_context(pgstore.connect())
                c.execute(f"BEGIN; SET LOCAL application_name = 'orgtree:unrelated_{i}'")
                c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (902031, i))
            t = threading.Thread(target=holder_behind_older_sessions)
            t.start()
            try:
                self.assertTrue(held.wait(10))
                with pgstore.connect() as c:
                    pids = c.execute("SELECT pid FROM pg_stat_activity WHERE application_name "
                                     "LIKE %s", ("%holder_behind_older_sessions%",)).fetchall()
                self.assertEqual(len(pids), 1, pids)
                with self.assertRaises(orgtx.LockTimeout):
                    with orgtx.org_tx(self.slug, nodes=['n5'], lock_timeout=0.3, retries=0):
                        pass
            finally:
                done.set()
                t.join(10)
        rows = [r for r in self.mine() if r["outcome"] == "LockTimeout"]
        self.assertEqual(len(rows), 1, self.mine())
        bl = rows[0]["blockers"]
        self.assertIsInstance(bl, list, bl)
        self.assertLessEqual(len(bl), txlog.MAX_BLOCKERS)
        self.assertEqual(bl[0]["pid"], pids[0][0], bl)      # ranked first
        self.assertTrue(bl[0]["holds_plan_key"], bl[0])
        self.assertIn("holder_behind_older_sessions", bl[0]["label"])
        self.assertFalse(any(b["holds_plan_key"] for b in bl[1:]), bl)


if __name__ == "__main__":
    unittest.main()
