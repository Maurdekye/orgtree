"""PG-3a lifecycle writers on org_tx (engine/backend/orgtree/lifecycle_tx.py).

Each writer must (1) do exactly what the legacy ledger method did, and (2)
lock EXACTLY the rows it writes: every row its spec declares is needed (drop
one and the commit is refused with UnlockedWrite, writing nothing), and the
writer blocks a concurrent writer of its node row.

Run:  python tools/run-python-verification.py tests/test_pg3a_lifecycle_tx.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-pg3a-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, lifecycle_tx, orgtx, store  # noqa: E402


class MarkUnrecoverable(unittest.TestCase):
    def setUp(self):
        self.slug = "pg3a-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def org(self):
        return store.load_org(self.slug)

    def test_matches_the_legacy_method(self):
        # legacy: the same method on a DOC_LOCK load/save of a twin org
        twin = "pg3a-twin-" + str(time.time_ns())
        o = store.create_org(twin)
        o.hire(ledger.USER, None, "luna", 0, "boss")
        o.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(o)
        boxed = len((self.org().d.get("notices") or {}).get("boss") or [])
        with store.DOC_LOCK:
            o = store.load_org(twin)
            o.mark_unrecoverable("worker", "No conversation found")
            store.save_org(o)
        self.assertTrue(lifecycle_tx.mark_unrecoverable(self.slug, "worker",
                                                        "No conversation found"))
        a, b = store.load_org(twin), self.org()
        self.assertEqual(b.node("worker")["state"], "unrecoverable")
        self.assertEqual(a.node("worker")["state"], b.node("worker")["state"])
        na = (a.d.get("notices") or {}).get("boss") or []
        nb = (b.d.get("notices") or {}).get("boss") or []
        self.assertEqual(len(nb), boxed + 1)          # one notice to the parent
        self.assertEqual(len(na), len(nb))
        self.assertEqual([r["text"] for r in na], [r["text"] for r in nb])
        ev = [e for e in b.d["events"] if e.get("op") == "unrecoverable"]
        self.assertEqual([e["detail"] for e in ev],
                         [{"node": "worker", "reason": "No conversation found"}])
        store._POOL.close_all(twin)

    def test_missing_node_is_false_and_writes_nothing(self):
        before = len(self.org().d["events"])
        self.assertFalse(lifecycle_tx.mark_unrecoverable(self.slug, "ghost", "x"))
        self.assertEqual(len(self.org().d["events"]), before)

    def test_every_declared_row_is_needed(self):
        # negative controls: drop each declared section/log in turn; the
        # commit must be refused and NOTHING written
        spec = lifecycle_tx.SPECS["mark_unrecoverable"]
        drops = [("sections", s) for s in spec.sections] + \
                [("logs", lg) for lg in spec.logs]
        self.assertEqual(len(drops), 3)
        refused = 0
        for field, name in drops:
            smaller = lifecycle_tx.Spec(
                sections=tuple(x for x in spec.sections if (field, x) != ("sections", name)),
                logs=tuple(x for x in spec.logs if (field, x) != ("logs", name)))
            with patch.dict(lifecycle_tx.SPECS, {"mark_unrecoverable": smaller}):
                with self.assertRaises(orgtx.UnlockedWrite, msg=name):
                    lifecycle_tx.mark_unrecoverable(self.slug, "worker", "x")
            refused += 1
            self.assertEqual(self.org().node("worker")["state"], "live", name)
        self.assertEqual(refused, 3)

    def test_holds_the_node_row_against_a_concurrent_writer(self):
        # a writer of the same node row waits for the mark to commit
        order = []
        held, release = threading.Event(), threading.Event()
        os.environ["ORGTREE_ORGTX_TEST_HOOKS"] = "1"
        self.addCleanup(os.environ.pop, "ORGTREE_ORGTX_TEST_HOOKS", None)

        def hook(point, tx):
            if threading.current_thread().name == "mark" and point == "before_commit":
                held.set()
                release.wait(5)
        orgtx.set_pause_hook(hook)
        self.addCleanup(orgtx.set_pause_hook, None)
        self.enterContext(patch.object(halt, "_FENCE", False))   # the row alone must order them

        def mark():
            lifecycle_tx.mark_unrecoverable(self.slug, "worker", "x")
            order.append("mark")

        def other():
            with orgtx.org_tx(self.slug, nodes=["worker"]) as tx:
                order.append("other:" + tx.org.node("worker")["state"])
        t1 = threading.Thread(target=mark, name="mark")
        t1.start()
        self.assertTrue(held.wait(5))
        t2 = threading.Thread(target=other, name="other")
        t2.start()
        time.sleep(0.3)
        self.assertEqual(order, [])          # the other writer is waiting
        release.set()
        t1.join(5)
        t2.join(5)
        self.assertEqual(order, ["mark", "other:unrecoverable"])


if __name__ == "__main__":
    unittest.main()
