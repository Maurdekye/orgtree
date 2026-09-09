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


    # S7: the profile-aware identity read and its endpoint logic — the
    # feasibility gate's AUTOMATED half (read-side behavior on synthetic
    # profile dirs; whether a REAL redirected login writes here stays an
    # explicitly unverified precondition until the live gate runs).

    def test_profile_identity_reads_redirected_config(self):
        from engine.backend.orgtree import accounts
        import json as _json
        prof = os.path.join(self.root, "ident-prof")
        os.makedirs(prof, exist_ok=True)
        with open(os.path.join(prof, ".claude.json"), "w",
                  encoding="utf-8") as f:
            _json.dump({"oauthAccount": {"accountUuid": "u-1",
                                         "emailAddress": "a@b.c"}}, f)
        self.assertEqual(accounts.profile_identity(prof),
                         {"uuid": "u-1", "email": "a@b.c"})
        # absent file reads as nobody, never a guess
        empty = os.path.join(self.root, "ident-empty")
        os.makedirs(empty, exist_ok=True)
        self.assertEqual(accounts.profile_identity(empty),
                         {"uuid": "", "email": ""})

    def test_identity_endpoint_updates_row_auth_from_observation(self):
        import asyncio
        import json as _json
        row = self._row()
        prof = row["credential"]["path"]
        os.makedirs(prof, exist_ok=True)
        # not signed in yet: endpoint observes and records unauthenticated
        out = asyncio.run(self.api.accounts_identity(row["id"]))
        self.assertEqual(out["auth"], "unauthenticated")
        self.assertEqual(
            self.registry.get_account(row["id"])["auth"], "unauthenticated")
        # a sign-in lands the config; the endpoint observes authenticated
        with open(os.path.join(prof, ".claude.json"), "w",
                  encoding="utf-8") as f:
            _json.dump({"oauthAccount": {"accountUuid": "u-9",
                                         "emailAddress": "x@y.z"}}, f)
        out2 = asyncio.run(self.api.accounts_identity(row["id"]))
        self.assertEqual(out2["auth"], "authenticated")
        fresh = self.registry.get_account(row["id"])
        self.assertEqual(fresh["identity"]["uuid"], "u-9")
        self.assertEqual(fresh["auth"], "authenticated")


    # S-usage: the per-account usage endpoint's ROUTING — every non-network
    # path (AG unsupported, org-key no-windows, claude profile without
    # credentials, codex non-ambient home). The claude-token and ambient
    # network reads are packaged-acceptance evidence, not unit territory.

    def test_usage_routing_non_network_paths(self):
        import asyncio
        ag = self.registry.create_account(
            "google", "ag", {"kind": "managed",
                             "path": os.path.join(self.root, "ag-u")})
        out = asyncio.run(self.api.accounts_usage(ag["id"]))
        self.assertFalse(out["available"])
        self.assertTrue(out["unsupported"])  # explicit, never fabricated
        okey = self.registry.create_account(
            "claude", "ok", {"kind": "token",
                             "token_ref": "org-api-key:u1"},
            origin_org="u1")
        out2 = asyncio.run(self.api.accounts_usage(okey["id"]))
        self.assertFalse(out2["available"])
        self.assertIn("API-key", out2["error"])
        prof = self.registry.create_account(
            "claude", "p", {"kind": "managed",
                            "path": os.path.join(self.root, "cl-u")})
        os.makedirs(os.path.join(self.root, "cl-u"), exist_ok=True)
        out3 = asyncio.run(self.api.accounts_usage(prof["id"]))
        self.assertFalse(out3["available"])  # no credentials file yet
        self.assertIn("credentials", out3["error"])
        cx = self.registry.create_account(
            "openai", "cx", {"kind": "managed",
                             "path": os.path.join(self.root, "cx-u")})
        out4 = asyncio.run(self.api.accounts_usage(cx["id"]))
        self.assertFalse(out4["available"])
        self.assertIn("app-server", out4["error"])
        # standing rides every answer
        for o in (out, out2, out3, out4):
            self.assertIn("standing", o)


if __name__ == "__main__":
    unittest.main()
