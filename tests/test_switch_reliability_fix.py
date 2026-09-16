"""Fix verification for the switch-reliability ticket
(`make-model-provider-and-account-switching-on-liv`). Separate from the
reproduction suite so a shared fixture can never mask a regression.

Covered here:
- D: the queued-switch drop at the turn boundary (an account that no longer
  validates) now emits a lifecycle.switch_dropped EVENT to the requester and
  the live superior, not just a log row — matching ledger.apply_pending_switch,
  so "a queued switch is never silently forgotten" holds on every drop path,
  including the one the multi-account feature introduced.
- A: the frozen-node rebind policy (coordinator ruling 2026-09-16, build (a)).
  A bare rebind on a MOVABLE usage-limit freeze is REFUSED and leaves the agent
  EXACTLY as it was; a bare rebind on an AUTH/CREDENTIAL freeze succeeds and
  thaws; recovery paths (allow_frozen) bypass the refusal.
"""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

# ONE data root for the whole module, bound BEFORE the first import — store
# binds DATA_ROOT at import time, so every class in this module must share the
# same root (each module already runs in its own process). supervisor prints
# switch outcomes with non-ASCII (→); the packaged engine runs utf-8 stdout,
# but a dev cp1252 console would crash on it.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-switch-fix-")
os.environ["ORGTREE_DATA"] = _ROOT
from engine.backend.orgtree import ledger, registry, store, supervisor  # noqa: E402
if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
    raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")


class BoundarySwitchDropIsAnnounced(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _ROOT
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


class FrozenRebindPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = _ROOT
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self, label):
        FrozenRebindPolicy._seq += 1
        row = self.registry.create_account(
            "claude", label,
            {"kind": "managed",
             "path": os.path.join(self.root, f"claude-{label}-{self._seq}")})
        self.registry.set_auth(row["id"], "authenticated")
        return self.registry.get_account(row["id"])

    def _frozen_org(self, slug, source, frozen):
        org = self.ledger.Org.create(slug)
        org.hire(self.ledger.USER, None, "opus", 0, "worker")
        n = org.node("worker")
        n["account"] = source["id"]
        n["frozen"] = frozen
        st = self.supervisor.state(slug, "worker")
        st.update(busy=False, responding=False, queue=[])
        self.store.save_org(org)
        return org

    def test_bare_rebind_on_usage_limit_freeze_refuses_and_changes_nothing(self):
        source, target = self._account("source"), self._account("target")
        slug = "policy-refuse"
        frozen = {"at": "2026-09-14T00:00:00Z", "limit": True,
                  "account": source["id"], "resume_texts": ["resume the task"]}
        org = self._frozen_org(slug, source, frozen)
        before_sid = org.node("worker")["session_id"]

        with self.assertRaises(RuntimeError) as ctx:
            self.supervisor.assign_account(slug, "worker", target["id"],
                                           actor="USER")
        # the refusal names the supported recovery path
        self.assertIn("/continue-on", str(ctx.exception))

        # NOTHING half-applied: same account, same freeze, same session
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], source["id"])
        self.assertEqual(fresh.get("frozen"), frozen)
        self.assertEqual(fresh["session_id"], before_sid)

    def test_bare_rebind_on_auth_freeze_succeeds_and_thaws(self):
        source, target = self._account("source"), self._account("target")
        slug = "policy-auth-thaw"
        frozen = {"at": "2026-09-14T00:00:00Z", "cause": "auth",
                  "account": source["id"], "resume_texts": ["resume the task"]}
        self._frozen_org(slug, source, frozen)

        with patch.object(self.supervisor, "send_message") as send:
            disclosure = self.supervisor.assign_account(
                slug, "worker", target["id"], actor="USER")

        self.assertTrue(disclosure.get("auth_thawed"))
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], target["id"], "the rebind applied")
        self.assertNotIn("frozen", fresh, "the auth freeze was thawed")
        # the node was woken so it can actually run again
        send.assert_called()

    def test_untrusted_credential_freeze_also_thaws(self):
        # a rejected credential can present as `untrusted` rather than a
        # cause string — it is still the auth kind and rebinding is its fix
        source, target = self._account("source"), self._account("target")
        slug = "policy-untrusted"
        self._frozen_org(slug, source, {"at": "2026-09-14T00:00:00Z",
                                        "untrusted": True,
                                        "account": source["id"]})
        with patch.object(self.supervisor, "send_message"):
            out = self.supervisor.assign_account(slug, "worker", target["id"],
                                                 actor="USER")
        self.assertTrue(out.get("auth_thawed"))
        self.assertNotIn("frozen", self.store.load_org(slug).node("worker"))

    def test_recovery_path_may_rebind_a_usage_limit_freeze(self):
        # allow_frozen=True is the /continue-on and auto-fallback opt-in: the
        # refusal does not apply, and the freeze is NOT auto-thawed here (the
        # recovery path releases it separately, in its own save window)
        source, target = self._account("source"), self._account("target")
        slug = "policy-recovery"
        frozen = {"at": "2026-09-14T00:00:00Z", "limit": True,
                  "account": source["id"], "resume_texts": ["resume the task"]}
        self._frozen_org(slug, source, frozen)
        out = self.supervisor.assign_account(slug, "worker", target["id"],
                                             actor="USER", allow_frozen=True)
        self.assertEqual(out["account"], target["id"])
        self.assertFalse(out.get("auth_thawed"))
        fresh = self.store.load_org(slug).node("worker")
        self.assertEqual(fresh["account"], target["id"])
        self.assertIn("frozen", fresh, "recovery path leaves the freeze for its "
                                       "own release step")


if __name__ == "__main__":
    unittest.main()
