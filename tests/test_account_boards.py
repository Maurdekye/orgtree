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

    # Route-table truth (user defect 2026-09-10, "Create managed does
    # nothing"): handler-level calls CANNOT catch a path registered twice —
    # the legacy readout shadowed the registry list on GET /api/accounts, so
    # creation succeeded while the section never saw a row. These go through
    # the REAL router, exactly like the renderer.

    def test_create_managed_is_visible_through_the_real_router(self):
        from fastapi.testclient import TestClient
        client = TestClient(self.api.app, raise_server_exceptions=False)
        made = client.post("/api/accounts",
                           json={"provider": "claude", "kind": "managed"})
        self.assertEqual(made.status_code, 200, made.text)
        row = made.json()
        self.assertTrue(row["credential"]["path"])         # profile minted
        listed = client.get("/api/accounts")
        self.assertEqual(listed.status_code, 200, listed.text)
        payload = listed.json()
        # the REGISTRY shape — the legacy readout has no "accounts" array,
        # which is precisely what the shadowed route used to answer here
        self.assertIn("accounts", payload)
        self.assertIn(row["id"], [r["id"] for r in payload["accounts"]])
        # the org-filtered form the placement picker uses rides the same path
        filtered = client.get("/api/accounts?org=any-org")
        self.assertIn("accounts", filtered.json())
        # and the legacy readout remains served, at its own path
        legacy = client.get("/api/accounts/readout")
        self.assertEqual(legacy.status_code, 200)
        self.assertIn("assignments", legacy.json())
        self.assertNotIn("accounts", legacy.json())

    def test_usage_routing_non_network_paths(self):
        import asyncio
        ag = self.registry.create_account(
            "google", "ag", {"kind": "managed",
                             "path": os.path.join(self.root, "ag-u")})
        out = asyncio.run(self.api.accounts_usage(ag["id"]))
        self.assertFalse(out["available"])
        self.assertTrue(out["unsupported"])  # explicit, never fabricated
        okey = self.registry.create_account(
            "claude", "ok", {"kind": "apikey", "token_ref": "tok-u1"},
            mode="apikey")
        out2 = asyncio.run(self.api.accounts_usage(okey["id"]))
        # the metered-key branch answers early, fetch-free, in local USD
        self.assertTrue(out2["available"])
        self.assertEqual(out2["mode"], "apikey")
        self.assertEqual(out2["currency"], "USD")
        prof = self.registry.create_account(
            "claude", "p", {"kind": "managed",
                            "path": os.path.join(self.root, "cl-u")})
        os.makedirs(os.path.join(self.root, "cl-u"), exist_ok=True)
        out3 = asyncio.run(self.api.accounts_usage(prof["id"]))
        self.assertFalse(out3["available"])  # no credentials file yet
        # user ruling 2026-09-11: `error` is the sentence a PERSON reads and
        # the technical line moved to `detail`. This row has no credentials
        # file at all, which is a local observation and a real sign-in
        # problem — so it says so, and says which kind of evidence it had.
        self.assertIn("sign", out3["error"].lower())
        self.assertIn("credentials", out3["detail"])
        self.assertTrue(out3["reauth_required"])
        self.assertEqual(out3["reauth_evidence"], "not_connected")
        cx = self.registry.create_account(
            "openai", "cx", {"kind": "managed",
                             "path": os.path.join(self.root, "cx-u")})
        from unittest.mock import patch
        from engine.backend.orgtree import codex_limits
        with patch.object(codex_limits, "fetch_for_home", return_value={
                "available": False, "error": "fixture app-server unavailable"}) as fetch:
            out4 = asyncio.run(self.api.accounts_usage(cx["id"]))
        fetch.assert_called_once_with(cx["credential"]["path"], "acct:" + cx["id"])
        self.assertFalse(out4["available"])
        self.assertIn("app-server", out4["error"])
        # standing rides every answer
        for o in (out, out2, out3, out4):
            self.assertIn("standing", o)


    def test_default_and_redirected_identity_never_borrow_each_others_metadata(self):
        import asyncio, json
        from pathlib import Path
        home = Path(self.root) / "default-identity"
        profile = home / ".claude"
        profile.mkdir(parents=True, exist_ok=True)
        (home / ".claude.json").write_text(json.dumps({"oauthAccount": {
            "accountUuid": "default-id", "emailAddress": "default@example.test"}}), encoding="utf-8")
        default = self.registry.create_account("claude", "default", {
            "kind": "imported", "path": str(profile), "default_config": True})
        redirected = self.registry.create_account("claude", "redirected", {
            "kind": "imported", "path": str(profile)})
        actual = asyncio.run(self.api.accounts_identity(default["id"]))
        self.assertEqual(actual["identity"]["uuid"], "default-id")
        self.assertEqual(asyncio.run(self.api.accounts_identity(redirected["id"]))["auth"], "unauthenticated")
        (profile / ".claude.json").write_text(json.dumps({"oauthAccount": {
            "accountUuid": "redirected-id"}}), encoding="utf-8")
        self.assertEqual(asyncio.run(self.api.accounts_identity(redirected["id"]))["identity"]["uuid"], "redirected-id")
        self.assertEqual(asyncio.run(self.api.accounts_identity(default["id"]))["identity"]["uuid"], "default-id")


    def test_importing_default_claude_profile_keeps_its_selector(self):
        import asyncio
        from unittest.mock import patch
        from engine.backend.orgtree import registry_migration
        profile = os.path.join(self.root, "import-default", ".claude")
        os.makedirs(profile, exist_ok=True)
        with patch.object(registry_migration, "_claude_default_config", return_value=True):
            row = asyncio.run(self.api.accounts_create(self.api.AccountCreate(
                provider="claude", kind="imported", path=profile)))
        self.assertTrue(row["credential"]["default_config"])
        with patch.object(registry_migration, "_claude_default_config", return_value=False):
            redirected = asyncio.run(self.api.accounts_create(self.api.AccountCreate(
                provider="claude", kind="imported", path=profile)))
        self.assertNotIn("default_config", redirected["credential"])


if __name__ == "__main__":
    unittest.main()
