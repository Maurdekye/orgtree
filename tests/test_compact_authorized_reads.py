"""Opt-in compact docket reads preserve authorization and actionable scope."""

import os
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="w04-compact-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name

from orgtree import events, ledger


class CompactAuthorizedReads(unittest.TestCase):
    def setUp(self) -> None:
        self.org = ledger.Org.create("compact-authorized-fixture")
        self.owner = self.org.hire(ledger.USER, None, "haiku", 0, "owner")["node"]
        self.peer = self.org.hire(ledger.USER, None, "haiku", 0, "peer")["node"]
        self.item = self.org.work_create(
            ledger.USER, "Owned item",
            "The old read was too large. Use an explicit compact projection.",
            owner=self.owner, acceptance=["the condition remains visible"],
            done_so_far=["a completed step"], working_on_next=["the next step"])
        self.wid = str(self.item["created"])
        self.org.work_create(
            ledger.USER, "Peer item", "A separate problem. A separate solution.",
            owner=self.peer)

    def test_full_is_unchanged_and_compact_keeps_scope_state_and_candidate(self) -> None:
        full = self.org.work_get(self.owner, self.wid)
        compact = self.org.work_get(self.owner, self.wid, compact=True)
        self.assertNotIn("compact", full)
        self.assertNotIn("omissions", full)
        self.assertEqual(compact["owner"]["node"], self.owner)
        self.assertIsNone(compact["reviewer"])
        self.assertEqual(compact["rev"], full["rev"])
        self.assertEqual(compact["status"], full["status"])
        self.assertEqual(compact["questions"], full["questions"])
        self.assertEqual(compact["acceptance"], full["acceptance"])
        self.assertEqual(compact["requested_scope"]["objective"], full["objective"])
        self.assertIsNone(compact["candidate"])
        self.assertNotIn("history", compact)
        self.assertEqual(compact["omitted_history_count"], len(full["history"]))

    def test_list_filters_before_compacting(self) -> None:
        full = self.org.work_list(self.owner)
        compact = self.org.work_list(self.owner, compact=True)
        self.assertNotIn("compact", full)
        self.assertTrue(compact["compact"])
        self.assertEqual([x["slug"] for x in compact["items"]],
                         [x["slug"] for x in full["items"]])
        self.assertNotIn("Peer item", [x["title"] for x in compact["items"]])
        self.assertEqual(compact["counts"], full["counts"])

    def test_assignment_and_review_context_carries_acceptance(self) -> None:
        actor = {"kind": "agent", "id": self.owner}
        obj = {"kind": "work_item", "org": "compact-authorized-fixture",
               "slug": self.wid, "title": "Owned item"}
        assigned = events.mint(
            "docket.assigned", actor, obj, owner=self.owner,
            previous_owner=None, assigner=ledger.USER, status="open",
            objective="The old read was too large. Use an explicit compact projection.",
            done_so_far=[], working_on_next=[],
            acceptance=["the condition remains visible"])
        reviewed = events.mint(
            "docket.review_requested", actor, obj, reviewer=self.peer,
            requested_by=self.owner, owner=self.owner,
            objective="The old read was too large. Use an explicit compact projection.",
            done_so_far=[], acceptance=["the condition remains visible"])
        self.assertIn("Acceptance conditions: the condition remains visible",
                      events.render_agent(assigned))
        self.assertIn("Acceptance conditions: the condition remains visible",
                      events.render_agent(reviewed))
        self.assertIn("complete standalone scope", events.render_agent(reviewed))


if __name__ == "__main__":
    unittest.main()
