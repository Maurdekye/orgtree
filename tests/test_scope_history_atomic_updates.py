"""A docket item's scope has a history, and an update is all-or-nothing.

SUGGESTION PACKAGE W03, reconciled from twelve agent reports (PR17, WE14,
WE15, WE16, statereview-09, agentlist-06, lanepolicy-02, lanepolicy-03,
ticketdesc-03, haltstate-07, ZA19, EXP-01). They describe five distinct ways
the docket loses or distorts the record of how work actually went:

  · `update` REWROTE `objective` and recorded nothing whatsoever — not even
    that a change had happened. The sentence that WAS the authoritative
    specification simply stopped existing the moment somebody widened it
    (ticketdesc-03), and a scope addition that arrived as mail either got
    re-typed by hand or stayed out of the ticket entirely (EXP-01);
  · rulings went into `done_so_far`, which the next update overwrites
    wholesale, so WHY a thing is the way it is survived only in commit
    messages. One twelve-round review re-argued the same settled point in
    rounds 5, 6, 7 and 10 (WE14, WE15);
  · every update re-sent both lists in full — ~1500 words by round 11 — with
    no way to detect a concurrent write (WE16, ZA19);
  · four acceptance conditions meant four round trips and read on the docket
    as four separate completion events (lanepolicy-02, statereview-09);
  · amending an attention reason RE-RAISED the flag: one question with three
    parts became six consecutive raises, reading as six nags (lanepolicy-03);
  · a finished item that the user then extended could not record that in one
    call, so it passed through an in_progress state that was never true for an
    instant (agentlist-06).

WHAT THIS SUITE PINS:

  §1  The description is VERSIONED: every change appends a scope row holding
      the complete before AND after, and those survive later edits.
  §2  `objective_append` widens rather than replaces, and the current
      objective stays authoritative.
  §3  Decisions append, are never rewritten, and supersession writes ONLY a
      back-pointer onto the superseded row.
  §4  `expected_rev` is compare-and-set: a stale call writes NOTHING.
  §5  keep/append materialize the COMPLETE list; the both-empty rule and the
      entry cap are measured on that result; keep/append without
      `expected_rev` is refused.
  §6  Batch checks are atomic and write ONE history row.
  §7  Batch evidence is atomic, cap-checked as a whole, ONE history row.
  §8  An amendment keeps `set_rev`, mints no notification edge, does not
      clear the flag, and a dismissed reason is still refused.
  §9  An atomic reopen-to-done records the transition AND a fresh acceptance,
      and never stores an intermediate status.
  §10 The tool card and the api dispatch actually expose all of it.

Every bound used here is read from `orgtree.workfields` — W02's contract —
rather than restated, so a limit cannot drift between the two packages.
"""
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-scope-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

# ⚠ `events` BEFORE `events_render`: events.py imports the renderer module at
# its own tail, so importing the renderer first hands it a half-built `events`
# and its completeness check fires on an empty table.
from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import ledger, mcptool, notification_state, workfields  # noqa: E402
from orgtree.ledger import USER, LedgerError  # noqa: E402

_n = 0

OBJ_1 = ("Problem: the pane re-renders on every keystroke. Solution: memoize "
         "the row list.")
OBJ_2 = ("Problem: the pane re-renders on every keystroke AND the popout "
         "loses focus. Solution: memoize the row list, and keep the focused "
         "element across the remount.")
#: a scope addition of the shape that actually arrives as mail
ADDITION = ("## Added after assignment\n\nThe context-menu half: the menu "
            "stays open and the right-clicked event stays highlighted. This "
            "arrived as a separate `decision` message a minute after the "
            "original brief, and it is part of the statement of work.")


def fixture(acceptance=None):
    """A fresh in-memory org: owner-a holds an item, peer-b is a participant."""
    global _n
    _n += 1
    org = ledger.Org.create(f"sc-{_n}")
    for nid in ("owner-a", "peer-b"):
        org.hire(USER, None, "haiku", 0, nid)
    org.work_create("owner-a", "Scope fixture", objective=OBJ_1,
                    acceptance=(acceptance if acceptance is not None else
                                ["first holds", "second holds",
                                 "third holds", "fourth holds"]))
    wid = org.d["work_items"][-1]["slug"]
    org.work_participants("owner-a", wid, add=["peer-b"])
    return org, wid


def item(org, wid):
    for bucket in ("work_items", "work_items_archive"):
        for it in org.d.get(bucket, []):
            if it["slug"] == wid:
                return it
    raise AssertionError(f"{wid} vanished")


def upd(org, wid, **kw):
    """`work_update` with the two required lists defaulted to something legal,
    so a test says only what it is actually about."""
    kw.setdefault("done_so_far", ["a step"])
    kw.setdefault("working_on_next", [])
    return org.work_update("owner-a", wid, kw.pop("done_so_far"),
                           kw.pop("working_on_next"), **kw)


def ops(org, wid):
    return [r.get("op") for r in item(org, wid).get("history") or []]


def snapshot(it):
    """Everything an update could touch, for proving a refusal wrote nothing."""
    import copy
    return copy.deepcopy({k: it.get(k) for k in (
        "rev", "status", "title", "objective", "done_so_far",
        "working_on_next", "manual_attention", "manual_attention_rev",
        "history", "scope", "scope_seq", "acceptance", "evidence", "accepted",
        "status_at", "updated_at", "docket_at", "blocked_reason",
        "dropped_reason")})


# ---------------------------------------------------------------- §1 objective
class ObjectiveIsVersioned(unittest.TestCase):
    """The description is versioned, not overwritten. ticketdesc-03: `update`
    rewrote it and history recorded only that *a* change happened — in fact
    not even that."""

    def test_a_change_appends_a_scope_row_with_both_sides_whole(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        scope = item(org, wid)["scope"]
        self.assertEqual(len(scope), 1)
        row = scope[0]
        self.assertEqual(row["kind"], "objective")
        self.assertEqual(row["seq"], 1)
        self.assertEqual(row["mode"], "replace")
        self.assertEqual(row["before"], OBJ_1)
        self.assertEqual(row["after"], OBJ_2)
        self.assertEqual(row["by"]["node"], "owner-a")
        self.assertTrue(row["at"])

    def test_the_current_objective_stays_authoritative(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        self.assertEqual(item(org, wid)["objective"], OBJ_2)
        self.assertEqual(org.work_get("owner-a", wid)["objective"], OBJ_2)

    def test_before_and_after_survive_several_later_edits(self):
        """The acceptance condition, stated directly: the whole chain stays
        readable, and the FIRST version is still recoverable at the end."""
        org, wid = fixture()
        chain = [OBJ_2, OBJ_2 + "\n\nThird.", OBJ_2 + "\n\nThird.\n\nFourth."]
        for text in chain:
            upd(org, wid, objective=text)
        scope = item(org, wid)["scope"]
        self.assertEqual([r["seq"] for r in scope], [1, 2, 3])
        self.assertEqual(scope[0]["before"], OBJ_1)
        for i, text in enumerate(chain):
            self.assertEqual(scope[i]["after"], text)
        # and each row's `before` is the previous row's `after` — the chain is
        # continuous, so no version was lost between two recorded ones
        for earlier, later in zip(scope, scope[1:]):
            self.assertEqual(later["before"], earlier["after"])

    def test_each_objective_row_supersedes_the_previous_one(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        upd(org, wid, objective=OBJ_2 + "\n\nMore.")
        scope = item(org, wid)["scope"]
        self.assertIsNone(scope[0]["supersedes"])
        self.assertEqual(scope[0]["superseded_by"], 2)
        self.assertEqual(scope[1]["supersedes"], 1)
        self.assertIsNone(scope[1]["superseded_by"])
        # ⚠ and the superseded row's TEXT is untouched
        self.assertEqual(scope[0]["before"], OBJ_1)
        self.assertEqual(scope[0]["after"], OBJ_2)

    def test_history_points_at_the_row_rather_than_carrying_the_text(self):
        """`history` folds past its cap; `scope` never does. So the text lives
        in scope and history carries only the shape of the change."""
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        row = [r for r in item(org, wid)["history"] if r.get("op") == "update"][-1]
        ch = row["changes"]["objective"]
        self.assertEqual(ch["scope_seq"], 1)
        self.assertEqual(ch["mode"], "replace")
        self.assertEqual(ch["chars_from"], len(OBJ_1))
        self.assertEqual(ch["chars_to"], len(OBJ_2))
        self.assertNotIn(OBJ_1, str(row))

    def test_restating_the_same_objective_records_nothing(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_1)
        self.assertEqual(item(org, wid).get("scope") or [], [])

    def test_emptying_the_description_is_refused_and_writes_nothing(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, objective="   ")
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_participant_may_not_re_scope(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_update("peer-b", wid, ["x"], [], objective=OBJ_2)
        with self.assertRaises(LedgerError):
            org.work_update("peer-b", wid, ["x"], [], objective_append="more")

    def test_the_scope_cap_refuses_and_never_truncates_or_folds(self):
        org, wid = fixture()
        it = item(org, wid)
        it["scope"] = [{"seq": i + 1, "at": "t", "by": "owner-a",
                        "kind": "decision", "text": f"r{i}",
                        "supersedes": None, "superseded_by": None}
                       for i in range(ledger.Org.WORK_SCOPE_MAX)]
        it["scope_seq"] = ledger.Org.WORK_SCOPE_MAX
        before = snapshot(it)
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, objective=OBJ_2)
        self.assertIn(str(ledger.Org.WORK_SCOPE_MAX), str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)


# ----------------------------------------------------------------- §2 append
class ObjectiveAppend(unittest.TestCase):
    """EXP-01: a scope addition arrived as mail and there was no way to widen
    the description without re-typing all of it, which loses the wording."""

    def test_it_adds_rather_than_replaces(self):
        org, wid = fixture()
        upd(org, wid, objective_append=ADDITION)
        it = item(org, wid)
        self.assertEqual(it["objective"], OBJ_1 + "\n\n" + ADDITION)
        self.assertTrue(it["objective"].startswith(OBJ_1))
        self.assertIn(ADDITION, it["objective"])

    def test_it_records_mode_append_with_both_sides(self):
        org, wid = fixture()
        upd(org, wid, objective_append=ADDITION)
        row = item(org, wid)["scope"][0]
        self.assertEqual(row["mode"], "append")
        self.assertEqual(row["before"], OBJ_1)
        self.assertEqual(row["after"], OBJ_1 + "\n\n" + ADDITION)

    def test_append_is_lossless(self):
        org, wid = fixture()
        long_addition = ("A paragraph that is well past every bounded field's "
                         "limit in the contract. " * 40) + "END-OF-SCOPE"
        upd(org, wid, objective_append=long_addition)
        self.assertTrue(item(org, wid)["objective"].endswith("END-OF-SCOPE"))
        self.assertIn(long_addition, item(org, wid)["scope"][0]["after"])

    def test_objective_and_objective_append_together_are_refused(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, objective=OBJ_2, objective_append=ADDITION)
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_blank_append_is_refused(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            upd(org, wid, objective_append="  \n ")

    def test_appending_to_an_item_with_no_description_is_refused(self):
        org, wid = fixture()
        item(org, wid)["objective"] = ""
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, objective_append=ADDITION)
        self.assertIn("objective", str(cm.exception))


# --------------------------------------------------------------- §3 decisions
class Decisions(unittest.TestCase):
    """WE15: `done_so_far` is rewritten wholesale on every update, so eight
    substantive rulings survived only in git commit messages."""

    RULE = ("A live mark may NOT move a committed deadline. Ruled by the user "
            "at round 7 after it was argued in rounds 5, 6 and 10; the "
            "committed deadline is the promise, and the live mark is an "
            "observation about it.")

    def test_a_decision_appends_with_actor_and_time(self):
        org, wid = fixture()
        r = org.work_decision("owner-a", wid, self.RULE)
        row = item(org, wid)["scope"][0]
        self.assertEqual(r["decision"], 1)
        self.assertEqual(row["kind"], "decision")
        self.assertEqual(row["text"], self.RULE)
        self.assertEqual(row["by"]["node"], "owner-a")
        self.assertTrue(row["at"])

    def test_decisions_are_lossless(self):
        org, wid = fixture()
        long_rule = ("The reasoning, at the length an actual ruling runs to. "
                     * 40) + "END-OF-RULING"
        org.work_decision("owner-a", wid, long_rule)
        self.assertEqual(item(org, wid)["scope"][0]["text"], long_rule)
        self.assertTrue(
            org.work_get("owner-a", wid)["scope"][0]["text"].endswith(
                "END-OF-RULING"))

    def test_an_update_does_not_rewrite_them(self):
        """The whole point: this is what `done_so_far` could not do."""
        org, wid = fixture()
        org.work_decision("owner-a", wid, self.RULE)
        for i in range(4):
            upd(org, wid, done_so_far=[f"round {i}"])
        self.assertEqual(item(org, wid)["scope"][0]["text"], self.RULE)

    def test_supersession_writes_only_a_back_pointer(self):
        org, wid = fixture()
        org.work_decision("owner-a", wid, self.RULE)
        org.work_decision("peer-b", wid, "Reversed at round 9: it may.",
                          supersedes=1)
        scope = item(org, wid)["scope"]
        self.assertEqual(scope[0]["superseded_by"], 2)
        self.assertEqual(scope[0]["text"], self.RULE)   # ⚠ untouched
        self.assertEqual(scope[1]["supersedes"], 1)
        self.assertEqual(set(scope[0]) - {"superseded_by"},
                         set(scope[1]) - {"superseded_by"})

    def test_a_participant_may_record_one(self):
        """A ruling is usually the REVIEWER's; owner-level would make the
        agent that holds it unable to write it down."""
        org, wid = fixture()
        org.work_decision("peer-b", wid, "Reviewer's ruling.")
        self.assertEqual(item(org, wid)["scope"][0]["by"]["node"], "peer-b")

    def test_a_blank_decision_is_refused(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_decision("owner-a", wid, "   ")

    def test_superseding_an_unknown_seq_is_refused_and_writes_nothing(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            org.work_decision("owner-a", wid, "x", supersedes=99)
        self.assertIn("99", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_decision_may_supersede_an_objective_row(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        org.work_decision("owner-a", wid, "That widening is withdrawn.",
                          supersedes=1)
        self.assertEqual(item(org, wid)["scope"][0]["superseded_by"], 2)


# ------------------------------------------------------------- §4 expected_rev
class ExpectedRev(unittest.TestCase):
    """WE16/ZA19: no way to detect that somebody wrote to the item between
    your read and your update."""

    def test_the_matching_rev_passes(self):
        org, wid = fixture()
        rev = item(org, wid)["rev"]
        upd(org, wid, expected_rev=rev, done_so_far=["fine"])
        self.assertEqual(item(org, wid)["done_so_far"], ["fine"])

    def test_a_stale_rev_refuses_and_writes_absolutely_nothing(self):
        org, wid = fixture()
        stale = item(org, wid)["rev"]
        org.work_decision("peer-b", wid, "somebody else wrote")   # rev moves
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, expected_rev=stale, status="blocked",
                blocked_reason="would have been written",
                objective=OBJ_2, title="would have been written",
                done_so_far=["would have been written"])
        msg = str(cm.exception)
        self.assertIn(str(stale), msg)
        self.assertIn(str(before["rev"]), msg)
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_it_refuses_before_even_the_lists_are_parsed(self):
        """Ordering matters: a stale call is not worth diagnosing, so the CAS
        answer wins over an unrelated complaint about the payload."""
        org, wid = fixture()
        stale = item(org, wid)["rev"] - 1
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, expected_rev=stale, done_so_far=[], working_on_next=[])
        self.assertIn("expected_rev", str(cm.exception))

    def test_it_is_optional_for_a_whole_list_update(self):
        org, wid = fixture()
        upd(org, wid, done_so_far=["no rev named"])
        self.assertEqual(item(org, wid)["done_so_far"], ["no rev named"])


# ------------------------------------------------------------ §5 keep / append
class KeepAndPatchLists(unittest.TestCase):
    """WE16: ~1500 words re-sent on every boundary. The user's standing rule
    is that the STORED lists are the complete current summary — so these
    operations change who assembles the list, not what is written."""

    def seed(self):
        org, wid = fixture()
        upd(org, wid, done_so_far=["one", "two"], working_on_next=["next"])
        return org, wid, item(org, wid)["rev"]

    def test_keep_carries_the_stored_list_forward(self):
        org, wid, rev = self.seed()
        upd(org, wid, expected_rev=rev, done_so_far=None, keep_done=True,
            working_on_next=["a new step"])
        self.assertEqual(item(org, wid)["done_so_far"], ["one", "two"])
        self.assertEqual(item(org, wid)["working_on_next"], ["a new step"])

    def test_append_materializes_the_complete_list(self):
        org, wid, rev = self.seed()
        r = upd(org, wid, expected_rev=rev, done_so_far=None,
                working_on_next=None, done_append=["three"], keep_next=True)
        self.assertEqual(item(org, wid)["done_so_far"], ["one", "two", "three"])
        # and the RESULT says what was stored, so no second read is needed
        self.assertEqual(r["done_so_far"], ["one", "two", "three"])
        self.assertEqual(r["working_on_next"], ["next"])

    def test_the_stored_list_is_never_a_fragment(self):
        org, wid, rev = self.seed()
        upd(org, wid, expected_rev=rev, done_so_far=None, working_on_next=None,
            done_append=["three"], keep_next=True)
        stored = item(org, wid)["done_so_far"]
        self.assertNotEqual(stored, ["three"])
        self.assertEqual(len(stored), 3)

    def test_keep_or_append_without_expected_rev_is_refused(self):
        org, wid, _ = self.seed()
        before = snapshot(item(org, wid))
        for kw in ({"keep_done": True}, {"done_append": ["x"]},
                   {"keep_next": True}, {"next_append": ["x"]}):
            with self.assertRaises(LedgerError) as cm:
                upd(org, wid, done_so_far=None, working_on_next=None, **kw)
            self.assertIn("expected_rev", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_stale_append_refuses_rather_than_interleaving(self):
        org, wid, rev = self.seed()
        upd(org, wid, done_so_far=["somebody else's summary"])
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, expected_rev=rev, done_so_far=None,
                done_append=["mine"], keep_next=True)
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_whole_list_and_patch_together_are_refused(self):
        org, wid, rev = self.seed()
        with self.assertRaises(LedgerError):
            upd(org, wid, expected_rev=rev, done_so_far=["x"],
                done_append=["y"])
        with self.assertRaises(LedgerError):
            upd(org, wid, expected_rev=rev, done_so_far=["x"], keep_done=True)

    def test_keep_and_append_on_the_same_list_are_refused(self):
        org, wid, rev = self.seed()
        with self.assertRaises(LedgerError):
            upd(org, wid, expected_rev=rev, done_so_far=None,
                keep_done=True, done_append=["y"])

    def test_both_empty_is_measured_on_the_materialized_result(self):
        org, wid, rev = self.seed()
        # legal: the kept done list is non-empty even though nothing was sent
        upd(org, wid, expected_rev=rev, done_so_far=None, keep_done=True,
            working_on_next=[])
        self.assertEqual(item(org, wid)["done_so_far"], ["one", "two"])
        # and refused when the materialized result really is empty
        org2, wid2 = fixture()
        upd(org2, wid2, done_so_far=[], working_on_next=["only next"])
        rev2 = item(org2, wid2)["rev"]
        with self.assertRaises(LedgerError) as cm:
            upd(org2, wid2, expected_rev=rev2, done_so_far=None,
                keep_done=True, working_on_next=[])
        self.assertIn("both empty", str(cm.exception))

    def test_the_entry_cap_is_measured_on_the_merge_and_says_so(self):
        org, wid = fixture()
        cap = ledger.Org.WORK_LIST_ENTRY_MAX
        upd(org, wid, done_so_far=[f"e{i}" for i in range(cap)])
        rev = item(org, wid)["rev"]
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, expected_rev=rev, done_so_far=None,
                done_append=["one too many"])
        msg = str(cm.exception)
        self.assertIn(str(cap + 1), msg)
        self.assertIn("appended", msg)
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_an_over_length_appended_entry_refuses_the_whole_call(self):
        org, wid, rev = self.seed()
        before = snapshot(item(org, wid))
        over = "x" * (workfields.limit_of("done_so_far") + 1)
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, expected_rev=rev, done_so_far=None,
                done_append=[over], keep_next=True)
        self.assertIn("done_append", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)


# ------------------------------------------------------------ §6 batch checks
class BatchChecks(unittest.TestCase):
    """lanepolicy-02: four conditions meant four round trips, each its own
    completion event in the history."""

    def test_a_batch_checks_them_all(self):
        org, wid = fixture()
        r = org.work_check("owner-a", wid, checks=[
            {"index": 0, "evidence_ref": "tests/a.py", "note": "first"},
            {"index": 1, "evidence_ref": "tests/b.py"},
            {"index": 2, "evidence_ref": "tests/c.py"}])
        self.assertEqual(r["indexes"], [0, 1, 2])
        acc = item(org, wid)["acceptance"]
        self.assertEqual(acc[0]["checked"]["evidence_ref"], "tests/a.py")
        self.assertEqual(acc[0]["checked"]["note"], "first")
        self.assertEqual(acc[2]["checked"]["evidence_ref"], "tests/c.py")
        self.assertIsNone(acc[3]["checked"])

    def test_it_reads_as_ONE_history_row(self):
        org, wid = fixture()
        org.work_check("owner-a", wid, checks=[
            {"index": i, "evidence_ref": f"t{i}"} for i in range(4)])
        rows = [r for r in item(org, wid)["history"] if r.get("op") == "check"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["batch"], 4)
        self.assertEqual(rows[0]["indexes"], [0, 1, 2, 3])

    def test_one_bad_element_writes_nothing_at_all(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            org.work_check("owner-a", wid, checks=[
                {"index": 0, "evidence_ref": "good"},
                {"index": 1, "evidence_ref": "good"},
                {"index": 99, "evidence_ref": "out of range"}])
        self.assertIn("checks[2]", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_an_over_length_ref_in_a_batch_is_atomic_too(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        over = "x" * (workfields.limit_of("evidence_ref") + 1)
        with self.assertRaises(LedgerError) as cm:
            org.work_check("owner-a", wid, checks=[
                {"index": 0, "evidence_ref": "good"},
                {"index": 1, "evidence_ref": over}])
        self.assertIn("checks[1]", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_the_same_index_twice_in_one_batch_is_refused(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            org.work_check("owner-a", wid, checks=[
                {"index": 0, "evidence_ref": "one"},
                {"index": 0, "evidence_ref": "the other"}])
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_an_empty_batch_is_refused(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_check("owner-a", wid, checks=[])

    def test_batch_and_single_together_are_refused(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_check("owner-a", wid, index=0, evidence_ref="x",
                           checks=[{"index": 1, "evidence_ref": "y"}])

    def test_the_single_form_is_unchanged(self):
        org, wid = fixture()
        r = org.work_check("owner-a", wid, 1, "tests/one.py", "a note")
        self.assertEqual(r["checked"], 1)
        acc = item(org, wid)["acceptance"]
        self.assertEqual(acc[1]["checked"]["evidence_ref"], "tests/one.py")
        self.assertEqual(acc[1]["checked"]["note"], "a note")
        rows = [r for r in item(org, wid)["history"] if r.get("op") == "check"]
        self.assertEqual(rows[0]["index"], 1)
        self.assertNotIn("batch", rows[0])

    def test_checking_is_still_owner_level(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_check("peer-b", wid, checks=[
                {"index": 0, "evidence_ref": "x"}])


# ---------------------------------------------------------- §7 batch evidence
class BatchEvidence(unittest.TestCase):
    """statereview-09: the same SHA, test evidence and delivery caveat got
    repeated call after call."""

    SHA = "95677153d394566f86ae89de7180175329949e60"

    def test_a_batch_appends_all_rows_and_one_history_row(self):
        org, wid = fixture()
        r = org.work_evidence("owner-a", wid, "", "", None, items=[
            {"kind": "commit", "ref": self.SHA, "note": "the candidate"},
            {"kind": "log", "ref": "logs/focused.txt", "note": "37/37 OK"},
            {"kind": "note", "ref": "delivery", "note": "not deployed"}])
        self.assertEqual(r["added"], 3)
        ev = item(org, wid)["evidence"]
        self.assertEqual([e["kind"] for e in ev], ["commit", "log", "note"])
        self.assertEqual(ev[0]["ref"], self.SHA)
        rows = [x for x in item(org, wid)["history"] if x.get("op") == "evidence"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["batch"], 3)

    def test_notes_in_a_batch_stay_lossless(self):
        org, wid = fixture()
        long_note = ("The full reasoning of the review. " * 60) + "END-OF-NOTE"
        org.work_evidence("owner-a", wid, "", "", None,
                          items=[{"kind": "note", "ref": "r", "note": long_note}])
        self.assertEqual(item(org, wid)["evidence"][0]["note"], long_note)

    def test_one_bad_element_writes_nothing(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            org.work_evidence("owner-a", wid, "", "", None, items=[
                {"kind": "note", "ref": "fine"},
                {"kind": "not-a-kind", "ref": "bad"}])
        self.assertIn("items[1]", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_missing_ref_in_a_batch_is_atomic(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            org.work_evidence("owner-a", wid, "", "", None, items=[
                {"kind": "note", "ref": "fine"}, {"kind": "note", "ref": ""}])
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_the_cap_is_measured_against_the_WHOLE_batch(self):
        org, wid = fixture()
        it = item(org, wid)
        it["evidence"] = [{"at": "t", "by": "owner-a", "kind": "note",
                           "ref": f"r{i}"}
                          for i in range(ledger.Org.WORK_EVIDENCE_MAX - 2)]
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            org.work_evidence("owner-a", wid, "", "", None, items=[
                {"kind": "note", "ref": f"x{i}"} for i in range(3)])
        self.assertIn(str(ledger.Org.WORK_EVIDENCE_MAX), str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)
        # two of the three would have fitted — and NEITHER was written
        self.assertEqual(len(item(org, wid)["evidence"]),
                         ledger.Org.WORK_EVIDENCE_MAX - 2)

    def test_batch_and_single_together_are_refused(self):
        org, wid = fixture()
        with self.assertRaises(LedgerError):
            org.work_evidence("owner-a", wid, "note", "a-ref", None,
                              items=[{"kind": "note", "ref": "b"}])

    def test_the_single_form_is_unchanged(self):
        org, wid = fixture()
        r = org.work_evidence("owner-a", wid, "log", "logs/x.txt", "a note")
        self.assertEqual(r["evidence"], 1)
        ev = item(org, wid)["evidence"][0]
        self.assertEqual((ev["kind"], ev["ref"], ev["note"]),
                         ("log", "logs/x.txt", "a note"))
        rows = [x for x in item(org, wid)["history"] if x.get("op") == "evidence"]
        self.assertEqual(rows[0]["kind"], "log")
        self.assertNotIn("batch", rows[0])

    def test_a_participant_may_still_add_evidence(self):
        org, wid = fixture()
        org.work_evidence("peer-b", wid, "", "", None,
                          items=[{"kind": "note", "ref": "peer"}])
        self.assertEqual(item(org, wid)["evidence"][0]["by"]["node"], "peer-b")


# --------------------------------------------------------- §8 attention amend
class AttentionAmendment(unittest.TestCase):
    """lanepolicy-03: flagging three deviations produced six consecutive
    manual_attention revisions — six nags where there was one question."""

    R1 = "Two deviations need your eye: the default, and the edge case."
    R2 = ("Three deviations need your eye: the default, the edge case, and "
          "the definition I filled in for you.")

    def raised(self):
        org, wid = fixture()
        upd(org, wid, attention=True, attention_reason=self.R1)
        return org, wid

    def test_an_amendment_keeps_set_rev_and_does_not_advance_the_counter(self):
        org, wid = self.raised()
        rev_before = item(org, wid)["manual_attention_rev"]
        set_rev = item(org, wid)["manual_attention"]["set_rev"]
        upd(org, wid, attention_amend=True, attention_reason=self.R2)
        flag = item(org, wid)["manual_attention"]
        self.assertEqual(flag["reason"], self.R2)
        self.assertEqual(flag["set_rev"], set_rev)
        self.assertEqual(item(org, wid)["manual_attention_rev"], rev_before)

    def test_it_mints_no_new_notification_edge(self):
        """The user is not pinged again for a sentence they are reading."""
        org, wid = self.raised()
        notification_state.reconcile_attention(org.d)
        epoch = item(org, wid)["notification_attention_epoch"]
        upd(org, wid, attention_amend=True, attention_reason=self.R2)
        notification_state.reconcile_attention(org.d)
        self.assertEqual(item(org, wid)["notification_attention_epoch"], epoch)
        self.assertTrue(item(org, wid)["notification_attention_active"])

    def test_a_re_raise_by_contrast_DOES_advance_both(self):
        """The control: this is what the amendment is distinguished from."""
        org, wid = self.raised()
        notification_state.reconcile_attention(org.d)
        rev_before = item(org, wid)["manual_attention_rev"]
        upd(org, wid, done_so_far=["clearing it"])          # clears the flag
        notification_state.reconcile_attention(org.d)
        upd(org, wid, attention=True, attention_reason=self.R2)
        notification_state.reconcile_attention(org.d)
        self.assertGreater(item(org, wid)["manual_attention_rev"], rev_before)

    def test_an_amending_update_does_not_clear_the_flag(self):
        org, wid = self.raised()
        r = upd(org, wid, attention_amend=True, attention_reason=self.R2)
        self.assertTrue(r["manual_attention"])
        self.assertIsNotNone(item(org, wid)["manual_attention"])

    def test_it_records_its_own_history_op_with_both_texts(self):
        org, wid = self.raised()
        upd(org, wid, attention_amend=True, attention_reason=self.R2)
        rows = [r for r in item(org, wid)["history"]
                if r.get("op") == "attention_amend"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["from"], self.R1)
        self.assertEqual(rows[0]["to"], self.R2)

    def test_amending_with_no_flag_standing_is_refused(self):
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, attention_amend=True, attention_reason=self.R2)
        self.assertIn("nothing to amend", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_amend_together_with_a_raise_is_refused(self):
        org, wid = self.raised()
        with self.assertRaises(LedgerError):
            upd(org, wid, attention=True, attention_amend=True,
                attention_reason=self.R2)

    def test_amending_needs_a_nonblank_reason(self):
        org, wid = self.raised()
        with self.assertRaises(LedgerError):
            upd(org, wid, attention_amend=True, attention_reason="  ")

    def test_an_over_length_amendment_refuses_the_whole_call(self):
        org, wid = self.raised()
        before = snapshot(item(org, wid))
        over = "x" * (workfields.limit_of("attention_reason") + 1)
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, attention_amend=True, attention_reason=over,
                status="blocked", blocked_reason="would have been written")
        self.assertIn("attention_reason", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_DISMISSED_reason_cannot_come_back_as_an_amendment(self):
        """The acceptance condition, stated directly: amendment must not be
        the way around a dismissal."""
        org, wid = self.raised()
        set_rev = item(org, wid)["manual_attention"]["set_rev"]
        org.work_dismiss_attention(wid, set_rev)
        upd(org, wid, attention=True, attention_reason=self.R2)
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, attention_amend=True, attention_reason=self.R1)
        self.assertIn("DISMISSED", str(cm.exception))

    def test_the_dismissed_repeat_refusal_is_atomic_on_a_raise_too(self):
        """It used to run two thirds of the way down, so a refused re-raise
        had already rewritten the status, title and lists."""
        org, wid = self.raised()
        set_rev = item(org, wid)["manual_attention"]["set_rev"]
        org.work_dismiss_attention(wid, set_rev)
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, attention=True, attention_reason=self.R1,
                title="would have been written", objective=OBJ_2,
                done_so_far=["would have been written"])
        self.assertEqual(snapshot(item(org, wid)), before)


# --------------------------------------------------------- §9 atomic reopen
class AtomicReopen(unittest.TestCase):
    """agentlist-06: the user extended a ticket after it closed. Recording
    "extended, built and landed" took two calls, and the middle state was
    never true for an instant."""

    def closed(self):
        org, wid = fixture()
        upd(org, wid, status="done", done_so_far=["the first round"])
        return org, wid

    def test_reopen_to_done_in_one_call(self):
        org, wid = self.closed()
        upd(org, wid, reopen=True, status="done",
            done_so_far=["the first round", "the extension, also landed"])
        it = item(org, wid)
        self.assertEqual(it["status"], "done")
        self.assertEqual(len(it["done_so_far"]), 2)

    def test_it_records_the_transition_AND_the_outcome(self):
        org, wid = self.closed()
        first = item(org, wid)["accepted"]["at"]
        upd(org, wid, reopen=True, status="done", done_so_far=["and again"])
        hist = item(org, wid)["history"]
        row = [r for r in hist if r.get("op") == "reopen"][-1]
        self.assertEqual(row["from"], "done")
        self.assertEqual(row["to"], "done")
        self.assertTrue(row["atomic_completion"])
        self.assertIsNotNone(row["accepted_was"])
        # THE OUTCOME: a FRESH acceptance, not the one reopen cleared
        acc = item(org, wid)["accepted"]
        self.assertIsNotNone(acc)
        self.assertEqual(acc["via"], "update")
        self.assertGreaterEqual(acc["at"], first)

    def test_no_intermediate_status_is_ever_stored(self):
        org, wid = self.closed()
        upd(org, wid, reopen=True, status="done", done_so_far=["again"])
        seen = [r.get("changes", {}).get("status", {}).get("to")
                for r in item(org, wid)["history"] if r.get("op") == "update"]
        self.assertNotIn("in_progress", seen)
        self.assertEqual(item(org, wid)["status"], "done")

    def test_status_at_moves_even_though_the_value_did_not(self):
        """The state genuinely moved: closed, reopened, closed again. Stamped
        from a sentinel rather than compared against the previous value,
        because both completions can land inside the same millisecond."""
        org, wid = self.closed()
        sentinel = "2020-01-01T00:00:00.000Z"
        item(org, wid)["status_at"] = sentinel
        upd(org, wid, reopen=True, status="done", done_so_far=["again"])
        self.assertGreater(item(org, wid)["status_at"], sentinel)
        row = [r for r in item(org, wid)["history"] if r.get("op") == "update"][-1]
        self.assertEqual(row["changes"]["reopened_to"], "done")

    def test_an_ordinary_restated_status_still_does_NOT_re_stamp(self):
        """The control for the rule above: the reopen earns the stamp, and
        merely mentioning the status you already had still does not."""
        org, wid = fixture()
        upd(org, wid, status="in_progress")
        sentinel = "2020-01-01T00:00:00.000Z"
        item(org, wid)["status_at"] = sentinel
        upd(org, wid, status="in_progress", done_so_far=["restated"])
        self.assertEqual(item(org, wid)["status_at"], sentinel)

    def test_reopen_to_dropped_needs_a_fresh_reason(self):
        """The overturned outcome's reason goes with the outcome — a re-drop
        must not silently inherit the sentence explaining the drop it undid."""
        org, wid = fixture()
        upd(org, wid, status="dropped", dropped_reason="Cancelled by the user.")
        with self.assertRaises(LedgerError):
            upd(org, wid, reopen=True, status="dropped", done_so_far=["x"])
        upd(org, wid, reopen=True, status="dropped",
            dropped_reason="Cancelled again, this time for good.",
            done_so_far=["x"])
        self.assertEqual(item(org, wid)["dropped_reason"],
                         "Cancelled again, this time for good.")

    def test_a_refused_reopen_to_dropped_LEAVES_THE_ITEM_UNTOUCHED(self):
        """Found in review by worktree-safe. The reopen used to run its
        mutations first and let `_work_state_info` refuse afterwards, so a
        missing fresh reason left behind a `reopen` history row, a bumped rev
        and — worst of all — a WIPED stored dropped_reason: the refused call
        destroyed the record of why the work had ended."""
        org, wid = fixture()
        upd(org, wid, status="dropped", dropped_reason="Cancelled by the user.")
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, reopen=True, status="dropped", done_so_far=["x"])
        self.assertIn("NOTHING WAS WRITTEN", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)
        # the three specifics, named so a regression says which one came back
        it = item(org, wid)
        self.assertEqual(it["dropped_reason"], "Cancelled by the user.")
        self.assertEqual(it["rev"], before["rev"])
        self.assertNotIn("reopen", [r.get("op") for r in it["history"]])

    def test_a_refused_reopen_from_DONE_to_dropped_is_atomic_too(self):
        """The done -> dropped direction: a different pre-state, the same
        promise. Here the acceptance record is what a partial mutation would
        have destroyed."""
        org, wid = self.closed()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, reopen=True, status="dropped", done_so_far=["x"])
        self.assertEqual(snapshot(item(org, wid)), before)
        self.assertIsNotNone(item(org, wid)["accepted"])

    def test_a_refused_reopen_does_not_move_an_ARCHIVED_item(self):
        """The reopen physically lifts an archived item back into the active
        list before the refusal could fire. A refused call must not resurrect
        an item onto the active docket."""
        org, wid = fixture()
        upd(org, wid, status="dropped", dropped_reason="Cancelled.")
        org.work_archive_now("owner-a", wid)
        self.assertTrue(any(x["slug"] == wid
                            for x in org.d.get("work_items_archive") or []))
        with self.assertRaises(LedgerError):
            upd(org, wid, reopen=True, status="dropped", done_so_far=["x"])
        self.assertTrue(any(x["slug"] == wid
                            for x in org.d.get("work_items_archive") or []))
        self.assertFalse(any(x["slug"] == wid
                             for x in org.d.get("work_items") or []))

    def test_a_refused_reopen_to_BLOCKED_is_atomic(self):
        """Not only the terminal statuses: `blocked` owes a reason on entry
        too, and that refusal was equally late."""
        org, wid = self.closed()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, reopen=True, status="blocked", done_so_far=["x"])
        self.assertIn("blocked_reason", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_a_blank_state_reason_is_refused_before_anything_moves(self):
        """A blank does not erase what is recorded — and refusing it must not
        itself be the thing that erases it."""
        org, wid = fixture()
        upd(org, wid, status="blocked", blocked_reason="Waiting on the slot.")
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, status="in_progress", blocked_reason="   ",
                title="would have been written")
        self.assertIn("NOTHING WAS WRITTEN", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_an_ordinary_late_entry_refusal_is_atomic_too(self):
        """Not a reopen at all: plain `status=dropped` with no reason used to
        set the status and stamp status_at before refusing."""
        org, wid = fixture()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError):
            upd(org, wid, status="dropped", title="would have been written")
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_the_legacy_waiting_conversion_still_owes_no_fresh_reason(self):
        """⚠ The preflight must not break the one write that converts a legacy
        row: a stored `waiting` READS as blocked, so naming blocked is the
        conversion, not an entry, and it carries the reason it already had."""
        org, wid = fixture()
        it = item(org, wid)
        it["status"] = "waiting"
        it["waiting_reason"] = "The original waiting reason."
        upd(org, wid, status="blocked", done_so_far=["converted"])
        self.assertEqual(item(org, wid)["status"], "blocked")
        self.assertEqual(item(org, wid)["blocked_reason"],
                         "The original waiting reason.")

    def test_reopen_to_superseded_is_still_refused(self):
        """`superseded` is written by `supersede`, which names the replacing
        item. It is not an agent status, and opening reopen to terminal
        statuses did not quietly make it one."""
        org, wid = self.closed()
        before = snapshot(item(org, wid))
        with self.assertRaises(LedgerError) as cm:
            upd(org, wid, reopen=True, status="superseded")
        self.assertIn("status must be one of", str(cm.exception))
        self.assertEqual(snapshot(item(org, wid)), before)

    def test_an_ordinary_reopen_still_works_and_is_not_marked_atomic(self):
        org, wid = self.closed()
        upd(org, wid, reopen=True, status="in_progress")
        it = item(org, wid)
        self.assertEqual(it["status"], "in_progress")
        self.assertIsNone(it["accepted"])
        row = [r for r in it["history"] if r.get("op") == "reopen"][-1]
        self.assertNotIn("atomic_completion", row)

    def test_reopen_still_defaults_to_in_progress_never_to_a_terminal_status(self):
        org, wid = self.closed()
        upd(org, wid, reopen=True)
        self.assertEqual(item(org, wid)["status"], "in_progress")


# ------------------------------------------------------- §10 the exposed API
class ExposedThroughTheTool(unittest.TestCase):
    """A backend capability no tool card mentions is a capability no agent
    will ever use."""

    def card(self):
        for t in mcptool.TOOLS:
            if t["name"] == "orgtree_work":
                return t
        raise AssertionError("orgtree_work is not in the tool list")

    def test_decision_is_an_offered_action(self):
        self.assertIn("decision", self.card()["inputSchema"]
                      ["properties"]["action"]["enum"])

    def test_every_new_argument_is_declared(self):
        props = self.card()["inputSchema"]["properties"]
        for name in ("checks", "items", "text", "supersedes", "expected_rev",
                     "objective_append", "keep_done", "keep_next",
                     "done_append", "next_append", "attention_amend"):
            self.assertIn(name, props, f"{name} is not on the tool card")
            self.assertTrue(str(props[name].get("description") or "").strip(),
                            f"{name} has no description")

    def test_the_card_says_expected_rev_is_required_for_keep_and_append(self):
        props = self.card()["inputSchema"]["properties"]
        for name in ("keep_done", "keep_next", "done_append", "next_append"):
            self.assertIn("expected_rev", props[name]["description"])

    def test_the_doctrine_states_the_versioning_and_the_ruling_record(self):
        from orgtree import supervisor
        d = supervisor.DOCKET_DOCTRINE
        self.assertIn("VERSIONED", d)
        self.assertIn("objective_append", d)
        self.assertIn("decision", d)
        self.assertIn("expected_rev", d)
        self.assertIn("attention_amend", d)

    def test_the_api_dispatch_reaches_every_new_operation(self):
        """Not just the ledger: the wire path an agent actually travels."""
        from orgtree import api
        org, wid = fixture()
        base = {"slug": wid}
        api._work_mutate_action(org, "owner-a", {**base, "action": "decision",
                                                 "text": "ruled"},
                                "decision", wid)
        self.assertEqual(item(org, wid)["scope"][0]["text"], "ruled")
        api._work_mutate_action(org, "owner-a", {
            **base, "action": "check",
            "checks": [{"index": 0, "evidence_ref": "a"},
                       {"index": 1, "evidence_ref": "b"}]}, "check", wid)
        self.assertEqual(item(org, wid)["acceptance"][1]["checked"]
                         ["evidence_ref"], "b")
        api._work_mutate_action(org, "owner-a", {
            **base, "action": "evidence",
            "items": [{"kind": "note", "ref": "r1"},
                      {"kind": "log", "ref": "r2"}]}, "evidence", wid)
        self.assertEqual(len(item(org, wid)["evidence"]), 2)
        rev = item(org, wid)["rev"]
        api._work_mutate_action(org, "owner-a", {
            **base, "action": "update", "expected_rev": rev,
            "objective_append": ADDITION, "keep_done": True,
            "working_on_next": ["next"]}, "update", wid)
        self.assertTrue(item(org, wid)["objective"].endswith(ADDITION))

    def test_the_projection_serves_the_scope_record(self):
        org, wid = fixture()
        upd(org, wid, objective=OBJ_2)
        org.work_decision("owner-a", wid, "a ruling")
        view = org.work_get("owner-a", wid)
        self.assertEqual([r["kind"] for r in view["scope"]],
                         ["objective", "decision"])
        self.assertEqual(view["scope"][0]["before"], OBJ_1)

    def test_no_new_bounded_field_was_invented_outside_the_W02_contract(self):
        """W03 imports the contract rather than restating numbers; its own new
        text fields are all lossless, so `LIMITS` must be untouched."""
        self.assertEqual(set(workfields.LIMITS), {
            "title", "acceptance", "attention_reason", "blocked_reason",
            "waiting_reason", "dropped_reason", "done_so_far",
            "working_on_next", "ref", "evidence_ref"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
