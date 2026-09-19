"""Assignment moves ownership and leaves the backlog where it is.

⚠ THIS FILE USED TO ASSERT THE OPPOSITE. Until 2026-09-19 `assign` opened a
backlogged item automatically, and the 2.1.0 release notes advertised it
("Assigning a backlogged ticket opens it automatically"). The user reversed it
after a coordinator's plain reassignment silently started work that had been
left unstarted on purpose: ownership and status are independent metadata, and a
caller that asked to change one should not get two.

The wider rule, and the field-by-field matrix behind it, live in
tests/test_work_metadata_isolation.py (ticket:
allow-every-ticket-metadata-field-to-be-updated). What is kept here is the
backlog case specifically, because that is the one a future change is most
likely to "restore" by accident.
"""
import os
import tempfile
import unittest

# Keep storage isolated from the developer installation. The ledger imports
# storage lazily while constructing an Org.
os.environ["ORGTREE_DATA"] = tempfile.mkdtemp(prefix="assign-backlog-")
os.environ["ORGTREE_V2_TOKEN"] = "assign-backlog-tests"

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import ledger


def _org():
    org = ledger.Org.create("assign-backlog")
    hire_args = dict(add_dirs=[], tools={"bash": False, "web": False,
                                         "edit": False, "subagents": False,
                                         "mcp": []}, org_visibility="self",
                     charter="test worker")
    manager = org.hire(ledger.USER, None, "haiku", 2, "manager",
                       **hire_args)["node"]
    worker = org.hire(manager, manager, "haiku", 0, "worker",
                      **hire_args)["node"]
    return org, str(manager), str(worker)


class AssignBackloggedTests(unittest.TestCase):
    def test_explicit_assignment_leaves_a_backlogged_item_backlogged(self):
        org, manager, worker = _org()
        item = org.work_create(manager, "Unstarted", "needs doing",
                               status="backlogged")

        result = org.work_assign(manager, item["slug"], worker)

        self.assertEqual(result["status"], "backlogged")
        self.assertEqual(org.work_get(manager, item["slug"])["status"],
                         "backlogged")
        # the assignment still happened — this is not green because the call
        # became a no-op
        self.assertEqual(
            org.work_get(manager, item["slug"])["owner"]["node"], worker)
        history = org._work_active()[0]["history"]
        self.assertEqual(history[-1]["op"], "assign")
        self.assertNotIn("status_from", history[-1])
        self.assertNotIn("status_to", history[-1])
        # and it is still out of the active count, which is the whole point of
        # having left it in the backlog
        self.assertEqual(org.work_counts()["backlogged"], 1)

    def test_composite_update_assignment_uses_same_rule(self):
        org, manager, worker = _org()
        item = org.work_create(manager, "Unstarted", "needs doing",
                               status="backlogged")

        # work_update's explicit owner is the composite assignment path used
        # by staffing an existing item; it must share work_assign's rule.
        result = org.work_update(manager, item["slug"], ["picked up"],
                                 ["implement it"], owner=worker)

        self.assertEqual(result["status"], "backlogged")
        self.assertEqual(result["assigned_to"], worker)
        self.assertEqual(org.work_get(manager, item["slug"])["status"],
                         "backlogged")

    def test_a_caller_that_wants_it_open_asks_for_that(self):
        """Preserving the backlog is not refusing to leave it."""
        org, manager, worker = _org()
        item = org.work_create(manager, "Unstarted", "needs doing",
                               status="backlogged")

        result = org.work_update(manager, item["slug"], ["picked up"],
                                 ["implement it"], status="open", owner=worker)

        self.assertEqual(result["status"], "open")
        self.assertEqual(org.work_get(manager, item["slug"])["status"], "open")
        self.assertEqual(org.work_counts()["backlogged"], 0)

    def test_assignment_preserves_existing_status(self):
        org, manager, worker = _org()
        for status in ("open", "in_progress", "blocked", "review",
                       "deploy_ready"):
            item = org.work_create(manager, "Existing " + status,
                                   "needs doing", status=status,
                                   blocked_reason=("external blocker"
                                                   if status == "blocked"
                                                   else None))
            result = org.work_assign(manager, item["slug"], worker)
            self.assertEqual(result["status"], status)


if __name__ == "__main__":
    unittest.main()
