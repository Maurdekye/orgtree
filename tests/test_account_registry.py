"""S1 registry: rows, marks with provenance, allocation, availability scope.

Design: v2-accounts-design.md draft 6 (Opus stage-1 cleared 18:39Z). Every
check here is one the design's verification sketch names, written so it can
fail: the ride-along has an absent-only NEGATIVE beside its positive, the
unknown-id refusal asserts the log record exists (a silent no-op fails), and
tint stability is pinned by removing a MIDDLE account, not by a restart.
"""
import logging
import os
import tempfile
import unittest


class RegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-registry-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import registry, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.registry = registry

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    def _mk(self, provider="claude", org=None, kind="managed"):
        cred = ({"kind": kind, "path": os.path.join(self.root, "p")}
                if kind != "token" else {"kind": "token", "token_ref": "row1"})
        return self.registry.create_account(
            provider, "t", cred, origin_org=org)

    # ------------------------------------------------------------ allocation
    def test_ids_and_tints_never_reused_after_middle_removal(self):
        a, b, c = self._mk(), self._mk(), self._mk()
        self.assertEqual([a["tint_ordinal"], b["tint_ordinal"],
                          c["tint_ordinal"]], [1, 2, 3])
        self.assertTrue(self.registry.remove_account(b["id"]))
        # the surviving rows keep their exact ordinals (removal repaints
        # nobody) and a new row does NOT take the freed slot
        rows = {r["id"]: r for r in self.registry.list_accounts()}
        self.assertEqual(rows[a["id"]]["tint_ordinal"], 1)
        self.assertEqual(rows[c["id"]]["tint_ordinal"], 3)
        d = self._mk()
        self.assertEqual(d["tint_ordinal"], 4)
        self.assertNotEqual(d["id"], b["id"])

    def test_display_names_reuse_free_numbers_without_reusing_identity(self):
        def create(label=""):
            return self.registry.create_account("claude", label,
                {"kind": "managed", "path": os.path.join(self.root, "p")})
        first = create()
        self.assertEqual(first["label"], "claude-0")
        self.registry.remove_account(first["id"])
        second = create()
        self.assertEqual(second["label"], "claude-0")
        self.assertNotEqual(first["id"], second["id"])
        third = create()
        self.assertEqual(third["label"], "claude-1")
        self.registry.remove_account(second["id"])
        fourth = create()
        self.assertEqual(fourth["label"], "claude-0")
        self.assertEqual(self.registry.get_account(third["id"])["label"], "claude-1")
        named = create("claude-2")
        self.assertEqual(create()["label"], "claude-3")
        self.assertEqual(self.registry.get_account(named["id"])["label"], "claude-2")

    def test_openrouter_and_unknown_providers_refused(self):
        for bad in ("openrouter", "xai", ""):
            with self.assertRaises(ValueError):
                self._mk(provider=bad)

    def test_secret_shaped_credential_refused(self):
        from engine.backend.orgtree.accounts import SecretInRegistry
        with self.assertRaises((SecretInRegistry, ValueError)):
            self.registry.create_account(
                "claude", "t", {"kind": "token",
                                "token_ref": "sk-ant-" + "a" * 60})

    # ---------------------------------------------------------- availability
    def test_org_scoped_row_invisible_to_other_orgs(self):
        keyrow = self._mk(org="org-a", kind="token")
        plain = self._mk()
        available_b = {r["id"] for r in self.registry.list_accounts("org-b")}
        self.assertNotIn(keyrow["id"], available_b)
        self.assertIn(plain["id"], available_b)
        available_a = {r["id"] for r in self.registry.list_accounts("org-a")}
        self.assertIn(keyrow["id"], available_a)

    # ----------------------------------------------------------------- marks
    def test_pooled_mark_gates_all_three_tiers_and_rides_onto_fable(self):
        a = self._mk()
        self.assertTrue(self.registry.record_mark(
            a["id"], "sonnet", until=1000.0, window="w", now=0.0))
        for tier in ("haiku", "sonnet", "opus"):
            mark = self.registry.active_mark(a["id"], tier, now=1.0)
            self.assertIsNotNone(mark, tier)
            self.assertEqual(mark["provenance"], "observed")
        ride = self.registry.active_mark(a["id"], "fable", now=1.0)
        self.assertIsNotNone(ride)
        self.assertEqual(ride["provenance"], "inferred")
        self.assertEqual(ride["until"], 1000.0)  # source horizon, not its own

    def test_ride_along_is_absent_only_and_one_directional(self):
        a = self._mk()
        # an OBSERVED fable mark is never altered by a later pooled limit
        self.assertTrue(self.registry.record_mark(
            a["id"], "fable", until=500.0, now=0.0))
        self.assertTrue(self.registry.record_mark(
            a["id"], "opus", until=9000.0, now=0.0))
        fable = self.registry.active_mark(a["id"], "fable", now=1.0)
        self.assertEqual(fable["provenance"], "observed")
        self.assertEqual(fable["until"], 500.0)
        # one-directional: a fable limit on a fresh account marks fable ONLY
        b = self._mk()
        self.assertTrue(self.registry.record_mark(
            b["id"], "fable", until=800.0, now=0.0))
        self.assertIsNone(self.registry.active_mark(b["id"], "sonnet", now=1.0))

    def test_unknown_account_refused_and_logged_never_minted(self):
        with self.assertLogs("orgtree.registry", level=logging.WARNING) as log:
            ok = self.registry.record_mark("ghost-1", "opus",
                                           until=1000.0, now=0.0)
        self.assertFalse(ok)
        self.assertTrue(any("ghost-1" in line for line in log.output))
        self.assertEqual(self.registry.list_accounts(), [])

    def test_same_provenance_never_shortens(self):
        a = self._mk()
        # 5-day observed mark, then a 2-hour observed event on the same pool:
        # the later wall is the one still known to be true (measured gap,
        # redteam probe_mark_shorten.py — a shortened mark is a wait not
        # honoured under wait-not-fallback)
        self.registry.record_mark(a["id"], "opus", until=432000.0, now=0.0)
        self.registry.record_mark(a["id"], "sonnet", until=7200.0, now=0.0)
        mark = self.registry.active_mark(a["id"], "opus", now=1.0)
        self.assertEqual(mark["until"], 432000.0)
        # lengthening IS allowed
        self.registry.record_mark(a["id"], "opus", until=500000.0, now=0.0)
        self.assertEqual(
            self.registry.active_mark(a["id"], "opus", now=1.0)["until"],
            500000.0)

    def test_observed_supersedes_inferred_even_when_shorter(self):
        a = self._mk()
        self.registry.record_mark(a["id"], "opus", until=432000.0, now=0.0)
        ride = self.registry.active_mark(a["id"], "fable", now=1.0)
        self.assertEqual(ride["provenance"], "inferred")
        # a real, SHORTER fable measurement replaces the guess outright
        self.registry.record_mark(a["id"], "fable", until=7200.0, now=0.0)
        mark = self.registry.active_mark(a["id"], "fable", now=1.0)
        self.assertEqual(mark["provenance"], "observed")
        self.assertEqual(mark["until"], 7200.0)

    def test_cross_provider_tier_never_rides_onto_fable(self):
        # pins the pool_key mapping: a codex tier is its own pool, so an
        # openai account's limit cannot mark fable (a future pool_key edit
        # would enable it silently — this is the tripwire)
        b = self._mk(provider="openai")
        self.registry.record_mark(b["id"], "luna", until=9000.0, now=0.0)
        self.assertIsNone(self.registry.active_mark(b["id"], "fable", now=1.0))
        self.assertIsNotNone(self.registry.active_mark(b["id"], "luna", now=1.0))

    def test_marks_expire_and_release(self):
        a = self._mk()
        self.registry.record_mark(a["id"], "opus", until=100.0, now=0.0)
        self.assertIsNotNone(self.registry.active_mark(a["id"], "opus", now=99.0))
        self.assertIsNone(self.registry.active_mark(a["id"], "opus", now=100.5))

    def test_distinct_accounts_never_cross_contaminate(self):
        a, b = self._mk(), self._mk()  # two genuinely distinct rows
        self.registry.record_mark(a["id"], "opus", until=1000.0, now=0.0)
        self.assertIsNone(self.registry.active_mark(b["id"], "opus", now=1.0))
        self.assertIsNone(self.registry.active_mark(b["id"], "fable", now=1.0))

    # ---------------------------------------------------------- load discipline
    def test_strict_mutation_never_blanks_a_corrupt_file(self):
        with open(self.registry.registry_path(), "w", encoding="utf-8") as f:
            f.write("{not json")
        with self.assertRaises(self.registry.RegistryUnreadable):
            self._mk()
        with open(self.registry.registry_path(), encoding="utf-8") as f:
            self.assertEqual(f.read(), "{not json")  # file untouched
        self.assertEqual(self.registry.load()["accounts"], [])  # reader: blank

    def test_alias_resolves_for_reads(self):
        a = self._mk()
        doc = self.registry.load(strict=True)
        doc["aliases"]["primary"] = a["id"]
        self.registry.save(doc)
        self.assertEqual(self.registry.resolve_alias("primary"), a["id"])
        self.assertEqual(self.registry.get_account("primary")["id"], a["id"])


if __name__ == "__main__":
    unittest.main()
