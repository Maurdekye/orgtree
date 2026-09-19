"""A hire/rehire that carries `work_item` starts the agent, so it opens the backlog.

Ticket: allow-every-ticket-metadata-field-to-be-updated (review finding f1)

THE REGRESSION THIS EXISTS FOR. Making a plain `assign` leave `backlogged`
alone was the point of the ticket. The first cut of it then restored the
transition for `orgtree_staff` only — at `api._staff_call` — and missed the
other route that meets the same criterion: `orgtree_hire` / `orgtree_rehire`
carrying `work_item`. Those reach the assignment through `api._seat_finish`,
and `_staff_call` pops `work_item` before the seat is made precisely so the
assignment is filed once, so the two paths are DISJOINT and fixing one does
nothing for the other.

The result was an item that read `backlogged` while an agent was already
running on it. That is worse than a cosmetic status error: a backlogged item is
hidden behind its own toggle, excluded from the user's active count, and never
nudged by the idle reminder — so the work was invisible AND unreminded, and
could sit silently forever.

Found in review by textmenu. These tests drive the REAL `_seat_finish`, exactly
as the dispatcher calls it, rather than the ledger rule underneath it — the
ledger rule was never the broken part.
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="seat-work-item-",
                                    ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name,
                  ORGTREE_V2_TOKEN="seat-work-item-tests")

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, store  # noqa: E402

_HIRE = dict(add_dirs=[], tools={"bash": False, "web": False, "edit": False,
                                 "subagents": False, "mcp": []},
             org_visibility="self", charter="test worker")


class SeatWorkItemBacklogTests(unittest.TestCase):
    def setUp(self):
        # `mail_notify` is a UI signal with no state on it; stubbing it keeps
        # the test to the docket transaction, which is what regressed.
        p = patch.object(api, "mail_notify", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        self.org = ledger.Org.create("seat-wi-" + uuid.uuid4().hex[:8])
        self.slug = self.org.d["slug"]
        self.manager = self.org.hire(ledger.USER, None, "haiku", 3, "manager",
                                     **_HIRE)["node"]
        self.one = self.org.hire(self.manager, self.manager, "haiku", 0,
                                 "worker-one", **_HIRE)["node"]
        self.two = self.org.hire(self.manager, self.manager, "haiku", 0,
                                 "worker-two", **_HIRE)["node"]
        store.save_org(self.org)

    def _item(self, status="backlogged"):
        return str(self.org.work_create(self.manager, "Unstarted",
                                        "needs doing", status=status,
                                        owner=self.one)["slug"])

    def _seat_finish(self, wid, nid=None):
        drive: list[str] = []
        api._seat_finish(self.org, self.slug, self.manager, nid or self.two,
                         {"work_item": wid}, {}, drive)
        return drive

    def test_a_seat_carrying_a_work_item_opens_a_backlogged_one(self):
        wid = self._item()

        drive = self._seat_finish(wid)

        item = self.org.work_get(self.manager, wid)
        self.assertEqual(item["status"], "open")
        self.assertEqual(item["owner"]["node"], self.two)
        # the seat really is started — which is what makes `backlogged` wrong
        self.assertIn(self.two, drive)

    def test_the_item_is_never_both_unstarted_and_running(self):
        """The exact contradiction the finding named, asserted as one fact."""
        wid = self._item()

        drive = self._seat_finish(wid)

        counts = self.org.work_counts()
        started = self.two in drive
        reads_unstarted = (self.org.work_get(self.manager, wid)["status"]
                           == "backlogged")
        self.assertTrue(started)
        self.assertFalse(reads_unstarted)
        self.assertEqual(counts["backlogged"], 0)
        self.assertEqual(counts["active"], 1)

    def test_it_leaves_every_other_status_alone(self):
        """The exception is for the backlog only. A seat handed a blocked or
        in-progress item must not have its status rewritten."""
        for status in ("open", "in_progress", "blocked", "deploy_ready"):
            with self.subTest(status=status):
                wid = str(self.org.work_create(
                    self.manager, "Existing " + status, "needs doing",
                    status=status, owner=self.one,
                    blocked_reason=("external blocker"
                                    if status == "blocked" else None))["slug"])

                self._seat_finish(wid)

                self.assertEqual(
                    self.org.work_get(self.manager, wid)["status"], status)

    def test_a_plain_assign_on_the_same_item_still_preserves_the_backlog(self):
        """The control. The ticket's whole point is that assignment alone does
        NOT start work; if this ever goes green-by-accident the exception has
        swallowed the rule."""
        wid = self._item()

        self.org.work_assign(self.manager, wid, self.two)

        self.assertEqual(self.org.work_get(self.manager, wid)["status"],
                         "backlogged")
        self.assertEqual(self.org.work_counts()["backlogged"], 1)


if __name__ == "__main__":
    unittest.main()
