"""Org.cost_total on on-demand rows: the walk's exact answer, without the walk.

mem-leak-probe measured (2026-09-28, N=1000 message burst on v3 f0836e8): the
turn-end spend check (`_after_turn` -> `cost_total`) walked `nodes.values()`,
decoding all 1000 rows (~200 MB) into the transaction's copy and marking
every row touched, so the save then re-serialized each one. With
ORGTREE_LAZY_COST_TOTAL (default on) the costs come from the table in the
walk's order (store.lazy_node_costs), rows this copy holds from memory.

Actual PostgreSQL (disposable, via test_pgstore), on-demand rows ON. Proves:
  * EXACT equality with the walk — not approximate — over values that drift
    under reordering (0.1, 1e16, 1e-12), and the legacy shapes the walk's
    `float(v.get("cost_usd") or 0.0)` accepts (None, missing, 0, "1.5", True);
  * an edit, a delete and an addition made in the same transaction all count
    exactly as the walk counts them;
  * nothing is decoded and nothing is marked touched, so the save stays scoped;
  * switch off, or an already complete map: the walk, unchanged.

Run:  python tools/run-python-verification.py tests/test_lazy_cost_total.py
"""
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, orgtx, store

# w1, w2 and w10 make the sum ORDER-sensitive even under compensated summation:
# in table order (w1, w2, ...) 1e308 + 1e308 overflows to inf; in id order
# (w1, w10, ..., w2) -1e308 comes between them and it does not (review-astra's
# costs-by-id mutant survived a fixture without them)
COSTS = [0.1, 1e308, 1e308, 0.2, None, "missing", 0, "1.5", True, 0.3, -1e308, 1e-12,
         -3.5, 0.7, 12.5, 0.1]


def tearDownModule():
    f.tearDownModule()


#: the transaction's declared rows: prefetched, so decoded, by org_tx itself
DECLARED = ["w1", "w5", "w7", "new"]


class _Abort(Exception):
    """Roll the transaction back: nothing it did is saved."""


def decoded(org):
    return dict.__len__(dict.get(org.d, "nodes"))


@unittest.skipUnless(f.ADMIN, "disposable PostgreSQL required: NOT RUN")
class LazyCostTotal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True, LAZY_COST_TOTAL=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org("cost-" + uuid.uuid4().hex[:10])
        self.slug = org.d["slug"]
        for i, c in enumerate(COSTS):
            org.hire(ledger.USER, None, "opus", 0, f"w{i}")
            n = org.node(f"w{i}")
            if c == "missing":
                n.pop("cost_usd", None)
            else:
                n["cost_usd"] = c
        org.d["deleted_cost_usd"] = 0.05
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=["w1"]):   # the whole load that stamps the heal epoch
            pass
        self.addCleanup(lambda: store._POOL.close_all(self.slug))

    def both(self, change=None):
        """cost_total from a lazy copy and from the walk, each on its own
        transaction copy with the same in-transaction `change`; each
        transaction is aborted, so both start from the same stored rows."""
        out = []
        for lazy in (True, False):
            with patch.object(store, "LAZY_COST_TOTAL", lazy):
                try:
                    with orgtx.org_tx(self.slug, nodes=DECLARED) as tx:
                        org = tx.org
                        if change:
                            change(org)
                        total = org.cost_total()
                        nodes = dict.get(org.d, "nodes")
                        out.append((total, decoded(org), nodes._touched_all, nodes._complete))
                        raise _Abort()
                except _Abort:
                    pass
        return out

    def test_equal_to_the_walk_bit_for_bit(self):
        (lazy, rows, touched_all, complete), (walk, walk_rows, _, walk_complete) = self.both()
        self.assertTrue(walk_complete and walk_rows == len(COSTS),
                        "the control never walked: this comparison proves nothing")
        self.assertEqual(repr(lazy), repr(walk))
        self.assertFalse(complete, "the lazy path decoded the table")
        self.assertLessEqual(rows, len(DECLARED), "rows beyond the declared ones were decoded")
        self.assertFalse(touched_all, "the lazy path marked every row touched")

    def test_an_edit_a_delete_and_an_addition_count_as_the_walk_counts_them(self):
        def change(org):
            org.node("w5")["cost_usd"] = 7.25            # decoded + edited, unsaved
            org.nodes.pop("w1")                          # deleted in this copy (1e308: no rounding hides it)
            org.nodes["new"] = {"id": "new", "cost_usd": 0.4, "state": "live",
                                "parent": None}           # added, unsaved
        (lazy, rows, touched_all, complete), (walk, *_rest) = self.both(change)
        self.assertEqual(repr(lazy), repr(walk))
        self.assertFalse(complete)
        self.assertFalse(touched_all)

    def test_the_switch_off_or_a_complete_map_walks(self):
        with patch.object(store, "LAZY_COST_TOTAL", False):
            org = orgtx.org_read(self.slug)
            self.assertIsNone(store.lazy_node_costs(org.d))
        org = orgtx.org_read(self.slug)
        list(org.nodes)                                  # now complete
        self.assertIsNone(store.lazy_node_costs(org.d))


if __name__ == "__main__":
    unittest.main()
