"""S3 (fence-off): orgtree_halt / orgtree_unhalt receipts off DOC_LOCK.

The halt itself already runs on `halt.txn`. What stayed on the legacy
whole-document cycle was the receipt: the admission (authority for every
target + `_op_admit`) and the filing (`_op_file` + save). Now the admission
reads lock-free (`orgtx.org_read`, the receipt log) and the filing is its own
row transaction on the receipt META row and log — PRE coverage, as before.

The DOC_LOCK tripwire (S8) counts every legacy acquisition and every save
outside an org_tx per call site; no api.py site may appear for these tools.

Run:  python tools/run-python-verification.py tests/test_s3_halt_receipts.py
"""
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-s3-halt-",
                                    ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from fastapi import HTTPException  # noqa: E402
from orgtree import (api, ledger, opreceipts, store,  # noqa: E402
                     supervisor as sup, warmpool)

REQUEST = SimpleNamespace(state=SimpleNamespace())


class HaltReceipts(unittest.TestCase):
    def setUp(self):
        self.slug = "s3halt-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "w1")
        org.hire(ledger.USER, "boss", "luna", 0, "w2")
        org.hire(ledger.USER, None, "luna", 0, "other")
        store.save_org(org)
        self.stack = ExitStack()
        for name in ("_cancel_working_cache", "notify"):
            self.stack.enter_context(patch.object(sup, name))
        for name in ("kill_node", "poke"):
            self.stack.enter_context(patch.object(warmpool, name))

    def tearDown(self):
        self.stack.close()
        store._POOL.close_all(self.slug)

    def call(self, tool, args, actor="boss"):
        return api.agent_call(api.AgentCall(org=self.slug, node=actor,
                                            tool=tool, args=args), REQUEST)

    def keyed(self, tool, args, actor="boss"):
        epoch = self.call(opreceipts.OP_EPOCH, {}, actor)["epoch"]
        call = {"tool": tool, "args": args, "op_key": opreceipts.mint_key(),
                "op_epoch": epoch}
        return call, self.call(opreceipts.OP_CALL, call, actor)

    def receipts(self):
        return [r for r in store.load_org(self.slug).d.get(opreceipts.SECTION)
                or [] if r.get("tool") in ("orgtree_halt", "orgtree_unhalt")]

    @staticmethod
    def api_sites(counts):
        """Legacy DOC_LOCK acquisitions and saves outside an org_tx whose
        first frame is in api.py (the halt/unhalt receipt blocks)."""
        return {k: [s for s in counts[k] if s.startswith("api.py:")]
                for k in ("legacy", "save")}

    def test_keyed_halt_and_unhalt_file_receipts_without_the_legacy_cycle(self):
        with store.doc_lock_tripwire(raising=False) as counts:
            call, r = self.keyed("orgtree_halt", {"node": "w1"})
            self.assertTrue(r["halted"], r)
            replay = self.call(opreceipts.OP_CALL, call)
            self.assertTrue(replay["replayed"], replay)
            self.assertTrue(replay["receipt"]["result"]["halted"])
            _, u = self.keyed("orgtree_unhalt", {"node": "w1"})
            self.assertTrue(u["unhalted"], u)
        self.assertEqual(self.api_sites(counts), {"legacy": [], "save": []},
                         counts)
        self.assertEqual([r["tool"] for r in self.receipts()],
                         ["orgtree_halt", "orgtree_unhalt"])
        self.assertEqual(opreceipts.coverage("orgtree_halt", {}), opreceipts.PRE)

    def test_a_keyed_batch_halt_files_one_receipt(self):
        with store.doc_lock_tripwire(raising=False) as counts:
            _, r = self.keyed("orgtree_halt", {"nodes": ["w1", "w2"]})
        self.assertEqual(r["batch"], 2, r)
        self.assertTrue(all(v.get("halted") for v in r["nodes"].values()), r)
        self.assertEqual(self.api_sites(counts), {"legacy": [], "save": []},
                         counts)
        self.assertEqual(len(self.receipts()), 1)

    def test_an_unauthorised_target_is_refused_before_anything_is_filed(self):
        with self.assertRaises(HTTPException) as e:
            self.keyed("orgtree_halt", {"nodes": ["w1", "other"]})
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual(self.receipts(), [])
        o = store.load_org(self.slug)
        self.assertFalse(o.node("w1").get("halt"))
        self.assertFalse(o.node("other").get("halt"))

    def test_an_unkeyed_halt_writes_no_receipt_row(self):
        with store.doc_lock_tripwire(raising=False) as counts:
            self.assertTrue(self.call("orgtree_halt", {"node": "w1"})["halted"])
        self.assertEqual(self.api_sites(counts), {"legacy": [], "save": []},
                         counts)
        self.assertEqual(self.receipts(), [])


if __name__ == "__main__":
    unittest.main()
