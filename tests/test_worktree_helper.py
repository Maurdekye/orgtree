"""Focused W10 safety controls (no Git repository mutation required)."""
from __future__ import annotations

import tempfile
import os
from pathlib import Path
import unittest
from unittest import mock

from tools import worktree
# gitworkspace imports the persistence layer, which must never point focused
# tests at the live installation data root.
os.environ["ORGTREE_DATA"] = tempfile.mkdtemp(prefix="orgtree-w10-test-")
from engine.backend.orgtree import gitworkspace


class WorktreeHelperTests(unittest.TestCase):
    def test_rename_repairs_only_contained_registered_paths(self) -> None:
        registry = {"repositories": {"r": {"worktree_agents": {
            "alice": ["C:/scratch/old/project", "C:/scratch/oldish/project"]}}}}
        repaired, moved = worktree.repair_registered_worktrees(
            registry, "C:/scratch/old", "C:/scratch/new")
        self.assertEqual(len(moved), 1)
        self.assertTrue(repaired["repositories"]["r"]["worktree_agents"]["alice"][0].lower().endswith("new\\project"))
        self.assertEqual(repaired["repositories"]["r"]["worktree_agents"]["alice"][1], "C:/scratch/oldish/project")

    def test_setup_plan_is_lockfile_based_and_does_not_write_git_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "package.json").write_text("{}", encoding="utf-8")
            (root / "package-lock.json").write_text("{}", encoding="utf-8")
            plan = worktree.dependency_setup(folder)
            self.assertEqual(plan["command"], ["npm", "ci"])
            self.assertFalse(plan["git_metadata_write"])
            self.assertNotIn("dependency_link", plan)

    def test_cleanup_protects_operation_only_worktree(self) -> None:
        state = {"count": 0, "conflicted": 0, "operations": ["MERGE_HEAD"]}
        self.assertTrue(gitworkspace.worktree_protected(state))
        preview = gitworkspace.preview_worktree_cleanup(
            "C:/checkout", ["node_modules"], owned=["C:/checkout/node_modules"],
            protected=gitworkspace.worktree_protected(state))
        self.assertEqual(preview["unlinkable"], 0)
        self.assertEqual(preview["targets"][0]["reason"],
                         "worktree is dirty, unmerged, or actively referenced")

    def test_cleanup_preview_preserves_ordinary_entries(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            ordinary = Path(folder) / "ordinary"
            ordinary.write_text("keep", encoding="utf-8")
            preview = worktree.cleanup_preview(folder, [str(ordinary)], owned=[str(ordinary)])
            self.assertEqual(preview["unlinkable"], 0)
            self.assertTrue(ordinary.exists())

    def test_cleanup_unlinks_link_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, target = Path(folder), Path(folder) / "target"
            target.mkdir()
            (target / "sentinel").write_bytes(b"unchanged")
            link = root / "owned-link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            preview = worktree.cleanup_preview(folder, [str(link)], owned=[str(link)])
            self.assertEqual(preview["unlinkable"], 1)
            result = worktree.apply_cleanup(preview, confirm=True)
            self.assertEqual(result["removed"], [worktree.canonical(link)])
            self.assertFalse(link.exists())
            self.assertEqual((target / "sentinel").read_bytes(), b"unchanged")

    def test_cleanup_preserves_link_when_target_changes_after_preview(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, target = Path(folder), Path(folder) / "target"
            target.mkdir()
            link = root / "owned-link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            preview = worktree.cleanup_preview(folder, [str(link)], owned=[str(link)])
            with mock.patch.object(worktree.os, "readlink", return_value="different-target"):
                result = worktree.apply_cleanup(preview, confirm=True)
            self.assertEqual(result["removed"], [])
            self.assertEqual(result["targets"][0]["action"], "preserve")
            self.assertTrue(link.is_symlink())

    def test_cleanup_does_not_unlink_replaced_entry_without_filesystem_links(self) -> None:
        preview = {"targets": [{"path": "C:/checkout/dependency", "action": "unlink", "owned": True,
                                 "kind": "symlink", "identity": ["symlink", 1],
                                 "target": "old-target"}]}
        with mock.patch.object(worktree, "_entry_kind", return_value="symlink"), \
                mock.patch.object(worktree, "_entry_identity", return_value=("symlink", 1)), \
                mock.patch.object(worktree.os, "readlink", return_value="new-target"), \
                mock.patch.object(worktree.os, "unlink") as unlink:
            result = worktree.apply_cleanup(preview, confirm=True)
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["targets"][0]["action"], "preserve")
        unlink.assert_not_called()


if __name__ == "__main__":
    unittest.main()
