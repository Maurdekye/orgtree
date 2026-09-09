"""S5a reassignment: the shared binding validator (both doors inherit it),
the disclosure set, audit-log emission, and the refusals — org-scope,
provider-match, self-rebind shape, busy. The scope negative is asserted at
the VALIDATOR (the one implementation both surfaces call) and the
engine-level assign path; the HTTP doors are thin wrappers over these."""
import os
import tempfile
import time
import unittest


class AccountAssignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-assign-")
        os.environ["ORGTREE_DATA"] = cls.root
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

    def _row(self, provider="claude", org=None, kind="managed"):
        AccountAssignTests._seq += 1
        cred = ({"kind": kind,
                 "path": os.path.join(self.root, f"as-{self._seq}")}
                if kind != "token"
                else {"kind": "token",
                      "token_ref": f"org-api-key:{org or 'x'}"})
        return self.registry.create_account(provider, "t", cred,
                                            origin_org=org)

    def _org(self, slug, model="opus", account=None):
        org = self.ledger.Org.create(slug)
        org.nodes["root"] = {"state": "live", "parent": None,
                             "generation": 1, "model": model}
        if account:
            org.nodes["root"]["account"] = account
        self.store.save_org(org)
        return org

    # ------------------------------------------------------------- validator
    def test_org_scope_refused_for_foreign_org_and_allowed_at_origin(self):
        keyrow = self._row(org="alpha", kind="token")
        with self.assertRaises(self.registry.BindingRefused) as ctx:
            self.registry.validate_binding("beta", "opus", keyrow["id"])
        self.assertIn("alpha", str(ctx.exception))  # names the origin scope
        self.assertEqual(
            self.registry.validate_binding("alpha", "opus",
                                           keyrow["id"])["id"],
            keyrow["id"])

    def test_provider_mismatch_refused_naming_both_sides(self):
        codex_row = self._row(provider="openai")
        with self.assertRaises(self.registry.BindingRefused) as ctx:
            self.registry.validate_binding("any", "opus", codex_row["id"])
        msg = str(ctx.exception)
        self.assertIn("openai", msg)
        self.assertIn("claude", msg)

    def test_openrouter_tier_and_unknown_account_refused(self):
        row = self._row()
        with self.assertRaises(self.registry.BindingRefused):
            self.registry.validate_binding("any", "or-foo/bar", row["id"])
        with self.assertRaises(self.registry.BindingRefused):
            self.registry.validate_binding("any", "opus", "ghost-1")

    # ------------------------------------------------------ assign + disclosure
    def test_assign_writes_binding_discloses_and_logs(self):
        row = self._row()
        self._org("as-happy")
        out = self.supervisor.assign_account("as-happy", "root", row["id"],
                                             actor="USER")
        self.assertEqual(out["account"], row["id"])
        self.assertEqual(out["billing_mode"], "subscription")
        self.assertEqual(out["standing"], {"state": "ready"})
        self.assertIn("continuity", out)
        org = self.store.load_org("as-happy")
        self.assertEqual(org.node("root")["account"], row["id"])
        evs = [e for e in org.d["events"] if e["op"] == "account_assign"]
        self.assertEqual(len(evs), 1)  # the user-readable record (D2d)
        self.assertEqual(evs[0]["detail"]["account"], row["id"])

    def test_assign_to_marked_account_names_the_wait_with_provenance(self):
        row = self._row()
        self.registry.record_mark(row["id"], "sonnet",
                                  until=time.time() + 3600.0)
        self._org("as-wait", model="fable")
        out = self.supervisor.assign_account("as-wait", "root", row["id"],
                                             actor="USER")
        self.assertEqual(out["standing"]["state"], "limited")
        self.assertEqual(out["standing"]["provenance"], "inferred")

    def test_org_key_binding_discloses_api_billing(self):
        keyrow = self._row(org="as-key", kind="token")
        self._org("as-key")
        out = self.supervisor.assign_account("as-key", "root", keyrow["id"],
                                             actor="USER")
        self.assertEqual(out["billing_mode"], "api-key")

    def test_engine_path_enforces_scope_too(self):
        # the operator door has no separate filter to get wrong: the shared
        # validator fires inside assign_account itself
        keyrow = self._row(org="elsewhere", kind="token")
        self._org("as-scope")
        with self.assertRaises(self.registry.BindingRefused):
            self.supervisor.assign_account("as-scope", "root", keyrow["id"],
                                           actor="USER")

    def test_busy_node_refused_session_boundary(self):
        row = self._row()
        self._org("as-busy")
        st = self.supervisor.state("as-busy", "root")
        st["busy"] = True
        try:
            with self.assertRaises(RuntimeError):
                self.supervisor.assign_account("as-busy", "root", row["id"],
                                               actor="USER")
        finally:
            st["busy"] = False

    def test_caller_owned_org_is_not_saved_by_assign(self):
        # the dispatch-transaction shape: with org= passed, assign mutates
        # the CALLER's object and the caller owns persistence — a fresh
        # load must NOT yet see the binding
        row = self._row()
        org = self._org("as-txn")
        self.supervisor.assign_account("as-txn", "root", row["id"],
                                       actor="child", org=org)
        self.assertEqual(org.node("root")["account"], row["id"])
        fresh = self.store.load_org("as-txn")
        self.assertNotEqual(fresh.node("root").get("account"), row["id"])


if __name__ == "__main__":
    unittest.main()
