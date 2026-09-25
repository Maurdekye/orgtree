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


class Move(unittest.TestCase):
    """lifecycle_tx.move: the legacy `Org.move`, on exactly `_move_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 0, "root")
        org.hire(ledger.USER, "root", "luna", 3, "a")
        org.hire(ledger.USER, "root", "luna", 0, "b")
        org.hire(ledger.USER, "a", "luna", 2, "x")
        org.hire(ledger.USER, "x", "luna", 0, "x1")      # x moves WITH its subtree
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-mv-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def snapshot(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["state"]) for k, v in o.nodes.items()},
                [(e["op"], e["detail"]) for e in o.d["events"] if e["op"] in ("demote", "promote")])

    def test_matches_the_legacy_method(self):
        twin = "pg3a-mv-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.move(ledger.USER, "x", "b")
            store.save_org(o)
        mine = lifecycle_tx.move(self.slug, ledger.USER, "x", "b")
        self.assertEqual(mine, legacy)
        self.assertEqual(self.snapshot(self.slug), self.snapshot(twin))
        self.assertEqual(store.load_org(self.slug).node("x")["parent"], "b")
        self.assertEqual(store.load_org(self.slug).node("x1")["parent"], "x")
        store._POOL.close_all(twin)

    def test_a_deep_move_matches_the_legacy_method_on_every_hop(self):
        # the acquire leg runs from the LCA (root) down through b to b1: b's
        # grant swells on the way, so b must be held FOR UPDATE even though
        # it is neither the moved node nor its new parent
        for slug in (self.slug,):
            with store.DOC_LOCK:
                o = store.load_org(slug)
                o.hire(ledger.USER, "b", "luna", 0, "b1")
                store.save_org(o)
        twin = "pg3a-mv-deep-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            o.hire(ledger.USER, "b", "luna", 0, "b1")
            store.save_org(o)
        g_before = store.load_org(self.slug).node("b")["grant"]
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.move(ledger.USER, "x", "b1")
            store.save_org(o)
        mine = lifecycle_tx.move(self.slug, ledger.USER, "x", "b1")
        self.assertEqual(mine, legacy)
        self.assertEqual(self.snapshot(self.slug), self.snapshot(twin))
        self.assertGreater(store.load_org(self.slug).node("b")["grant"], g_before)
        store._POOL.close_all(twin)

    def test_a_refused_move_writes_nothing(self):
        before = self.snapshot(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.move(self.slug, ledger.USER, "x", "x1")   # into its own subtree
        self.assertEqual(self.snapshot(self.slug), before)

    def test_a_stale_spec_widens_and_converges(self):
        # the runner is handed a spec missing every row but the moved node:
        # the body re-derives its rows on the LOCKED document, raises Widen,
        # and the runner re-runs with them — nothing half-applied in between
        calls = []
        real = lifecycle_tx._move_rows

        def rows(org, actor, nid, new_parent):
            calls.append(len(calls))
            if len(calls) == 1:
                return {nid}, set()           # the stale snapshot
            return real(org, actor, nid, new_parent)
        widened = []
        real_need = lifecycle_tx._need

        def need(org, r, hn, hs):
            try:
                real_need(org, r, hn, hs)
            except lifecycle_tx.Widen as w:
                widened.append(w)
                raise
        with patch.object(lifecycle_tx, "_move_rows", rows),                 patch.object(lifecycle_tx, "_need", need):
            lifecycle_tx.move(self.slug, ledger.USER, "x", "b")
        self.assertEqual(len(widened), 1, "the stale spec never widened")
        self.assertIn("b", widened[0].nodes)
        self.assertEqual(store.load_org(self.slug).node("x")["parent"], "b")

    def test_the_moved_nodes_new_parent_is_held_for_update(self):
        upd, share = lifecycle_tx._move_rows(store.load_org(self.slug),
                                             ledger.USER, "x", "b")
        self.assertIn("b", upd)                      # the children-cap row
        self.assertTrue({"x", "x1", "a"} <= upd)      # subtree + release leg
        self.assertIn("root", share)                  # decided on, not written
        self.assertFalse(upd & share)


class Archive(unittest.TestCase):
    """retire / dissolve / rescind: the legacy methods on `_archive_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 5, "root")
        org.hire(ledger.USER, "root", "luna", 2, "a")
        org.hire(ledger.USER, "a", "luna", 0, "a1")
        org.hire(ledger.USER, "root", "luna", 0, "b")
        org.hire(ledger.USER, None, "luna", 0, "t")          # top level
        store.save_org(org)
        with store.DOC_LOCK:
            o = store.load_org(slug)
            o.ask_user("t", "still there?")
            o.request_credits("t", 50, "more room")
            store.save_org(o)

    def setUp(self):
        self.slug = "pg3a-ar-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["state"], bool(v.get("rescinded_at")))
                 for k, v in o.nodes.items()},
                sorted((a["node"], a["status"]) for a in o.d.get("asks") or []),
                sorted((r["node"], r["status"]) for r in o.d.get("credit_requests") or []),
                [e["op"] for e in o.d["events"]][-6:])

    def parity(self, op, actor, nid):
        twin = f"pg3a-ar-twin-{op}-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = getattr(o, op)(actor, nid)
            store.save_org(o)
        mine = getattr(lifecycle_tx, op)(self.slug, actor, nid)
        self.assertEqual(mine, legacy, op)
        self.assertEqual(self.view(self.slug), self.view(twin), op)
        store._POOL.close_all(twin)
        return mine

    def test_retire_a_leaf(self):
        self.parity("retire", ledger.USER, "b")
        self.assertEqual(store.load_org(self.slug).node("b")["state"], "archived")

    def test_retire_with_live_reports_becomes_dissolve(self):
        r = self.parity("retire", ledger.USER, "a")
        self.assertEqual(sorted(r["nodes"]), ["a", "a1"])

    def test_dissolve(self):
        self.parity("dissolve", "root", "a")

    def test_rescind_claws_back_the_parents_grant(self):
        g = store.load_org(self.slug).node("root")["grant"]
        r = self.parity("rescind", ledger.USER, "b")
        self.assertGreater(r["clawed"], 0)
        self.assertLess(store.load_org(self.slug).node("root")["grant"], g)

    def test_retire_moots_the_open_requests(self):
        self.parity("retire", ledger.USER, "t")
        o = store.load_org(self.slug)
        self.assertEqual({a["status"] for a in o.d["asks"] if a["node"] == "t"}, {"moot"})
        self.assertEqual({r["status"] for r in o.d["credit_requests"] if r["node"] == "t"},
                         {"moot"})

    def test_every_declared_section_the_retire_writes_is_needed(self):
        spec = lifecycle_tx.SPECS["retire"]
        refused = []
        for drop in ("asks", "credit_requests", "notices"):
            smaller = lifecycle_tx.Spec(
                sections=tuple(x for x in spec.sections if x != drop), logs=spec.logs)
            with patch.dict(lifecycle_tx.SPECS, {"retire": smaller}):
                with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                    lifecycle_tx.retire(self.slug, ledger.USER, "t")
            refused.append(drop)
            self.assertEqual(store.load_org(self.slug).node("t")["state"], "live", drop)
        self.assertEqual(refused, ["asks", "credit_requests", "notices"])

    def test_mooting_an_item_attached_question_rewrites_the_work_item(self):
        # store._save_org runs reconcile_attention whenever `asks` was touched,
        # and it rewrites the attention fields of the work item the question
        # is attached to: a retire that moots it writes `work_items` too
        with store.DOC_LOCK:
            o = store.load_org(self.slug)
            slug = o.work_create(ledger.USER, "a docket item", "why it exists",
                                 owner="t")["slug"]
            o.ask_user("t", "about the item", work_item=slug)
            store.save_org(o)
        self.parity("retire", ledger.USER, "t")
        items = store.load_org(self.slug).d["work_items"]
        self.assertFalse(next(i for i in items if i["slug"] == slug)
                         ["notification_attention_active"])

    def test_rescind_holds_the_parent_retire_does_not(self):
        o = store.load_org(self.slug)
        self.assertIn("root", lifecycle_tx._archive_rows(o, ledger.USER, "b", True)[0])
        self.assertNotIn("root", lifecycle_tx._archive_rows(o, ledger.USER, "b")[0])
        self.assertEqual(lifecycle_tx._archive_rows(o, ledger.USER, "a")[0], {"a", "a1"})


if __name__ == "__main__":
    unittest.main()
