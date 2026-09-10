"""GET /api/accounts `ambient` flag: which registry rows the usage modal's
host provider lanes already serve (user report 2026-09-10 — the modal omitted
a signed-in secondary account because it had no way to list registry rows
without double-rendering the host boards).

The flag must mirror how `accounts_usage` actually routes: claude covered
iff the row IS the `primary` alias, openai/google covered iff the row's
profile directory IS the ambient home — and a token row is never covered.
Both polarities are asserted for every rule, so a flag that answered a
constant could not pass.
"""
import asyncio
import os
import tempfile
import unittest


class AccountListAmbientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-ambientflag-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import api, registry, registry_migration, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.api = api
        cls.registry = registry
        cls.migration = registry_migration

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        self._real_observe = self.migration.observe_ambient

    def tearDown(self):
        self.migration.observe_ambient = self._real_observe

    def _list(self, ambient_paths):
        self.migration.observe_ambient = lambda: dict(ambient_paths)
        return asyncio.run(self.api.accounts_list())

    def _alias_primary(self, account_id):
        doc = self.registry.load(strict=True)
        doc["aliases"]["primary"] = account_id
        self.registry.save(doc)

    def test_primary_claude_row_is_covered_secondary_is_not(self):
        host = self.registry.create_account(
            "claude", "machine login",
            {"kind": "imported", "path": os.path.join(self.root, "host")})
        second = self.registry.create_account(
            "claude", "claude-0",
            {"kind": "managed", "path": os.path.join(self.root, "second")})
        self._alias_primary(host["id"])
        rows = {r["id"]: r for r in self._list(
            {"claude": None, "openai": None, "google": None})["accounts"]}
        self.assertTrue(rows[host["id"]]["ambient"])
        # the defect's exact shape: the secondary must stand as its OWN row
        self.assertFalse(rows[second["id"]]["ambient"])

    def test_no_primary_alias_covers_no_claude_row(self):
        row = self.registry.create_account(
            "claude", "t",
            {"kind": "imported", "path": os.path.join(self.root, "host")})
        rows = self._list(
            {"claude": None, "openai": None, "google": None})["accounts"]
        self.assertFalse(rows[0]["ambient"])
        self.assertEqual(rows[0]["id"], row["id"])

    def test_openai_covered_by_path_identity_not_by_provider(self):
        home = os.path.join(self.root, "codex-home")
        ambient_row = self.registry.create_account(
            "openai", "machine codex", {"kind": "imported", "path": home})
        other = self.registry.create_account(
            "openai", "second codex",
            {"kind": "managed", "path": os.path.join(self.root, "codex-2")})
        # the compare is canonical: a differently-cased, unnormalized spelling
        # of the same directory still covers
        rows = {r["id"]: r for r in self._list(
            {"claude": None, "google": None,
             "openai": home.upper() + os.sep})["accounts"]}
        self.assertTrue(rows[ambient_row["id"]]["ambient"])
        self.assertFalse(rows[other["id"]]["ambient"])

    def test_token_rows_are_never_covered(self):
        row = self.registry.create_account(
            "claude", "key row", {"kind": "token", "token_ref": "row1"})
        # even if a stale alias points at the token row, the claude rule is
        # the primary alias — assert the non-alias case here
        rows = self._list({"claude": os.path.join(self.root, "host"),
                           "openai": None, "google": None})["accounts"]
        self.assertEqual(rows[0]["id"], row["id"])
        self.assertFalse(rows[0]["ambient"])

    def test_codex_email_comes_from_own_profile_and_tracks_signin_changes(self):
        import base64
        import json
        from pathlib import Path
        from unittest.mock import patch
        host = Path(tempfile.mkdtemp(dir=self.root))
        other = Path(tempfile.mkdtemp(dir=self.root))
        def signin(home, email):
            payload = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).decode().rstrip("=")
            (home / "auth.json").write_text(json.dumps({"tokens": {
                "id_token": "header." + payload + ".signature",
                "access_token": "secret-must-not-be-returned"}}))
        signin(host, "host@example.test")
        signin(other, "secondary@example.test")
        row = self.registry.create_account("openai", "second",
            {"kind": "managed", "path": str(other)})
        self.registry.set_identity(row["id"], {"account_digest": "digest", "email": "old@example.test"})
        with patch.dict(os.environ, {"CODEX_HOME": str(host)}):
            data = self._list({"openai": str(host)})
            self.assertEqual(data["accounts"][0]["identity"]["email"], "secondary@example.test")
            self.assertNotIn("secret-must-not-be-returned", json.dumps(data))
            # The read projection must not rewrite stored routing/auth identity.
            self.assertEqual(self.registry.get_account(row["id"])["identity"]["email"], "old@example.test")
            signin(other, "changed@example.test")
            self.assertEqual(self._list({})["accounts"][0]["identity"]["email"], "changed@example.test")
            (other / "auth.json").write_text('{broken')
            self.assertNotIn("email", self._list({})["accounts"][0]["identity"])
            (other / "auth.json").unlink()
            self.assertNotIn("email", self._list({})["accounts"][0]["identity"])

    def test_codex_identity_refresh_keeps_profile_email(self):
        from unittest.mock import patch
        from engine.backend.orgtree import providers
        row = self.registry.create_account("openai", "second",
            {"kind": "managed", "path": os.path.join(self.root, "refresh-home")})
        with patch.object(self.api.supervisor, "_cache_codex_account_namespace", return_value=("digest", "subscription")), \
             patch.object(providers, "_codex_account", return_value={"email": "second@example.test"}) as read:
            data = asyncio.run(self.api.accounts_identity(row["id"]))
        read.assert_called_once_with(row["credential"]["path"])
        self.assertEqual(data["identity"]["email"], "second@example.test")
        self.assertEqual(data["identity"]["account_digest"], "digest")
        self.assertEqual(data["auth"], "authenticated")

    def test_every_row_carries_the_flag(self):
        self.registry.create_account(
            "google", "agy", {"kind": "managed",
                              "path": os.path.join(self.root, "agy")})
        rows = self._list(
            {"claude": None, "openai": None, "google": None})["accounts"]
        for r in rows:
            self.assertIn("ambient", r)
            self.assertIn("standing", r)


if __name__ == "__main__":
    unittest.main()
