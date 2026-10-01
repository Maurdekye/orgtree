"""A same-parent move checks authority before it answers.

Item lifecycle-tool-receipts-and-admission-keyed-rena (point 6). `Org.move`
with the node's current parent as the target is a no-op whose answer names
that parent. It used to return before the §7.1 authority check, so an agent
with no authority over the node learnt where it sits in the chart. These
tests pin:

  §1  an unrelated agent, and the node itself, are refused, and the refusal
      does not name the parent
  §2  an ancestor and the user still get the no-op answer, unchanged
  §3  the same holds inside `move_batch`
"""
import os
import tempfile
import unittest

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-move-authority-",
                                    ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _ROOT.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store

U = ledger.USER
T = {"bash": False, "web": False, "edit": False, "subagents": False, "mcp": []}


class SameParentMove(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f"move-auth-{self.seq}"
        org = store.create_org(self.slug)
        org.hire(U, None, "haiku", 20, "top")
        org.hire(U, None, "haiku", 5, "top2")
        org.hire("top", "top", "haiku", 6, "mid", add_dirs=[], tools=T,
                 org_visibility="full", charter="c")
        org.hire("top", "mid", "haiku", 0, "leaf", add_dirs=[], tools=T,
                 org_visibility="full", charter="c")
        store.save_org(org)
        self.org = store.load_org(self.slug)
        self.addCleanup(store._POOL.close_all, self.slug)

    def test_an_unrelated_agent_and_the_node_itself_are_refused(self):
        for caller in ("top2", "leaf"):
            with self.subTest(caller=caller):
                with self.assertRaises(ledger.LedgerError) as cm:
                    self.org.move(caller, "leaf", "mid")
                self.assertIn("has no authority over leaf", str(cm.exception))
                self.assertNotIn("reports to", str(cm.exception))

    def test_an_ancestor_and_the_user_still_get_the_no_op(self):
        for caller in ("top", "mid", U):
            with self.subTest(caller=caller):
                r = self.org.move(caller, "leaf", "mid")
                self.assertEqual((r["moved"], r["changed"], r["parent"]),
                                 (False, False, "mid"))
                self.assertIn("leaf already reports to mid", r["warnings"][0])

    def test_a_batch_refuses_the_same_way(self):
        with self.assertRaises(ledger.LedgerError) as cm:
            self.org.move_batch("top2", [("leaf", "mid")])
        self.assertIn("has no authority over leaf", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
