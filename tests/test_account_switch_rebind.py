"""S5b atomic switch+rebind: the enqueue rule, the boundary apply's veto as
a RECORDED NO-OP (never a raise — it runs in the shared finally), and the
atomicity assertion (tier and binding both changed after one act, neither
after a refusal)."""
import os
import tempfile
import unittest


class SwitchRebindTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-switch-")
        os.environ["ORGTREE_DATA"] = cls.root
        import sys
        # the apply path prints an arrow; a cp1252 test console would turn
        # that pre-existing print into a UnicodeEncodeError unrelated to
        # what these tests assert
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="replace")
        from engine.backend.orgtree import ledger, registry, store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _row(self, provider="claude"):
        SwitchRebindTests._seq += 1
        return self.registry.create_account(
            provider, "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"sw-{self._seq}")})

    def _org(self, slug, model="opus", account=None, grant=50):
        org = self.ledger.Org.create(slug)
        org.nodes["root"] = {"state": "live", "parent": None,
                             "generation": 1, "model": model,
                             "grant": grant, "free": grant,
                             "session_id": "sid-0", "scope": {}}
        if account:
            org.nodes["root"]["account"] = account
        return org

    # --------------------------------------------------------- enqueue rule
    def test_cross_provider_switch_on_bound_node_requires_account(self):
        row = self._row()
        org = self._org("sw-req", account=row["id"])
        with self.assertRaises(self.registry.BindingRefused):
            self.supervisor.check_switch_account(org, "sw-req", "root",
                                                 "luna", None)
        # with a valid target-provider account it passes
        codex = self._row(provider="openai")
        self.supervisor.check_switch_account(org, "sw-req", "root",
                                             "luna", codex["id"])
        # and a wrong-provider account for the NEW tier is refused
        with self.assertRaises(self.registry.BindingRefused):
            self.supervisor.check_switch_account(org, "sw-req", "root",
                                                 "luna", row["id"])

    def test_same_provider_and_unbound_switches_need_no_account(self):
        row = self._row()
        org = self._org("sw-free", account=row["id"])
        self.supervisor.check_switch_account(org, "sw-free", "root",
                                             "sonnet", None)
        org2 = self._org("sw-unbound")
        self.supervisor.check_switch_account(org2, "sw-unbound", "root",
                                             "luna", None)

    # -------------------------------------------------- boundary apply veto
    def test_accountless_pending_cross_switch_drops_as_recorded_noop(self):
        row = self._row()
        org = self._org("sw-veto", account=row["id"])
        # a pending switch queued WITHOUT an account (pre-feature shape)
        org.nodes["root"]["pending_switch"] = {
            "tier": "luna", "from": "opus", "by": "USER", "at": 0.0}
        changed = self.supervisor._apply_pending_switch_locked(
            org, "sw-veto", "root")  # must NOT raise (shared finally)
        self.assertTrue(changed)
        node = org.node("root")
        # neither half moved: old tier kept, old binding kept, pend gone
        self.assertEqual(node["model"], "opus")
        self.assertEqual(node["account"], row["id"])
        self.assertNotIn("pending_switch", node)
        drops = [e for e in org.d["events"]
                 if e["op"] == "switch_queue_dropped"]
        self.assertEqual(len(drops), 1)  # surfaced, never silent

    def test_pending_with_account_applies_both_halves_atomically(self):
        row = self._row()
        codex = self._row(provider="openai")
        org = self._org("sw-atomic", account=row["id"])
        org.nodes["root"]["pending_switch"] = {
            "tier": "luna", "from": "opus", "by": "USER", "at": 0.0,
            "account": codex["id"]}
        self.supervisor._apply_pending_switch_locked(org, "sw-atomic", "root")
        node = org.node("root")
        self.assertEqual(node["model"], "luna")
        self.assertEqual(node["account"], codex["id"])
        logs = [e for e in org.d["events"] if e["op"] == "account_assign"]
        self.assertEqual(logs[0]["detail"]["via"], "switch_model")

    def test_veto_never_raises_even_on_internal_error(self):
        # the seam rule: a broken check must become a recorded drop, not a
        # raise into turn bookkeeping — force an internal error by pointing
        # the pending account at a corrupt registry file
        row = self._row()
        org = self._org("sw-broken", account=row["id"])
        org.nodes["root"]["pending_switch"] = {
            "tier": "luna", "from": "opus", "by": "USER", "at": 0.0,
            "account": "claude-999"}
        with open(self.registry.registry_path(), "w", encoding="utf-8") as f:
            f.write("{corrupt")
        try:
            changed = self.supervisor._apply_pending_switch_locked(
                org, "sw-broken", "root")
        finally:
            os.unlink(self.registry.registry_path())
        self.assertTrue(changed)
        self.assertEqual(org.node("root")["model"], "opus")


if __name__ == "__main__":
    unittest.main()
