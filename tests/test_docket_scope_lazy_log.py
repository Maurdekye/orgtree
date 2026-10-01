"""DOCKET SCOPE HISTORY OUT OF THE EAGER DOCUMENT (docket-history-lazy).

`work_items` is ONE eager value that every whole-org copy decodes, and on the
live org 72% of its 11.8 MB was scope history. An item now keeps only its newest
`Org.WORK_SCOPE_INLINE` scope rows inline; older rows live in the lazy dict log
`work_scope_log[slug]`, loaded for one item only when its rows are served.

WHAT IS PINNED HERE, each with the failure it guards against.

  * WHAT A READER IS SERVED DOES NOT MOVE. `work_get` before a save and after a
    cold reload are equal, field for field, including `scope`, `scope_archive`,
    `scope_archive_summary` and `objective_notice`.
  * A LEGACY ITEM (whole scope inline, plus an inline `scope_archive`) heals
    under the sweep's lock into the new layout and is served exactly what an
    independent oracle, built from the raw legacy lists, says the old build
    served. Nothing is lost and the order is unchanged.
  * THE ONE IN-PLACE WRITE (a supersede pointer) reaches a row that has
    already spilled to the log, and survives a reload.
  * DELETE takes the spilled rows with the item.
  * COUNT-ONLY READS DO NOT LOAD THE LOG. `objective_notice`, the archive
    summary and the live-window count come from counters on the item.
"""
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="v3-scope-lazy-")
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store                      # noqa: E402
from orgtree import ledger                     # noqa: E402
from orgtree.ledger import USER                # noqa: E402

_slugs: set[str] = set()

if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    raise unittest.SkipTest(
        "store.DATA_ROOT already bound elsewhere in this process; "
        "run this file on its own")


def tearDownModule():
    for slug in _slugs:
        store._POOL.close_all(slug)
    _root.cleanup()


INLINE = ledger.Org.WORK_SCOPE_INLINE


def row(seq, text):
    return {"seq": seq, "at": "2026-01-01T00:00:%02d.000Z" % (seq % 60),
            "by": "owner-a", "kind": "decision", "text": text,
            "supersedes": None, "superseded_by": None}


class Base(unittest.TestCase):

    def org_with_item(self, name):
        org = store.create_org(name)
        slug = org.d["slug"]
        _slugs.add(slug)
        org.hire(USER, None, "haiku", 8, "boss", charter="fixture")
        org.hire(USER, "boss", "haiku", 0, "worker", charter="fixture")
        org.work_create("worker", "lazy scope item", "first description",
                        owner="worker")
        wid = org._work_active()[-1]["slug"]
        return org, slug, wid

    def item(self, org, wid):
        return next(i for i in org._work_active() if i["slug"] == wid)

    def served(self, org, wid):
        got = org.work_get(USER, wid)
        return {k: copy.deepcopy(got.get(k)) for k in (
            "scope", "scope_archive", "scope_archive_summary",
            "objective", "objective_notice", "folded")}


class RoundTrip(Base):

    def test_spilled_rows_are_served_unchanged_after_a_cold_reload(self):
        org, slug, wid = self.org_with_item("lazy-roundtrip")
        for i in range(12):
            org.work_decision("worker", wid, "ruling %d" % i)
        org.work_update("worker", wid, objective="second description")
        it = self.item(org, wid)
        self.assertLessEqual(len(it["scope"]), INLINE,
                             "the item still carries its whole scope inline")
        self.assertEqual(int(it["scope_logged"]),
                         len(org.d["work_scope_log"][wid]))
        before = self.served(org, wid)
        self.assertGreater(len(before["scope"]), INLINE + 7)
        store.save_org(org)
        cold = store.load_org(slug)
        self.assertEqual(self.served(cold, wid), before)

    def test_a_supersede_pointer_reaches_a_spilled_row_and_persists(self):
        org, slug, wid = self.org_with_item("lazy-supersede")
        first = org.work_decision("worker", wid, "the ruling to replace")
        first_seq = int(first["decision"])
        for i in range(INLINE + 3):
            org.work_decision("worker", wid, "filler %d" % i)
        it = self.item(org, wid)
        self.assertNotIn(first_seq, [int(r["seq"]) for r in it["scope"]],
                         "the fixture did not spill the row it supersedes")
        store.save_org(org)
        org = store.load_org(slug)
        org.work_decision("worker", wid, "the replacement",
                          supersedes=first_seq)
        store.save_org(org)
        cold = store.load_org(slug)
        rows = {int(r["seq"]): r for r in self.served(cold, wid)["scope"]}
        self.assertIsNotNone(rows[first_seq]["superseded_by"],
                             "the back-pointer on a spilled row was lost")
        self.assertEqual(rows[first_seq]["text"], "the ruling to replace")


class LegacyHeal(Base):

    def test_a_legacy_inline_item_heals_and_is_served_what_the_old_build_served(self):
        org, slug, wid = self.org_with_item("lazy-heal")
        it = self.item(org, wid)
        arch = [row(i + 1, "archived %d" % i) for i in range(10)]
        live = [row(i + 11, "live %d" % i) for i in range(30)]
        it["scope_archive"] = copy.deepcopy(arch)
        it["scope"] = copy.deepcopy(live)
        it["scope_seq"] = 40
        it.pop("scope_logged", None)
        it.pop("scope_rolled", None)
        store.save_org(org)
        org = store.load_org(slug)
        # THE ORACLE: the old build served the inline lists as they were
        want_arch = [int(r["seq"]) for r in arch]
        want_live = [int(r["seq"]) for r in live]
        got = self.served(org, wid)
        self.assertEqual([int(r["seq"]) for r in got["scope_archive"]], want_arch)
        self.assertEqual([int(r["seq"]) for r in got["scope"]], want_live)
        before = got
        # the heal runs under the sweep's lock
        org._work_archive_eligible()
        it = self.item(org, wid)
        self.assertNotIn("scope_archive", it)
        self.assertEqual(int(it["scope_rolled"]), 10)
        self.assertEqual(len(it["scope"]), INLINE)
        self.assertEqual(int(it["scope_logged"]), 40 - INLINE)
        store.save_org(org)
        cold = store.load_org(slug)
        self.assertEqual(self.served(cold, wid), before)
        # and the next scope write keeps the window and the archive apart
        cold.work_decision("worker", wid, "after the heal")
        got = self.served(cold, wid)
        self.assertEqual([int(r["seq"]) for r in got["scope_archive"]], want_arch)
        self.assertEqual([int(r["seq"]) for r in got["scope"]][:-1], want_live)

    def test_the_heal_is_a_noop_on_a_healed_item(self):
        org, slug, wid = self.org_with_item("lazy-noop")
        for i in range(8):
            org.work_decision("worker", wid, "r%d" % i)
        it = self.item(org, wid)
        snap = copy.deepcopy({k: it.get(k) for k in (
            "scope", "scope_logged", "scope_rolled")})
        org._work_archive_eligible()
        it = self.item(org, wid)
        self.assertEqual({k: it.get(k) for k in snap}, snap)


class Delete(Base):

    def test_delete_takes_the_spilled_rows_with_it(self):
        org, slug, wid = self.org_with_item("lazy-delete")
        for i in range(INLINE + 4):
            org.work_decision("worker", wid, "r%d" % i)
        self.assertIn(wid, org.d["work_scope_log"])
        org.work_delete(USER, wid)
        self.assertNotIn(wid, org.d.get("work_scope_log") or {})
        store.save_org(org)
        cold = store.load_org(slug)
        self.assertNotIn(wid, cold.d.get("work_scope_log") or {})


class CountsDoNotLoad(Base):

    def test_notice_summary_and_window_count_leave_the_log_unloaded(self):
        org, slug, wid = self.org_with_item("lazy-counts")
        for i in range(INLINE + 6):
            org.work_decision("worker", wid, "r%d" % i)
        store.save_org(org)
        cold = store.load_org(slug)
        it = self.item(cold, wid)
        logs = cold.d.get("work_scope_log")
        # the instrument must be able to see a load: a SectionMap owner
        self.assertIsInstance(logs, store.SectionMap)
        self.assertFalse(dict.__contains__(logs, wid))
        cold._work_objective_notice(it)
        cold._work_scope_archive_summary(it)
        n = cold._work_scope_live_n(it)
        self.assertFalse(dict.__contains__(logs, wid),
                         "a count-only read loaded the item's scope log")
        # and the instrument does see the load when the rows are served,
        # and the count it answered without loading is the served length
        got = cold.work_get(USER, wid)
        self.assertTrue(dict.__contains__(logs, wid))
        self.assertEqual(n, len(got["scope"]))
        self.assertGreater(n, INLINE)


if __name__ == "__main__":
    unittest.main()
