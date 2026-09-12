"""Real Antigravity /usage parsing, caching, and read-only safeguards."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

_root = tempfile.TemporaryDirectory(prefix="v2-antigravity-usage-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

from orgtree import (antigravity_limits, providers, supervisor,  # noqa: E402
                     turnusage)


def usage_result(*, turns=0, total_tokens=0):
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
                                "remaining_fraction": 0.7122005224227905,
                                "reset_time": "2026-09-17T19:40:25Z",
                            },
                            {
                                "id": "gemini-5h",
                                "name": "Five Hour Limit Remaining",
                                "window": "5h",
                                "remaining_fraction": 0.3560321033000946,
                                "reset_time": "2026-09-12T14:35:27Z",
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
                                "remaining_fraction": 1,
                                "reset_time": "2026-09-19T12:04:17Z",
                            },
                            {
                                "id": "bad-value",
                                "name": "Invalid",
                                "window": "weekly",
                                "remaining_fraction": 1.2,
                                "reset_time": "not-a-date",
                            },
                        ],
                    },
                ],
            },
        },
    }


class NormalizeTests(unittest.TestCase):
    def test_real_shape_becomes_used_percentages_and_resets(self):
        board = antigravity_limits._normalize(usage_result(), 1000.0)
        self.assertTrue(board["available"])
        self.assertEqual(board["observed_at"], "1970-01-01T00:16:40Z")
        self.assertEqual(len(board["limits"]), 3)
        weekly, session, third_party = board["limits"]
        self.assertAlmostEqual(weekly["percent"], 28.779948, places=6)
        self.assertEqual(weekly["kind"], "weekly_scoped")
        self.assertEqual(weekly["resets_at"], "2026-09-17T19:40:25Z")
        self.assertEqual(weekly["label"],
                         "Gemini Models · Weekly")
        self.assertAlmostEqual(session["percent"], 64.39679, places=5)
        self.assertEqual(session["kind"], "session")
        self.assertEqual(third_party["percent"], 0)
        self.assertNotIn("bad-value", [row["group"] for row in board["limits"]])

    def test_nonzero_model_work_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "zero-token"):
            antigravity_limits._normalize(
                usage_result(turns=1, total_tokens=12), 1000.0)

    def test_wall_reset_parser_remains_immediate_freeze_evidence(self):
        self.assertEqual(
            antigravity_limits.reset_at("Quota reached. Resets in 2h3m4s.", 10),
            10 + 2 * 3600 + 3 * 60 + 4)


class FetchTests(unittest.TestCase):
    status = {
        "installed": True,
        "connected": True,
        "path": "agy-test",
        "email": "agy@example.test",
        "version": "1.2.0",
    }

    def setUp(self):
        antigravity_limits.invalidate()

    def test_fetch_uses_cache_and_force_bypasses_it(self):
        with mock.patch.object(providers, "antigravity_status",
                               return_value=self.status), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=usage_result()) as run:
            first = antigravity_limits.fetch()
            second = antigravity_limits.fetch()
            forced = antigravity_limits.fetch(force=True)
        self.assertTrue(first["available"])
        self.assertEqual(first["label"], "agy@example.test")
        self.assertEqual(second["limits"], first["limits"])
        self.assertTrue(forced["available"])
        self.assertEqual(run.call_count, 2)

    def test_cache_never_crosses_account_or_signout_boundaries(self):
        account_a = {**self.status, "email": "a@example.test"}
        account_b = {**self.status, "email": "b@example.test"}
        with mock.patch.object(providers, "antigravity_status",
                               return_value=account_a), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=usage_result()):
            first = antigravity_limits.fetch(force=True)
        self.assertEqual(first["label"], "a@example.test")

        with mock.patch.object(providers, "antigravity_status",
                               return_value=account_b), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               side_effect=RuntimeError("offline")):
            changed = antigravity_limits.fetch(force=True)
        self.assertFalse(changed["available"])
        self.assertEqual(changed["label"], "b@example.test")
        self.assertNotIn("limits", changed)

        with mock.patch.object(providers, "antigravity_status",
                               return_value=account_b), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=usage_result()):
            antigravity_limits.fetch(force=True)
        self.assertTrue(antigravity_limits.peek()["available"])

        signed_out = {**account_b, "connected": False, "email": None}
        with mock.patch.object(providers, "antigravity_status",
                               return_value=signed_out):
            antigravity_limits.fetch(force=True)
        self.assertFalse(antigravity_limits.peek()["available"])
        self.assertFalse(antigravity_limits.snapshot()["available"])

    def test_account_change_during_read_is_refused_and_not_cached(self):
        account_a = {**self.status, "email": "a@example.test"}
        account_b = {**self.status, "email": "b@example.test"}
        with mock.patch.object(providers, "antigravity_status",
                               side_effect=[account_a, account_b]), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=usage_result()):
            out = antigravity_limits.fetch(force=True)
        self.assertFalse(out["available"])
        self.assertEqual(out["label"], "b@example.test")
        self.assertIn("changed during", out["error"])
        self.assertFalse(antigravity_limits.snapshot()["available"])

    def test_refresh_failure_serves_last_good_board_with_error(self):
        with mock.patch.object(providers, "antigravity_status",
                               return_value=self.status), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               return_value=usage_result()):
            good = antigravity_limits.fetch()
        with mock.patch.object(providers, "antigravity_status",
                               return_value=self.status), \
             mock.patch.object(antigravity_limits, "_run_usage",
                               side_effect=RuntimeError("offline")):
            stale = antigravity_limits.fetch(force=True)
        self.assertEqual(stale["limits"], good["limits"])
        self.assertIn("offline", stale["error"])

    def test_disconnected_account_never_spawns_usage(self):
        status = {**self.status, "connected": False}
        with mock.patch.object(providers, "antigravity_status",
                               return_value=status), \
             mock.patch.object(antigravity_limits, "_run_usage") as run:
            out = antigravity_limits.fetch(force=True)
        self.assertFalse(out["available"])
        self.assertTrue(out["reauth_required"])
        run.assert_not_called()

    def test_old_cli_never_spawns_usage(self):
        status = {**self.status, "version": "1.1.24"}
        with mock.patch.object(providers, "antigravity_status",
                               return_value=status), \
             mock.patch.object(antigravity_limits, "_run_usage") as run:
            out = antigravity_limits.fetch(force=True)
        self.assertFalse(out["available"])
        self.assertTrue(out["unsupported"])
        self.assertIn("1.2.0", out["error"])
        run.assert_not_called()

    def test_runner_uses_structured_read_only_print_command(self):
        completed = mock.Mock(returncode=0, stderr="", stdout=(
            "banner\n" + json.dumps(usage_result()) + "\n"))
        with mock.patch.object(providers, "antigravity_probe_dir",
                               return_value=_root.name), \
             mock.patch.object(providers, "antigravity_argv",
                               return_value=["agy-test"]), \
             mock.patch.object(providers, "antigravity_env",
                               return_value={"SAFE": "1"}), \
             mock.patch.object(antigravity_limits.subprocess, "run",
                               return_value=completed) as run:
            parsed = antigravity_limits._run_usage("agy-test")
        self.assertEqual(parsed["command"]["name"], "usage")
        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index("--print") + 1], "/usage")
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        self.assertEqual(run.call_args.kwargs["stdin"],
                         antigravity_limits.subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["env"], {"SAFE": "1"})


class IntegrationRegressionTests(unittest.TestCase):
    def test_warm_loop_has_the_antigravity_reader_bound(self):
        self.assertIs(supervisor.antigravity_limits, antigravity_limits)

    def test_equal_quota_values_keep_distinct_safe_bucket_identity(self):
        raw = usage_result()
        groups = raw["command"]["data"]["groups"]
        groups[1]["buckets"][0].update(
            remaining_fraction=groups[0]["buckets"][0]["remaining_fraction"],
            reset_time=groups[0]["buckets"][0]["reset_time"],
        )
        board = antigravity_limits._normalize(raw, 1000.0)
        rows = turnusage._cached_rows(
            {**board, "age": 0.0, "stale": False},
            "antigravity", "account", 1000.0, False, False)
        weekly = [line for _key, line in rows if "weekly_scoped:" in line]
        self.assertEqual(len(weekly), 2)
        self.assertTrue(any("weekly_scoped:gemini-weekly" in line
                            for line in weekly))
        self.assertTrue(any("weekly_scoped:3p-weekly" in line
                            for line in weekly))


if __name__ == "__main__":
    unittest.main()
