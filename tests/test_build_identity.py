"""Packaged and source build identity never borrow a nearby repository."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))
from orgtree import build_identity


SHA = "0123456789abcdef0123456789abcdef01234567"


class BuildIdentityTests(unittest.TestCase):
    def test_verified_checkout_uses_its_own_git_and_marks_source(self):
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            (root / ".git").mkdir()
            calls: list[list[str]] = []

            def run(argv, **kwargs):
                calls.append(argv)
                if argv[3:] == ["rev-parse", "--show-toplevel"]:
                    return subprocess.CompletedProcess(argv, 0, str(root) + "\n", "")
                if argv[3:] == ["rev-parse", "HEAD"]:
                    return subprocess.CompletedProcess(argv, 0, SHA + "\n", "")
                if argv[3:] == ["rev-parse", "--abbrev-ref", "HEAD"]:
                    return subprocess.CompletedProcess(argv, 0, "feature/w22\n", "")
                return subprocess.CompletedProcess(argv, 0, " M source.py\n", "")

            identity = build_identity.resolve_build_identity(root, run=run)
            self.assertEqual(identity, {
                "commit": SHA, "commit_short": SHA[:7], "branch": "feature/w22",
                "dirty": True, "provenance": "source",
            })
            self.assertTrue(all(argv[:2] == ["git", "-C"] for argv in calls), calls)

    def test_installed_runtime_uses_packaged_metadata_without_running_git(self):
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            info = root / "build-info.json"
            info.write_text(json.dumps({
                "version": "2.1.1", "channel": "release", "commit": SHA,
                "dirty": False, "builtAt": "2026-09-12T00:00:00Z", "sha256": {},
            }), encoding="utf-8")

            def must_not_run(*args, **kwargs):
                raise AssertionError("installed artifact must not inspect a nearby repository")

            identity = build_identity.resolve_build_identity(root, run=must_not_run)
            self.assertEqual(identity["commit"], SHA)
            self.assertEqual(identity["commit_short"], SHA[:7])
            self.assertEqual(identity["provenance"], "packaged")
            self.assertFalse(identity["dirty"])

    def test_missing_or_malformed_packaged_metadata_is_explicitly_unknown(self):
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            info = root / "build-info.json"
            for value in ("not json", {"commit": "nearby-head", "channel": "release", "dirty": False},
                          {"commit": 17, "channel": "release", "dirty": False}):
                info.write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")
                identity = build_identity.resolve_build_identity(root)
                self.assertEqual(identity["commit"], "unknown")
                self.assertEqual(identity["commit_short"], "unknown")
                self.assertEqual(identity["provenance"], "unknown")

    def test_artifact_root_is_not_process_cwd(self):
        module = "/installed/resources/engine/backend/orgtree/build_identity.py"
        self.assertTrue(str(build_identity.artifact_root_for(module)).endswith("installed\\resources"))

    def test_unknown_restart_notice_does_not_offer_a_fake_ancestry_command(self):
        from orgtree import events

        event = events.mint(
            "runtime.restart_notice", {"kind": "system", "id": "@system"},
            {"kind": "build", "commit": "unknown", "short": "unknown",
             "dirty": False, "pid": 1, "provenance": "unknown"},
            prev_pid=None, started_at="now", branch=None)
        text = events.render_agent(event)
        self.assertIn("identity is unknown", text)
        self.assertNotIn("git merge-base", text)


if __name__ == "__main__":
    unittest.main()
