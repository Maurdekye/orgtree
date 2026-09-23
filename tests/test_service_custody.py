"""No real account files or user session are read by these policy tests."""

import unittest
import json
from pathlib import Path
import tempfile

from orgtree.service_custody import (WAITING_FOR_SIGN_IN, decide,
                                     probe_provider_file, provider_custody)


class CustodyTests(unittest.TestCase):
    def test_selected_file_account_can_run_at_boot_when_git_is_independent(self):
        account = {"provider": "openai", "credential": {"kind": "managed"}}
        self.assertEqual(provider_custody(account), "file")
        self.assertEqual(decide(account, provider_file_readable=True,
                                git_custody="file", bridge_on=False).decision, "service")

    def test_missing_file_does_not_fall_back_to_session_or_another_account(self):
        account = {"provider": "claude", "credential": {"kind": "imported"}}
        for bridge_on in (False, True):
            with self.subTest(bridge_on=bridge_on):
                self.assertEqual(decide(account, provider_file_readable=False,
                                        git_custody="file", bridge_on=bridge_on).decision,
                                 "unavailable")

    def test_keyring_provider_waits_then_uses_bridge(self):
        account = {"provider": "google", "credential": {"kind": "ambient"}}
        self.assertEqual(provider_custody(account), "session")
        waiting = decide(account, provider_file_readable=False,
                         git_custody="file", bridge_on=False)
        self.assertEqual((waiting.decision, waiting.reason),
                         ("unavailable", WAITING_FOR_SIGN_IN))
        self.assertEqual(decide(account, provider_file_readable=False,
                                git_custody="file", bridge_on=True).decision, "bridge")

    def test_git_session_secret_also_waits_even_with_safe_provider_file(self):
        account = {"provider": "claude", "credential": {"kind": "managed"}}
        self.assertEqual(decide(account, provider_file_readable=True,
                                git_custody="session", bridge_on=False).reason,
                         WAITING_FOR_SIGN_IN)
        self.assertEqual(decide(account, provider_file_readable=True,
                                git_custody="session", bridge_on=True).decision, "bridge")

    def test_unknown_custody_is_never_inferred_safe(self):
        account = {"provider": "unrecognized", "credential": {"kind": "managed"}}
        self.assertEqual(decide(account, provider_file_readable=True,
                                git_custody="file", bridge_on=True).decision, "unavailable")
        account = {"provider": "openai", "credential": {"kind": "ambient"}}
        self.assertEqual(decide(account, provider_file_readable=True,
                                git_custody="unknown", bridge_on=True).decision, "unavailable")

    def test_probe_reads_only_selected_profile_file_and_never_ambient_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ambient = root / ".codex"
            ambient.mkdir()
            (ambient / "auth.json").write_text(
                json.dumps({"tokens": {"access_token": "ambient"}}), encoding="utf-8")
            selected = root / "selected"
            selected.mkdir()
            row = {"provider": "openai", "credential":
                   {"kind": "managed", "path": str(selected)}}
            self.assertFalse(probe_provider_file(row, home=root, has_token=lambda _: True))
            (selected / "auth.json").write_text(
                json.dumps({"tokens": {"access_token": "selected"}}), encoding="utf-8")
            self.assertTrue(probe_provider_file(row, home=root, has_token=lambda _: False))

    def test_key_store_probe_checks_only_its_named_ref(self):
        row = {"provider": "claude", "credential":
               {"kind": "apikey", "token_ref": "selected-ref"}}
        seen = []
        def has_token(ref):
            seen.append(ref)
            return ref == "selected-ref"
        self.assertTrue(probe_provider_file(row, home=Path("C:/unused"),
                                            has_token=has_token))
        self.assertEqual(seen, ["selected-ref"])


if __name__ == "__main__":
    unittest.main()
