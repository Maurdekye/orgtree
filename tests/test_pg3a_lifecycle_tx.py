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

    def parity(self, op, actor, nid, prep=None):
        twin = f"pg3a-ar-twin-{op}-" + str(time.time_ns())
        self.build(twin)
        if prep is not None:
            prep(twin)
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
        def prep(org_slug):
            with store.DOC_LOCK:
                o = store.load_org(org_slug)
                made = o.work_create(ledger.USER, "a docket item", "why it exists",
                                     owner="t")["slug"]
                o.ask_user("t", "about the item", work_item=made)
                store.save_org(o)
            return made
        slug = prep(self.slug)
        self.assertTrue(next(i for i in store.load_org(self.slug).d["work_items"]
                             if i["slug"] == slug)["notification_attention_active"])
        self.parity("retire", ledger.USER, "t", prep)
        items = store.load_org(self.slug).d["work_items"]
        self.assertFalse(next(i for i in items if i["slug"] == slug)
                         ["notification_attention_active"])

    def test_rescind_holds_the_parent_retire_does_not(self):
        o = store.load_org(self.slug)
        self.assertIn("root", lifecycle_tx._archive_rows(o, ledger.USER, "b", True)[0])
        self.assertNotIn("root", lifecycle_tx._archive_rows(o, ledger.USER, "b")[0])
        self.assertEqual(lifecycle_tx._archive_rows(o, ledger.USER, "a")[0], {"a", "a1"})


class Rename(unittest.TestCase):
    """supervisor.rename_node on lifecycle_tx's row plan."""

    def setUp(self):
        from orgtree import supervisor as sup, warmpool
        self.sup = sup
        self.slug = "pg3a-rn-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "alpha")
        org.hire(ledger.USER, "alpha", "luna", 0, "kid")     # its pointer moves
        store.save_org(org)
        self.enterContext(patch.object(warmpool, "kill_node"))
        self.enterContext(patch.object(sup, "notify"))
        self.scratch = Path(store.scratch_root(self.slug))
        (self.scratch / "alpha").mkdir(parents=True, exist_ok=True)
        (self.scratch / "alpha" / "note.txt").write_text("mine")

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def test_rename_rekeys_the_stack_and_its_children_and_moves_the_folder(self):
        r = self.sup.rename_node(self.slug, "alpha", "beta", actor=ledger.USER)
        self.assertEqual(r["node"], "beta")
        o = store.load_org(self.slug)
        self.assertIn("beta", o.nodes)
        self.assertNotIn("alpha", o.nodes)
        self.assertEqual(o.node("kid")["parent"], "beta")
        self.assertTrue((self.scratch / "beta" / "note.txt").exists())
        self.assertFalse((self.scratch / "alpha").exists())

    def test_the_plan_holds_the_children_and_the_new_id(self):
        upd, share, sections, logs = lifecycle_tx._rename_plan(
            store.load_org(self.slug), ledger.USER, "alpha", "beta")
        self.assertTrue({"alpha", "beta", "kid"} <= upd)
        self.assertIn("boss", share)
        self.assertIn("audiences", sections)
        self.assertIn(("mail_log", "alpha"), logs)
        self.assertIn(("mail_log", "beta"), logs)

    def test_a_refused_commit_puts_the_folder_back(self):
        # negative control: a plan missing the child's row makes the commit
        # refuse (the child's parent pointer is rewritten) — and the folder
        # the body already moved must be moved back
        real = lifecycle_tx._rename_plan

        def short(org, actor, nid, new_name):
            upd, share, sections, logs = real(org, actor, nid, new_name)
            return upd - {"kid"}, share, sections, logs
        with patch.object(lifecycle_tx, "_rename_plan", short), \
                patch.object(lifecycle_tx, "check_rename_rows", lambda *a: None):
            with self.assertRaises(orgtx.UnlockedWrite):
                self.sup.rename_node(self.slug, "alpha", "beta", actor=ledger.USER)
        self.assertTrue((self.scratch / "alpha" / "note.txt").exists())
        self.assertFalse((self.scratch / "beta").exists())
        o = store.load_org(self.slug)
        self.assertIn("alpha", o.nodes)
        self.assertEqual(o.node("kid")["parent"], "alpha")

    def test_a_stale_plan_widens_before_any_folder_moves(self):
        real = lifecycle_tx._rename_plan
        calls = []

        def stale_first(org, actor, nid, new_name):
            upd, share, sections, logs = real(org, actor, nid, new_name)
            calls.append(1)
            if len(calls) == 1:
                return upd - {"kid"}, share, sections, logs
            return upd, share, sections, logs
        with patch.object(lifecycle_tx, "_rename_plan", stale_first):
            r = self.sup.rename_node(self.slug, "alpha", "beta", actor=ledger.USER)
        self.assertEqual(r["node"], "beta")
        self.assertGreaterEqual(len(calls), 3)      # snapshot, locked re-check (widen), re-check
        self.assertTrue((self.scratch / "beta" / "note.txt").exists())


class Rehire(unittest.TestCase):
    """lifecycle_tx.rehire: the legacy `Org.rehire` on `_rehire_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 6, "root")
        org.hire(ledger.USER, "root", "luna", 2, "mid")
        org.hire(ledger.USER, "mid", "luna", 0, "leaf")
        org.hire(ledger.USER, "root", "luna", 0, "solo")
        org.dissolve(ledger.USER, "mid")                    # mid + leaf archived
        org.retire(ledger.USER, "solo")
        org.d.setdefault("watchdogs", []).append(
            {"id": "w1", "name": "dog", "owner": "solo", "state": "paused",
             "paused_why": org.WATCHDOG_ARCHIVE_PAUSE})
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-rh-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["state"]) for k, v in o.nodes.items()},
                [(w["id"], w["state"]) for w in o.d.get("watchdogs") or []],
                [e["op"] for e in o.d["events"]][-4:])

    def parity(self, actor, nid, **kw):
        twin = "pg3a-rh-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.rehire(actor, nid, **kw)
            store.save_org(o)
        mine = lifecycle_tx.rehire(self.slug, actor, nid, **kw)
        self.assertEqual(mine, legacy)
        self.assertEqual(self.view(self.slug), self.view(twin))
        store._POOL.close_all(twin)
        return mine

    def test_rehire_a_leaf_rearms_its_archive_paused_watchdog(self):
        self.parity(ledger.USER, "solo")
        o = store.load_org(self.slug)
        self.assertEqual(o.node("solo")["state"], "live")
        self.assertEqual([w["state"] for w in o.d["watchdogs"]], ["armed"])

    def test_rehire_under_an_archived_parent_rehires_the_chain_first(self):
        r = self.parity(ledger.USER, "leaf")
        o = store.load_org(self.slug)
        self.assertEqual((o.node("mid")["state"], o.node("leaf")["state"]),
                         ("live", "live"))
        self.assertTrue(any("rehired first" in w for w in r["warnings"]))

    def test_rehire_of_an_unrecoverable_node_reseeds(self):
        for slug in (self.slug,):
            with store.DOC_LOCK:
                o = store.load_org(slug)
                o.rehire(ledger.USER, "solo")
                o.mark_unrecoverable("solo", "gone")
                store.save_org(o)
        twin = "pg3a-rh-rs-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            o.rehire(ledger.USER, "solo")
            o.mark_unrecoverable("solo", "gone")
            store.save_org(o)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.rehire(ledger.USER, "solo")
            store.save_org(o)
        mine = lifecycle_tx.rehire(self.slug, ledger.USER, "solo")
        strip = lambda r: {k: v for k, v in r.items() if k not in ("session_id",)}  # noqa: E731
        self.assertEqual(sorted(strip(mine)), sorted(strip(legacy)))
        a, b = store.load_org(twin), store.load_org(self.slug)
        self.assertEqual(sorted(a.nodes), sorted(b.nodes))
        self.assertIn("solo@0", b.nodes)
        self.assertEqual(b.node("solo")["state"], "live")
        store._POOL.close_all(twin)

    def test_a_refused_rehire_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.rehire(self.slug, ledger.USER, "solo", tier="no-such-tier")
        self.assertEqual(self.view(self.slug), before)


class Delete(unittest.TestCase):
    """lifecycle_tx.delete: the legacy `Org.delete` on `_delete_plan`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 6, "root")
        org.hire(ledger.USER, "root", "luna", 2, "a")
        org.hire(ledger.USER, "a", "luna", 0, "a1")
        org.hire(ledger.USER, "root", "luna", 0, "b")
        org.nodes["a1"]["cost_usd"] = 0.25
        org.d.setdefault("watchdogs", []).append(
            {"id": "w1", "name": "dog", "owner": "a1", "state": "armed"})
        store.save_org(org)
        with store.DOC_LOCK:
            o = store.load_org(slug)
            o.ask_user("a1", "still there?")
            # a pending credit row (only top-level agents may file one, so
            # it is placed directly)
            o.d.setdefault("credit_requests", []).append(
                {"id": "c1", "node": "a", "amount": 50, "status": "pending"})
            o.work_create(ledger.USER, "an item", "why it exists", owner="a1")
            store.save_org(o)

    def setUp(self):
        self.slug = "pg3a-dl-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return (sorted(o.nodes), o.d.get("deleted_cost_usd"),
                sorted(a["node"] for a in o.d.get("asks") or []),
                sorted(r["node"] for r in o.d.get("credit_requests") or []),
                [w["id"] for w in o.d.get("watchdogs") or []],
                sorted(o.d.get("mail") or {}),
                [e["op"] for e in o.d["events"]][-3:],
                len((o.d.get("notices") or {}).get("b") or []),
                [(i.get("owner") or {}).get("node") for i in o.d.get("work_items") or []])

    def test_matches_the_legacy_method(self):
        twin = "pg3a-dl-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.delete(ledger.USER, "a")
            store.save_org(o)
        mine = lifecycle_tx.delete(self.slug, ledger.USER, "a")
        self.assertEqual(mine, legacy)
        self.assertEqual(mine["deleted"], ["a", "a1"])
        self.assertEqual(self.view(self.slug), self.view(twin))
        o = store.load_org(self.slug)
        self.assertEqual(o.d["deleted_cost_usd"], 0.25)
        self.assertEqual(o.d.get("watchdogs") or [], [])
        store._POOL.close_all(twin)

    def test_plan_holds_the_subtree_and_shares_the_parent(self):
        o = store.load_org(self.slug)
        upd, share, sections, logs = lifecycle_tx._delete_plan(o, ledger.USER, "a")
        self.assertEqual(upd, {"a", "a1"})
        self.assertEqual(share, {"root"})
        for s in ("asks", "credit_requests", "watchdogs", "audiences", "work_items",
                  "mail", "notices", "deleted_cost_usd"):
            self.assertIn(s, sections)
        self.assertIn(("mail_log", "a1"), logs)
        self.assertIn("op_receipts", logs)

    def test_an_agent_may_not_delete_and_nothing_is_written(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.delete(self.slug, "root", "b")
        self.assertEqual(self.view(self.slug), before)

    def test_every_node_section_the_delete_writes_is_needed(self):
        real = lifecycle_tx._delete_plan
        refused = []
        for drop in ("asks", "credit_requests", "watchdogs", "work_items",
                     "deleted_cost_usd"):
            def smaller(org, actor, nid, drop=drop):
                u, s, secs, lg = real(org, actor, nid)
                return u, s, tuple(x for x in secs if x != drop), lg
            with patch.object(lifecycle_tx, "_delete_plan", smaller):
                with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                    lifecycle_tx.delete(self.slug, ledger.USER, "a")
            refused.append(drop)
            self.assertIn("a1", store.load_org(self.slug).nodes, drop)
        self.assertEqual(len(refused), 5)

    def test_a_stale_snapshot_widens_to_the_new_report(self):
        # the first plan misses a1; the body re-derives the plan on the
        # locked document and widens instead of popping an unlocked row
        real = lifecycle_tx._delete_plan
        calls = []

        def stale(org, actor, nid):
            u, s, secs, lg = real(org, actor, nid)
            calls.append(1)
            if len(calls) == 1:
                u = u - {"a1"}
            return u, s, secs, lg
        with patch.object(lifecycle_tx, "_delete_plan", stale):
            r = lifecycle_tx.delete(self.slug, ledger.USER, "a")
        self.assertEqual(r["deleted"], ["a", "a1"])
        self.assertGreaterEqual(len(calls), 3)          # plan, refused body, rerun


class Swap(unittest.TestCase):
    """lifecycle_tx.swap_seats: the legacy `Org.swap_seats` on `_swap_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 8, "root")
        org.hire(ledger.USER, "root", "luna", 3, "a")
        org.hire(ledger.USER, "a", "luna", 0, "a1")
        org.hire(ledger.USER, "root", "luna", 3, "b")
        org.hire(ledger.USER, "b", "luna", 1, "b1")
        org.hire(ledger.USER, "b1", "luna", 0, "b11")
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-sw-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v.get("ui_order")) for k, v in o.nodes.items()},
                sorted((x["grantee"], x["grantor"]) for x in o.d.get("audiences") or []),
                sorted((k, len(v)) for k, v in (o.d.get("notices") or {}).items()),
                [e["op"] for e in o.d["events"]][-2:])

    def parity(self, actor, a, b):
        twin = "pg3a-sw-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.swap_seats(actor, a, b)
            store.save_org(o)
        mine = lifecycle_tx.swap_seats(self.slug, actor, a, b)
        self.assertEqual(mine, legacy)
        self.assertEqual(self.view(self.slug), self.view(twin))
        store._POOL.close_all(twin)
        return mine

    def test_siblings_exchange_seats_and_teams(self):
        self.parity(ledger.USER, "a", "b")
        o = store.load_org(self.slug)
        self.assertEqual(o.node("a1")["parent"], "b")
        self.assertEqual(o.node("b1")["parent"], "a")

    def test_a_nested_non_adjacent_pair_keeps_an_audience(self):
        r = self.parity(ledger.USER, "b", "b11")
        self.assertTrue(r["audience_retained"])

    def test_an_agent_swap_by_the_common_parent(self):
        self.parity("root", "a1", "b1")

    def test_plan_holds_both_subtrees_and_shares_the_parents(self):
        o = store.load_org(self.slug)
        upd, share = lifecycle_tx._swap_rows(o, ledger.USER, "a1", "b1")
        self.assertEqual(upd, {"a1", "b1", "b11"})
        self.assertEqual(share, {"a", "b", "root"})

    def test_a_refused_swap_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.swap_seats(self.slug, "a1", "b", "b1")   # no authority
        self.assertEqual(self.view(self.slug), before)

    def test_every_row_the_swap_writes_is_needed(self):
        spec = lifecycle_tx.SPECS["swap_seats"]
        for drop in ("audiences", "notices"):
            smaller = lifecycle_tx.Spec(
                sections=tuple(x for x in spec.sections if x != drop), logs=spec.logs)
            with patch.dict(lifecycle_tx.SPECS, {"swap_seats": smaller}):
                with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                    lifecycle_tx.swap_seats(self.slug, ledger.USER, "b", "b11")
        # a reparented child left out of the plan: the body re-derives the
        # plan on the locked document and widens, so it can only be caught
        # by opening the transaction without it directly
        with self.assertRaises(orgtx.UnlockedWrite):
            with halt.txn(self.slug, nodes=["a", "b", "b1", "b11"],
                          share_nodes=["root"], sections=spec.sections,
                          logs=spec.logs) as tx:
                tx.org.swap_seats(ledger.USER, "a", "b")           # a1 moves too
        self.assertEqual(store.load_org(self.slug).node("a1")["parent"], "a")

    def test_a_stale_plan_widens(self):
        real = lifecycle_tx._swap_rows
        calls = []

        def stale(org, actor, a, b):
            u, s = real(org, actor, a, b)
            calls.append(1)
            return (u - {"a1"}, s) if len(calls) == 1 else (u, s)
        with patch.object(lifecycle_tx, "_swap_rows", stale):
            lifecycle_tx.swap_seats(self.slug, ledger.USER, "a", "b")
        self.assertEqual(store.load_org(self.slug).node("a1")["parent"], "b")
        self.assertGreaterEqual(len(calls), 3)


class Scope(unittest.TestCase):
    """lifecycle_tx.set_scope: the legacy `Org.set_scope` on `_scope_plan`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 6, "root")
        org.hire(ledger.USER, "root", "luna", 2, "mid")
        org.hire(ledger.USER, "mid", "luna", 0, "leaf")
        org.hire(ledger.USER, "root", "luna", 0, "side")
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-sc-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["scope"], v.get("charter")) for k, v in o.nodes.items()},
                o.d.get("dirs"), o.d.get("default_tools"), o.d.get("permission_mode"),
                sorted((k, len(v)) for k, v in (o.d.get("notices") or {}).items()),
                [e["op"] for e in o.d["events"]][-2:])

    def parity(self, actor, nid, **kw):
        twin = "pg3a-sc-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.set_scope(actor, nid, **kw)
            store.save_org(o)
        mine = lifecycle_tx.set_scope(self.slug, actor, nid, **kw)
        # each org's scope carries its own workspace folder, named by slug
        same = lambda x: repr(x).replace(twin, self.slug)  # noqa: E731
        self.assertEqual(same(mine), same(legacy))
        self.assertEqual(same(self.view(self.slug)), same(self.view(twin)))
        store._POOL.close_all(twin)
        return mine

    def test_a_charter_change_locks_only_the_node(self):
        o = store.load_org(self.slug)
        upd, share, secs, ssecs, _ = lifecycle_tx._scope_plan(
            o, ledger.USER, "leaf", {"charter": "x"}, True)
        self.assertEqual(upd, {"leaf"})
        self.assertEqual(share, {"mid", "root"})
        self.assertEqual((secs, ssecs), (("notices",), ()))
        self.parity(ledger.USER, "leaf", charter="a new charter")

    def test_narrowing_tools_sweeps_the_subtree(self):
        tools = dict(store.load_org(self.slug).node("mid")["scope"]["tools"])
        tools["web"] = False
        self.parity(ledger.USER, "mid", tools=tools)
        self.assertFalse(store.load_org(self.slug).node("leaf")["scope"]["tools"].get("web"))

    def test_a_top_level_folder_grant_is_absorbed_by_the_org(self):
        import tempfile as _t
        d = _t.mkdtemp(prefix="pg3a-sc-dir-")
        r = self.parity(ledger.USER, "root", add_dirs=[{"path": d, "mode": "rw"}])
        self.assertTrue(any("organization now holds" in w for w in r["warnings"]))

    def test_a_raised_leaf_grant_cascades_up_the_path(self):
        import tempfile as _t
        d = _t.mkdtemp(prefix="pg3a-sc-dir-")
        r = self.parity(ledger.USER, "leaf", add_dirs=[{"path": d, "mode": "ro"}])
        self.assertIn("mid", r.get("cascaded") or [])

    def test_an_agent_retool_shares_the_org_grants(self):
        o = store.load_org(self.slug)
        _u, _s, secs, ssecs, _ = lifecycle_tx._scope_plan(
            o, "root", "leaf", {"tools": {}}, False)
        self.assertEqual(secs, ("notices",))
        self.assertIn("dirs", ssecs)
        self.assertIn("kiosk", ssecs)
        self.parity("root", "leaf", charter="set by the parent")

    def test_every_section_a_capability_change_writes_is_needed(self):
        import tempfile as _t
        d = _t.mkdtemp(prefix="pg3a-sc-dir-")
        real = lifecycle_tx._scope_plan
        for drop in ("dirs", "notices"):
            def smaller(org, actor, nid, kw, may_raise, drop=drop):
                u, s, secs, ss, lg = real(org, actor, nid, kw, may_raise)
                return u, s, tuple(x for x in secs if x != drop), ss, lg
            with patch.object(lifecycle_tx, "_scope_plan", smaller):
                with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                    lifecycle_tx.set_scope(self.slug, ledger.USER, "root",
                                           add_dirs=[{"path": d, "mode": "rw"}])
        self.assertNotIn(d, [x["path"] for x in store.load_org(self.slug).d.get("dirs") or []])

    def kiosk(self, slug):
        with store.DOC_LOCK:
            o = store.load_org(slug)
            ms = o.default_kiosk_ceiling()
            ms["tools"]["bash"] = False
            o.d["kiosk"] = {"max_scope": ms, "auto_raise": False}
            store.save_org(o)

    def test_raising_the_kiosk_ceiling_writes_the_kiosk_row(self):
        self.kiosk(self.slug)
        tools = dict(store.load_org(self.slug).node("root")["scope"]["tools"])
        tools["bash"] = True
        twin = "pg3a-sc-twin-" + str(time.time_ns())
        self.build(twin)
        self.kiosk(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.set_scope(ledger.USER, "root", tools=tools, raise_ceiling=True)
            store.save_org(o)
        mine = lifecycle_tx.set_scope(self.slug, ledger.USER, "root", tools=tools,
                                      raise_ceiling=True)
        same = lambda x: repr(x).replace(twin, self.slug)  # noqa: E731
        self.assertEqual(same(mine), same(legacy))
        o = store.load_org(self.slug)
        self.assertTrue(o.d["kiosk"]["max_scope"]["tools"]["bash"])      # it rose
        self.assertEqual(same(o.d["kiosk"]), same(store.load_org(twin).d["kiosk"]))
        store._POOL.close_all(twin)

    def test_without_may_raise_the_grant_is_clamped_and_kiosk_only_read(self):
        self.kiosk(self.slug)
        tools = dict(store.load_org(self.slug).node("root")["scope"]["tools"])
        tools["bash"] = True
        o = store.load_org(self.slug)
        _u, _s, secs, ssecs, _ = lifecycle_tx._scope_plan(
            o, ledger.USER, "root", {"tools": tools}, False)
        self.assertIn("kiosk", ssecs)
        self.assertNotIn("kiosk", secs)
        r = lifecycle_tx.set_scope(self.slug, ledger.USER, "root", may_raise=False,
                                   tools=tools, raise_ceiling=True)
        self.assertEqual(r.get("bridge"), {"raise_ceiling": True})
        o = store.load_org(self.slug)
        self.assertFalse(o.d["kiosk"]["max_scope"]["tools"]["bash"])
        self.assertFalse(o.node("root")["scope"]["tools"]["bash"])

    def test_a_refused_retool_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.set_scope(self.slug, "side", "leaf", charter="not mine")
        self.assertEqual(self.view(self.slug), before)


class MoveBatch(unittest.TestCase):
    """lifecycle_tx.move_batch: the legacy `Org.move_batch` on the replayed
    union of each step's move rows."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 8, "root")
        org.hire(ledger.USER, "root", "luna", 3, "a")
        org.hire(ledger.USER, "root", "luna", 3, "b")
        org.hire(ledger.USER, "a", "luna", 0, "a1")
        org.hire(ledger.USER, "b", "luna", 0, "b1")
        org.hire(ledger.USER, "b1", "luna", 0, "b11")
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-mb-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"]) for k, v in o.nodes.items()},
                [e["op"] for e in o.d["events"]][-3:])

    def parity(self, actor, moves):
        twin = "pg3a-mb-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.move_batch(actor, moves)
            store.save_org(o)
        mine = lifecycle_tx.move_batch(self.slug, actor, moves)
        self.assertEqual(mine, legacy)
        self.assertEqual(self.view(self.slug), self.view(twin))
        store._POOL.close_all(twin)
        return mine

    def test_a_position_swap_keeping_each_team(self):
        self.parity(ledger.USER, [("a1", "b"), ("b1", "a")])
        o = store.load_org(self.slug)
        self.assertEqual((o.node("a1")["parent"], o.node("b1")["parent"]), ("b", "a"))
        self.assertEqual(o.node("b11")["parent"], "b1")

    def test_a_later_step_depends_on_an_earlier_one(self):
        # step 2 moves b11 under a1, which only sits under b after step 1:
        # its rows (the acquire leg through b) come from the REPLAYED tree
        o = store.load_org(self.slug)
        upd, _share = lifecycle_tx._move_batch_rows(
            o, ledger.USER, [("a1", "b"), ("b11", "a1")])
        self.assertTrue({"a1", "b", "b11", "b1"} <= upd)
        self.parity(ledger.USER, [("a1", "b"), ("b11", "a1")])

    def test_a_refused_step_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.move_batch(self.slug, ledger.USER,
                                    [("a1", "b"), ("b", "b11")])   # a cycle
        self.assertEqual(self.view(self.slug), before)

    def test_a_step_row_left_out_is_refused(self):
        # the first step's rows only: the second step's writes are unlocked.
        # The body re-derives and widens, so this is caught at the org_tx
        # itself, the way the other exactness tests reach it
        o = store.load_org(self.slug)
        u, s = lifecycle_tx._move_rows(o, ledger.USER, "a1", "b")
        spec = lifecycle_tx.SPECS["move"]
        with self.assertRaises(orgtx.UnlockedWrite):
            with halt.txn(self.slug, nodes=u, share_nodes=s - u,
                          sections=spec.sections, share_sections=spec.share_sections,
                          logs=spec.logs) as tx:
                tx.org.move_batch(ledger.USER, [("a1", "b"), ("b11", "a")])
        self.assertEqual(store.load_org(self.slug).node("a1")["parent"], "a")


class Promote(unittest.TestCase):
    """lifecycle_tx.subjugate / promote_subtree on `_promote_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 9, "root")
        org.hire(ledger.USER, "root", "luna", 6, "a")
        org.hire(ledger.USER, "a", "luna", 0, "x")
        org.hire(ledger.USER, "a", "luna", 4, "m")
        org.hire(ledger.USER, "m", "luna", 2, "t")
        org.hire(ledger.USER, "t", "luna", 0, "t1")
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-pr-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["scope"].get("tools")) for k, v in o.nodes.items()},
                sorted((k, len(v)) for k, v in (o.d.get("notices") or {}).items()),
                [e["op"] for e in o.d["events"]][-2:])

    def parity(self, op, actor, nid, target):
        twin = "pg3a-pr-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = getattr(o, op)(actor, nid, target)
            store.save_org(o)
        mine = getattr(lifecycle_tx, op)(self.slug, actor, nid, target)
        self.assertEqual(mine, legacy)
        self.assertEqual(self.view(self.slug), self.view(twin))
        store._POOL.close_all(twin)
        return mine

    def test_self_subjugation_promotes_the_target_with_its_team(self):
        self.parity("subjugate", "a", "a", "t")
        o = store.load_org(self.slug)
        self.assertEqual((o.node("t")["parent"], o.node("a")["parent"],
                          o.node("t1")["parent"], o.node("m")["parent"]),
                         ("root", "t", "t", "a"))

    def test_promote_subtree_by_the_user(self):
        self.parity("promote_subtree", ledger.USER, "a", "t")

    def test_plan_holds_both_legs(self):
        o = store.load_org(self.slug)
        upd, share = lifecycle_tx._promote_rows(o, "a", "a", "t")
        self.assertTrue({"a", "t", "t1", "m", "x", "root"} <= upd, upd)

    def test_the_second_leg_rows_are_needed(self):
        # leg 1's rows only: leg 2 (a and its remainder under t) is unlocked
        o = store.load_org(self.slug)
        u, s = lifecycle_tx._move_rows(o, "a", "t", "root")
        spec = lifecycle_tx.SPECS["move"]
        with self.assertRaises(orgtx.UnlockedWrite):
            with halt.txn(self.slug, nodes=u, share_nodes=s - u,
                          sections=spec.sections, share_sections=spec.share_sections,
                          logs=spec.logs) as tx:
                tx.org.subjugate("a", "a", "t")
        self.assertEqual(store.load_org(self.slug).node("t")["parent"], "m")

    def test_a_refused_promotion_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.subjugate(self.slug, "a", "a", "root")   # not a descendant
        self.assertEqual(self.view(self.slug), before)


class InsertParent(unittest.TestCase):
    """lifecycle_tx.insert_parent on `_insert_rows`."""

    def build(self, slug):
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "luna", 9, "root")
        org.hire(ledger.USER, "root", "luna", 5, "t")
        org.hire(ledger.USER, "t", "luna", 1, "n")          # the one inserted
        org.hire(ledger.USER, "t", "luna", 0, "k1")
        org.hire(ledger.USER, "k1", "luna", 0, "k11")
        store.save_org(org)

    def setUp(self):
        self.slug = "pg3a-ip-" + str(time.time_ns())
        self.build(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def view(self, slug):
        o = store.load_org(slug)
        return ({k: (v["parent"], v["grant"], v["scope"].get("tools")) for k, v in o.nodes.items()},
                sorted((k, len(v)) for k, v in (o.d.get("notices") or {}).items()),
                [e["op"] for e in o.d["events"]][-2:])

    def test_matches_the_legacy_method(self):
        twin = "pg3a-ip-twin-" + str(time.time_ns())
        self.build(twin)
        with store.DOC_LOCK:
            o = store.load_org(twin)
            legacy = o.insert_parent(ledger.USER, "n", "t")
            store.save_org(o)
        mine = lifecycle_tx.insert_parent(self.slug, ledger.USER, "n", "t")
        self.assertEqual(mine, legacy)
        self.assertEqual(self.view(self.slug), self.view(twin))
        o = store.load_org(self.slug)
        self.assertEqual((o.node("n")["parent"], o.node("t")["parent"],
                          o.node("k1")["parent"]), ("root", "n", "t"))
        store._POOL.close_all(twin)

    def test_plan(self):
        o = store.load_org(self.slug)
        upd, share = lifecycle_tx._insert_rows(o, ledger.USER, "n", "t")
        self.assertEqual(upd, {"t", "n", "k1", "k11"})
        self.assertEqual(share, {"root"})

    def test_the_inserted_node_row_is_needed(self):
        # n is re-parented and re-granted: a transaction without it is refused
        # and nothing is written. (The rest of target's branch is locked
        # CONSERVATIVELY for `_sweep_dirs(nid)`, which only writes it when a
        # branch row holds more than the seat: normally n takes t's scope and
        # nothing clamps, so no test can make that part fail.)
        spec = lifecycle_tx.SPECS["move"]
        with self.assertRaises(orgtx.UnlockedWrite):
            with halt.txn(self.slug, nodes=["t", "k1", "k11"], share_nodes=["root"],
                          sections=spec.sections, share_sections=spec.share_sections,
                          logs=spec.logs) as tx:
                tx.org.insert_parent(ledger.USER, "n", "t")
        self.assertEqual(store.load_org(self.slug).node("n")["parent"], "t")

    def test_a_refused_insertion_writes_nothing(self):
        before = self.view(self.slug)
        with self.assertRaises(ledger.LedgerError):
            lifecycle_tx.insert_parent(self.slug, ledger.USER, "k11", "t")  # not a direct report
        self.assertEqual(self.view(self.slug), before)


if __name__ == "__main__":
    unittest.main()
