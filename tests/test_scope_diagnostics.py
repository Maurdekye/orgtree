"""W11 scope diagnostics and harness classification tests."""
from __future__ import annotations

import tempfile
import unittest
import os
import subprocess
from pathlib import Path
from unittest import mock

# The authoritative Git path adapter imports the persistence layer. Keep this
# focused suite on disposable test storage rather than an installation root.
os.environ["ORGTREE_DATA"] = tempfile.mkdtemp(prefix="orgtree-w11-test-")
from engine.backend.orgtree import scope_diagnostics as sd


class ScopeDiagnosticsTests(unittest.TestCase):
    def test_own_scratch_wins_over_read_only_parent_grant(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scratch = root / "scratch"
            scratch.mkdir()
            got = sd.diagnose_target(
                str(scratch / "breadcrumbs.md"), "write", scratch=str(scratch),
                grants=[{"path": str(root), "mode": "ro"}],
            )
            self.assertTrue(got["operation"]["allowed"])
            self.assertEqual(got["org_grant"]["source"], "own_scratch")

    def test_conflicting_alias_grants_keep_the_restrictive_mode(self) -> None:
        if os.name != "nt":
            self.skipTest("case aliases are a Windows path concern")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "target"
            target.mkdir()
            got = sd.diagnose_target(
                str(target / "x"), "write", scratch=str(root / "scratch"),
                grants=[{"path": str(target), "mode": "rw"},
                        {"path": str(target).swapcase(), "mode": "ro"}],
            )
            self.assertFalse(got["operation"]["allowed"])

    def test_sibling_and_ungranted_path_are_denied(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scratch, sibling = root / "scratch", root / "sibling"
            scratch.mkdir(); sibling.mkdir()
            got = sd.diagnose_target(str(sibling / "x"), "read", scratch=str(scratch))
            self.assertFalse(got["operation"]["allowed"])
            self.assertEqual(got["decision"]["reason_code"], "org_grant_missing_or_read_only")

    def test_case_and_long_path_spellings_use_platform_containment(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            scratch = Path(folder) / "Scratch"
            scratch.mkdir()
            requested = str(scratch / ("nested-" + "x" * 180 + ".txt"))
            if os.name == "nt":
                requested = requested.swapcase()
            got = sd.diagnose_target(requested, "read", scratch=str(scratch))
            self.assertTrue(got["operation"]["allowed"])
            self.assertEqual(got["org_grant"]["source"], "own_scratch")

    def test_link_escape_is_reported_as_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scratch, outside = root / "scratch", root / "outside"
            scratch.mkdir(); outside.mkdir()
            link = scratch / "dependency"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            got = sd.diagnose_target(str(link / "secret.txt"), "read", scratch=str(scratch))
            self.assertFalse(got["operation"]["allowed"])
            self.assertEqual(got["decision"]["reason_code"], "path_escape")
            self.assertEqual(got["target"]["reparse_components"][0]["kind"], "symlink")

    def test_reparse_scratch_root_never_becomes_a_writable_live_target(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scratch, target = root / "scratch-link", root / "live-data"
            target.mkdir()
            # Exercise the same junction shape on hosts where creating a real
            # junction requires an unavailable privilege (the path adapter's
            # lstat test is covered by the W10 suite on capable hosts).
            def reparse(path: str) -> list[dict[str, str]]:
                return ([{"path": str(scratch), "kind": "reparse"}]
                        if os.path.normcase(os.path.abspath(path)) ==
                        os.path.normcase(os.path.abspath(str(scratch))) else [])
            with mock.patch.object(sd, "_reparse_components", side_effect=reparse):
                got = sd.diagnose_target(str(scratch / "secret.txt"), "write",
                                         scratch=str(scratch))
            self.assertFalse(got["operation"]["allowed"])
            self.assertEqual(got["decision"]["reason_code"], "path_escape")
            self.assertFalse(got["scratch"]["trusted"])

    def test_parent_alias_cannot_reach_junction_scratch_root(self) -> None:
        if os.name != "nt":
            self.skipTest("junction aliases are a Windows path concern")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            live = root / "live-data"
            scratch = root / "scratch"
            alias = root / "alias"
            live.mkdir()
            # Junctions are used instead of symlinks because the Windows
            # harness may deny symlink creation while permitting mklink /J.
            for link, target in ((scratch, live), (alias, root)):
                made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                                      check=False, capture_output=True)
                if made.returncode != 0:
                    self.skipTest("junction creation is unavailable")
            got = sd.diagnose_target(str(alias / "scratch" / "secret.txt"), "write",
                                     scratch=str(scratch))
            self.assertFalse(got["operation"]["allowed"])
            self.assertEqual(got["decision"]["reason_code"], "path_escape")
            self.assertFalse(got["scratch"]["trusted"])

    def test_nested_git_owner_is_explicit_not_inferred(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".git").mkdir()
            nested = root / "nested"
            nested.mkdir(); (nested / ".git").write_text("gitdir: ../.git", encoding="utf-8")
            got = sd.diagnose_target(str(nested / "file"), "read", scratch=str(root), git_owner="alice")
            self.assertEqual(got["git"]["root"].casefold(), str(nested).casefold())
            self.assertEqual(got["git"]["owner_source"], "explicit")

    def test_provider_and_sandbox_restrictions_are_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scratch, mounted = root / "scratch", root / "mounted"
            scratch.mkdir(); mounted.mkdir()
            got = sd.diagnose_target(
                str(mounted / "x"), "execute", scratch=str(scratch),
                grants=[{"path": str(mounted), "mode": "rw"}], provider="codex",
                provider_restrictions={"execute": "provider does not expose this operation"},
                sandboxed=True, sandbox_roots=[],
            )
            self.assertEqual(got["decision"]["reason_code"], "sandbox_restricted")
            self.assertEqual(got["provider"]["status"], "restricted")
            self.assertEqual(got["sandbox"]["status"], "restricted")

    def test_shell_result_preserves_exit_and_stderr_without_retry(self) -> None:
        got = sd.shell_result(127, "", "'grep' is not recognized", started=True, boundary=True)
        self.assertEqual(got["outcome"], "command_failed")
        self.assertEqual(got["owner"], "provider_or_os")
        self.assertTrue(got["blocked"])
        self.assertEqual(got["stderr"], "'grep' is not recognized")

    def test_external_reproduction_keeps_owner_and_refuses_bypass(self) -> None:
        result = sd.shell_result(1, "", "connection reset by peer", started=True, boundary=True)
        report = sd.reproduction_report(result, command=["external-tool", "probe"],
                                        owner="external_tool", environment={"shell": "cmd.exe"})
        self.assertEqual(report["owner"], "external_tool")
        self.assertTrue(report["result"]["blocked"])
        self.assertIn("does not alter the grant", report["bypass"])

    def test_mcp_names_use_active_grant_and_runtime_tools(self) -> None:
        got = sd.mcp_tool_names(
            {"box": {"tools": ["search"]}, "hidden": {"tools": ["secret"]}},
            granted=["box", "hidden"], ceiling=["box"],
            observed={"box": ["search", "ArtifactMetadata"]},
        )
        self.assertEqual(got, ["mcp__box__ArtifactMetadata", "mcp__box__search"])
        self.assertEqual(sd.mcp_prefixes(got), ["mcp__box__"])

    def test_mcp_tool_grant_does_not_widen_from_a_server_name(self) -> None:
        got = sd.diagnose_target(
            "mcp__hidden__secret", "mcp", scratch=".",
            tool_grants={"mcp": ["box"]},
        )
        self.assertFalse(got["operation"]["allowed"])
        self.assertEqual(got["decision"]["reason_code"], "tool_not_granted")

    def test_mcp_wildcard_grant_matches_launcher_semantics(self) -> None:
        got = sd.diagnose_target(
            "mcp__box__search", "mcp", scratch=".",
            tool_grants={"mcp": ["*"]},
        )
        self.assertTrue(got["operation"]["allowed"])

    def test_schema_names_do_not_invent_artifact_metadata(self) -> None:
        got = sd.schema_names([{"name": "mcp__box__search", "inputSchema": {}}])
        self.assertEqual(got["schema_fields"], ["inputSchema"])
        self.assertEqual(got["artifact_metadata"], [])
        explicit = sd.schema_names([{"name": "ArtifactMetadata", "schema": {}}])
        self.assertEqual(explicit["artifact_metadata"], ["ArtifactMetadata"])
        nested = sd.schema_names([{"name": "search", "inputSchema": {
            "$defs": {"ArtifactMetadata": {"type": "object"}}}}])
        self.assertEqual(nested["artifact_metadata"], ["ArtifactMetadata"])


if __name__ == "__main__":
    unittest.main()
