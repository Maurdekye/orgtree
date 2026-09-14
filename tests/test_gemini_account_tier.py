"""Authoritative, safe, per-account Gemini account tier usage tests.

Verifies:
1. Gemini usage displays the authoritative account tier on the correct account row when available.
2. Multiple Gemini accounts can show different tiers without cross-account attribution.
3. Missing or unresolved tier metadata is shown as unknown/unavailable rather than guessed.
4. Existing usage windows, percentages, resets, freshness labels, and provider rows remain unchanged.
5. No credential or billing secrets reach the renderer or API payload.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

_root = tempfile.TemporaryDirectory(prefix="gemini-tier-test-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

from orgtree import accountusage, antigravity_limits, providers, registry, store  # noqa: E402


def _base_usage_result(*, turns: int = 0, total_tokens: int = 0) -> dict:
    return {
        "conversation_id": "",
        "status": "SUCCESS",
        "num_turns": turns,
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "thinking_tokens": 0,
            "cache_read_tokens": 0,
            "total_tokens": total_tokens,
        },
        "command": {
            "name": "usage",
            "data": {
                "groups": [
                    {
                        "name": "Gemini Models",
                        "buckets": [
                            {
                                "id": "gemini-weekly",
                                "name": "Weekly Limit Remaining",
                                "window": "weekly",
                                "remaining_fraction": 0.75,
                                "reset_time": "2026-09-17T19:40:25Z",
                            },
                        ],
                    },
                ],
            },
        },
    }


class TierSanitizationTests(unittest.TestCase):
    """Safe tier extraction and secret exclusion."""

    def test_valid_safe_tiers_accepted(self):
        self.assertEqual(antigravity_limits._sanitize_tier("Standard"), "Standard")
        self.assertEqual(antigravity_limits._sanitize_tier("Advanced"), "Advanced")
        self.assertEqual(antigravity_limits._sanitize_tier("Ultra 1.5"), "Ultra 1.5")
        self.assertEqual(antigravity_limits._sanitize_tier("Google One AI Premium"), "Google One AI Premium")
        self.assertEqual(antigravity_limits._sanitize_tier("Gemini Advanced"), "Gemini Advanced")
        self.assertEqual(antigravity_limits._sanitize_tier("Workspace-Pro"), "Workspace-Pro")

    def test_bearer_tokens_and_keys_rejected(self):
        self.assertIsNone(antigravity_limits._sanitize_tier("ya29.a0AfH6SMBx1234567890abcdef"))
        self.assertIsNone(antigravity_limits._sanitize_tier("sk-ant-api03-1234567890abcdef"))
        self.assertIsNone(antigravity_limits._sanitize_tier("Bearer ya29.secret"))
        self.assertIsNone(antigravity_limits._sanitize_tier("ghp_1234567890abcdefghijklmnopqrstuv"))
        self.assertIsNone(antigravity_limits._sanitize_tier("eyJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2.eyJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2"))

    def test_file_paths_rejected(self):
        self.assertIsNone(antigravity_limits._sanitize_tier("C:\\Users\\admin\\.credentials.json"))
        self.assertIsNone(antigravity_limits._sanitize_tier("/home/user/.gemini/settings.json"))
        self.assertIsNone(antigravity_limits._sanitize_tier("../relative/path"))

    def test_raw_json_and_multiline_rejected(self):
        self.assertIsNone(antigravity_limits._sanitize_tier('{"tier": "Standard"}'))
        self.assertIsNone(antigravity_limits._sanitize_tier("Standard\nAdvanced"))
        self.assertIsNone(antigravity_limits._sanitize_tier("Standard\r\n"))

    def test_billing_identifiers_rejected(self):
        self.assertIsNone(antigravity_limits._sanitize_tier("sub_1MvXYZ2eZvKYlo2C"))
        self.assertIsNone(antigravity_limits._sanitize_tier("cus_987654321"))
        self.assertIsNone(antigravity_limits._sanitize_tier("ba-987654321"))
        self.assertIsNone(antigravity_limits._sanitize_tier("billing-account-123"))

    def test_non_string_and_empty_rejected(self):
        self.assertIsNone(antigravity_limits._sanitize_tier(None))
        self.assertIsNone(antigravity_limits._sanitize_tier(""))
        self.assertIsNone(antigravity_limits._sanitize_tier("   "))
        self.assertIsNone(antigravity_limits._sanitize_tier(12345))
        self.assertIsNone(antigravity_limits._sanitize_tier(["Standard"]))
        self.assertIsNone(antigravity_limits._sanitize_tier({"name": "Standard"}))
        self.assertIsNone(antigravity_limits._sanitize_tier("A" * 65))


class NormalizeTierTests(unittest.TestCase):
    """Normalize extracts authoritative tier metadata without altering existing windows."""

    def test_tier_in_command_data_is_extracted(self):
        res = _base_usage_result()
        res["command"]["data"]["tier"] = "Standard"
        board = antigravity_limits._normalize(res, 1000.0)
        self.assertEqual(board["tier"], "Standard")
        self.assertEqual(board["plan"], "Standard")
        self.assertTrue(board["available"])
        self.assertEqual(len(board["limits"]), 1)
        self.assertEqual(board["limits"][0]["percent"], 25.0)

    def test_tier_in_result_is_extracted(self):
        res = _base_usage_result()
        res["tier"] = "Advanced"
        board = antigravity_limits._normalize(res, 1000.0)
        self.assertEqual(board["tier"], "Advanced")
        self.assertEqual(board["plan"], "Advanced")

    def test_missing_tier_is_omitted_without_guessing(self):
        res = _base_usage_result()
        board = antigravity_limits._normalize(res, 1000.0)
        self.assertNotIn("tier", board)
        self.assertNotIn("plan", board)
        self.assertTrue(board["available"])
        self.assertEqual(len(board["limits"]), 1)

    def test_secret_in_tier_is_excluded(self):
        res = _base_usage_result()
        res["command"]["data"]["tier"] = "ya29.secret_token"
        board = antigravity_limits._normalize(res, 1000.0)
        self.assertNotIn("tier", board)
        self.assertNotIn("plan", board)


class AccountFunctionTierTests(unittest.TestCase):
    """_account() sanitizes data tier/plan and never leaks raw unsafe values."""

    def test_safe_tier_in_data_is_preserved(self):
        acct = antigravity_limits._account(
            {"available": True, "tier": "Standard", "limits": []},
            {"email": "user@example.test", "connected": True, "installed": True},
        )
        self.assertEqual(acct["tier"], "Standard")
        self.assertEqual(acct["plan"], "Standard")

    def test_unsafe_data_tier_and_plan_are_sanitized_and_omitted(self):
        acct = antigravity_limits._account(
            {
                "available": True,
                "tier": "ya29.secret_token",
                "plan": "sk-ant-api03-token",
                "limits": [],
            },
            {"email": "user@example.test", "connected": True, "installed": True},
        )
        self.assertNotIn("tier", acct)
        self.assertNotIn("plan", acct)

    def test_unsafe_status_tier_is_sanitized_and_omitted(self):
        acct = antigravity_limits._account(
            {"available": True, "limits": []},
            {
                "email": "user@example.test",
                "connected": True,
                "installed": True,
                "tier": "C:\\Users\\admin\\secret.json",
            },
        )
        self.assertNotIn("tier", acct)
        self.assertNotIn("plan", acct)


class ProfileTierTests(unittest.TestCase):
    """profile_tier reads tier from account directory."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="gemini-prof-", dir=_root.name)

    def test_reads_tier_from_settings_json(self):
        settings = Path(self.dir) / "settings.json"
        settings.write_text(json.dumps({"tier": "Standard"}), encoding="utf-8")
        self.assertEqual(antigravity_limits.profile_tier(self.dir), "Standard")

    def test_reads_plan_from_credentials_json(self):
        creds = Path(self.dir) / ".credentials.json"
        creds.write_text(json.dumps({"subscriptionType": "Advanced"}), encoding="utf-8")
        self.assertEqual(antigravity_limits.profile_tier(self.dir), "Advanced")

    def test_reads_nested_account_tier(self):
        acct = Path(self.dir) / "account.json"
        acct.write_text(json.dumps({"google": {"tier": "Google One AI Premium"}}), encoding="utf-8")
        self.assertEqual(antigravity_limits.profile_tier(self.dir), "Google One AI Premium")

    def test_missing_or_bad_files_return_none(self):
        self.assertIsNone(antigravity_limits.profile_tier(self.dir))
        bad = Path(self.dir) / "settings.json"
        bad.write_text("{invalid json", encoding="utf-8")
        self.assertIsNone(antigravity_limits.profile_tier(self.dir))


class MultiAccountAttributionTests(unittest.TestCase):
    """Multiple accounts with different tiers without cross-account attribution."""

    def setUp(self):
        antigravity_limits.invalidate()
        self.ambient_prof = tempfile.mkdtemp(prefix="amb-prof-", dir=_root.name)
        self.sec_prof = tempfile.mkdtemp(prefix="sec-prof-", dir=_root.name)

    def test_ambient_and_secondary_accounts_show_different_tiers(self):
        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy-test",
            "email": "primary@example.test",
            "version": "1.2.0",
            "tier": "Advanced",
        }
        res = _base_usage_result()
        res["command"]["data"]["tier"] = "Advanced"

        # Secondary row has its own distinct tier
        (Path(self.sec_prof) / "settings.json").write_text(
            json.dumps({"tier": "Standard"}), encoding="utf-8")
        sec_row = {
            "id": "google-secondary",
            "provider": "google",
            "credential": {"kind": "managed", "path": self.sec_prof},
            "identity": {"email": "secondary@example.test"},
        }

        # Ambient row
        amb_row = {
            "id": "google-primary",
            "provider": "google",
            "credential": {"kind": "managed", "path": self.ambient_prof},
            "identity": {"email": "primary@example.test"},
        }

        with mock.patch("orgtree.registry_migration.observe_ambient",
                        return_value={"google": self.ambient_prof}), \
             mock.patch.object(providers, "antigravity_status",
                               return_value=ambient_status), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=res):
            amb_view = accountusage.view(amb_row, allow_fetch=True)
            sec_view = accountusage.view(sec_row, allow_fetch=False)

        # Ambient view reflects authoritative ambient tier "Advanced"
        self.assertEqual(amb_view["tier"], "Advanced")
        self.assertEqual(amb_view["plan"], "Advanced")

        # Secondary view reflects its OWN authoritative tier "Standard"
        self.assertEqual(sec_view["tier"], "Standard")
        self.assertEqual(sec_view["plan"], "Standard")
        # No cross attribution!
        self.assertNotEqual(amb_view["tier"], sec_view["tier"])

    def test_secondary_without_tier_does_not_inherit_ambient_tier(self):
        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy-test",
            "email": "primary@example.test",
            "version": "1.2.0",
            "tier": "Advanced",
        }
        res = _base_usage_result()
        res["command"]["data"]["tier"] = "Advanced"

        # Secondary has NO tier anywhere
        sec_row = {
            "id": "google-secondary-notier",
            "provider": "google",
            "credential": {"kind": "managed", "path": self.sec_prof},
            "identity": {"email": "secondary@example.test"},
        }

        amb_row = {
            "id": "google-primary",
            "provider": "google",
            "credential": {"kind": "managed", "path": self.ambient_prof},
            "identity": {"email": "primary@example.test"},
        }

        with mock.patch("orgtree.registry_migration.observe_ambient",
                        return_value={"google": self.ambient_prof}), \
             mock.patch.object(providers, "antigravity_status",
                               return_value=ambient_status), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=res):
            amb_view = accountusage.view(amb_row, allow_fetch=True)
            sec_view = accountusage.view(sec_row, allow_fetch=False)

        self.assertEqual(amb_view["tier"], "Advanced")
        # Secondary MUST NOT inherit "Advanced"
        self.assertNotIn("tier", sec_view)
        self.assertNotIn("plan", sec_view)


class InstalledAntigravityTierCorrectionTests(unittest.TestCase):
    """Installed Antigravity tier detection correction (2026-09-14).
    
    Covers:
    - Status probe preferred when supported with structured JSON output.
    - Status probe ignored and rejected if ungrounded/billed (num_turns > 0).
    - Structured log extraction of authMethod (consumer -> Consumer, enterprise -> Enterprise).
    - Structured log extraction of SetUserTier and keyring userTier.
    - Image-115 reproduction: ncolaprete@gmail.com with authMethod=consumer resolves Consumer tier
      while preserving all 4 quota windows.
    - Cross-account attribution isolation for probe log entries.
    - Unavailable retained when every supported structured source genuinely lacks tier.
    - Secret and billing identifier exclusion from probe log lines.
    """

    def setUp(self):
        antigravity_limits.invalidate()
        antigravity_limits._status_supported_cache.clear()
        self.probe_dir = tempfile.mkdtemp(prefix="probe-dir-", dir=_root.name)

    def test_status_probe_preferred_when_supported(self):
        """Structured /status JSON output is preferred over other sources when supported."""
        status_result = {
            "conversation_id": "",
            "status": "SUCCESS",
            "num_turns": 0,
            "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
                      "cache_read_tokens": 0, "total_tokens": 0},
            "command": {
                "name": "status",
                "data": {"tier": "Gemini Advanced", "plan": "Gemini Advanced"},
            },
        }
        usage_res = _base_usage_result()
        usage_res["command"]["data"]["tier"] = "Standard"

        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy.exe",
            "email": "user@example.test",
            "version": "1.2.2",
            "tier": "Standard",
        }

        with mock.patch.object(providers, "antigravity_status", return_value=ambient_status), \
             mock.patch.object(antigravity_limits, "_run_status", return_value=status_result), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=usage_res):
            board = antigravity_limits.fetch(force=True)

        self.assertEqual(board["tier"], "Gemini Advanced")
        self.assertEqual(board["plan"], "Gemini Advanced")
        self.assertTrue(board["available"])
        self.assertEqual(len(board["limits"]), 1)

    def test_status_probe_rejected_if_billed_or_not_read_only(self):
        """Billed model turn on /status (num_turns != 0) is rejected as a read-only source."""
        billed_status = {
            "conversation_id": "conv-123",
            "status": "SUCCESS",
            "num_turns": 1,
            "usage": {"input_tokens": 50, "output_tokens": 100, "thinking_tokens": 0,
                      "cache_read_tokens": 0, "total_tokens": 150},
            "response": "I am an AI",
        }
        usage_res = _base_usage_result()
        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy.exe",
            "email": "user@example.test",
            "version": "1.2.2",
        }

        log_content = (
            "I0914 23:14:17.918219 1 server_oauth.go:192] applyAuthResult: "
            "email=user@example.test, authMethod=consumer, quotaProject=\n"
        )
        (Path(self.probe_dir) / "usage-probe.log").write_text(log_content, encoding="utf-8")

        with mock.patch.object(providers, "antigravity_status", return_value=ambient_status), \
             mock.patch.object(providers, "antigravity_probe_dir", return_value=self.probe_dir), \
             mock.patch.object(antigravity_limits, "_run_status", return_value=billed_status), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=usage_res):
            board = antigravity_limits.fetch(force=True)

        # Billed status was ignored; structured probe log fallback was used
        self.assertEqual(board["tier"], "Consumer")
        self.assertEqual(board["plan"], "Consumer")

    def test_image_115_reproduction_consumer_tier_with_all_quota_windows(self):
        """Reproduction of uploads/image-115.png: ncolaprete@gmail.com with authMethod=consumer
        resolves Antigravity Consumer and preserves all 4 quota windows.
        """
        image_115_usage = {
            "conversation_id": "",
            "status": "SUCCESS",
            "num_turns": 0,
            "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
                      "cache_read_tokens": 0, "total_tokens": 0},
            "command": {
                "name": "usage",
                "data": {
                    "groups": [
                        {
                            "name": "Gemini Models",
                            "buckets": [
                                {
                                    "id": "gemini-weekly",
                                    "name": "Weekly Limit Remaining",
                                    "window": "weekly",
                                    "remaining_fraction": 0.19,  # 81% used
                                    "reset_time": "2026-09-17T19:40:25Z",
                                },
                                {
                                    "id": "gemini-5h",
                                    "name": "Five Hour Limit Remaining",
                                    "window": "5h",
                                    "remaining_fraction": 1.0,  # 0% used
                                    "reset_time": "2026-09-15T04:35:27Z",
                                },
                            ],
                        },
                        {
                            "name": "Claude and GPT models",
                            "buckets": [
                                {
                                    "id": "3p-weekly",
                                    "name": "Weekly Limit Remaining",
                                    "window": "weekly",
                                    "remaining_fraction": 1.0,  # 0% used
                                    "reset_time": "2026-09-21T19:40:25Z",
                                },
                                {
                                    "id": "3p-5h",
                                    "name": "Five Hour Limit Remaining",
                                    "window": "5h",
                                    "remaining_fraction": 1.0,  # 0% used
                                    "reset_time": "2026-09-15T04:35:27Z",
                                },
                            ],
                        },
                    ],
                },
            },
        }

        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy.exe",
            "email": "ncolaprete@gmail.com",
            "version": "1.2.2",
        }

        probe_log = (
            "I0914 23:14:17.918219 1 keyring.go:64] keyringAuth: loaded token, expired=false\n"
            "I0914 23:14:17.918219 1 server_oauth.go:192] applyAuthResult: email=ncolaprete@gmail.com, authMethod=consumer, quotaProject=\n"
            "I0914 23:14:17.918219 1 server_oauth.go:197] OAuth: authenticated successfully as ncolaprete@gmail.com\n"
        )
        (Path(self.probe_dir) / "models-probe.log").write_text(probe_log, encoding="utf-8")

        with mock.patch.object(providers, "antigravity_status", return_value=ambient_status), \
             mock.patch.object(providers, "antigravity_probe_dir", return_value=self.probe_dir), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=image_115_usage):
            board = antigravity_limits.fetch(force=True)

        self.assertEqual(board["tier"], "Consumer")
        self.assertEqual(board["plan"], "Consumer")
        self.assertEqual(board["label"], "ncolaprete@gmail.com")
        self.assertEqual(board["account"], "antigravity")
        self.assertTrue(board["available"])
        self.assertEqual(len(board["limits"]), 4)
        self.assertEqual(board["limits"][0]["label"], "Gemini Models · Weekly")
        self.assertEqual(board["limits"][0]["percent"], 81.0)
        self.assertEqual(board["limits"][1]["label"], "Gemini Models · Five Hour")
        self.assertEqual(board["limits"][1]["percent"], 0.0)
        self.assertEqual(board["limits"][2]["label"], "Claude and GPT models · Weekly")
        self.assertEqual(board["limits"][2]["percent"], 0.0)
        self.assertEqual(board["limits"][3]["label"], "Claude and GPT models · Five Hour")
        self.assertEqual(board["limits"][3]["percent"], 0.0)

    def test_user_tier_and_tier_display_name_in_probe_log(self):
        """SetUserTier and keyring userTier in probe logs take precedence over generic authMethod."""
        log_with_display = (
            'I0914 23:14:17.918219 1 server_oauth.go:192] applyAuthResult: email=user@example.test, authMethod=consumer, quotaProject=\n'
            '[AuthProvider] SetUserTier called with userTier: "G1_PRO_TIER", tierDisplayName: "Google One AI Premium"\n'
        )
        email, tier = providers._extract_antigravity_log_tier(log_with_display, "user@example.test")
        self.assertEqual(email, "user@example.test")
        self.assertEqual(tier, "Google One AI Premium")

        log_with_enum = (
            'I0914 23:14:17.918219 1 server_oauth.go:192] applyAuthResult: email=user@example.test, authMethod=consumer, quotaProject=\n'
            'Restored saved token from keyring: authMethod=consumer projectID="" region="" userTier="CS_STANDARD_TIER" wifProvider=""\n'
        )
        email2, tier2 = providers._extract_antigravity_log_tier(log_with_enum, "user@example.test")
        self.assertEqual(tier2, "Standard")

    def test_probe_log_cross_account_isolation(self):
        """Probe log for a different email must not be attributed to the current account."""
        foreign_log = (
            "I0914 23:14:17.918219 1 server_oauth.go:192] applyAuthResult: "
            "email=other@example.test, authMethod=enterprise, quotaProject=\n"
        )
        email, tier = providers._extract_antigravity_log_tier(foreign_log, "user@example.test")
        self.assertIsNone(tier)

    def test_tier_unavailable_when_all_structured_sources_lack_tier(self):
        """Retains unavailable presentation when no supported structured source reports tier."""
        usage_res = _base_usage_result()
        ambient_status = {
            "installed": True,
            "connected": True,
            "path": "agy.exe",
            "email": "user@example.test",
            "version": "1.2.2",
        }
        # Empty probe dir, no log files
        with mock.patch.object(providers, "antigravity_status", return_value=ambient_status), \
             mock.patch.object(providers, "antigravity_probe_dir", return_value=self.probe_dir), \
             mock.patch.object(antigravity_limits, "_run_usage", return_value=usage_res):
            board = antigravity_limits.fetch(force=True)

        self.assertNotIn("tier", board)
        self.assertNotIn("plan", board)
        self.assertTrue(board["available"])
        self.assertEqual(len(board["limits"]), 1)

    def test_secrets_and_paths_in_probe_log_sanitized(self):
        """Bearer tokens, file paths, and billing IDs in log tier fields are rejected."""
        leak_log = (
            'applyAuthResult: email=user@example.test, authMethod=ya29.secret_token, quotaProject=\n'
            '[AuthProvider] SetUserTier called with userTier: "C:\\Users\\admin\\secret.json", tierDisplayName: "sub_12345678"\n'
        )
        email, tier = providers._extract_antigravity_log_tier(leak_log, "user@example.test")
        self.assertIsNone(tier)


if __name__ == "__main__":
    unittest.main()
