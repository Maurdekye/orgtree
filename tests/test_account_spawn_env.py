"""S3b: spawn_env node binding — the binding wins uniformly, legacy lanes
survive for unbound nodes, and the §9.5 seeded negatives run through the REAL
spawn_env (a cross-account check without seeding passes because nothing was
ever there)."""
import os
import tempfile
import unittest


class SpawnEnvBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-spawnenv-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger, registry, store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger
        cls.registry = registry
        cls.supervisor = supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _org(self, slug, nid="root", account=None, **extra):
        org = self.ledger.Org.create(slug)
        org.nodes[nid] = {"state": "live", "parent": None, "generation": 1,
                          "model": "opus"}
        if account:
            org.nodes[nid]["account"] = account
        org.d.update(extra)
        return org

    def _profile_row(self):
        SpawnEnvBindingTests._seq += 1
        return self.registry.create_account(
            "claude", "t",
            {"kind": "managed",
             "path": os.path.join(self.root, f"prof-{self._seq}")})

    def test_binding_wins_over_org_key_uniformly(self):
        row = self._profile_row()
        org = self._org("bind-a", account=row["id"], api_key="ORGKEY")
        env = self.supervisor.spawn_env(org, tier="opus", nid="root")
        self.assertEqual(env[self.registry.MARKER], row["id"])
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], row["credential"]["path"])
        # the old precedence CANNOT fire for a bound node
        self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_unbound_node_keeps_legacy_org_key_lane(self):
        org = self._org("legacy-a", api_key="ORGKEY")
        env = self.supervisor.spawn_env(org, tier="opus", nid="root")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "ORGKEY")
        self.assertNotIn(self.registry.MARKER, env)

    def test_org_key_row_injects_this_orgs_key(self):
        row = self.registry.create_account(
            "claude", "orgkey",
            {"kind": "token", "token_ref": "org-api-key:keyed"},
            origin_org="keyed")
        org = self._org("keyed", account=row["id"], api_key="THEKEY")
        env = self.supervisor.spawn_env(org, tier="opus", nid="root")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "THEKEY")
        self.assertEqual(env[self.registry.MARKER], row["id"])

    def test_foreign_org_key_ref_refused_in_depth(self):
        row = self.registry.create_account(
            "claude", "orgkey",
            {"kind": "token", "token_ref": "org-api-key:other"},
            origin_org="other")
        org = self._org("victim", account=row["id"], api_key="MYKEY")
        with self.assertRaises(RuntimeError):
            self.supervisor.spawn_env(org, tier="opus", nid="root")

    def test_missing_binding_refuses_the_spawn(self):
        org = self._org("parked", account="missing:claude")
        with self.assertRaises(RuntimeError):
            self.supervisor.spawn_env(org, tier="opus", nid="root")

    def test_seeded_cross_account_env_never_leaks_into_a_bound_spawn(self):
        a, b = self._profile_row(), self._profile_row()
        org = self._org("seeded", account=a["id"])
        seeded = {"CLAUDE_CONFIG_DIR": b["credential"]["path"],
                  "ORGTREE_ACCOUNT_ID": b["id"],
                  "ANTHROPIC_API_KEY": "hostile"}
        saved = {k: os.environ.get(k) for k in seeded}
        os.environ.update(seeded)
        try:
            env = self.supervisor.spawn_env(org, tier="opus", nid="root")
            self.assertEqual(env[self.registry.MARKER], a["id"])
            self.assertEqual(env["CLAUDE_CONFIG_DIR"],
                             a["credential"]["path"])
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            # and attribution reads A, not B, from the resolved env
            self.assertEqual(self.supervisor.identity_in_env(env), a["id"])
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_codex_home_resolves_from_binding_never_environ(self):
        # the strip-bypass finding: a host CODEX_HOME must not re-enter as
        # the explicit parameter — seed it and assert the resolver ignores it
        row = self.registry.create_account(
            "openai", "cx", {"kind": "managed",
                             "path": os.path.join(self.root, "cxprof")})
        org = self._org("codex-bound", account=row["id"])
        org.nodes["root"]["model"] = "luna"
        saved = os.environ.get("CODEX_HOME")
        os.environ["CODEX_HOME"] = r"C:\hostile\codex"
        try:
            home, bound = self.supervisor.codex_bound_home(org, "root")
            self.assertEqual(home, row["credential"]["path"])
            self.assertEqual(bound, row["id"])
            # unbound node: empty home (spec falls to the CLI default),
            # NEVER the seeded host value
            org2 = self._org("codex-unbound")
            home2, bound2 = self.supervisor.codex_bound_home(org2, "root")
            self.assertEqual((home2, bound2), ("", ""))
        finally:
            if saved is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = saved

    def test_codex_binding_provider_mismatch_and_missing_refuse(self):
        claude_row = self._profile_row()
        org = self._org("codex-wrong", account=claude_row["id"])
        with self.assertRaises(RuntimeError):
            self.supervisor.codex_bound_home(org, "root")
        org2 = self._org("codex-missing", account="missing:openai")
        with self.assertRaises(RuntimeError):
            self.supervisor.codex_bound_home(org2, "root")

    def test_no_nid_no_bind_node_stays_ambient(self):
        # passing NEITHER nid nor bind_node stays ambient (legacy lanes) —
        # the deliberate residual, no longer a gap
        row = self._profile_row()
        org = self._org("forks", account=row["id"])
        env = self.supervisor.spawn_env(org, tier="opus")
        self.assertNotIn(self.registry.MARKER, env)

    def test_bind_node_carries_binding_without_overrides(self):
        # the S3c fork shape: bind_node gives the agent's ACCOUNT (marker +
        # credential) while the nid-keyed branches (env_overrides/agentauth)
        # stay untaken — asserted via the agentauth var the nid path injects
        row = self._profile_row()
        org = self._org("forks-bind", account=row["id"])
        env = self.supervisor.spawn_env(org, tier="opus", bind_node="root")
        self.assertEqual(env[self.registry.MARKER], row["id"])
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], row["credential"]["path"])
        # the nid path ADDS agentauth/override vars over the ambient
        # baseline; the bind_node path must add ONLY the binding pair —
        # baselined against a bindingless call because the test process's
        # own environment legitimately carries ORGTREE_* vars already
        org_plain = self._org("forks-base")
        baseline = set(self.supervisor.spawn_env(org_plain, tier="opus"))
        env_full = self.supervisor.spawn_env(org, tier="opus", nid="root")
        nid_added = set(env_full) - baseline - {
            self.registry.MARKER, "CLAUDE_CONFIG_DIR"}
        bind_added = set(env) - baseline
        self.assertEqual(bind_added,
                         {self.registry.MARKER, "CLAUDE_CONFIG_DIR"})
        for k in nid_added:
            self.assertNotIn(k, env, k)


if __name__ == "__main__":
    unittest.main()
