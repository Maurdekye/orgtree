"""COUNTING THE ARCHIVED DOCKET WITHOUT MATERIALISING IT.

`work_items_archive` is a lazy section -- 508 rows and 10.17 MB on the operator's
org, larger than the whole eager document -- and two counting loops walked all of
it to produce four integers. A cold `orgtree_work list`, and every cold
`Ledger.tree()` behind the UI poll, paid a 10.4 MB parse for a count.
`LazyDoc.project` reads only the fields the classifiers need; `_work_archive_proj`
hands those to the SAME predicates.

WHAT IS PINNED HERE, each with the failure it guards against.

  * THE COUNTS DO NOT MOVE. An independent oracle -- the pre-change loop,
    rewritten in this file over WHOLE items -- is compared against the live
    implementation on a deliberately mixed docket: physically archived items,
    active-but-rolled-over done items, backlogged items, items the viewer cannot
    read, and an item carrying attention. This assertion matters more than the
    speed one, because a wrong badge is worse than a slow call.

  * THE PROJECTION COVERS WHAT THE PREDICATES READ. Every classifier is run
    twice on every archived item -- once on the whole record, once on the
    projected mapping -- and the answers must match. This is what fails when
    `_WORK_PROJ` falls behind a predicate that starts reading a new field, which
    is the one way this design can rot silently.

  * THE SECTION IS NOT MATERIALISED, ASSERTED AS AN EXACT COUNT. Bounds would
    let a re-added access pass; `assertEqual(0, ...)` does not. And the same
    instrument must SEE a materialisation when one legitimately happens
    (`include_archived=True`), so a zero is provably an instrument that works
    rather than one that never fired.

  * A DEPENDENCY ON AN ARCHIVED ITEM DOES NOT DRAG THE SECTION IN. `_work_view`
    resolves every dependency, and `_work_find` falls through to the archive.
    Two live items on the operator's org depend on archived items right now, so
    without `_work_pointer_target` the counting fix bought nothing at all.

  * AN ARCHIVED ROW THAT HOLDS ATTENTION IS STILL SERVED WHOLE, on the main
    list, because attention outranks the list the row is physically in. That is
    the one branch a projection cannot answer, and it must pay for the section
    rather than quietly drop the row.

  * A CACHED PROJECTION CANNOT GO STALE. Materialising, replacing, deleting or
    buffering an append all drop it. The materialisation is the gate: an entry
    cannot be edited in place by a caller that has not first obtained it.
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="v2-archive-proj-")
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store                      # noqa: E402
from orgtree.ledger import USER, LedgerError    # noqa: E402

_slugs: set[str] = set()

if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    raise unittest.SkipTest(
        "store.DATA_ROOT already bound elsewhere in this process; "
        "run this file on its own")


def tearDownModule():
    for slug in _slugs:
        store._POOL.close_all(slug)
    _root.cleanup()


OLD = "2020-01-01T00:00:00.000Z"          # older than WORK_ARCHIVE_AFTER_S
NEW = "2099-01-01T00:00:00.000Z"          # never rolls over


# --------------------------------------------------------------- THE ORACLE
# The pre-change implementation, over WHOLE items, written out here so the
# comparison is against an independent statement of the rule rather than
# against the code under test calling itself.
def oracle_counts(org, now_ts):
    attention = active = archived = backlogged = 0
    for it, phys in ([(i, False) for i in org._work_active()]
                     + [(i, True) for i in org._work_archive()]):
        if org._work_attention(it):
            attention += 1
        if org._work_archived(it, phys, now_ts):
            archived += 1
        elif org._work_backlogged(it):
            backlogged += 1
        elif org._work_counts_active(it):
            active += 1
    return {"attention": attention, "active": active,
            "archived": archived, "backlogged": backlogged}


def oracle_groups(org, viewer, now_ts):
    """The three group sizes the old loop produced, for any viewer."""
    items, arch, back = [], [], []
    for it, phys in ([(i, False) for i in org._work_active()]
                     + [(i, True) for i in org._work_archive()]):
        if not org._work_can_read(viewer, it):
            continue
        v = org._work_view(it, phys, viewer, now_ts, scope_archive=False)
        if v["archived"]:
            arch.append(v)
        elif org._work_backlogged(it):
            back.append(v)
        else:
            items.append(v)
    counts = (oracle_counts(org, now_ts) if viewer == USER else {
        "attention": sum(1 for v in items + arch + back
                         if v["effective_attention"]),
        "active": sum(1 for v in items
                      if v["status"] not in org.WORK_UNCOUNTED),
        "archived": len(arch),
        "backlogged": len(back)})
    return counts, {"items": len(items), "archived": len(arch),
                    "backlogged": len(back)}


class ArchiveProjectionBase(unittest.TestCase):
    """A mixed docket, saved to real rows, then reloaded cold."""

    def mixed(self, name):
        org = store.create_org(name)
        slug = org.d["slug"]
        _slugs.add(slug)
        # ⚠ HIRED, NOT HAND-ROLLED. `Ledger.tree()` reads fields a hand-built
        # node dict does not have (`created`, `title`, and whatever is added
        # next), and the point of the tree test below is the archive section,
        # not my guess at a node's shape. Going through `hire` means the fixture
        # cannot drift out of date with what a real seat carries.
        org.hire(USER, None, "haiku", 8, "boss", charter="fixture")
        org.hire(USER, "boss", "haiku", 0, "worker", charter="fixture")
        org.hire(USER, None, "haiku", 8, "stranger", charter="fixture")
        org.hire(USER, "stranger", "haiku", 0, "helper", charter="fixture")
        mk = org.work_create

        # -- rows destined for the PHYSICAL archive (done, stale) ------------
        for i in range(4):
            mk("worker", "phys done %d" % i, "o", owner="worker")
        # one archived item nobody but its own branch may read
        mk("stranger", "phys done stranger", "o", owner="stranger")
        # one archived item reachable only through PARTICIPATION
        mk("stranger", "phys done participant", "o", owner="stranger",
           participants=["worker"])
        # one archived item reachable only as the named REVIEWER
        mk("stranger", "phys done reviewer", "o", owner="stranger")
        # -- rows that stay ACTIVE -----------------------------------------
        mk("worker", "open one", "o", owner="worker")
        mk("worker", "rolled over done", "o", owner="worker")
        mk("worker", "backlogged one", "o", owner="worker",
           status="backlogged")
        mk("stranger", "unreadable open", "o", owner="stranger")
        mk("worker", "attention one", "o", owner="worker")
        # a live item whose DEPENDENCY will be archived -- the site that made
        # the counting fix insufficient on its own
        mk("worker", "depends on archived", "o", owner="worker",
           dependencies=["phys-done-0"])

        by_slug = {it["slug"]: it for it in org._work_active()}
        by_slug["phys-done-reviewer"]["reviewer"] = {"node": "worker",
                                                     "generation": 1}
        for s in ("phys-done-0", "phys-done-1", "phys-done-2", "phys-done-3",
                  "phys-done-stranger", "phys-done-participant",
                  "phys-done-reviewer"):
            by_slug[s].update(status="done", docket_at=OLD, updated_at=OLD)
        by_slug["attention-one"]["manual_attention"] = {
            "reason": "look at this", "at": NEW, "set_rev": 1}
        for s in ("open-one", "backlogged-one", "unreadable-open",
                  "attention-one", "depends-on-archived", "rolled-over-done"):
            by_slug[s].update(docket_at=NEW, updated_at=NEW)

        moved = org._work_sweep()          # physically archive the stale done
        self.assertEqual(len(moved), 7, "the fixture did not archive 7 rows")
        # ⚠ STALED AFTER THE SWEEP, DELIBERATELY. This row is DONE and old
        # enough to read as archived, but it still sits in the ACTIVE list
        # because no mutation has swept it yet -- the case that makes the
        # archived count differ from the physical archive's length, and the one
        # a `len(work_items_archive)` shortcut gets wrong. Staling it before the
        # sweep would simply have archived it too (the first draft of this
        # fixture did exactly that, and every test in the file failed on the
        # count rather than on the thing it was testing).
        act = {it["slug"]: it for it in org._work_active()}
        act["rolled-over-done"].update(status="done", docket_at=OLD,
                                       updated_at=OLD)
        store.save_org(org)
        return slug

    def cold(self, slug):
        """A document whose lazy sections are untouched."""
        store._bump_org_seq(slug)
        return store.load_org(slug)

    def counting(self):
        """(counter, restore) around LazyDoc.__missing__ for the archive."""
        seen = []
        real = store.LazyDoc.__missing__

        def probe(doc, k):
            if k == "work_items_archive":
                seen.append(k)
            return real(doc, k)

        store.LazyDoc.__missing__ = probe
        self.addCleanup(setattr, store.LazyDoc, "__missing__", real)
        return seen


class CountsDoNotMove(ArchiveProjectionBase):
    """The assertion that matters most: the numbers are the same numbers."""

    def test_counts_and_groups_match_the_oracle_for_every_viewer(self):
        slug = self.mixed("Counts Oracle")
        now = time.time()
        for viewer in (USER, "worker", "boss", "stranger", "helper"):
            with self.subTest(viewer=viewer):
                live = self.cold(slug).work_list(viewer, now_ts=now)
                want_counts, want_groups = oracle_groups(
                    self.cold(slug), viewer, now)
                self.assertEqual(live["counts"], want_counts)
                self.assertEqual(
                    {k: v["count"] for k, v in live["groups"].items()},
                    want_groups)

    def test_counts_identical_with_and_without_include_archived(self):
        """The archive's SIZE is reported whether or not its rows are served."""
        slug = self.mixed("Counts Symmetry")
        now = time.time()
        for viewer in (USER, "worker"):
            a = self.cold(slug).work_list(viewer, now_ts=now)
            b = self.cold(slug).work_list(viewer, include_archived=True,
                                          now_ts=now)
            self.assertEqual(a["counts"], b["counts"])
            self.assertEqual({k: v["count"] for k, v in a["groups"].items()},
                             {k: v["count"] for k, v in b["groups"].items()})

    def test_work_counts_matches_the_oracle(self):
        slug = self.mixed("Work Counts Oracle")
        now = time.time()
        self.assertEqual(self.cold(slug).work_counts(now),
                         oracle_counts(self.cold(slug), now))

    def test_the_mixed_docket_actually_contains_every_case(self):
        """THE CONTROL ON THE FIXTURE ITSELF. Acceptance condition 3 names five
        shapes, and an oracle comparison over a docket missing one of them
        passes without ever testing it — both sides would read the same absent
        thing. So each shape is asserted present before the comparisons above
        are worth anything. Written after the first draft silently lost the
        attention flag and still went green.
        """
        org = self.cold(self.mixed("Fixture Control"))
        now = time.time()
        act = {it["slug"]: it for it in org._work_active()}
        arch = {it["slug"]: it for it in org._work_archive()}
        self.assertEqual(len(arch), 7, "no physically archived rows")
        self.assertTrue(org._work_archived(act["rolled-over-done"], False, now),
                        "no active-but-rolled-over row")
        self.assertTrue(org._work_backlogged(act["backlogged-one"]),
                        "no backlogged row")
        self.assertFalse(org._work_can_read("worker", act["unreadable-open"]),
                         "no row the viewer cannot read")
        self.assertFalse(org._work_can_read("worker", arch["phys-done-stranger"]),
                         "no ARCHIVED row the viewer cannot read")
        self.assertEqual(org._work_attention(act["attention-one"]), ["manual"],
                         "the attention case is not in the fixture")
        self.assertEqual(org.work_counts(now)["attention"], 1)
        self.assertTrue(act["depends-on-archived"]["dependencies"],
                        "no dependency pointing into the archive")

    def test_a_physical_count_would_have_been_wrong(self):
        """The fixture actually exercises the trap, so the oracle test above is
        not passing on a docket where every shortcut happens to agree."""
        org = self.cold(slug := self.mixed("Trap Present"))
        now = time.time()
        counts = org.work_counts(now)
        self.assertEqual(len(org._work_archive()), 7)
        self.assertEqual(counts["archived"], 8,
                         "expected 7 physical + 1 rolled-over active")
        del slug


class ProjectionCoversThePredicates(ArchiveProjectionBase):
    """The one way this design can rot silently."""

    def test_every_classifier_agrees_on_the_projection_and_the_whole_item(self):
        org = self.cold(self.mixed("Predicate Fidelity"))
        now = time.time()
        # ⚠ PROJECTED FIRST, DELIBERATELY. Reading `_work_archive()` first would
        # make the projection come from the materialised list, and this test
        # would then compare the in-memory path against itself and prove
        # nothing about what SQLite extracted.
        proj = org._work_archive_proj()
        full = org._work_archive()
        self.assertEqual(len(proj), len(full))
        self.assertTrue(proj, "fixture has no archived rows to compare")
        for p, f in zip(proj, full):
            with self.subTest(slug=f.get("slug")):
                self.assertEqual(p["slug"], f["slug"])
                self.assertEqual(org._work_status(p), org._work_status(f))
                self.assertEqual(org._work_attention(p), org._work_attention(f))
                self.assertEqual(org._work_archived(p, True, now),
                                 org._work_archived(f, True, now))
                self.assertEqual(org._work_backlogged(p), org._work_backlogged(f))
                self.assertEqual(org._work_counts_active(p),
                                 org._work_counts_active(f))
                self.assertEqual(org._work_eligible(p, now),
                                 org._work_eligible(f, now))
                for viewer in (USER, "worker", "boss", "stranger", "helper"):
                    self.assertEqual(org._work_can_read(viewer, p),
                                     org._work_can_read(viewer, f),
                                     "readability disagrees for %s" % viewer)
                    self.assertEqual(org._work_can_manage(viewer, p),
                                     org._work_can_manage(viewer, f))

    def test_the_fixture_exercises_all_three_ways_to_be_readable(self):
        """Owner, participant and reviewer each decide at least one archived
        row, so the agreement above is not trivially true."""
        org = self.cold(self.mixed("Readable Paths"))
        proj = {p["slug"]: p for p in org._work_archive_proj()}
        self.assertFalse(org._work_can_read("worker", proj["phys-done-stranger"]))
        self.assertTrue(org._work_can_read("worker", proj["phys-done-participant"]))
        self.assertTrue(org._work_can_read("worker", proj["phys-done-reviewer"]))
        self.assertTrue(org._work_can_read("worker", proj["phys-done-0"]))

    def test_projection_field_list_is_a_superset_of_what_predicates_read(self):
        """A field a predicate reads but the projection omits would come back as
        None and answer wrongly. Checked by NAME, so adding a read of a new
        field to a predicate without adding it here fails."""
        org = self.cold(self.mixed("Field List"))
        needed = {"slug", "status", "docket_at", "updated_at", "owner",
                  "created_by", "participants", "reviewer", "manual_attention"}
        self.assertTrue(needed <= set(org._WORK_PROJ),
                        "missing: %s" % (needed - set(org._WORK_PROJ)))


class SectionIsNotMaterialised(ArchiveProjectionBase):
    """Exact counts, and an instrument proved to fire."""

    def test_cold_work_list_does_not_materialise_the_archive(self):
        slug = self.mixed("No Materialise List")
        seen = self.counting()
        out = self.cold(slug).work_list("worker")
        self.assertEqual(len(seen), 0, "materialised: %r" % seen)
        # 7 = four archived rows `worker` owns + one it may read by
        # PARTICIPATION + one as the named REVIEWER + the rolled-over row still
        # sitting in the ACTIVE list. The first draft asserted 4 and was wrong
        # about its own fixture in three different ways.
        self.assertEqual(out["groups"]["archived"]["count"], 7)

    def test_cold_work_list_for_the_user_does_not_materialise_the_archive(self):
        """The user's path also runs `work_counts`, a second walk of the same
        section, and the UI polls it."""
        slug = self.mixed("No Materialise User")
        seen = self.counting()
        out = self.cold(slug).work_list(USER)
        self.assertEqual(len(seen), 0, "materialised: %r" % seen)
        self.assertEqual(out["counts"]["archived"], 8)

    def test_cold_work_counts_does_not_materialise_the_archive(self):
        slug = self.mixed("No Materialise Counts")
        seen = self.counting()
        self.cold(slug).work_counts()
        self.assertEqual(len(seen), 0, "materialised: %r" % seen)

    def test_cold_tree_does_not_materialise_the_archive(self):
        """`Ledger.tree()` carries the docket badge and is polled by the UI, so
        it paid the same parse on a timer."""
        slug = self.mixed("No Materialise Tree")
        seen = self.counting()
        self.cold(slug).tree()
        self.assertEqual(len(seen), 0, "materialised: %r" % seen)

    def test_include_archived_materialises_exactly_once(self):
        """THE NEGATIVE CONTROL. A section that legitimately IS loaded must show
        up in the very same instrument, so the zeros above are a working
        instrument rather than one that never fired."""
        slug = self.mixed("Negative Control")
        seen = self.counting()
        out = self.cold(slug).work_list("worker", include_archived=True)
        self.assertEqual(len(seen), 1, "expected exactly one materialisation")
        self.assertEqual(len(out["archived"]), 7)

    def counting_projections(self):
        """Count narrow reads that actually READ — cache MISSES, not calls.

        ⚠ COUNTING CALLS, OR INSPECTING THE CACHE AFTERWARDS, BOTH LIE HERE.
        `project` memoises per (section, fields), so a second caller is a hit
        rather than a read; and materialising the section DROPS the cache
        (`_drop_proj`), so a projection that really was built leaves no trace by
        the time the call returns. The first version of the two tests below
        asserted on `_proj` after the fact and passed under mutations M16 and
        M17, which is how this instrument came to be written.
        """
        reads = []
        real = store.LazyDoc.project

        def probe(doc, k, fields):
            miss = (k, fields) not in doc._proj
            out = real(doc, k, fields)
            if miss:
                reads.append(k)
            return out

        store.LazyDoc.project = probe
        self.addCleanup(setattr, store.LazyDoc, "project", real)
        return reads

    def test_include_archived_does_not_also_build_a_projection(self):
        """A narrow read of a section the process is ALREADY HOLDING WHOLE is
        pure waste, and the first draft of this fix did exactly that: serving the
        archive materialised it (48 ms) and the dependency resolution then built
        a projected copy of the same rows (17 ms), which made this arm SLOWER
        than before the fix — 116.9 ms to 177.7 ms for an agent, measured, while
        every other arm got much faster. Pinned so it cannot come back quietly.
        """
        slug = self.mixed("No Double Read")
        reads = self.counting_projections()
        out = self.cold(slug).work_list("worker", include_archived=True)
        self.assertEqual(len(out["archived"]), 7)
        self.assertEqual(reads, [],
                         "projected a section that was already materialised")

    def test_the_cold_path_still_projects(self):
        """THE NEGATIVE CONTROL for the test above. If `_work_archive_rows` ever
        preferred the whole section unconditionally, no projection would be built
        at all — the fix would be silently undone and that test would still
        pass, because "no projection" is exactly what it asserts."""
        slug = self.mixed("Cold Path Projects")
        reads = self.counting_projections()
        self.cold(slug).work_list("worker")
        self.assertEqual(reads, ["work_items_archive"])

    def test_a_dependency_on_an_archived_item_does_not_materialise(self):
        """`_work_view` resolves dependencies, and `_work_find` falls through to
        the archive. Without `_work_pointer_target` this alone re-materialised the section
        on the same call and the counting fix bought nothing."""
        slug = self.mixed("Dependency Pointer")
        seen = self.counting()
        out = self.cold(slug).work_list("worker")
        self.assertEqual(len(seen), 0, "materialised: %r" % seen)
        row = next(r for r in out["items"]
                   if r["slug"] == "depends-on-archived")
        self.assertEqual(row["dependencies"],
                         [{"slug": "phys-done-0", "visible": True,
                           "title": "phys done 0", "status": "done"}])

    def test_an_unreadable_archived_dependency_is_anonymous_not_missing(self):
        """The projection must not leak a title the viewer may not read, and
        must not lose the fact that the dependency exists."""
        slug = self.mixed("Dependency Hidden")
        org = self.cold(slug)
        dep = next(it for it in org._work_active()
                   if it["slug"] == "depends-on-archived")
        dep["dependencies"] = ["phys-done-stranger"]
        out = org.work_list("worker")
        row = next(r for r in out["items"]
                   if r["slug"] == "depends-on-archived")
        self.assertEqual(row["dependencies"], [{"visible": False}])


class AttentionOutranksTheArchive(ArchiveProjectionBase):
    """The branch a projection cannot answer."""

    def archived_with_attention(self, name):
        slug = self.mixed(name)
        org = store.load_org(slug)
        it = next(i for i in org._work_archive() if i["slug"] == "phys-done-1")
        it["manual_attention"] = {"reason": "raised after archiving",
                                  "at": NEW, "set_rev": 1}
        store.save_org(org)
        return slug

    def test_an_archived_row_holding_attention_is_served_on_the_main_list(self):
        slug = self.archived_with_attention("Attention In Archive")
        out = self.cold(slug).work_list("worker")
        served = {r["slug"] for r in out["items"]}
        self.assertIn("phys-done-1", served,
                      "an archived row holding attention must still be visible")
        self.assertEqual(out["groups"]["archived"]["count"], 6,
                         "the row must leave the archive group, not be dropped")
        row = next(r for r in out["items"] if r["slug"] == "phys-done-1")
        self.assertTrue(row["effective_attention"])
        # served WHOLE -- a field outside the projection proves the full record
        # was fetched rather than the narrow mapping being passed off as an item
        self.assertEqual(row["objective"], "o")

    def test_that_row_is_counted_by_the_oracle_the_same_way(self):
        slug = self.archived_with_attention("Attention Oracle")
        now = time.time()
        live = self.cold(slug).work_list("worker", now_ts=now)
        want_counts, want_groups = oracle_groups(self.cold(slug), "worker", now)
        self.assertEqual(live["counts"], want_counts)
        self.assertEqual({k: v["count"] for k, v in live["groups"].items()},
                         want_groups)

    def test_archived_rows_contribute_nothing_to_the_attention_count(self):
        """`work_list` sums `effective_attention` over items+arch+back and
        leaves `arch` empty when the archive is not served. That is only safe
        because a row reaching `arch` cannot hold attention -- asserted here
        rather than assumed, since the whole count rests on it."""
        org = self.cold(self.mixed("Attention Invariant"))
        now = time.time()
        for p in org._work_archive_proj():
            if org._work_archived(p, True, now):
                self.assertEqual(org._work_attention(p), [],
                                 "%s is archived AND holds attention" % p["slug"])

    def test_an_open_question_on_an_archived_item_also_pulls_it_back(self):
        """Attention is not only the manual flag: an open ask attached to the
        item counts, and the ask store is reached by SLUG, which the projection
        carries."""
        slug = self.mixed("Question Attention")
        org = store.load_org(slug)
        org.d.setdefault("asks", []).append(
            {"id": "a1", "node": "worker", "status": "open", "at": NEW,
             "questions": [{"question": "well?", "work_item": "phys-done-2"}]})
        store.save_org(org)
        out = self.cold(slug).work_list("worker")
        self.assertIn("phys-done-2", {r["slug"] for r in out["items"]})
        self.assertEqual(out["groups"]["archived"]["count"], 6)


class IncludeArchivedStillServesTheRows(ArchiveProjectionBase):
    def test_full_archived_rows_come_back(self):
        slug = self.mixed("Serve Archived")
        out = self.cold(slug).work_list("worker", include_archived=True)
        self.assertEqual(len(out["archived"]), 7)
        for row in out["archived"]:
            self.assertEqual(row["status"], "done")
            self.assertEqual(row["objective"], "o")
            self.assertTrue(row["archived"])
            self.assertIn("history", row)

    def test_work_get_still_reads_an_archived_item_whole(self):
        slug = self.mixed("Get Archived")
        got = self.cold(slug).work_get("worker", "phys-done-0")
        self.assertEqual(got["slug"], "phys-done-0")
        self.assertEqual(got["objective"], "o")


class ProjectionCannotGoStale(ArchiveProjectionBase):
    """A cached narrow read must never outlive the rows being the whole truth."""

    def test_materialising_then_editing_is_seen_by_a_later_projection(self):
        org = self.cold(self.mixed("Stale Edit"))
        first = org._work_archive_proj()
        self.assertEqual(
            next(p["status"] for p in first if p["slug"] == "phys-done-0"),
            "done")
        it = next(i for i in org._work_archive() if i["slug"] == "phys-done-0")
        it["status"] = "dropped"
        again = org._work_archive_proj()
        self.assertEqual(
            next(p["status"] for p in again if p["slug"] == "phys-done-0"),
            "dropped", "the projection was served from a stale cache")

    def test_replacing_the_section_is_seen(self):
        org = self.cold(self.mixed("Stale Replace"))
        self.assertEqual(len(org._work_archive_proj()), 7)
        org.d["work_items_archive"] = []
        self.assertEqual(org._work_archive_proj(), [])

    def test_a_buffered_append_is_seen(self):
        org = self.cold(self.mixed("Stale Append"))
        self.assertEqual(len(org._work_archive_proj()), 7)
        store.log_append(org.d, "work_items_archive",
                         {"slug": "added-late", "status": "done"})
        after = org._work_archive_proj()
        self.assertEqual(len(after), 8)
        self.assertIn("added-late", {p["slug"] for p in after})

    def test_clearing_the_document_is_seen(self):
        """`clear()` marks every lazy section dropped WITHOUT materialising any
        of them, so it is the one invalidation route a cached projection cannot
        survive by accident — after it, an uninvalidated cache would be the only
        thing still claiming the archive had rows. Found by mutation M14, which
        survived until this test existed.
        """
        org = self.cold(self.mixed("Stale Clear"))
        self.assertEqual(len(org._work_archive_proj()), 7)
        org.d.clear()
        self.assertEqual(org._work_archive_proj(), [])

    def test_deleting_the_section_is_seen(self):
        org = self.cold(self.mixed("Stale Delete"))
        self.assertEqual(len(org._work_archive_proj()), 7)
        del org.d["work_items_archive"]
        self.assertEqual(org._work_archive_proj(), [])


class ProjectApiContract(ArchiveProjectionBase):
    def test_one_field_is_refused_rather_than_guessed(self):
        """`json_extract` with a single path returns a bare value that cannot be
        told apart from JSON text, so one field is refused instead of parsed."""
        org = self.cold(self.mixed("Project One Field"))
        with self.assertRaises(ValueError) as caught:
            org.d.project("work_items_archive", ("slug",))
        self.assertIn("at least 2 fields", str(caught.exception))

    def test_a_dict_log_is_refused(self):
        org = self.cold(self.mixed("Project Dict Log"))
        with self.assertRaises(ValueError):
            org.d.project("steer_attempts", ("a", "b"))

    def test_a_non_lazy_key_is_refused(self):
        org = self.cold(self.mixed("Project Eager"))
        with self.assertRaises(ValueError):
            org.d.project("nodes", ("a", "b"))

    def test_absent_fields_come_back_as_none_like_get_does(self):
        org = self.cold(self.mixed("Project Absent"))
        rows = org.d.project("work_items_archive", ("slug", "no_such_field"))
        self.assertTrue(rows)
        for r in rows:
            self.assertIsNone(r["no_such_field"])

    def test_nested_objects_and_lists_survive_the_projection(self):
        """`owner` is an object and `participants` a list; both have to come back
        as structures, not as JSON text, or `_work_can_read` silently fails."""
        org = self.cold(self.mixed("Project Shapes"))
        rows = {p["slug"]: p for p in org._work_archive_proj()}
        owner = rows["phys-done-participant"]["owner"]
        # a dict, not the string '{"node": ...}' -- if json_extract handed back
        # JSON TEXT for a nested value, `_work_actor_node` would read it as a
        # bare string and every readability answer would quietly flip
        self.assertIsInstance(owner, dict)
        self.assertEqual(owner["node"], "stranger")
        self.assertIsInstance(rows["phys-done-participant"]["participants"], list)
        self.assertEqual(rows["phys-done-participant"]["participants"], ["worker"])
        reviewer = rows["phys-done-reviewer"]["reviewer"]
        self.assertIsInstance(reviewer, dict)
        self.assertEqual(reviewer["node"], "worker")

    def test_a_plain_dict_document_still_answers(self):
        """`Org.create` and test fixtures hold a plain dict with no rows to
        project from; the narrowing then happens in Python. Same answers."""
        from orgtree.ledger import Org
        org = Org.create("plain-dict-projection")
        org.d["work_items_archive"] = [
            {"slug": "a", "status": "done", "objective": "big",
             "owner": {"node": "x", "generation": 1}}]
        rows = org._work_archive_proj()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["slug"], "a")
        self.assertEqual(rows[0]["owner"], {"node": "x", "generation": 1})
        self.assertIsNone(rows[0]["reviewer"])
        self.assertNotIn("objective", rows[0])

    def test_projection_is_read_from_the_rows_not_the_section(self):
        """Proves the SQL path is the one under test: the rows on disk are
        edited behind the document's back, and the projection sees the edit
        while the unmaterialised section is still untouched."""
        slug = self.mixed("Project From Rows")
        store._POOL.close_all(slug)
        con = sqlite3.connect(store._db_path(slug))
        try:
            seq, val = con.execute(
                "SELECT seq, val FROM log_l WHERE sect='work_items_archive' "
                "ORDER BY seq LIMIT 1").fetchone()
            row = json.loads(val)
            row["status"] = "superseded"
            con.execute("UPDATE log_l SET val=? WHERE sect=? AND seq=?",
                        (json.dumps(row), "work_items_archive", seq))
            con.commit()
        finally:
            con.close()
        org = self.cold(slug)
        got = {p["slug"]: p["status"] for p in org._work_archive_proj()}
        self.assertEqual(got[row["slug"]], "superseded")


class NonReadPathsAreUntouched(ArchiveProjectionBase):
    """The sites the ticket marked out of scope stay as they are."""

    def test_find_still_resolves_an_archived_item_whole(self):
        org = self.cold(self.mixed("Find Whole"))
        it, phys = org._work_find("phys-done-0")
        self.assertTrue(phys)
        self.assertEqual(it["objective"], "o")

    def test_find_still_refuses_an_unknown_name(self):
        org = self.cold(self.mixed("Find Unknown"))
        with self.assertRaises(LedgerError):
            org._work_find("no-such-item")

    def test_pointer_target_returns_none_for_an_unknown_name(self):
        org = self.cold(self.mixed("Ref Unknown"))
        self.assertIsNone(org._work_pointer_target("no-such-item"))

    def test_the_pre_existing_work_ref_still_names_an_item(self):
        """⚠ A NAME COLLISION I CAUSED, PINNED SO IT CANNOT RECUR. The new
        pointer resolver was first called `_work_ref` — and `Org` ALREADY had a
        `_work_ref(it) -> str`, which returns an item's NAME. Mine was defined
        later in the class body, so it silently won, and two pre-existing callers
        in `repair_rename_identity` started passing an item dict to a function
        expecting a slug. Python raised nothing: the dict stringified, matched no
        slug, and the repair refused with "work item ... has no slug".

        Only ONE of the two broken callers had a test
        (`test_rename_history_immutable.py`), which is what caught it; the other,
        at the `wid = self._work_ref(it)` in the same region, had none. So this
        asserts the surviving meaning directly rather than relying on that.
        """
        org = self.cold(self.mixed("Ref Collision"))
        it, _phys = org._work_find("phys-done-0")
        self.assertEqual(org._work_ref(it), "phys-done-0")
        # and the two names are genuinely different functions, in both directions
        self.assertIsInstance(org._work_ref(it), str)
        self.assertIsInstance(org._work_pointer_target("phys-done-0"), dict)

    def test_a_mutation_still_sweeps_and_names_uniquely(self):
        """`_work_names_in_use` and the slug backfill run at the head of a
        mutation and legitimately read the archive; a new item must not reuse
        an archived name."""
        slug = self.mixed("Mutation Sweep")
        org = store.load_org(slug)
        org.work_create("worker", "phys done 0", "o", owner="worker")
        made = org._work_active()[-1]
        self.assertNotEqual(made["slug"], "phys-done-0")
        self.assertEqual(made["slug"], "phys-done-0-2")


if __name__ == "__main__":
    unittest.main()
