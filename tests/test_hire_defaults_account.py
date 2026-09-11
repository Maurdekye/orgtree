"""Tests for hire defaults provider account configuration and new hire inheritance."""
import os
import tempfile
import unittest


class HireDefaultsAccountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-hire-defaults-")
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
        HireDefaultsAccountTests._seq += 1
        cred = ({"kind": kind,
                 "path": os.path.join(self.root, f"hd-{self._seq}")}
                if kind != "token"
                else {"kind": "token",
                      "token_ref": f"org-api-key:{org or 'x'}"})
        return self.registry.create_account(provider, f"{provider}-{self._seq}",
                                            cred, origin_org=org)

    def test_set_hire_defaults_account_persists_and_reflects_in_tree(self):
        row = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-1")
        res = org.set_hire_defaults(default_account=row["id"])
        self.assertEqual(res.get("default_account"), row["id"])
        self.assertEqual(org.d.get("default_account"), row["id"])
        tree = org.tree()
        self.assertEqual(tree.get("default_account"), row["id"])

        # Unset / clear default_account
        res_clear = org.set_hire_defaults(default_account="")
        self.assertIsNone(res_clear.get("default_account"))
        self.assertIsNone(org.d.get("default_account"))
        self.assertIsNone(org.tree().get("default_account"))

    def test_new_hire_inherits_compatible_default_account(self):
        row = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-2")
        org.set_hire_defaults(default_account=row["id"])
        hire_res = org.hire(self.ledger.USER, None, "opus", 10, "claude-worker")
        nid = hire_res["node"]
        self.assertEqual(org.nodes[nid].get("account"), row["id"])
        tree_node = [n for n in org.tree()["roots"] if n["id"] == nid][0]
        self.assertEqual(tree_node.get("account"), row["id"])

    def test_new_hire_incompatible_tier_safely_falls_back_to_unbound(self):
        row = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-3")
        org.set_hire_defaults(default_account=row["id"])
        # Luna is codex (openai), which cannot bind a claude account
        hire_res = org.hire(self.ledger.USER, None, "luna", 10, "codex-worker")
        nid = hire_res["node"]
        self.assertIsNone(org.nodes[nid].get("account"))
        tree_node = [n for n in org.tree()["roots"] if n["id"] == nid][0]
        self.assertIsNone(tree_node.get("account"))

    def test_explicit_account_in_hire_overrides_default_account(self):
        row_def = self._row(provider="claude")
        row_exp = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-4")
        org.set_hire_defaults(default_account=row_def["id"])
        hire_res = org.hire(self.ledger.USER, None, "opus", 10, "custom-worker",
                            account=row_exp["id"])
        nid = hire_res["node"]
        self.assertEqual(org.nodes[nid].get("account"), row_exp["id"])

    def test_explicit_incompatible_account_in_hire_raises_ledger_error(self):
        row_claude = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-5")
        with self.assertRaises(self.ledger.LedgerError):
            org.hire(self.ledger.USER, None, "luna", 10, "bad-worker",
                     account=row_claude["id"])

    def test_explicit_empty_account_stays_unbound_despite_default_account(self):
        row = self._row(provider="claude")
        org = self.ledger.Org.create("test-org-6")
        org.set_hire_defaults(default_account=row["id"])
        hire_res = org.hire(self.ledger.USER, None, "opus", 10, "unbound-worker",
                            account="")
        nid = hire_res["node"]
        self.assertIsNone(org.nodes[nid].get("account"))
        tree_node = [n for n in org.tree()["roots"] if n["id"] == nid][0]
        self.assertIsNone(tree_node.get("account"))

    def test_explicit_nonexistent_account_raises_ledger_error(self):
        org = self.ledger.Org.create("test-org-7")
        with self.assertRaises(self.ledger.LedgerError):
            org.hire(self.ledger.USER, None, "opus", 10, "missing-worker",
                     account="non-existent-account-id")


if __name__ == "__main__":
    unittest.main()
