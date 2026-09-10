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

    def test_ambient_claude_default_config_marking(self):
        # Measured CLI semantics (root 2026-09-10): unset selector writes
        # HOME/.claude.json, so the unredirected machine login is a
        # default-config row; an explicit CLAUDE_CONFIG_DIR — EVEN AT THE
        # SAME PATH — stays redirected. Asserted at the MINT boundary: the
        # registry-side persistence of the field is root's half of the
        # split (credential validation), not migration's.
        from unittest.mock import patch
        home = os.path.join(self.root, "home")
        default_dir = os.path.join(home, ".claude")
        os.makedirs(default_dir, exist_ok=True)
        minted = []
        real_create = self.registry.create_account

        def recording(provider, label, credential, **kw):
            minted.append((provider, dict(credential)))
            return real_create(provider, label, credential, **kw)

        def run(claude_path):
            minted.clear()
            path = self.registry.registry_path()
            if os.path.exists(path):
                os.unlink(path)
            with patch.object(self.registry, "create_account", recording):
                self.migration.run_migration(
                    [], {"claude": claude_path, "openai": None,
                         "google": None})
            [cred] = [c for p, c in minted if p == "claude"]
            return cred

        env = {"USERPROFILE": home, "HOME": home}
        # unset selector + canonical default path → default_config rides
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
            self.assertIs(run(default_dir).get("default_config"), True)
            # unset selector but a NON-default path: redirected, no flag
            self.assertNotIn("default_config", run(self.claude_dir))
        # explicit selector at the SAME path: still redirected, no flag
        with patch.dict(os.environ, dict(env, CLAUDE_CONFIG_DIR=default_dir),
                        clear=False):
            self.assertNotIn("default_config", run(default_dir))

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

    def test_inert_declares_itself_and_completion_blocks_reruns(self):
        report = self.migration.run_migration([], {"claude": None,
                                                   "openai": None,
                                                   "google": None})
        self.assertTrue(report["inert"])
        self.assertIn("reason", report)  # a statement, not an empty pass
        # the ENGINE never marks completion (that is the caller's, after
        # persists succeed) — so nothing is marked yet
        self.assertFalse(self.registry.load().get("migrated_at"))
        # once the caller marks it, a rerun is a declared no-op that mints
        # nothing despite an ambient login existing
        self.migration.mark_migrated()
        again = self.migration.run_migration([], self._ambient())
        self.assertTrue(again["inert"])
        self.assertEqual(again["reason"], "already migrated")
        self.assertEqual(self.registry.list_accounts(), [])

    def test_existing_binding_never_overwritten(self):
        org = self._org("bound", {"n": {"model": "opus",
                                        "account": "claude-77"}})
        self.migration.run_migration([org], self._ambient())
        self.assertEqual(org["nodes"]["n"]["account"], "claude-77")

    def test_engine_rerun_reuses_rows_by_evidence(self):
        # a rerun (the resume after a partial startup failure) must return
        # the rows the first attempt minted — path evidence for imported
        # ambient rows, token_ref evidence for org-key rows — so bindings
        # written by the first attempt keep pointing at live ids
        first = self._org("keyed", {"n": {"model": "opus"}}, api_key="k")
        r1 = self.migration.run_migration([first], self._ambient(openai=True))
        minted = {row["id"] for row in self.registry.list_accounts()}
        # same fleet again, bindings not yet persisted: a fresh unbound doc
        second = self._org("keyed", {"n": {"model": "opus"}}, api_key="k")
        r2 = self.migration.run_migration([second], self._ambient(openai=True))
        self.assertEqual(r2["ambient_rows"], r1["ambient_rows"])
        self.assertEqual(r2["org_key_rows"], r1["org_key_rows"])
        self.assertEqual(second["nodes"]["n"]["account"],
                         first["nodes"]["n"]["account"])
        # and NO duplicate was minted for any credential
        self.assertEqual({row["id"] for row in self.registry.list_accounts()},
                         minted)


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


    # Injected-failure resumability (coordinator directive 2026-09-10): a
    # partial org-save failure must HOLD completion truthfully and the next
    # startup must finish the remainder — same account ids, no duplicates,
    # no lost bindings — never skip a half-migrated fleet as already done.

    def _stored_org(self, slug):
        from engine.backend.orgtree import ledger, store
        org = ledger.Org.create(slug)
        org.nodes["n"] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus"}
        store.save_org(org)

    def test_partial_save_failure_holds_completion_and_rerun_finishes(self):
        import json
        from unittest.mock import patch
        from engine.backend.orgtree import store
        self._stored_org("m-one")
        self._stored_org("m-two")
        real_save = store.save_org

        def failing_save(org):
            if str(org.d.get("slug") or "") == "m-two":
                raise OSError("disk full (injected)")
            return real_save(org)

        os.environ[self.migration.CUTOVER_ENV] = "1"
        try:
            with patch.object(store, "save_org", failing_save):
                with self.assertRaises(
                        self.migration.MigrationIncomplete) as ctx:
                    self.migration.run_startup_migration()
            # truthful partial state: completion HELD, the failure named,
            # the org that could save did save
            self.assertFalse(self.registry.load().get("migrated_at"))
            rep = ctx.exception.report
            self.assertFalse(rep["completed"])
            self.assertEqual(rep["saved_orgs"], ["m-one"])
            self.assertIn("disk full (injected)", rep["save_failures"]["m-two"])
            one = store.load_org("m-one").node("n").get("account")
            self.assertTrue(one)                       # persisted binding
            self.assertFalse(
                store.load_org("m-two").node("n").get("account"))
            # the on-disk report also says INCOMPLETE, not success
            with open(os.path.join(store.DATA_ROOT,
                                   self.migration.REPORT_NAME),
                      encoding="utf-8") as f:
                self.assertFalse(json.load(f)["completed"])
            minted = {row["id"] for row in self.registry.list_accounts()}
            # rerun without the injected failure: finishes the REMAINDER
            report2 = self.migration.run_startup_migration()
            self.assertTrue(report2["completed"])
            self.assertEqual(report2["save_failures"], {})
            self.assertEqual(report2["saved_orgs"], ["m-two"])
            # no duplicate accounts, no lost or diverging bindings
            self.assertEqual(
                {row["id"] for row in self.registry.list_accounts()}, minted)
            self.assertEqual(store.load_org("m-one").node("n").get("account"),
                             one)
            self.assertEqual(store.load_org("m-two").node("n").get("account"),
                             one)
            self.assertTrue(self.registry.load().get("migrated_at"))
            # and only NOW is a further startup the declared no-op
            self.assertEqual(self.migration.run_startup_migration()["reason"],
                             "already migrated")
        finally:
            os.environ.pop(self.migration.CUTOVER_ENV, None)

    def test_report_write_failure_holds_completion(self):
        from engine.backend.orgtree import store
        self._stored_org("rw-org")
        # inject the failure at the FILESYSTEM, not by patching the writer:
        # a directory squatting on the report path makes open(..., "w")
        # raise, so a writer that swallowed its own OSError would pass a
        # mutated run — this way the test kills that mutation
        rp = os.path.join(store.DATA_ROOT, self.migration.REPORT_NAME)
        if os.path.isfile(rp):
            os.unlink(rp)               # a prior test's real report
        os.makedirs(rp, exist_ok=True)
        os.environ[self.migration.CUTOVER_ENV] = "1"
        try:
            with self.assertRaises(self.migration.MigrationIncomplete):
                self.migration.run_startup_migration()
            os.rmdir(rp)
            # report state is part of completion: marker held, though the
            # org saves themselves landed
            self.assertFalse(self.registry.load().get("migrated_at"))
            self.assertTrue(store.load_org("rw-org").node("n").get("account"))
            # rerun with a working report writer: completes and marks
            report = self.migration.run_startup_migration()
            self.assertTrue(report["completed"])
            self.assertTrue(self.registry.load().get("migrated_at"))
        finally:
            os.environ.pop(self.migration.CUTOVER_ENV, None)


if __name__ == "__main__":
    unittest.main()
