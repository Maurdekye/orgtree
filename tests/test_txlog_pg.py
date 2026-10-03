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
                raise RuntimeError("something broke")
        rows = self.mine()
        self.assertEqual([r["outcome"] for r in rows], ["RuntimeError"])
        self.assertIn("something broke", rows[0]["error"])

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


if __name__ == "__main__":
    unittest.main()
