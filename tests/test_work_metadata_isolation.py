"""Every mutable ticket metadata field changes in isolation.

Ticket: allow-every-ticket-metadata-field-to-be-updated

The defect this file exists for: on 2026-09-19 a coordinator ran `action=assign`
to move a BACKLOGGED item to a new owner, and the item silently became `open`.
The caller asked for one field and got two, which started work the user had
deliberately left unstarted.

The rule these tests hold to: changing one metadata field preserves every other
field unless the caller explicitly supplied it. Transitions may still have
semantic consequences, but only the ones that are part of their documented
contract — and those are pinned here too, so that "isolated" never quietly
becomes "inert".

WHY THE MATRIX IS WRITTEN THE WAY IT IS. Each case declares the fields it
expects to change, and the assertion fails BOTH ways: on a field that changed
and should not have (the coupling bug), and on a field that did not change and
should have (a mutation that silently did nothing). A test that only checked
the first half would pass against an API that had stopped writing altogether.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-metadata-isolation-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine",
                                "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.ledger import USER, LedgerError  # noqa: E402

# The mutable metadata the ticket names, plus the progress summaries, which are
# metadata as far as "did an unrelated call rewrite them" is concerned.
TRACKED = ("title", "objective", "status", "owner", "reviewer", "participants",
           "acceptance", "dependencies", "done_so_far", "working_on_next",
           "blocked_reason", "dropped_reason", "manual_attention", "kind",
           "parent")

_HIRE = dict(add_dirs=[], tools={"bash": False, "web": False, "edit": False,
                                 "subagents": False, "mcp": []},
             org_visibility="self", charter="test worker")
_seq = 0


def fixture(status="open", **create):
    """A manager with three subordinates and one item owned by worker-one.

    Three workers, not two: the assignment-destination rule means the manager
    must own the seats it assigns to, and the documented side-effect cases need
    a spare agent that is neither the current owner nor the reviewer.
    """
    global _seq
    _seq += 1
    org = ledger.Org.create(f"metadata-isolation-{_seq}")
    manager = org.hire(USER, None, "haiku", 3, "manager", **_HIRE)["node"]
    workers = [org.hire(manager, manager, "haiku", 0, name, **_HIRE)["node"]
               for name in ("worker-one", "worker-two", "worker-three")]
    create.setdefault("done_so_far", ["landed the parser"])
    create.setdefault("working_on_next", ["wire up the route"])
    item = org.work_create(manager, "Title A", "objective A", status=status,
                           owner=workers[0], **create)
    return org, str(item["slug"]), str(manager), [str(w) for w in workers]


def snapshot(org, actor, slug):
    item = org.work_get(actor, slug)
    return {field: copy.deepcopy(item.get(field)) for field in TRACKED}


class AssignmentLeavesTheStatusAlone(unittest.TestCase):
    """The reported defect, and the rule it generalises to."""

    def test_assigning_a_backlogged_item_keeps_it_backlogged(self):
        """The coordinator's 2026-09-19 transfer, reproduced exactly.

        Before the fix this asserted the opposite: `assign` moved the owner AND
        opened the item, and the release notes for 2.1.0 advertised that as a
        feature ("Assigning a backlogged ticket opens it automatically").
        """
        org, slug, manager, (one, two, _three) = fixture(status="backlogged")
        before = snapshot(org, manager, slug)

        result = org.work_assign(manager, slug, two)

        self.assertEqual(result["status"], "backlogged")
        self.assertEqual(org.work_get(manager, slug)["status"], "backlogged")
        # ... and the assignment itself did happen, so this is not passing
        # merely because the call did nothing at all.
        self.assertEqual(result["assigned"], slug)
        after = snapshot(org, manager, slug)
        self.assertEqual(
            sorted(f for f in TRACKED if before[f] != after[f]), ["owner"])
        self.assertEqual(after["owner"]["node"], two)
        self.assertEqual(before["owner"]["node"], one)

    def test_a_backlogged_item_stays_out_of_the_active_count(self):
        """The consequence the user actually cares about: an assigned backlog
        item must not start showing up as active work."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")
        self.assertEqual(org.work_counts()["backlogged"], 1)

        org.work_assign(manager, slug, two)

        counts = org.work_counts()
        self.assertEqual(counts["backlogged"], 1)
        self.assertEqual(counts["active"], 0)

    def test_the_assign_history_row_claims_no_status_change(self):
        """A history row that reported `status_from`/`status_to` on an assign
        would now be describing a change this path cannot make."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        org.work_assign(manager, slug, two)

        row = org.work_get(manager, slug)["history"][-1]
        self.assertEqual(row["op"], "assign")
        self.assertNotIn("status_from", row)
        self.assertNotIn("status_to", row)

    def test_assignment_preserves_every_other_status_too(self):
        """The rule is general: assignment is ownership, for every status."""
        for status in ("open", "in_progress", "blocked", "review",
                       "deploy_ready", "backlogged"):
            with self.subTest(status=status):
                extra = {}
                if status == "blocked":
                    extra["blocked_reason"] = "external blocker"
                org, slug, manager, (_one, two, _three) = fixture(
                    status=status, **extra)
                if status == "review":
                    # review owes a reviewer; name one that is not the agent
                    # the item is about to be assigned to, so this case tests
                    # the status rule and not the reviewer-empties rule.
                    org.work_update(manager, slug, ["ready"], ["review it"],
                                    status="review", reviewer=_three,
                                    owner=_one)

                result = org.work_assign(manager, slug, two)

                self.assertEqual(result["status"], status)
                self.assertEqual(org.work_get(manager, slug)["status"], status)

    def test_composite_update_assignment_shares_the_rule(self):
        """`work_update(owner=...)` is the path staffing and coordinators use;
        it must not reintroduce the transition by another door."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_update(manager, slug, owner=two)

        self.assertEqual(result["status"], "backlogged")
        self.assertEqual(org.work_get(manager, slug)["status"], "backlogged")

    def test_an_explicit_status_still_opens_it_in_the_same_call(self):
        """Preserving the backlog is not the same as refusing to leave it: a
        caller that wants both changes asks for both and gets both."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_update(manager, slug, ["picked up"], ["implement"],
                                 status="in_progress", owner=two)

        self.assertEqual(result["status"], "in_progress")
        item = org.work_get(manager, slug)
        self.assertEqual(item["status"], "in_progress")
        self.assertEqual(item["owner"]["node"], two)


class StartingAnAgentOpensTheBacklog(unittest.TestCase):
    """The opt-in exception, and the regression that proved it needed one home.

    A plain `assign` leaves `backlogged` alone. An assignment that also STARTS
    an agent on the item opens it, because a backlogged item is hidden from the
    active count and never nudged by the idle reminder — so an agent running on
    one is both invisible and unreminded.

    ⚠ THERE ARE TWO DISJOINT ROUTES INTO THAT CASE and the first cut of this
    ticket fixed only one. `orgtree_staff` reaches it through `work_update`'s
    `staffed_to`; `orgtree_hire`/`orgtree_rehire` carrying `work_item` reach it
    through `work_assign`'s `starts_agent`, because `_staff_call` pops
    `work_item` before the seat is created and so never comes through the other
    path. textmenu found the gap in review (finding f1). Both routes are pinned
    here, against the one shared rule, so they cannot drift apart again.
    """

    def test_an_assignment_that_starts_an_agent_opens_a_backlogged_item(self):
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_assign(manager, slug, two, starts_agent=True)

        self.assertEqual(result["status"], "open")
        self.assertEqual(org.work_get(manager, slug)["status"], "open")
        self.assertEqual(org.work_counts()["backlogged"], 0)

    def test_the_same_call_without_the_opt_in_leaves_it_backlogged(self):
        """The opt-in is real, not decorative: the identical call without it
        must not move the status. This is what stops the exception quietly
        becoming the rule again."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_assign(manager, slug, two)

        self.assertEqual(result["status"], "backlogged")
        self.assertEqual(org.work_counts()["backlogged"], 1)

    def test_it_only_touches_the_backlog_not_other_statuses(self):
        for status in ("open", "in_progress", "blocked", "deploy_ready"):
            with self.subTest(status=status):
                extra = ({"blocked_reason": "external blocker"}
                         if status == "blocked" else {})
                org, slug, manager, (_one, two, _t) = fixture(status=status,
                                                              **extra)

                result = org.work_assign(manager, slug, two, starts_agent=True)

                self.assertEqual(result["status"], status)

    def test_a_staffing_update_opens_it_through_the_same_rule(self):
        """The `orgtree_staff` route, via `staffed_to`."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_update(manager, slug, owner=two, staffed_to=two)

        self.assertEqual(result["status"], "open")
        self.assertEqual(org.work_get(manager, slug)["status"], "open")

    def test_a_staffing_that_names_a_status_is_not_second_guessed(self):
        """An explicit status from the caller still wins over the exception."""
        org, slug, manager, (_one, two, _three) = fixture(status="backlogged")

        result = org.work_update(manager, slug, ["picked up"], ["go"],
                                 status="blocked",
                                 blocked_reason="waiting on the API",
                                 owner=two, staffed_to=two)

        self.assertEqual(result["status"], "blocked")

    def test_a_staffing_that_does_not_change_hands_still_opens_it(self):
        """A rehire of the agent that ALREADY owns the item skips the
        assignment branch entirely, because the owner is unchanged. The
        transition belongs to the staffing, not to the change of owner."""
        org, slug, manager, (one, _two, _three) = fixture(status="backlogged")

        result = org.work_update(manager, slug, owner=one, staffed_to=one)

        self.assertEqual(result["status"], "open")
        self.assertEqual(org.work_get(manager, slug)["status"], "open")


class EveryFieldChangesAlone(unittest.TestCase):
    """The matrix: one field in, one field out, nothing else touched."""

    def _isolated(self, mutate, expected, status="open", **create):
        org, slug, manager, workers = fixture(status=status, **create)
        before = snapshot(org, manager, slug)
        mutate(org, slug, manager, workers)
        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         sorted(expected))
        return org, slug, manager, before, after

    def test_title_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_update(m, s, title="Title B", owner=w[0]),
            ["title"])
        self.assertEqual(after["title"], "Title B")

    def test_objective_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_update(m, s, objective="objective B",
                                             owner=w[0]),
            ["objective"])
        self.assertEqual(after["objective"], "objective B")

    def test_acceptance_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_update(m, s, acceptance=["condition B"],
                                             owner=w[0]),
            ["acceptance"],
            acceptance=["condition A"])
        self.assertEqual([c["text"] for c in after["acceptance"]],
                         ["condition B"])

    def test_status_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_update(m, s, status="in_progress",
                                             owner=w[0]),
            ["status"])
        self.assertEqual(after["status"], "in_progress")

    def test_owner_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_assign(m, s, w[1]), ["owner"])
        self.assertEqual(after["owner"]["node"], "worker-two")

    def test_participants_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_participants(m, s, add=[w[1]]),
            ["participants"])
        self.assertIn("worker-two",
                      [p["node"] if isinstance(p, dict) else p
                       for p in after["participants"]])

    def test_attention_alone(self):
        _o, _s, _m, _b, after = self._isolated(
            lambda o, s, m, w: o.work_update(m, s, attention=True,
                                             attention_reason="please confirm",
                                             owner=w[0]),
            ["manual_attention"])
        self.assertTrue(after["manual_attention"])

    def test_reviewer_swaps_without_re_entering_review(self):
        """An item already at `review` can change reviewer without the caller
        restating the status or the progress lists."""
        org, slug, manager, workers = fixture()
        org.work_update(manager, slug, ["ready"], ["review it"],
                        status="review", reviewer=workers[1], owner=workers[0])
        before = snapshot(org, manager, slug)

        org.work_update(manager, slug, reviewer=workers[2], owner=workers[0])

        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         ["reviewer"])
        self.assertEqual(after["reviewer"]["node"], "worker-three")

    def test_a_metadata_change_never_rewrites_the_progress_lists(self):
        """The ticket's second clause, stated on its own: changing only
        ownership must not require or rewrite done_so_far / working_on_next."""
        org, slug, manager, workers = fixture(status="backlogged")
        before = org.work_get(manager, slug)

        org.work_assign(manager, slug, workers[1])
        org.work_update(manager, slug, title="Title B", owner=workers[1])

        after = org.work_get(manager, slug)
        self.assertEqual(after["done_so_far"], before["done_so_far"])
        self.assertEqual(after["working_on_next"], before["working_on_next"])
        self.assertEqual(after["done_so_far"], ["landed the parser"])

    def test_a_blocked_item_keeps_its_reason_through_a_title_edit(self):
        org, slug, manager, workers = fixture()
        org.work_update(manager, slug, ["hit a wall"], ["wait"],
                        status="blocked", blocked_reason="waiting on the API",
                        owner=workers[0])
        before = snapshot(org, manager, slug)

        org.work_update(manager, slug, title="Title B", owner=workers[0])

        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         ["title"])
        self.assertEqual(after["blocked_reason"], "waiting on the API")
        self.assertEqual(after["status"], "blocked")


class DocumentedSideEffectsStillFire(unittest.TestCase):
    """The consequences that ARE part of a transition's contract.

    These are pinned deliberately. The ticket asks for accidental coupling to
    go and for intentional coupling to be documented and regression-tested —
    so each of these is a behaviour someone could mistake for the bug above and
    "fix", and each would be a real regression if they did.
    """

    def test_assigning_an_item_to_its_own_reviewer_empties_the_seat(self):
        """User ruling 2026-09-05: an owner may not be its own reviewer, so the
        seat empties rather than standing as a prohibited self-review."""
        org, slug, manager, workers = fixture()
        org.work_update(manager, slug, ["ready"], ["review it"],
                        status="review", reviewer=workers[1], owner=workers[0])
        before = snapshot(org, manager, slug)

        org.work_assign(manager, slug, workers[1])

        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         ["owner", "reviewer"])
        self.assertIsNone(after["reviewer"])
        self.assertEqual(after["status"], "review")

    def test_assigning_to_a_participant_drops_the_duplicate_seat(self):
        """An agent is the owner or a participant, never both at once."""
        org, slug, manager, workers = fixture()
        org.work_participants(manager, slug, add=[workers[1]])
        before = snapshot(org, manager, slug)

        org.work_assign(manager, slug, workers[1])

        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         ["owner", "participants"])
        self.assertEqual(after["participants"], [])

    def test_an_explicit_attention_false_still_clears_the_flag(self):
        """An agent may still take its own flag down — deliberately.

        This is the surviving half of what used to be
        test_a_later_update_clears_a_standing_attention_flag. See
        AttentionSurvivesUnrelatedEdits below for the half the user reversed.
        """
        org, slug, manager, workers = fixture()
        org.work_update(manager, slug, ["done a thing"], ["next thing"],
                        attention=True, attention_reason="please confirm",
                        owner=workers[0])
        self.assertTrue(snapshot(org, manager, slug)["manual_attention"])

        org.work_update(manager, slug, attention=False, owner=workers[0])

        self.assertFalse(snapshot(org, manager, slug)["manual_attention"])


class AttentionSurvivesUnrelatedEdits(unittest.TestCase):
    """The user's 2026-09-19 ruling, in their own words: "only the user
    replying / dismissing with no comment, or an explicit clearing of the
    attention by an agent should clear it".

    Until then ANY later update took a standing flag down, on the rule that the
    latest update is the complete current statement. That made the flag the one
    field an unrelated edit still moved — the same shape as the assign bug this
    ticket started from, and the reason fixing a ticket's title could silently
    drop a question the user was still reading.

    I had originally kept that behaviour and pinned it, because it was
    documented contract and the ticket said to keep documented consequences.
    The user overruled it. These tests are that reversal.
    """

    def _flagged(self):
        org, slug, manager, workers = fixture()
        org.work_update(manager, slug, ["done a thing"], ["next thing"],
                        attention=True, attention_reason="please confirm",
                        owner=workers[0])
        self.assertTrue(snapshot(org, manager, slug)["manual_attention"])
        return org, slug, manager, workers

    def test_a_title_edit_leaves_the_flag_standing(self):
        """The exact case in the user's complaint."""
        org, slug, manager, workers = self._flagged()
        before = snapshot(org, manager, slug)

        org.work_update(manager, slug, title="Title B", owner=workers[0])

        after = snapshot(org, manager, slug)
        self.assertEqual(sorted(f for f in TRACKED if before[f] != after[f]),
                         ["title"])
        self.assertTrue(after["manual_attention"])

    def test_an_ordinary_progress_update_leaves_the_flag_standing(self):
        """Not just metadata edits: a real status update does not clear it
        either. The user named three clearers and this is not one of them."""
        org, slug, manager, workers = self._flagged()

        org.work_update(manager, slug, ["more done"], ["more next"],
                        owner=workers[0])

        flag = snapshot(org, manager, slug)["manual_attention"]
        self.assertTrue(flag)
        self.assertEqual(flag["reason"], "please confirm")

    def test_the_reason_survives_untouched_across_several_updates(self):
        """A flag that survives but loses its sentence would be the same defect
        wearing a different shape."""
        org, slug, manager, workers = self._flagged()

        org.work_update(manager, slug, title="Title B", owner=workers[0])
        org.work_update(manager, slug, status="in_progress", owner=workers[0])
        org.work_update(manager, slug, ["more"], ["next"], owner=workers[0])

        flag = snapshot(org, manager, slug)["manual_attention"]
        self.assertEqual(flag["reason"], "please confirm")

    def test_a_user_reply_still_clears_it(self):
        """Clearer one of three, named by the user."""
        org, slug, manager, _workers = self._flagged()

        org.work_clear_attention_on_user_reply(slug)

        self.assertFalse(snapshot(org, manager, slug)["manual_attention"])

    def test_a_user_dismissal_still_clears_it(self):
        """Clearer two of three, named by the user."""
        org, slug, manager, _workers = self._flagged()
        set_rev = org.work_get(manager, slug)["manual_attention"]["set_rev"]

        org.work_dismiss_attention(slug, set_rev)

        self.assertFalse(snapshot(org, manager, slug)["manual_attention"])

    def test_an_explicit_agent_retraction_still_clears_it(self):
        """Clearer three of three, named by the user."""
        org, slug, manager, workers = self._flagged()

        org.work_update(manager, slug, attention=False, owner=workers[0])

        self.assertFalse(snapshot(org, manager, slug)["manual_attention"])


class ProtectionsSurvive(unittest.TestCase):
    """Compare-and-set and append-only history are unchanged by all of this."""

    def test_expected_rev_still_refuses_a_stale_metadata_update(self):
        org, slug, manager, workers = fixture()
        stale = org.work_get(manager, slug)["rev"]
        org.work_update(manager, slug, title="Title B", owner=workers[0])

        with self.assertRaises(LedgerError):
            org.work_update(manager, slug, title="Title C", owner=workers[0],
                            expected_rev=stale)

        self.assertEqual(org.work_get(manager, slug)["title"], "Title B")

    def test_expected_rev_accepts_the_revision_it_was_composed_against(self):
        org, slug, manager, workers = fixture()
        current = org.work_get(manager, slug)["rev"]

        org.work_update(manager, slug, title="Title B", owner=workers[0],
                        expected_rev=current)

        self.assertEqual(org.work_get(manager, slug)["title"], "Title B")

    def test_history_only_ever_grows(self):
        org, slug, manager, workers = fixture(status="backlogged")
        rows = list(org.work_get(manager, slug)["history"])

        org.work_assign(manager, slug, workers[1])
        org.work_update(manager, slug, title="Title B", owner=workers[1])

        grown = org.work_get(manager, slug)["history"]
        self.assertGreater(len(grown), len(rows))
        self.assertEqual(grown[:len(rows)], rows)


if __name__ == "__main__":
    unittest.main()
