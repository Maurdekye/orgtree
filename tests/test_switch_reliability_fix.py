"""Fix verification for the switch-reliability ticket
(`make-model-provider-and-account-switching-on-liv`). Separate from the
reproduction suite so a shared fixture can never mask a regression.

Covered here:
- D: the queued-switch drop at the turn boundary (an account that no longer
  validates) now emits a lifecycle.switch_dropped EVENT to the requester and
  the live superior, not just a log row — matching ledger.apply_pending_switch,
  so "a queued switch is never silently forgotten" holds on every drop path,
  including the one the multi-account feature introduced.
"""
import os
import sys
import tempfile
import unittest


class BoundarySwitchDropIsAnnounced(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # supervisor prints switch outcomes with non-ASCII (→); the packaged
        # engine runs utf-8 stdout, but a dev cp1252 console would crash on it.
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
        cls.root = tempfile.mkdtemp(prefix="orgtree-switch-fix-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger, store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.store = store
        cls.supervisor = supervisor

    def _org_with_boss_and_worker(self, slug):
        org = self.ledger.Org.create(slug)
        # a live node named as the REQUESTER so the drop event has a real
        # recipient — the ledger's own switch_dropped audience is
        # {requester, parent} filtered to live nodes, and a top-level node
        # requested by USER (not a node) has neither. Both are top-level hires
        # (a subordinate hire demands full explicit scope we do not need here);
        # naming `boss` as the pending switch's `by` is what puts it in scope.
        org.hire(self.ledger.USER, None, "opus", 0, "boss")
        org.hire(self.ledger.USER, None, "opus", 0, "worker")
        return org

    def test_boundary_drop_emits_switch_dropped_event(self):
        slug = "fix-drop-event"
        org = self._org_with_boss_and_worker(slug)
        node = org.node("worker")
        # a BOUND node (a real-looking claude account id) with a queued
        # CROSS-PROVIDER switch that carries NO account — exactly the shape
        # check_switch_account refuses at the boundary ("queued before this
        # feature, or against a binding that appeared meanwhile").
        node["account"] = "claude-acct-x"
        node["pending_switch"] = {"tier": "astra", "from": "opus",
                                  "by": "boss", "crossing": True,
                                  "at": "2026-09-16T00:00:00Z"}

        changed = self.supervisor._apply_pending_switch_locked(
            org, slug, "worker", wake=[])
        self.assertTrue(changed, "the drop is a recorded change, not a no-op")

        # the switch did NOT land: the node stays whole on its old tier …
        self.assertEqual(org.node("worker")["model"], "opus")
        self.assertNotIn("pending_switch", org.node("worker"))

        # … and the drop is ANNOUNCED to the live superior, not merely logged
        rows = [r for r in org.d.get("notice_log", [])
                if r.get("node") == "boss" and "DROPPED" in str(r.get("text"))]
        self.assertEqual(len(rows), 1,
                         "the boundary drop must emit lifecycle.switch_dropped "
                         "to the live superior (parity with the ledger drop)")
        self.assertIn("astra", rows[0]["text"])
        self.assertIn("worker", rows[0]["text"])

        # the node itself is never notified of its own dropped switch
        self.assertEqual(
            [r for r in org.d.get("notice_log", [])
             if r.get("node") == "worker" and "DROPPED" in str(r.get("text"))],
            [])

        # the audit log row is still there too — the event is ADDED, not a swap
        logs = [e for e in org.d["events"]
                if e.get("op") == "switch_queue_dropped"]
        self.assertEqual(len(logs), 1)

    def test_a_valid_queued_switch_is_not_dropped(self):
        # control: a SAME-provider queued switch needs no account, so the
        # boundary applies it and emits no drop.
        slug = "fix-no-drop"
        org = self._org_with_boss_and_worker(slug)
        org.node("worker")["pending_switch"] = {
            "tier": "sonnet", "from": "opus", "by": "boss",
            "crossing": False, "at": "2026-09-16T00:00:00Z"}
        self.supervisor._apply_pending_switch_locked(org, slug, "worker", wake=[])
        self.assertEqual(org.node("worker")["model"], "sonnet")
        self.assertNotIn("pending_switch", org.node("worker"))
        dropped = [r for r in org.d.get("notice_log", [])
                   if "DROPPED" in str(r.get("text"))]
        self.assertEqual(dropped, [])


if __name__ == "__main__":
    unittest.main()
