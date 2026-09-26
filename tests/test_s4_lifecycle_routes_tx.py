"""S4 (fence-off plan): the operator's lifecycle HTTP routes on row transactions.

`node_scope`, `node_reorder`, `org_dissolve_all` and `repair_rename` each run
as ONE `halt.txn` (engine/backend/orgtree/lifecycle_tx.py: set_scope_observed,
reorder, dissolve_all, repair_rename_identity with the conversion's rows) instead of
the legacy DOC_LOCK load-change-save cycle. What this pins, on a disposable
SQLite root:
  * each route commits through exactly one org_tx, in exactly one attempt
    when nothing contends, and broadcasts exactly ONCE (the commit's save
    hook; the routes no longer add their own call — S4 C5);
  * a STALE plan (the snapshot misses a row the locked document needs)
    widens once and then succeeds, with the conversion's backup taken once
    and the observer read on the attempt that commits;
  * a live-effort delivery that raises after the scope commit is a warning,
    not a 500, and the scope change stands (plan decision 27, F2);
  * with the transition fence off, each route completes while another
    thread HOLDS DOC_LOCK: it takes no DOC_LOCK of its own;
  * the rows are the declared ones: shrink a plan and the commit is refused
    with UnlockedWrite, writing nothing — including each of the repair's
    work-identity conversion sections, dropped separately;
  * route behaviour is unchanged: status codes (a missing org per route, a
    refusal), dissolve-all all-or-nothing, a refused repair leaving the
    conversion pending, the scope route's live-effort result; a lock set
    that keeps growing answers 409.

Run:  python tools/run-python-verification.py tests/test_s4_lifecycle_routes_tx.py
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from typing import Any
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-s4-routes-", ignore_cleanup_errors=True)
for _k in [k for k in os.environ if k.startswith("ORGTREE_")]:
    os.environ.pop(_k)
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name,
                  ORGTREE_STORE="sqlite", ORGTREE_WARM="0")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from orgtree import api, halt, ledger, orgtx, store  # noqa: E402
from orgtree import supervisor  # noqa: E402
from orgtree import lifecycle_tx as lt  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

REQ = Request({"type": "http", "headers": []})
_n = [0]


def make_org(legacy_item: bool = False) -> str:
    """root (a, b, c; a has a1) and a second top-level root2 with r2k; a
    docket item owned by `b`, renamed later by the repair tests."""
    _n[0] += 1
    slug = f"s4-routes-{_n[0]}"
    org = store.create_org(slug)
    org.d["max_top_grant"] = 0
    org.hire(USER, None, "opus", 0, "root")
    for k in ("a", "b", "c"):
        org.hire(USER, "root", "opus", 0, k)
    org.hire(USER, "a", "opus", 0, "a1")
    org.hire(USER, None, "opus", 0, "root2")
    org.hire(USER, "root2", "opus", 0, "r2k")
    org.work_create("a", "an item", objective="Problem: x. Solution: y.", owner="a")
    if legacy_item:
        # the retired opaque key, and a question still pointing at the item by
        # it: the conversion rewrites that pointer (its `asks` write)
        item = org.d["work_items"][-1]["slug"]
        aid = org.ask_user("root", "about the item", work_item=item)["asked"]
        next(q for q in org.d["asks"] if q["id"] == aid)["work_item"] = "w0000abcd"
        org.d["work_items"][-1]["id"] = "w0000abcd"
    store.save_org(org)
    return slug


class Counters:
    """txn attempts, org_tx commits and broadcasts during one call."""

    def __init__(self, slug: str):
        self.slug = slug
        self.attempts = 0
        self.commits = 0
        self.hub = 0

    @contextlib.contextmanager
    def watching(self):
        real_txn = halt.txn

        @contextlib.contextmanager
        def txn(slug, **kw):
            if slug == self.slug:
                self.attempts += 1
            with real_txn(slug, **kw) as tx:
                yield tx

        def listener(c):
            if c.slug == self.slug:
                self.commits += 1

        def hub(slug):
            if slug == self.slug:
                self.hub += 1
        orgtx.commit_listeners.append(listener)
        try:
            with patch.object(halt, "txn", txn), patch.object(api, "hub_changed", hub), \
                    patch.object(store, "on_save", hub):
                yield self
        finally:
            orgtx.commit_listeners.remove(listener)


def stranded_repair(slug: str) -> tuple[str, str]:
    """Rename `b` after re-owning the item to it, then strand the item's live
    owner back on the old id, as the pre-fix rename code left it
    (test_rename_history_immutable's fixture). Returns (item, rename_at)."""
    with store.DOC_LOCK:
        org = store.load_org(slug)
        item = org.d["work_items"][-1]["slug"]
        org.work_assign(USER, item, "b")
        org.rename(USER, "b", "b-renamed")
        it = next(i for i in org._work_all() if i["slug"] == item)
        row = [h for h in it["history"] if h.get("op") == "assign"][-1]
        holder = dict(row["to"])
        holder["node"] = "b"
        it["owner"] = row["to"] = holder
        at = [e for e in org.d["events"] if e.get("op") == "rename"][-1]["at"]
        store.save_org(org)
    return item, str(at)


def legacy_stranded() -> tuple[str, str, str]:
    """An org whose docket still needs the work-identity conversion AND holds
    an item a rename stranded: (slug, item, rename_at)."""
    slug = make_org(legacy_item=True)
    with store.DOC_LOCK:                  # the rename needs a converted docket
        org = store.load_org(slug)
        api._work_identity_ready(org, slug)
        store.save_org(org)
    item, at = stranded_repair(slug)
    with store.DOC_LOCK:                  # and back to legacy for the route
        org = store.load_org(slug)
        next(i for i in org._work_all() if i["slug"] == item)["id"] = "w0000abcd"
        # every pointer the conversion rewrites, pointing at the old key
        # again: the question, a node's live ask card, and no marker
        org.d["asks"][-1]["work_item"] = "w0000abcd"
        org.nodes["c"]["ask"] = {"id": "live-card", "work_item": "w0000abcd"}
        org.d.pop("work_identity", None)
        store.save_org(org)
    assert store.load_org(slug).work_identity_state() == "legacy"
    return slug, item, at


class RoutesCommitOnce(unittest.TestCase):
    def setUp(self):
        store.claim_data_root()

    def test_reorder(self):
        slug = make_org()
        with Counters(slug).watching() as c:
            out = api.node_reorder(slug, "c", api.Reorder(before="a"))
        org = store.load_org(slug)
        self.assertEqual([k for k in org.children("root")], ["c", "a", "b"])
        self.assertEqual(out["ui_order"], 0.0)
        self.assertEqual((c.attempts, c.commits, c.hub), (1, 1, 1))

    def test_dissolve_all(self):
        slug = make_org()
        with Counters(slug).watching() as c:
            out = api.org_dissolve_all(slug)
        org = store.load_org(slug)
        self.assertEqual(out["nodes"], 7)
        self.assertEqual({n["state"] for n in org.nodes.values()}, {"archived"})
        self.assertEqual((c.attempts, c.commits, c.hub), (1, 1, 1))

    def test_scope_and_its_live_effort_result(self):
        slug = make_org()
        with Counters(slug).watching() as c:
            out = api.node_scope(slug, "b", api.Scope(effort="high", charter="new card"), REQ)
        org = store.load_org(slug)
        self.assertEqual(org.node("b")["charter"], "new card")
        self.assertEqual(org.effective_effort("b"), "high")
        self.assertIn("effort_delivery", out)
        self.assertEqual((c.attempts, c.commits, c.hub), (1, 1, 1))

    def test_repair_converts_and_repairs_in_one_transaction(self):
        slug, item, at = legacy_stranded()
        backups = []
        real_export = store.export_json
        with Counters(slug).watching() as c, patch.object(
                store, "export_json", lambda s, *a, **k: backups.append(s) or real_export(s, *a, **k)):
            out = api.repair_rename(slug, api.RenameRepair(rename_at=at, work_items=[item]))
        org = store.load_org(slug)
        self.assertEqual(org.work_identity_state(), "slug")
        self.assertIsNotNone(out["migrated"])
        it = next(i for i in org._work_all() if i["slug"] == item)
        self.assertEqual(it["owner"]["node"], "b-renamed")
        self.assertEqual(backups, [slug])              # the pre-migration backup, once
        self.assertEqual((c.attempts, c.commits, c.hub), (1, 1, 1))


def stale(slug: str, change) -> Any:
    """A snapshot of `slug` with `change(org)` applied IN MEMORY only: the
    plan made from it misses rows the committed document needs."""
    org = store.load_org(slug)
    change(org)
    return org


class StalePlansWidenAndSucceed(unittest.TestCase):
    """The rerun path itself: the first attempt's plan (from a stale
    snapshot) misses rows, the locked re-derivation raises Widen, the missing
    rows are merged in and the second attempt commits. Drop a merge and these
    exhaust MAX_WIDEN instead."""

    def setUp(self):
        store.claim_data_root()

    def test_dissolve_all_widens_to_a_root_the_snapshot_missed(self):
        slug = make_org()
        snap = stale(slug, lambda o: o.nodes.pop("root2") and o.nodes.pop("r2k"))
        with Counters(slug).watching() as c, patch.object(store, "cached_org", lambda s: snap):
            out = api.org_dissolve_all(slug)
        self.assertEqual(out["nodes"], 7)
        self.assertEqual({n["state"] for n in store.load_org(slug).nodes.values()}, {"archived"})
        self.assertEqual((c.attempts, c.commits), (2, 1))

    def test_repair_widens_to_a_live_ask_card_and_backs_up_once(self):
        slug, item, at = legacy_stranded()
        snap = stale(slug, lambda o: o.nodes["c"].pop("ask"))
        backups = []
        real_export = store.export_json
        with Counters(slug).watching() as c, patch.object(store, "cached_org", lambda s: snap), \
                patch.object(store, "export_json",
                             lambda s, *a, **k: backups.append(s) or real_export(s, *a, **k)):
            out = api.repair_rename(slug, api.RenameRepair(rename_at=at, work_items=[item]))
        org = store.load_org(slug)
        self.assertEqual((c.attempts, c.commits), (2, 1))
        self.assertEqual(backups, [slug])          # the rerun took no second backup
        self.assertIsNotNone(out["migrated"])
        self.assertEqual(org.work_identity_state(), "slug")
        self.assertEqual(org.node("c")["ask"]["work_item"], item)

    def test_scope_widens_and_reads_the_effort_on_the_committing_attempt(self):
        slug = make_org()
        with store.DOC_LOCK:
            o = store.load_org(slug)
            o.set_scope(USER, "b", effort="low")
            store.save_org(o)
        # the snapshot has lost b's ancestry, so the first plan shares no
        # ancestor rows and the locked re-derivation widens to `root`
        snap = stale(slug, lambda o: o.nodes["b"].update(parent=None))
        seen = []
        real = supervisor.send_live_effort
        with Counters(slug).watching() as c, patch.object(store, "cached_org", lambda s: snap), \
                patch.object(supervisor, "send_live_effort",
                             lambda org, nid, previous=None: seen.append(previous) or real(
                                 org, nid, previous=previous)):
            out = api.node_scope(slug, "b", api.Scope(effort="high"), REQ)
        self.assertEqual((c.attempts, c.commits), (2, 1))
        self.assertEqual(seen, ["low"])
        self.assertIn("effort_delivery", out)
        self.assertEqual(store.load_org(slug).effective_effort("b"), "high")


class RouteBehaviour(unittest.TestCase):
    def setUp(self):
        store.claim_data_root()

    def status(self, fn, *a):
        with self.assertRaises(HTTPException) as cm:
            fn(*a)
        return cm.exception.status_code

    def test_a_failed_live_effort_delivery_is_a_warning_after_the_commit(self):
        slug = make_org()

        def boom(*a, **k):
            raise RuntimeError("delivery failed on purpose")
        with patch.object(supervisor, "send_live_effort", boom):
            out = api.node_scope(slug, "b", api.Scope(effort="high"), REQ)
        self.assertNotIn("effort_delivery", out)
        self.assertIn({"step": "effort_live",
                       "error": "RuntimeError: delivery failed on purpose"},
                      out.get("warnings") or [])
        self.assertEqual(store.load_org(slug).effective_effort("b"), "high")

    def test_missing_org_keeps_each_routes_status(self):
        self.assertEqual(self.status(api.node_scope, "no-such-org", "x", api.Scope(charter="c"),
                                     REQ), 422)
        self.assertEqual(self.status(api.node_reorder, "no-such-org", "x",
                                     api.Reorder(before="y")), 422)
        self.assertEqual(self.status(api.org_dissolve_all, "no-such-org"), 422)
        self.assertEqual(self.status(api.repair_rename, "no-such-org",
                                     api.RenameRepair(rename_at="t")), 404)

    def test_refusals_are_422_and_write_nothing(self):
        slug = make_org()

        def image():
            return json.dumps(store.load_org(slug).d, sort_keys=True, default=str)
        before = image()
        self.assertEqual(self.status(api.node_reorder, slug, "c", api.Reorder(before="nope")), 422)
        self.assertEqual(self.status(api.node_scope, slug, "no-node", api.Scope(charter="c"),
                                     REQ), 422)
        self.assertEqual(self.status(api.repair_rename, slug,
                                     api.RenameRepair(rename_at="not-a-rename")), 422)
        self.assertEqual(image(), before)

    def test_dissolve_all_is_all_or_nothing(self):
        slug = make_org()
        real = ledger.Org.dissolve
        calls = []

        def second_refuses(org_self, actor, nid):
            calls.append(nid)
            if len(calls) == 2:
                raise ledger.LedgerError("refused on purpose")
            return real(org_self, actor, nid)
        with patch.object(ledger.Org, "dissolve", second_refuses):
            self.assertEqual(self.status(api.org_dissolve_all, slug), 422)
        self.assertEqual(len(calls), 2)
        self.assertEqual({n["state"] for n in store.load_org(slug).nodes.values()}, {"live"})

    def test_refused_repair_leaves_the_conversion_pending(self):
        slug = make_org(legacy_item=True)
        self.assertEqual(self.status(api.repair_rename, slug,
                                     api.RenameRepair(rename_at="not-a-rename")), 422)
        self.assertEqual(store.load_org(slug).work_identity_state(), "legacy")

    def test_a_lock_set_that_keeps_growing_answers_409(self):
        slug = make_org()
        grew = []

        def always(tx, *a, **k):
            grew.append(1)
            raise lt.Widen(nodes={"a"})
        with patch.object(lt, "_need", always):
            self.assertEqual(self.status(api.org_dissolve_all, slug), 409)
        self.assertEqual(len(grew), lt.MAX_WIDEN + 1)
        self.assertEqual({n["state"] for n in store.load_org(slug).nodes.values()}, {"live"})


class NoDocLock(unittest.TestCase):
    """Fence off: each route completes while another thread holds DOC_LOCK.
    "Off" is BOTH flags: `orgtx.TRANSITION_FENCE` and `halt._FENCE`, which
    `halt.txn` takes on its own (it stays on until DOC_LOCK is gone)."""

    def setUp(self):
        store.claim_data_root()
        self.enterContext(patch.object(orgtx, "TRANSITION_FENCE", False))
        self.enterContext(patch.object(halt, "_FENCE", False))

    def under_held_doc_lock(self, fn):
        held, release = threading.Event(), threading.Event()

        def holder():
            with store.DOC_LOCK:
                held.set()
                release.wait(20)
        h = threading.Thread(target=holder, daemon=True)
        h.start()
        self.assertTrue(held.wait(5))
        out: dict = {}

        def call():
            try:
                out["result"] = fn()
            except BaseException as e:                       # noqa: BLE001
                out["error"] = e
        t = threading.Thread(target=call, daemon=True)
        t.start()
        t.join(10)
        finished = not t.is_alive()
        release.set()
        h.join(10)
        t.join(10)
        self.assertTrue(finished, "the route waited on DOC_LOCK")
        self.assertNotIn("error", out, out.get("error"))
        return out["result"]

    def test_every_route_runs_without_doc_lock(self):
        slug, item, at = legacy_stranded()
        self.under_held_doc_lock(lambda: api.node_reorder(slug, "c", api.Reorder(after="a")))
        self.under_held_doc_lock(lambda: api.node_scope(slug, "a", api.Scope(charter="z"), REQ))
        out = self.under_held_doc_lock(lambda: api.repair_rename(
            slug, api.RenameRepair(rename_at=at, work_items=[item])))
        self.assertEqual(out["work_items"], [{"item": item, "field": "owner"}])
        out = self.under_held_doc_lock(lambda: api.org_dissolve_all(slug))
        self.assertEqual(out["nodes"], 7)


class DeclaredRowsAreNeeded(unittest.TestCase):
    """Shrink a plan and the commit is refused with UnlockedWrite, writing
    nothing (lifecycle_tx's family pattern)."""

    def setUp(self):
        store.claim_data_root()

    def test_reorder_needs_every_sibling_row(self):
        slug = make_org()
        real = lt._reorder_rows

        def without_b(org, actor, nid):
            upd, share = real(org, actor, nid)
            return upd - {"b"}, share
        with patch.object(lt, "_reorder_rows", without_b):
            with self.assertRaises(orgtx.UnlockedWrite):
                lt.reorder(slug, USER, "c", "a", None)
        self.assertEqual(store.load_org(slug).children("root"), ["a", "b", "c"])

    def test_dissolve_all_needs_its_sections_and_logs(self):
        spec = lt.SPECS["dissolve_all"]
        for field, drop in (("sections", "notices"), ("logs", "events")):
            slug = make_org()
            smaller = lt.Spec(
                sections=tuple(s for s in spec.sections if not (field == "sections" and s == drop)),
                share_sections=spec.share_sections,
                logs=tuple(x for x in spec.logs if not (field == "logs" and x == drop)))
            with patch.dict(lt.SPECS, {"dissolve_all": smaller}):
                with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                    lt.dissolve_all(slug, USER)
            self.assertEqual({n["state"] for n in store.load_org(slug).nodes.values()},
                             {"live"}, drop)

    def test_repair_needs_the_live_ask_card_rows(self):
        slug, item, at = legacy_stranded()
        with self.assertRaises(orgtx.UnlockedWrite):
            lt.repair_rename_identity(
                slug, USER, at, extra_sections=api.WORK_CONVERSION_SECTIONS,
                extra_nodes=lambda org: api.work_conversion_nodes(org) - {"c"},
                pre=api._work_identity_ready_once(slug), work_items=[item])
        org = store.load_org(slug)
        self.assertEqual((org.work_identity_state(), org.node("c")["ask"]["work_item"]),
                         ("legacy", "w0000abcd"))

    def test_repair_needs_each_conversion_section(self):
        refused = []
        for drop in api.WORK_CONVERSION_SECTIONS:
            slug, item, at = legacy_stranded()
            kept = tuple(x for x in api.WORK_CONVERSION_SECTIONS if x != drop)
            with self.assertRaises(orgtx.UnlockedWrite, msg=drop):
                lt.repair_rename_identity(
                    slug, USER, at, extra_sections=kept,
                    extra_nodes=api.work_conversion_nodes,
                    pre=api._work_identity_ready_once(slug), work_items=[item])
            refused.append(drop)
            self.assertEqual(store.load_org(slug).work_identity_state(), "legacy", drop)
        self.assertEqual(refused, list(api.WORK_CONVERSION_SECTIONS))


if __name__ == "__main__":
    unittest.main()
