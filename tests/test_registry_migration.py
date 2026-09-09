"""S2 migration: ambient rows, evidence-based org keys, universal bindings.

Every check can fail: the held case has data-mutation negatives beside it,
the inert declaration is asserted as a STATEMENT (not an empty pass), and the
unconditional/conditional split goes through the same doc fields spawn_env
actually reads (api_key / api_fallback).
"""
import os
import tempfile
import unittest


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-migration-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import registry, registry_migration, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.registry = registry
        cls.migration = registry_migration

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        self.claude_dir = os.path.join(self.root, "claude-prof")
        os.makedirs(self.claude_dir, exist_ok=True)

    def _ambient(self, claude=True, openai=False):
        codex_dir = os.path.join(self.root, "codex-prof")
        if openai:
            os.makedirs(codex_dir, exist_ok=True)
        return {"claude": self.claude_dir if claude else None,
                "openai": codex_dir if openai else None, "google": None}

    def _org(self, slug, nodes, **extra):
        doc = {"slug": slug, "nodes": nodes}
        doc.update(extra)
        return doc

    def test_ambient_rows_alias_and_universal_bindings(self):
        org = self._org("alpha", {
            "a": {"model": "fable"}, "b": {"model": "luna"}})
        report = self.migration.run_migration([org], self._ambient(openai=True))
        self.assertFalse(report["inert"])
        self.assertIn("claude", report["ambient_rows"])
        self.assertEqual(self.registry.resolve_alias("primary"),
                         report["ambient_rows"]["claude"])
        self.assertEqual(org["nodes"]["a"]["account"],
                         report["ambient_rows"]["claude"])
        self.assertEqual(org["nodes"]["b"]["account"],
                         report["ambient_rows"]["openai"])
        self.assertEqual(report["changed_orgs"], ["alpha"])
        self.assertEqual(report["bound_nodes"], 2)

    def test_missing_provider_parks_named_and_reported(self):
        org = self._org("beta", {"c": {"model": "luna"}})
        report = self.migration.run_migration([org], self._ambient(openai=False))
        self.assertEqual(org["nodes"]["c"]["account"], "missing:openai")
        self.assertEqual(report["missing_bindings"], ["beta/c"])

    def test_unconditional_org_key_binds_conditional_is_held(self):
        uncond = self._org("keyed", {"n": {"model": "opus"}},
                           api_key="k")
        cond = self._org("spare", {"m": {"model": "opus"}},
                         api_key="k", api_fallback=True)
        report = self.migration.run_migration(
            [uncond, cond], self._ambient())
        row_id = report["org_key_rows"]["keyed"]
        self.assertEqual(uncond["nodes"]["n"]["account"], row_id)
        # the org-key row is scoped to its origin org
        row = self.registry.get_account(row_id)
        self.assertEqual(row["origin_org"], "keyed")
        # conditional: HELD — no row minted, node binds to its normal ambient
        # lane, and the org is documented for a decision
        self.assertEqual(report["org_key_held"], ["spare"])
        self.assertNotIn("spare", report["org_key_rows"])
        self.assertEqual(cond["nodes"]["m"]["account"],
                         report["ambient_rows"]["claude"])

    def test_sandboxed_and_openrouter_are_declared_exemptions(self):
        sandboxed = self._org("boxed", {"s": {"model": "opus"}},
                              sandbox={"image": "x"})
        orr = self._org("routed", {"r": {"model": "or-foo/bar"}})
        report = self.migration.run_migration(
            [sandboxed, orr], self._ambient())
        self.assertEqual(report["skipped_sandboxed"], ["boxed"])
        self.assertNotIn("account", sandboxed["nodes"]["s"])
        self.assertEqual(report["skipped_openrouter"], ["routed/r"])
        self.assertNotIn("account", orr["nodes"]["r"])

    def test_legacy_key_rows_become_token_rows(self):
        # accounts.py WRITES are disabled in desktop MVP, so a legacy key file
        # only ever arrives from a V1 import — simulate exactly that: the file
        # on disk, not a mutation through the disabled writer.
        import json
        from engine.backend.orgtree import accounts
        # accounts.load() answers BLANK whenever ORGTREE_DESKTOP_MANAGED=1
        # (the desktop MVP guard) — a desktop-managed backend therefore never
        # sees V1-imported key files, and this fixture must clear the flag to
        # exercise the non-managed read path it is testing.
        managed = os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
        doc = accounts._blank()
        doc["keys"] = [{"id": "abcd1234", "account_uuid": "abcd1234"}]
        with open(accounts.registry_path(), "w", encoding="utf-8") as f:
            json.dump(doc, f)
        try:
            report = self.migration.run_migration([], self._ambient())
            self.assertEqual(len(report["key_rows"]), 1)
            row = self.registry.get_account(report["key_rows"][0])
            self.assertEqual(row["credential"],
                             {"kind": "token", "token_ref": "abcd1234"})
        finally:
            os.unlink(accounts.registry_path())
            if managed is not None:
                os.environ["ORGTREE_DESKTOP_MANAGED"] = managed

    def test_inert_declares_itself_and_second_run_is_noop(self):
        report = self.migration.run_migration([], {"claude": None,
                                                   "openai": None,
                                                   "google": None})
        self.assertTrue(report["inert"])
        self.assertIn("reason", report)  # a statement, not an empty pass
        again = self.migration.run_migration([], self._ambient())
        self.assertTrue(again["inert"])
        self.assertEqual(again["reason"], "already migrated")
        # and the second run minted nothing despite an ambient login existing
        self.assertEqual(self.registry.list_accounts(), [])

    def test_existing_binding_never_overwritten(self):
        org = self._org("bound", {"n": {"model": "opus",
                                        "account": "claude-77"}})
        self.migration.run_migration([org], self._ambient())
        self.assertEqual(org["nodes"]["n"]["account"], "claude-77")


    def test_startup_adapter_gated_and_persists_only_changed(self):
        import json
        from engine.backend.orgtree import ledger, store
        # gate closed: nothing runs, nothing is written
        os.environ.pop(self.migration.CUTOVER_ENV, None)
        self.assertIsNone(self.migration.run_startup_migration())
        # gate open: real org docs migrate and persist; report file lands
        org = ledger.Org.create("cutover-org")
        org.nodes["n"] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus"}
        store.save_org(org)
        os.environ[self.migration.CUTOVER_ENV] = "1"
        try:
            report = self.migration.run_startup_migration()
        finally:
            os.environ.pop(self.migration.CUTOVER_ENV, None)
        self.assertIsNotNone(report)
        fresh = store.load_org("cutover-org")
        acct = str(fresh.node("n").get("account") or "")
        self.assertTrue(acct)  # bound (ambient claude row or named park)
        with open(os.path.join(store.DATA_ROOT,
                               self.migration.REPORT_NAME),
                  encoding="utf-8") as f:
            self.assertEqual(json.load(f)["bound_nodes"],
                             report["bound_nodes"])
        # second start with the flag still set: idempotent no-op
        os.environ[self.migration.CUTOVER_ENV] = "1"
        try:
            again = self.migration.run_startup_migration()
        finally:
            os.environ.pop(self.migration.CUTOVER_ENV, None)
        self.assertTrue(again["inert"])


if __name__ == "__main__":
    unittest.main()
