"""A finished lazy-row org copy is freed by refcount, not left to the cyclic GC.

mem-leak-probe measured (2026-09-28, v3 f0836e8): LazyNodesMap and
LazySplitSection held their LazyDoc strongly while the LazyDoc held them, so
every loaded copy was a reference cycle. Now an Org's death weakens the
back-pointer of every map nothing else holds (store.release_doc_links). With gc disabled, the LazyDoc of a
finished org_tx stayed alive — walked or not — and only gc.collect() freed
it. In the N=1000 message burst, dead copies (~200 MB each once walked)
piled up between gen-2 collections.

Actual PostgreSQL (disposable, via test_pgstore), on-demand rows ON. Proves:
  * a finished transaction's copy — untouched, point-read, or fully walked —
    is dead the moment its holder lets go, with the cyclic GC disabled;
  * a map that escapes its Org (`org_read(slug).nodes[...]`) keeps its
    document and works as before; a back-pointer that is somehow dead fails
    LOUDLY (LazyDocReleased), never by fetching rows with no baseline;
  * deepcopy keeps working: a copied document's maps point at the copy, and
    a map copied on its own still reads rows after the original is gone;
  * the policy context (which deep-copies a snapshot's nodes) still builds.

Run:  python tools/run-python-verification.py tests/test_lazy_doc_weakref.py
"""
import copy
import gc
import unittest
import uuid
import weakref
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, orgtx, store

N = 20


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, "disposable PostgreSQL required: NOT RUN")
class WeakDoc(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org("weak-" + uuid.uuid4().hex[:10])
        self.slug = org.d["slug"]
        for i in range(N):
            org.hire(ledger.USER, None, "opus", 0, f"w{i}")
        org.d["mail"] = {f"w{i}": [{"id": f"m{i}", "body": "hi"}] for i in range(5)}
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=["w1"]):   # the whole load that stamps the heal epoch
            pass
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        gc.collect()
        gc.disable()
        self.addCleanup(gc.enable)

    def finished_copy(self, use):
        """A transaction's copy after the transaction, used by `use`, and
        weakrefs to its Org and LazyDoc; the caller drops every strong ref."""
        with orgtx.org_tx(self.slug, nodes=["w1"], sections=["mail"]) as tx:
            org = tx.org
            self.assertIsInstance(dict.get(org.d, "nodes"), store.LazyNodesMap,
                                  "not a lazy-row copy: this test proves nothing")
            use(org)
            refs = weakref.ref(org), weakref.ref(org.d)
        return refs

    def assertFreed(self, refs, how):
        self.assertIsNone(refs[0](), f"{how}: the Org outlived its holder")
        self.assertIsNone(refs[1](), f"{how}: the LazyDoc outlived its Org without the "
                                     f"cyclic GC — a reference cycle is back")

    def test_an_untouched_copy_is_freed_without_the_gc(self):
        self.assertFreed(self.finished_copy(lambda org: None), "untouched")

    def test_a_point_read_copy_is_freed_without_the_gc(self):
        self.assertFreed(self.finished_copy(
            lambda org: (org.node("w1").__setitem__("x", 1), org.d["mail"].get("w2"))),
            "point read + write")

    def test_a_walked_copy_is_freed_without_the_gc(self):
        self.assertFreed(self.finished_copy(
            lambda org: (sum(1 for _ in org.nodes.values()), list(org.d["mail"].items()))),
            "whole walk")

    def test_a_map_that_escapes_its_org_keeps_its_document(self):
        """`org_read(slug).nodes[...]`, the Org a temporary: the map someone
        still holds keeps its document, exactly as before."""
        with orgtx.org_tx(self.slug, nodes=["w1"], sections=["mail"]) as tx:
            nodes = tx.org.nodes
            mail = tx.org.d["mail"]
        org = weakref.ref(tx.org)
        del tx
        self.assertIsNone(org(), "the Org is still held: nothing escaped")
        self.assertIsInstance(nodes, store.LazyNodesMap)
        self.assertFalse(nodes._complete, "a complete map needs no document: proves nothing")
        self.assertEqual(sorted(nodes), sorted(f"w{i}" for i in range(N)))
        self.assertEqual(sorted(mail), [f"w{i}" for i in range(5)])
        self.assertEqual(store.load_org(self.slug).nodes["w3"]["state"], "live")

    def test_a_map_taken_from_a_live_document_after_its_org_died(self):
        """review-astra's probe (fede452 round 2): the Org dies while the
        document lives on elsewhere (`doc = org.d`); a map taken from that
        document later, and kept after the document is dropped, must still
        read rows — so an Org's death may weaken nothing while its document
        is held."""
        with orgtx.org_tx(self.slug, nodes=["w1"]) as tx:
            org = tx.org
        self.assertFalse(dict.__contains__(dict.get(org.d, "nodes"), "w7"),
                         "setup: w7 already decoded, the read below would prove nothing")
        doc = org.d
        del tx
        alive = weakref.ref(org)
        del org                                   # the Org dies; the document lives on in `doc`
        self.assertIsNone(alive(), "the Org is still held: this proves nothing")
        nodes = doc["nodes"]                      # someone takes the map later ...
        del doc                                   # ... and keeps only the map
        self.assertEqual(nodes["w7"]["state"], "live")

    def test_a_dead_back_pointer_fails_loudly(self):
        """Unreachable by design (a map is weakened only when nothing else
        holds it); if it ever happens it must raise, never fetch rows with no
        baseline or heal context."""
        with orgtx.org_tx(self.slug, nodes=["w1"]) as tx:
            nodes = tx.org.nodes
        nodes._weaken_doc()                         # force what release would never do here
        del tx
        with self.assertRaises(store.LazyDocReleased):
            list(nodes)

    def test_deepcopy_of_the_document_keeps_every_row(self):
        org = orgtx.org_read(self.slug)
        dup = copy.deepcopy(org.d)
        nodes = dict.get(dup, "nodes")
        if isinstance(nodes, store.LazyNodesMap):
            self.assertIs(nodes._doc, dup, "a copied document's map points elsewhere")
        del org
        self.assertEqual(len(nodes), N)
        self.assertIn("w7", nodes)

    def test_a_map_copied_on_its_own_keeps_reading_rows(self):
        org = orgtx.org_read(self.slug)
        nodes = copy.deepcopy(org.nodes)
        ref = weakref.ref(org)
        del org
        self.assertIsNone(ref())
        self.assertEqual(sorted(nodes)[:2], ["w0", "w1"])
        self.assertIn("w7", nodes)

    def test_the_policy_context_still_builds(self):
        from orgtree import policy_context
        ctx = policy_context.read(self.slug)
        self.assertIn("w3", ctx.nodes)


if __name__ == "__main__":
    unittest.main()
