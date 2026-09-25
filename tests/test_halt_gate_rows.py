"""halt.delivery / halt.admission `rows=`: a wrapped body declares its own
rows and the gate locks them together with its own (nid FOR UPDATE, the
killswitch FOR SHARE) in ONE transaction. Without `rows` the gate locks
exactly what it always did, so a body writing beyond nid is refused with
UnlockedWrite; with `rows` naming that write, it commits.

Run:  python tools/run-python-verification.py tests/test_halt_gate_rows.py
"""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-gaterows-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, orgtx, store  # noqa: E402


def _write_mail(slug, nid, *_a, **_k):
    """A converted body: writes the `mail` section and the (mail_log, nid) log
    through the gate's transaction."""
    tx = halt.current_tx()
    tx.org.d.setdefault("mail", {}).setdefault(nid, []).append({"t": "x"})
    seen.append((frozenset(tx.lock_nodes), frozenset(tx.lock_sections),
                 frozenset(tx.share_sections), frozenset(tx.logs)))
    return "ran"


seen: list = []
MAIL_ROWS = lambda slug, nid, *a, **k: {"sections": ["mail"]}  # noqa: E731


class GateRows(unittest.TestCase):
    def setUp(self):
        seen.clear()
        self.slug = "gaterows-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def mail(self):
        return (store.load_org(self.slug).d.get("mail") or {}).get("worker") or []

    def test_delivery_without_rows_refuses_the_extra_write(self):
        gated = halt.delivery(lambda: "empty")(_write_mail)
        with self.assertRaises(orgtx.UnlockedWrite):
            gated(self.slug, "worker")
        self.assertEqual(len(seen), 1)                 # the body did run
        nodes, sections, share, _logs = seen[0]
        self.assertEqual(nodes, {"worker"})
        self.assertEqual(sections, frozenset())
        self.assertEqual(share, {halt.KILLSWITCH})
        self.assertEqual(self.mail(), [])              # nothing saved

    def test_delivery_with_rows_locks_the_union(self):
        calls = []

        def rows(slug, nid, extra, *, flag=None):
            calls.append((slug, nid, extra, flag))
            return {"sections": ["mail"], "nodes": ["boss"]}
        gated = halt.delivery(lambda: "empty", rows=rows)(_write_mail)
        self.assertEqual(gated(self.slug, "worker", 7, flag="f"), "ran")
        self.assertEqual(calls, [(self.slug, "worker", 7, "f")])  # same arguments
        nodes, sections, share, _logs = seen[0]
        self.assertEqual(nodes, {"worker", "boss"})
        self.assertEqual(sections, {"mail"})
        self.assertEqual(share, {halt.KILLSWITCH})
        self.assertEqual(len(self.mail()), 1)          # committed

    def test_admission_bare_and_with_rows(self):
        bare = halt.admission(_write_mail)
        with self.assertRaises(orgtx.UnlockedWrite):
            bare(self.slug, "worker", "hello")
        declared = halt.admission(
            rows=lambda slug, nid, text, *a, **k: {"sections": ["mail"]})(_write_mail)
        self.assertEqual(declared(self.slug, "worker", "hello"), "ran")
        self.assertEqual(len(self.mail()), 1)
        self.assertEqual(seen[-1][1], {"mail"})

    def test_rows_object_with_attributes_and_string_refused(self):
        class Spec:
            sections = ("mail",)
        gated = halt.delivery(lambda: "empty", rows=lambda *a, **k: Spec())(_write_mail)
        self.assertEqual(gated(self.slug, "worker"), "ran")
        bad = halt.delivery(lambda: "empty",
                            rows=lambda *a, **k: {"sections": "mail"})(_write_mail)
        with self.assertRaises(TypeError):
            bad(self.slug, "worker")

    def test_blocked_gate_still_returns_empty_with_rows(self):
        with halt.txn(self.slug, nodes=["worker"]) as tx:
            tx.org.node("worker")["halt"] = {"phase": "halted"}
        gated = halt.delivery(lambda: "empty", rows=MAIL_ROWS)(_write_mail)
        self.assertEqual(gated(self.slug, "worker"), "empty")
        self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main()
