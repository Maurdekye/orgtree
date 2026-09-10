"""S3a spawn/identity seam: single injector, strip extension, cross-checked
attribution. The divergence negatives assert at BOTH layers separately per
the design sketch (a check passing through whichever layer happens to exist
cannot tell you the other one is present)."""
import os
import tempfile
import unittest


class SpawnIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-spawnident-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import registry, store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.registry = registry
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _profile_row(self, provider="claude"):
        # unique path per row: two rows sharing a dir would make a
        # "divergent" pair genuinely sound and void the mismatch negatives
        SpawnIdentityTests._seq += 1
        return self.registry.create_account(
            provider, "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"{provider}-{self._seq}")})

    # ------------------------------------------------------- clean_env strip
    def test_inherited_selectors_and_marker_are_stripped(self):
        # §9.5 shape: SEED the hostile values, then assert the strip — a
        # check without the seeding passes because nothing was ever there
        seeded = {"CLAUDE_CONFIG_DIR": r"C:\hostile\claude",
                  "CODEX_HOME": r"C:\hostile\codex",
                  "ORGTREE_ACCOUNT_ID": "claude-99"}
        saved = {k: os.environ.get(k) for k in seeded}
        os.environ.update(seeded)
        try:
            env = self.supervisor.clean_env()
            for k in seeded:
                self.assertNotIn(k, env, k)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    # ------------------------------------------------------- single injector
    def test_injector_writes_the_pair_together(self):
        row = self._profile_row()
        env = self.registry.inject_binding({}, row)
        self.assertEqual(env[self.registry.MARKER], row["id"])
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], row["credential"]["path"])

    def test_token_lanes_split_by_ref_shape(self):
        org_row = self.registry.create_account(
            "claude", "orgkey", {"kind": "token",
                                 "token_ref": "org-api-key:alpha"},
            origin_org="alpha")
        legacy_row = self.registry.create_account(
            "claude", "legacy", {"kind": "token", "token_ref": "row1"})
        resolver = {"org-api-key:alpha": "KEYSECRET",
                    "row1": "TOKSECRET"}.get
        env1 = self.registry.inject_binding({}, org_row,
                                            secret_resolver=resolver)
        self.assertEqual(env1["ANTHROPIC_API_KEY"], "KEYSECRET")
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env1)
        env2 = self.registry.inject_binding({}, legacy_row,
                                            secret_resolver=resolver)
        self.assertEqual(env2["CLAUDE_CODE_OAUTH_TOKEN"], "TOKSECRET")
        self.assertNotIn("ANTHROPIC_API_KEY", env2)

    def test_unresolvable_secret_and_unwired_provider_fail_loudly(self):
        row = self.registry.create_account(
            "claude", "t", {"kind": "token", "token_ref": "gone"})
        with self.assertRaises(RuntimeError):
            self.registry.inject_binding({}, row,
                                         secret_resolver=lambda r: None)
        ag = self.registry.create_account(
            "google", "ag", {"kind": "managed",
                             "path": os.path.join(self.root, "ag")})
        with self.assertRaises(RuntimeError):
            self.registry.inject_binding({}, ag)

    # ------------------------------------- identity: cross-checked both layers
    def test_identity_answers_marker_on_sound_pair(self):
        row = self._profile_row()
        env = self.registry.inject_binding({}, row)
        self.assertEqual(self.supervisor.identity_in_env(env), row["id"])

    def test_divergent_pairs_answer_mismatch_at_identity_layer(self):
        a = self._profile_row()
        b = self._profile_row()
        # marker for B with A's profile var
        env = {self.registry.MARKER: b["id"],
               "CLAUDE_CONFIG_DIR": a["credential"]["path"]}
        self.assertEqual(self.supervisor.identity_in_env(env),
                         f"account-env-mismatch:{b['id']}")
        # marker for B with no profile var at all
        env2 = {self.registry.MARKER: b["id"]}
        self.assertEqual(self.supervisor.identity_in_env(env2),
                         f"account-env-mismatch:{b['id']}")
        # marker naming a row that does not exist
        env3 = {self.registry.MARKER: "claude-404"}
        self.assertEqual(self.supervisor.identity_in_env(env3),
                         "account-env-mismatch:claude-404")

    def test_mismatch_is_detected_by_the_shared_layer_directly(self):
        b = self._profile_row()
        self.assertIsNotNone(self.registry.identity_mismatch(
            {self.registry.MARKER: b["id"]}))
        env = self.registry.inject_binding({}, b)
        self.assertIsNone(self.registry.identity_mismatch(env))

    def test_legacy_branches_survive_untouched(self):
        # no marker: the credential-shaped branches answer exactly as before
        self.assertEqual(self.supervisor.identity_in_env(
            {"ANTHROPIC_API_KEY": "k"}), "api-key")
        from engine.backend.orgtree import accounts
        self.assertEqual(self.supervisor.identity_in_env({}),
                         accounts.PRIMARY)

    def test_codex_child_env_strips_inherited_home_and_marker(self):
        # the codex lane never passes through clean_env — codexrun.child_env
        # IS that lane's hygiene, and it must strip the same §9.5 selectors
        from engine.backend.orgtree import codexrun
        seeded = {"CODEX_HOME": r"C:\hostile\codex",
                  "ORGTREE_ACCOUNT_ID": "openai-9",
                  "ANTHROPIC_API_KEY": "leak"}
        saved = {k: os.environ.get(k) for k in seeded}
        os.environ.update(seeded)
        try:
            env = codexrun.child_env(None, None)
            for k in seeded:
                self.assertNotIn(k, env, k)
            # an EXPLICIT home still lands (the binding's future lane)
            env2 = codexrun.child_env(r"C:\bound\codex", None)
            self.assertEqual(env2["CODEX_HOME"], r"C:\bound\codex")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_token_row_marker_is_cross_checked_by_value(self):
        from engine.backend.orgtree import tokens
        managed = os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
        try:
            tokens.put("refA", "tokA")
            tokens.put("refB", "tokB")
            a = self.registry.create_account(
                "claude", "ta", {"kind": "token", "token_ref": "refA"})
            b = self.registry.create_account(
                "claude", "tb", {"kind": "token", "token_ref": "refB"})
            # happy pair: marker B with B's token
            env = {self.registry.MARKER: b["id"],
                   "CLAUDE_CODE_OAUTH_TOKEN": "tokB"}
            self.assertIsNone(self.registry.identity_mismatch(env))
            # marker B travelling with A's token ⇒ mismatch, never B
            env_bad = {self.registry.MARKER: b["id"],
                       "CLAUDE_CODE_OAUTH_TOKEN": "tokA"}
            self.assertEqual(self.registry.identity_mismatch(env_bad),
                             f"account-env-mismatch:{b['id']}")
            # marker B with no token at all ⇒ mismatch
            self.assertEqual(
                self.registry.identity_mismatch(
                    {self.registry.MARKER: b["id"]}),
                f"account-env-mismatch:{b['id']}")
            self.assertIsNotNone(a)
        finally:
            if managed is not None:
                os.environ["ORGTREE_DESKTOP_MANAGED"] = managed

    def test_org_key_marker_requires_its_lane(self):
        row = self.registry.create_account(
            "claude", "ok", {"kind": "token",
                             "token_ref": "org-api-key:alpha"},
            origin_org="alpha")
        self.assertEqual(
            self.registry.identity_mismatch({self.registry.MARKER: row["id"]}),
            f"account-env-mismatch:{row['id']}")
        self.assertIsNone(self.registry.identity_mismatch(
            {self.registry.MARKER: row["id"], "ANTHROPIC_API_KEY": "k"}))

    def test_mismatch_never_marks_a_row(self):
        b = self._profile_row()
        ident = self.supervisor.identity_in_env(
            {self.registry.MARKER: b["id"]})
        ok = self.registry.record_mark(ident, "opus", until=9999.0, now=0.0)
        self.assertFalse(ok)  # refused-and-logged, never attributed to b
        self.assertIsNone(self.registry.active_mark(b["id"], "opus", now=1.0))


    def test_default_claude_binding_preserves_home_metadata_location(self):
        home = os.path.join(self.root, "default-home")
        row = self.registry.create_account("claude", "default", {
            "kind": "imported", "path": os.path.join(home, ".claude"),
            "default_config": True})
        env = {"CLAUDE_CONFIG_DIR": "hostile", "HOME": "other", "USERPROFILE": "other"}
        self.registry.inject_binding(env, row)
        self.assertNotIn("CLAUDE_CONFIG_DIR", env)
        self.assertEqual(env["HOME"], os.path.abspath(home))
        self.assertEqual(env["USERPROFILE"], os.path.abspath(home))
        self.assertIsNone(self.registry.identity_mismatch(env))
        env["CLAUDE_CONFIG_DIR"] = row["credential"]["path"]
        self.assertIsNotNone(self.registry.identity_mismatch(env))
        env.pop("CLAUDE_CONFIG_DIR")
        env["USERPROFILE"] = "wrong-home"
        self.assertIsNotNone(self.registry.identity_mismatch(env))


if __name__ == "__main__":
    unittest.main()
