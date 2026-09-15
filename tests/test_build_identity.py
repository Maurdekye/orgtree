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
                # A checkout has commits, not releases. package.json's number
                # changes with a checkout, so quoting it here would report a
                # version nobody installed.
                "version": None,
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
            self.assertEqual(identity["version"], "2.1.1")

    def test_packaged_version_carries_the_prerelease_label_it_was_built_with(self):
        """A prerelease is a different installation from the stable of the same
        number, so the label is part of the answer, not decoration to be cut."""
        for version in ("2.1.5-beta.4", "2.1.5", "2.0.9-dev.gab12cd34ef",
                        "2.0.9-dev.gab12cd34ef.dirty"):
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                (root / "build-info.json").write_text(json.dumps({
                    "version": version,
                    "channel": "dev" if "-dev." in version else "release",
                    "commit": SHA, "dirty": False,
                }), encoding="utf-8")
                identity = build_identity.resolve_build_identity(root)
                self.assertEqual(identity["version"], version)

    def test_an_unusable_version_never_costs_the_commit_beside_it(self):
        """The version is the field most likely to be wrong, and the least
        important one in the notice. A metadata file with a newline, a path, a
        novel or no version at all still reports its commit and provenance."""
        cases = [
            None, "", "   ", 17, ["2.1.5"], {"n": 1}, True,
            "not-a-version", "v2.1.5", "2.1", "2.1.5\nInstalled version: 9.9.9",
            "2.1.5 C:\\Users\\someone\\secret", "2.1.5-" + "x" * 200,
        ]
        for bad in cases:
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                payload = {"channel": "release", "commit": SHA, "dirty": False}
                if bad is not None:
                    payload["version"] = bad
                (root / "build-info.json").write_text(json.dumps(payload), encoding="utf-8")
                identity = build_identity.resolve_build_identity(root)
                self.assertIsNone(identity["version"], bad)
                self.assertEqual(identity["commit"], SHA, bad)
                self.assertEqual(identity["provenance"], "packaged", bad)

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
            prev_pid=None, started_at="now", branch=None, version=None)
        text = events.render_agent(event)
        self.assertIn("identity is unknown", text)
        self.assertNotIn("git merge-base", text)


def _notice(version, provenance="packaged", **over):
    """Render a restart notice through the real minting and rendering path."""
    from orgtree import events

    fields = {"prev_pid": 26100, "started_at": "2026-09-15T15:50:33Z", "branch": None,
              "version": version}
    fields.update(over)
    return events.render_agent(events.mint(
        "runtime.restart_notice", {"kind": "system", "id": "@system"},
        {"kind": "build", "commit": SHA, "short": SHA[:7], "dirty": False,
         "pid": 1344, "provenance": provenance},
        **fields))


class RestartNoticeVersionTests(unittest.TestCase):
    """The notice is how a person learns which packaged release just restarted,
    so the version has to be there, has to be honest when there isn't one, and
    must never arrive INSTEAD of the fields the notice already carried."""

    def test_packaged_release_is_named_in_the_notice(self):
        text = _notice("2.1.5-beta.4")
        self.assertIn("- Installed version: 2.1.5-beta.4", text)

    def test_a_development_package_is_not_dressed_up_as_a_release(self):
        text = _notice("2.0.9-dev.gab12cd34ef")
        self.assertIn("- Installed version: 2.0.9-dev.gab12cd34ef", text)
        # No stable number appears anywhere: the dev label is the whole value.
        self.assertNotIn("Installed version: 2.0.9\n", text)

    def test_a_source_checkout_says_so_rather_than_reporting_a_failure(self):
        text = _notice(None, provenance="source")
        self.assertIn("- Installed version: not applicable (running from a source checkout)",
                      text)
        self.assertNotIn("unavailable", text)

    def test_unreadable_packaged_metadata_says_unavailable_and_invents_nothing(self):
        text = _notice(None, provenance="packaged")
        self.assertIn("- Installed version: unavailable (no packaged build metadata)", text)
        # ⚠ THE WHOLE POINT OF NOT GUESSING. Nothing that looks like a release
        # number may appear on that line when there is no authoritative one.
        line = next(l for l in text.splitlines() if l.startswith("- Installed version:"))
        self.assertNotRegex(line, r"\d+\.\d+\.\d+")

    def test_unknown_identity_reports_unavailable_too(self):
        text = _notice(None, provenance="unknown")
        self.assertIn("- Installed version: unavailable", text)

    def test_every_field_the_notice_already_carried_survives(self):
        """This is the regression that matters most: a new line at the top of
        the block is exactly the change that quietly drops one below it."""
        text = _notice("2.1.5-beta.4", branch="feature/w22")
        for expected in (
            "[ORGTREE RESTART NOTICE]",
            f"- Commit: {SHA} (short: {SHA[:7]})",
            "- Identity provenance: packaged",
            "- Backend PID: 1344 (was: 26100)",
            "- Started at: 2026-09-15T15:50:33Z, branch: feature/w22",
            f"git merge-base --is-ancestor <your-commit> {SHA}",
            "orgtree_restart_wake",
        ):
            self.assertIn(expected, text)

    def test_the_version_leads_the_block_and_the_block_keeps_its_order(self):
        lines = [l for l in _notice("2.1.5-beta.4").splitlines() if l.startswith("- ")
                 or l == "Running build:"]
        self.assertEqual(lines[:5], [
            "Running build:",
            "- Installed version: 2.1.5-beta.4",
            f"- Commit: {SHA} (short: {SHA[:7]})",
            "- Identity provenance: packaged",
            "- Backend PID: 1344 (was: 26100)",
        ])

    def test_a_dirty_packaged_build_keeps_both_its_warning_and_its_version(self):
        from orgtree import events

        text = events.render_agent(events.mint(
            "runtime.restart_notice", {"kind": "system", "id": "@system"},
            {"kind": "build", "commit": SHA, "short": SHA[:7], "dirty": True,
             "pid": 1344, "provenance": "packaged"},
            prev_pid=None, started_at="now", branch=None, version="2.1.5-beta.4"))
        self.assertIn("- Installed version: 2.1.5-beta.4", text)
        self.assertIn("[DIRTY - uncommitted changes present at boot]", text)


class VersionReadFailureTests(unittest.TestCase):
    """A version that cannot be read must not cost anybody the notice itself.
    The end-to-end delivery proof needs a throwaway data root, so it lives in
    test_restart_notice_version.py; this module deliberately imports nothing
    that touches storage."""

    def test_an_absent_version_still_renders_a_complete_notice(self):
        """A boot record frozen by an older build carries no `version` key at
        all. restart_wake reads it with .get for exactly that reason."""
        from orgtree import events, events_render

        boot = {"commit": SHA, "commit_short": SHA[:7], "branch": None,
                "dirty": False, "provenance": "packaged",
                "backend_pid": 1344, "started_at": "now"}
        self.assertIsNone(boot.get("version"))
        self.assertEqual(
            events_render.installed_version_line(boot.get("version"),
                                                 boot.get("provenance") or "unknown"),
            "- Installed version: unavailable (no packaged build metadata)")
        text = events.render_agent(events.mint(
            "runtime.restart_notice", {"kind": "system", "id": "@system"},
            {"kind": "build", "commit": SHA, "short": SHA[:7], "dirty": False,
             "pid": 1344, "provenance": "packaged"},
            prev_pid=None, started_at="now", branch=None,
            version=boot.get("version")))
        self.assertIn("[ORGTREE RESTART NOTICE]", text)
        self.assertIn(f"- Commit: {SHA}", text)

    def test_resolving_identity_never_raises_on_a_hostile_metadata_file(self):
        """Startup calls this before anything else; it returns, always."""
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            for payload in (b"", b"\x00\x01\x02", b"[]", b"{\"version\": \"2.1.5\"}",
                            ("{\"version\": \"" + "9" * 5000 + "\"}").encode("utf-8")):
                (root / "build-info.json").write_bytes(payload)
                identity = build_identity.resolve_build_identity(root)
                self.assertIn(identity["provenance"], ("packaged", "unknown"))
                self.assertIn("version", identity)


if __name__ == "__main__":
    unittest.main()
