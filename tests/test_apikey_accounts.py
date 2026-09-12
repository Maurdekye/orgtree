"""API-key accounts, stage (a) — the registry seam (ticket
redesign-api-key-inference-accounts; user decisions 2026-09-12 18:19Z).

Covers, at the registry + usage-resolver level (no spawn, no network):
  · row shape — mode/enabled/spend fields, the provider/kind matrix, and the
    secret guard still refusing key-shaped material in the registry file
  · the injection seam — ANTHROPIC_API_KEY and the marker written together
    for a claude apikey row; a resolver miss refuses the spawn; the openai
    form rides the existing managed-home lane untouched
  · the N2 cross-check — a marker naming an apikey row must travel with a
    populated metered lane
  · local spend metering — accumulation, zero-cost turns still counting,
    unknown ids and non-apikey rows staying logged no-ops
  · the usage view — an apikey row answers total spend in USD, never limit
    windows, identically on the fetch and cache-only paths
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

# the backend's [orgtree] diagnostics use unicode (→, ⚠, №); a bare Windows
# console is cp1252 and would crash the print, not the code under test.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="apikey-accounts-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

from engine.backend.orgtree import accountusage, registry, tokens  # noqa: E402
from engine.backend.orgtree.accounts import SecretInRegistry  # noqa: E402

# never a real credential: shaped like one so the guard tests mean something
FAKE_KEY = "sk-ant-api03-" + "x" * 40


def _fresh_registry():
    try:
        os.remove(registry.registry_path())
    except FileNotFoundError:
        pass


def _claude_row(ref: str = "akTESTROW0001", *, key: str = FAKE_KEY):
    tokens.put(ref, key)
    return registry.create_account(
        "claude", "metered key", {"kind": "apikey", "token_ref": ref},
        mode="apikey")


class RowShapeTests(unittest.TestCase):
    def setUp(self):
        _fresh_registry()

    def test_claude_apikey_row_shape_and_no_secret_on_disk(self):
        row = _claude_row()
        self.assertEqual(row["provider"], "claude")
        self.assertEqual(row["mode"], "apikey")
        self.assertTrue(row["enabled"])
        self.assertEqual(row["credential"],
                         {"kind": "apikey", "token_ref": "akTESTROW0001"})
        with open(registry.registry_path(), encoding="utf-8") as f:
            self.assertNotIn(FAKE_KEY, f.read())

    def test_provider_kind_matrix(self):
        # google has no key lane at all
        with self.assertRaises(ValueError):
            registry.create_account(
                "google", "nope", {"kind": "apikey", "token_ref": "akX"},
                mode="apikey")
        # an openai key account is a managed codex home, never a token ref
        with self.assertRaises(ValueError):
            registry.create_account(
                "openai", "nope", {"kind": "apikey", "token_ref": "akX"},
                mode="apikey")
        # a claude key account lives in the token store, never a profile dir
        with self.assertRaises(ValueError):
            registry.create_account(
                "claude", "nope", {"kind": "managed", "path": "/x"},
                mode="apikey")
        # the apikey credential kind exists only for apikey-mode rows
        with self.assertRaises(ValueError):
            registry.create_account(
                "claude", "nope", {"kind": "apikey", "token_ref": "akX"})
        # the valid openai form: managed home + apikey mode
        row = registry.create_account(
            "openai", "metered codex", {"kind": "managed", "path": "/tmp/ch"},
            mode="apikey")
        self.assertEqual(row["mode"], "apikey")
        self.assertTrue(row["enabled"])

    def test_secret_shaped_token_ref_is_refused(self):
        with self.assertRaises(SecretInRegistry):
            registry.create_account(
                "claude", "leak", {"kind": "apikey", "token_ref": FAKE_KEY},
                mode="apikey")

    def test_mode_and_enabled_readers(self):
        row = _claude_row()
        self.assertEqual(registry.account_mode(row), "apikey")
        self.assertTrue(registry.is_enabled(row))
        plain = registry.create_account(
            "claude", "profile", {"kind": "managed", "path": "/tmp/p"})
        self.assertEqual(registry.account_mode(plain), "subscription")
        self.assertTrue(registry.is_enabled(plain))     # no enable concept

    def test_set_enabled_flips_only_apikey_rows(self):
        row = _claude_row()
        registry.set_enabled(row["id"], False)
        self.assertFalse(registry.is_enabled(registry.get_account(row["id"])))
        registry.set_enabled(row["id"], True)
        self.assertTrue(registry.is_enabled(registry.get_account(row["id"])))
        plain = registry.create_account(
            "claude", "profile", {"kind": "managed", "path": "/tmp/p"})
        with self.assertRaises(ValueError):
            registry.set_enabled(plain["id"], False)


class InjectionTests(unittest.TestCase):
    def setUp(self):
        _fresh_registry()

    def test_claude_apikey_injects_key_and_marker_together(self):
        row = _claude_row("akINJECT000001")
        env: dict[str, str] = {}
        registry.inject_binding(env, row, secret_resolver=tokens.get)
        self.assertEqual(env["ANTHROPIC_API_KEY"], FAKE_KEY)
        self.assertEqual(env[registry.MARKER], row["id"])

    def test_resolver_miss_refuses_the_spawn(self):
        row = _claude_row("akMISSING00001")
        tokens.forget("akMISSING00001")
        with self.assertRaises(RuntimeError):
            registry.inject_binding({}, row, secret_resolver=tokens.get)
        with self.assertRaises(RuntimeError):
            registry.inject_binding({}, row)            # no resolver at all

    def test_openai_apikey_rides_the_managed_home_lane(self):
        row = registry.create_account(
            "openai", "metered codex", {"kind": "managed", "path": "/tmp/ch"},
            mode="apikey")
        env: dict[str, str] = {}
        registry.inject_binding(env, row)
        self.assertEqual(env["CODEX_HOME"], "/tmp/ch")
        self.assertEqual(env[registry.MARKER], row["id"])
        self.assertNotIn("OPENAI_API_KEY", env)         # auth.json, never env

    def test_identity_mismatch_needs_the_metered_lane(self):
        row = _claude_row("akMISMATCH0001")
        env = {registry.MARKER: row["id"]}
        self.assertEqual(registry.identity_mismatch(env),
                         f"account-env-mismatch:{row['id']}")
        env["ANTHROPIC_API_KEY"] = FAKE_KEY
        self.assertIsNone(registry.identity_mismatch(env))


class SpendTests(unittest.TestCase):
    def setUp(self):
        _fresh_registry()

    def test_add_spend_accumulates_and_counts_turns(self):
        row = _claude_row("akSPEND0000001")
        self.assertTrue(registry.add_spend(row["id"], 0.75, now=1000.0))
        self.assertTrue(registry.add_spend(row["id"], 0.25, now=2000.0))
        self.assertTrue(registry.add_spend(row["id"], 0.0, now=3000.0))
        spend = registry.spend_of(registry.get_account(row["id"]))
        self.assertAlmostEqual(spend["usd_total"], 1.0)
        self.assertEqual(spend["turns"], 3)              # zero still counts
        self.assertEqual(spend["since"], 1000.0)
        self.assertEqual(spend["updated_at"], 3000.0)

    def test_refusals_never_mint_state(self):
        row = _claude_row("akREFUSE000001")
        self.assertFalse(registry.add_spend("claude-999", 1.0))
        self.assertFalse(registry.add_spend(row["id"], -0.1))
        self.assertFalse(registry.add_spend(row["id"], float("nan")))
        plain = registry.create_account(
            "claude", "profile", {"kind": "managed", "path": "/tmp/p"})
        self.assertFalse(registry.add_spend(plain["id"], 1.0))
        self.assertEqual(
            registry.spend_of(registry.get_account(row["id"]))["turns"], 0)


class UsageViewTests(unittest.TestCase):
    def setUp(self):
        _fresh_registry()

    def test_apikey_row_answers_spend_never_windows(self):
        row = _claude_row("akVIEW00000001")
        registry.add_spend(row["id"], 2.5, now=1234.0)
        row = registry.get_account(row["id"])
        for allow_fetch in (False, True):               # identical, no fetch
            view = accountusage.view(row, allow_fetch=allow_fetch, now=2000.0)
            self.assertTrue(view["available"])
            self.assertEqual(view["mode"], "apikey")
            self.assertEqual(view["currency"], "USD")
            self.assertAlmostEqual(view["spend"]["usd_total"], 2.5)
            self.assertTrue(view["enabled"])
            self.assertNotIn("limits", view)
            self.assertIn("standing", view)

    def test_openai_apikey_row_answers_the_same_shape(self):
        row = registry.create_account(
            "openai", "metered codex", {"kind": "managed", "path": "/tmp/ch"},
            mode="apikey")
        view = accountusage.view(row, allow_fetch=False, now=2000.0)
        self.assertTrue(view["available"])
        self.assertEqual(view["mode"], "apikey")
        self.assertEqual(view["spend"]["turns"], 0)


if __name__ == "__main__":
    unittest.main()
