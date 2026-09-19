"""The attention flag, driven through the API door agents actually go through.

Ticket: allow-every-ticket-metadata-field-to-be-updated (review finding f3)

⚠ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS SEPARATE.

Two blocking findings on this ticket had the SAME root cause: the ledger rule
was right, one API call site was missed, and every test drove the ledger
directly so nothing saw it.

  f1  `_seat_finish` never opted into the backlog transition, so hire/rehire
      started agents on items the docket still called backlogged.
  f3  `_work_mutate_action`'s `update` branch collapsed `attention: false` to
      `None`, so an agent could not retract its own flag — while the shipped
      documentation, rewritten in the same commit, told it to do exactly that.

`tests/test_work_metadata_isolation.py` and
`tests/test_work_attention_question_survives.py` both construct `ledger.Org`
and call `work_update` directly. That is the right layer for the RULE and the
wrong layer for the WIRE: an argument that never survives the dispatcher is
invisible to them by construction. So the tests here drive
`api._work_mutate_action` — the same entry point `orgtree_work` reaches — and
assert on what an agent can actually cause to happen.

The rule under test (user ruling 2026-09-19): an update that does not mention
the flag leaves it standing; only a user reply, a user dismissal, or an
explicit `attention: false` from an agent clears it.
"""
import os
import tempfile
import unittest
import uuid

_root = tempfile.TemporaryDirectory(prefix="attention-api-door-",
                                    ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name,
                  ORGTREE_V2_TOKEN="attention-api-door-tests")

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, ledger  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

_HIRE = dict(add_dirs=[], tools={"bash": False, "web": False, "edit": False,
                                 "subagents": False, "mcp": []},
             org_visibility="self", charter="test worker")
REASON = "I chose an edge case you did not specify — please confirm."


class AttentionThroughTheApiDoor(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create("attn-api-" + uuid.uuid4().hex[:8])
        self.agent = self.org.hire(USER, None, "haiku", 2, "worker",
                                   **_HIRE)["node"]
        self.wid = str(self.org.work_create(
            self.agent, "Nightly sweep", "problem, then solution",
            done_so_far=["built it"],
            working_on_next=["confirm the edge case"])["slug"])

    # ---- the door itself, called the way orgtree_work calls it
    def _update(self, args):
        return api._work_mutate_action(self.org, self.agent, args, "update",
                                       self.wid)

    def _raise_flag(self):
        """Raised THROUGH THE API, so a fixture built on a broken door would
        fail loudly here rather than silently producing an unflagged item."""
        self._update({"done_so_far": ["built it"],
                      "working_on_next": ["confirm it"],
                      "attention": True, "attention_reason": REASON})
        self.assertTrue(self._flag(), "fixture failed: no flag was raised")

    def _flag(self):
        return self.org.work_get(self.agent, self.wid).get("manual_attention")

    def test_an_agent_can_retract_its_own_flag_through_update(self):
        """THE DEFECT (f3). `attention: false` was collapsed to `None` by the
        update branch, so this retraction was silently a no-op — and because
        nothing clears implicitly any more, an agent had NO way to take its own
        flag down on an active item."""
        self._raise_flag()

        self._update({"attention": False})

        self.assertIsNone(self._flag())

    def test_the_string_false_retracts_too(self):
        """`_arg_flag` exists because an LLM writes "false" often enough that
        plain truthiness would turn a deliberate opt-out into an opt-in. The
        retraction has to honour the same spellings the raise does."""
        self._raise_flag()

        self._update({"attention": "false"})

        self.assertIsNone(self._flag())

    def test_omitting_attention_still_leaves_the_flag_standing(self):
        """The headline rule, at this layer. Not a duplicate of the ledger
        test: this is the half that proves the door does not invent a clear."""
        self._raise_flag()

        self._update({"title": "A new title"})

        flag = self._flag()
        self.assertIsNotNone(flag)
        self.assertEqual(flag["reason"], REASON)

    def test_a_progress_update_through_the_door_leaves_it_standing(self):
        self._raise_flag()

        self._update({"done_so_far": ["more done"],
                      "working_on_next": ["more next"]})

        self.assertIsNotNone(self._flag())

    def test_raising_through_the_door_still_works(self):
        """The opposite direction, so a 'fix' that made the door ignore
        `attention` entirely would fail here instead of passing everything."""
        self.assertIsNone(self._flag())

        self._update({"done_so_far": ["built it"],
                      "working_on_next": ["confirm it"],
                      "attention": True, "attention_reason": REASON})

        flag = self._flag()
        self.assertIsNotNone(flag)
        self.assertEqual(flag["reason"], REASON)

    def test_a_plain_assign_through_the_door_preserves_the_backlog(self):
        """The ticket's HEADLINE defect, at the layer a coordinator hits.

        Everything else pinning this rule drives `Org.work_assign` directly.
        That is the right layer for the rule and the wrong one for the wire —
        the dispatcher could pass `starts_agent` and no ledger test would
        notice. The `assign` branch must reach the ledger WITHOUT the opt-in.
        """
        org = ledger.Org.create("attn-api-assign-" + uuid.uuid4().hex[:8])
        manager = org.hire(USER, None, "haiku", 3, "manager", **_HIRE)["node"]
        one = org.hire(manager, manager, "haiku", 0, "w-one", **_HIRE)["node"]
        two = org.hire(manager, manager, "haiku", 0, "w-two", **_HIRE)["node"]
        wid = str(org.work_create(manager, "Unstarted", "needs doing",
                                  status="backlogged", owner=one)["slug"])

        api._work_mutate_action(org, manager, {"owner": two}, "assign", wid)

        item = org.work_get(manager, wid)
        self.assertEqual(item["status"], "backlogged")
        self.assertEqual(item["owner"]["node"], two)   # it really did assign
        self.assertEqual(org.work_counts()["backlogged"], 1)

    def test_the_retraction_keeps_the_question_on_the_clearing_row(self):
        """The record property the sibling suite protects, asserted at this
        layer too — a retraction that loses the sentence is the defect
        test_work_attention_question_survives exists for."""
        self._raise_flag()

        self._update({"attention": False})

        rows = [h for h in self.org.work_get(self.agent, self.wid)["history"]
                if "cleared_set_rev" in ((h.get("changes") or {})
                                         .get("manual_attention") or {})]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["changes"]["manual_attention"]["reason"],
                         REASON)


if __name__ == "__main__":
    unittest.main()
