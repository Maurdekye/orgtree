"""Assignment starts docket items that have not yet been approached."""
import os
import tempfile
import unittest

# Keep storage isolated from the developer installation. The ledger imports
# storage lazily while constructing an Org.
os.environ["ORGTREE_DATA"] = tempfile.mkdtemp(prefix="assign-backlog-")
os.environ["ORGTREE_V2_TOKEN"] = "assign-backlog-tests"

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
    def test_explicit_assignment_opens_backlogged_item_and_reports_status(self):
        org, manager, worker = _org()
        item = org.work_create(manager, "Unstarted", "needs doing",
                               status="backlogged")

        result = org.work_assign(manager, item["slug"], worker)

        self.assertEqual(result["status"], "open")
        self.assertEqual(org.work_get(manager, item["slug"])["status"], "open")
        history = org._work_active()[0]["history"]
        self.assertEqual(history[-1]["op"], "assign")
        self.assertEqual(history[-1]["status_from"], "backlogged")
        self.assertEqual(history[-1]["status_to"], "open")
        self.assertEqual(org.work_counts()["backlogged"], 0)

    def test_composite_update_assignment_uses_same_transition(self):
        org, manager, worker = _org()
        item = org.work_create(manager, "Unstarted", "needs doing",
                               status="backlogged")

        # work_update's explicit owner is the composite assignment path used
        # by staffing an existing item; it must share work_assign's rule.
        result = org.work_update(manager, item["slug"], ["picked up"],
                                 ["implement it"], owner=worker)

        self.assertEqual(result["status"], "open")
        self.assertEqual(result["assigned_to"], worker)
        self.assertEqual(org.work_get(manager, item["slug"])["status"], "open")

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
