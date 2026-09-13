"""API-key accounts, stage (b) — registration, machine settings, endpoints
(ticket redesign-api-key-inference-accounts; user decisions 2026-09-12).

Covers:
  · apikey_accounts.register — claude store-first + value-idempotence;
    openai key-home synthesis (codex-native auth.json) + value-idempotence;
    google and empty keys refused; wrapped-paste normalization
  · forget_credentials — claude token disposal, openai key-home deletion
    bounded to the engine's own profiles base, subscription rows untouched
  · appsettings — apikey_fallback default OFF / explicit-true-only;
    subscription_inference default ON / explicit-false-only; provider-set
    refusals; choices dicts
  · the API doors — accounts_create kind="apikey", the enabled flip, and
    removal disposing of secret material (handlers called directly)
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="apikey-registration-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

from engine.backend.orgtree import (  # noqa: E402
    apikey_accounts, appsettings, registry, tokens)

FAKE_CLAUDE = "sk-ant-api03-" + "c" * 40
FAKE_OPENAI = "sk-proj-" + "o" * 40


def _fresh():
    for p in (registry.registry_path(), appsettings.path()):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


class RegisterTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_claude_store_first_and_idempotent(self):
        row, created = apikey_accounts.register("claude", FAKE_CLAUDE)
        self.assertTrue(created)
        self.assertEqual(registry.account_mode(row), "apikey")
        ref = row["credential"]["token_ref"]
        self.assertEqual(tokens.get(ref), FAKE_CLAUDE)   # durable, resolvable
        again, created2 = apikey_accounts.register("claude", FAKE_CLAUDE)
        self.assertFalse(created2)
        self.assertEqual(again["id"], row["id"])         # same value, same row

    def test_openai_key_lives_only_in_the_token_store(self):
        """THE DOCKET RULE, for openai too: key material lives in the machine
        token store and the row carries only a token_ref.

        The first cut wrote codex’s native auth.json holding the raw key.
        That is the provider’s own form, but it is a SECOND durable home
        for a secret, which is exactly what the rule forbids — and it put
        openai on a different discipline from claude for no reason the
        docket gives.
        """
        row, created = apikey_accounts.register("openai", FAKE_OPENAI)
        self.assertTrue(created)
        self.assertEqual(row["credential"]["kind"], "apikey")
        self.assertNotIn("path", row["credential"])
        self.assertEqual(tokens.get(row["credential"]["token_ref"]),
                         FAKE_OPENAI)
        # the derived spawn home exists for isolation and holds NOTHING
        home = apikey_accounts.codex_key_home(row)
        self.assertTrue(os.path.isdir(home))
        self.assertEqual(os.listdir(home), [])
        self.assertFalse(os.path.exists(os.path.join(home, "auth.json")))
        # and the key is nowhere on disk under the profiles base
        for base, _dirs, files in os.walk(os.path.dirname(home)):
            for name in files:
                with open(os.path.join(base, name), "rb") as f:
                    self.assertNotIn(FAKE_OPENAI.encode(), f.read(),
                                     f"raw key found in {name}")
        again, created2 = apikey_accounts.register("openai", FAKE_OPENAI)
        self.assertFalse(created2)
        self.assertEqual(again["id"], row["id"])

    def test_refusals_and_normalization(self):
        with self.assertRaises(ValueError):
            apikey_accounts.register("google", FAKE_CLAUDE)
        with self.assertRaises(ValueError):
            apikey_accounts.register("claude", "   ")
        # a wrapped-terminal paste: CR/LF inside the sk- family is removed
        wrapped = FAKE_CLAUDE[:20] + "\r\n" + FAKE_CLAUDE[20:] + "\n"
        row, _ = apikey_accounts.register("claude", wrapped)
        self.assertEqual(tokens.get(row["credential"]["token_ref"]),
                         FAKE_CLAUDE)

    def test_forget_credentials_bounds(self):
        row, _ = apikey_accounts.register("claude", FAKE_CLAUDE)
        apikey_accounts.forget_credentials(row)
        self.assertFalse(tokens.get(row["credential"]["token_ref"]))
        orow, _ = apikey_accounts.register("openai", FAKE_OPENAI)
        home = apikey_accounts.codex_key_home(orow)
        apikey_accounts.forget_credentials(orow)
        self.assertFalse(tokens.get(orow["credential"]["token_ref"]))
        self.assertFalse(os.path.isdir(home))       # derived home removed too
        # a subscription managed row is never touched, even via this door
        sub = registry.create_account(
            "openai", "login", {"kind": "managed",
                                "path": os.path.join(_root, "keep-me")})
        os.makedirs(os.path.join(_root, "keep-me"), exist_ok=True)
        apikey_accounts.forget_credentials(sub)
        self.assertTrue(os.path.isdir(os.path.join(_root, "keep-me")))
        # an apikey-shaped row pointing OUTSIDE the profiles base is refused
        rogue = dict(orow)
        rogue["credential"] = {"kind": "managed",
                               "path": os.path.join(_root, "keep-me")}
        apikey_accounts.forget_credentials(rogue)
        self.assertTrue(os.path.isdir(os.path.join(_root, "keep-me")))


class AppSettingsTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_apikey_fallback_defaults_off_and_flips(self):
        self.assertFalse(appsettings.apikey_fallback_enabled("claude"))
        self.assertFalse(appsettings.apikey_fallback_enabled("openai"))
        appsettings.set_apikey_fallback_enabled("claude", True)
        self.assertTrue(appsettings.apikey_fallback_enabled("claude"))
        self.assertFalse(appsettings.apikey_fallback_enabled("openai"))
        self.assertEqual(appsettings.apikey_fallback_choices(),
                         {"claude": True, "openai": False})
        with self.assertRaises(ValueError):
            appsettings.set_apikey_fallback_enabled("google", True)

    def test_subscription_inference_defaults_on_and_flips(self):
        for p in ("claude", "openai", "google"):
            self.assertTrue(appsettings.subscription_inference_enabled(p))
        appsettings.set_subscription_inference_enabled("claude", False)
        self.assertFalse(appsettings.subscription_inference_enabled("claude"))
        self.assertEqual(
            appsettings.subscription_inference_choices(),
            {"claude": False, "google": True, "openai": True})
        with self.assertRaises(ValueError):
            appsettings.set_subscription_inference_enabled("openrouter", False)

    def test_existing_records_unharmed(self):
        # a pre-redesign document (no new sections) reads with defaults and
        # a toggle write preserves the provider preferences already saved
        appsettings.set_provider_enabled("google", False)
        self.assertFalse(appsettings.apikey_fallback_enabled("claude"))
        appsettings.set_apikey_fallback_enabled("openai", True)
        self.assertFalse(appsettings.provider_enabled("google"))
        self.assertTrue(appsettings.apikey_fallback_enabled("openai"))


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine.backend.orgtree import api
        cls.api = api

    def setUp(self):
        _fresh()

    def test_accounts_create_apikey_and_remove_disposes(self):
        body = self.api.AccountCreate(
            provider="claude", kind="apikey", key=FAKE_CLAUDE, label="metered")
        out = asyncio.run(self.api.accounts_create(body))
        self.assertTrue(out["created"])
        self.assertEqual(out["mode"], "apikey")
        self.assertIn("standing", out)
        ref = out["credential"]["token_ref"]
        self.assertEqual(tokens.get(ref), FAKE_CLAUDE)
        again = asyncio.run(self.api.accounts_create(body))
        self.assertFalse(again["created"])
        self.assertEqual(again["id"], out["id"])
        removed = asyncio.run(self.api.accounts_remove(out["id"]))
        self.assertEqual(removed["removed"], out["id"])
        self.assertFalse(tokens.get(ref))                # secret went with it

    def test_accounts_create_apikey_refusals(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(self.api.accounts_create(self.api.AccountCreate(
                provider="google", kind="apikey", key="sk-x")))
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException):
            asyncio.run(self.api.accounts_create(self.api.AccountCreate(
                provider="claude", kind="apikey", key=" ")))

    def test_accounts_enabled_flip(self):
        from fastapi import HTTPException
        row, _ = apikey_accounts.register("claude", FAKE_CLAUDE)
        out = asyncio.run(self.api.accounts_enabled(
            row["id"], self.api.AccountEnabled(enabled=False)))
        self.assertEqual(out, {"account": row["id"], "enabled": False})
        fresh = registry.get_account(row["id"])
        self.assertFalse(registry.is_enabled(fresh))
        sub = registry.create_account(
            "claude", "login", {"kind": "managed", "path": "/tmp/x"})
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(self.api.accounts_enabled(
                sub["id"], self.api.AccountEnabled(enabled=False)))
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx2:
            asyncio.run(self.api.accounts_enabled(
                "claude-999", self.api.AccountEnabled(enabled=False)))
        self.assertEqual(ctx2.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
