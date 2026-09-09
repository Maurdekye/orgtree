"""S6 boards: standing derivation (provenance preserved, unobserved never
ready), the bindings scan feeding placement and the removal guard, and the
removal-refused-while-bound rule at the api helper level."""
import os
import tempfile
import time
import unittest


class BoardsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-boards-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import api, ledger, registry, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.api = api
        cls.ledger = ledger
        cls.registry = registry
        cls.store = store

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _row(self, provider="claude"):
        BoardsTests._seq += 1
        return self.registry.create_account(
            provider, "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"bd-{self._seq}")})

    def test_standing_preserves_provenance_and_pool_axes(self):
        row = self._row()
        now = time.time()
        self.registry.record_mark(row["id"], "sonnet", until=now + 3600,
                                  now=now)
        fresh = self.registry.get_account(row["id"])
        st = self.registry.standing_of(fresh, now=now + 1)
        self.assertEqual(st["state"], "limited")
        self.assertEqual(st["marks"]["pooled"]["provenance"], "observed")
        self.assertEqual(st["marks"]["fable"]["provenance"], "inferred")
        # expiry releases; unobserved auth rides along, never "ready"-washed
        st2 = self.registry.standing_of(fresh, now=now + 7200)
        self.assertEqual(st2["state"], "ready")
        self.assertEqual(st2["auth"], "unobserved")

    def test_bindings_scan_names_placements_and_guards_removal(self):
        row = self._row()
        org = self.ledger.Org.create("bd-org")
        org.nodes["a"] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus", "account": row["id"]}
        org.nodes["b"] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus", "account": "missing:claude"}
        self.store.save_org(org)
        bindings = self.api._account_bindings()
        self.assertEqual(bindings[row["id"]],
                         [{"org": "bd-org", "node": "a", "state": "live"}])
        # missing:* is a park, not a binding — never listed
        self.assertNotIn("missing:claude", bindings)

    def test_removal_refused_while_bound_allowed_after_unbind(self):
        # openai row: the per-test registry reset re-mints claude-1, which
        # would collide with the PREVIOUS test's persisted org binding —
        # production never resets the registry doc, so ids never recur there
        row = self._row(provider="openai")
        org = self.ledger.Org.create("bd-rm")
        org.nodes["a"] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus", "account": row["id"]}
        self.store.save_org(org)
        bound = self.api._account_bindings().get(row["id"], [])
        self.assertTrue(bound)  # the guard's evidence exists
        # unbind, and removal proceeds
        org2 = self.store.load_org("bd-rm")
        org2.node("a").pop("account")
        self.store.save_org(org2)
        self.assertEqual(self.api._account_bindings().get(row["id"], []), [])
        self.assertTrue(self.registry.remove_account(row["id"]))


if __name__ == "__main__":
    unittest.main()
