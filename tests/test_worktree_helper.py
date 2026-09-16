"""Focused W10 safety controls (no Git repository mutation required)."""
from __future__ import annotations

import subprocess
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


def make_link(link: Path, target: Path) -> None:
    """Create a directory link, preferring the kind the incidents involved.

    ⚠ A WINDOWS JUNCTION, NOT A SYMLINK, wherever one can be made. Symlink
    creation needs privilege the test account usually lacks, which is why the
    older cases here skip — and skipping is exactly wrong for these: a junction
    is what fourteen agents actually created and what `remove --force` followed
    out of a checkout. `mklink /J` needs no privilege, so the guards below are
    exercised against the real shape rather than skipped past.
    """
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                                capture_output=True, text=True)
        if result.returncode == 0 and worktree.is_reparse(str(link)):
            return
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        raise unittest.SkipTest("directory link creation is unavailable") from error


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
            make_link(link, target)
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
            make_link(link, target)
            preview = worktree.cleanup_preview(folder, [str(link)], owned=[str(link)])
            with mock.patch.object(worktree.os, "readlink", return_value="different-target"):
                result = worktree.apply_cleanup(preview, confirm=True)
            self.assertEqual(result["removed"], [])
            self.assertEqual(result["targets"][0]["action"], "preserve")
            self.assertTrue(worktree.is_reparse(str(link)))

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


class DependencyResolutionTests(unittest.TestCase):
    """The rule itself: a worktree under the root resolves node_modules upward."""

    def test_upward_resolution_finds_a_parent_dependency_tree(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "node_modules").mkdir()
            nested = root / ".worktrees" / "agent"
            nested.mkdir(parents=True)
            answer = worktree.dependency_resolution(str(nested))
            self.assertTrue(answer["resolves"])
            self.assertFalse(answer["linked"])
            # Not the worktree's own directory — the point is that it has none.
            self.assertFalse(answer["own"])
            self.assertEqual(answer["resolved"], worktree.canonical(root / "node_modules"))

    def test_a_worktree_with_no_tree_anywhere_above_it_reports_that_honestly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            # A real parent chain could carry a node_modules; only assert the
            # negative when this machine's chain genuinely has none.
            answer = worktree.dependency_resolution(folder)
            if answer["resolves"]:
                self.skipTest("an ancestor of the temp directory carries node_modules")
            self.assertIsNone(answer["resolved"])
            self.assertIn("cannot run", answer["note"])

    def test_a_linked_dependency_directory_is_reported_as_a_link(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "real").mkdir()
            make_link(root / "node_modules", root / "real")
            answer = worktree.dependency_resolution(str(root))
            self.assertTrue(answer["resolves"])
            self.assertTrue(answer["linked"])
            self.assertIn("loses data", answer["note"])


class JunctionGateTests(unittest.TestCase):
    """The junction is the shape that hurt people; it must be hard to reach."""

    def test_linking_is_refused_when_dependencies_already_resolve_upward(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "node_modules").mkdir()
            (root / "node_modules" / "marker.txt").write_text("x", encoding="utf-8")
            nested = root / ".worktrees" / "agent"
            nested.mkdir(parents=True)
            # Even asking for it in as many words does not get it, because here
            # the link would buy nothing at all.
            with self.assertRaises(ValueError) as caught:
                worktree.dependency_setup(
                    str(nested), dependency_source=str(root / "node_modules"),
                    accept_shared_dependencies=True, apply=True)
            self.assertIn("already resolves it upward", str(caught.exception))
            # And nothing was created, so the refusal is not merely advisory.
            self.assertEqual(worktree._entry_kind(str(nested / "node_modules")), "missing")

    def test_linking_needs_an_explicit_opt_in_even_with_no_upward_tree(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "source", root / "checkout"
            source.mkdir()
            target.mkdir()
            if worktree.dependency_resolution(str(target))["resolves"]:
                self.skipTest("an ancestor of the temp directory carries node_modules")
            with self.assertRaises(ValueError) as caught:
                worktree.dependency_setup(str(target), dependency_source=str(source), apply=True)
            self.assertIn("accept_shared_dependencies", str(caught.exception))
            self.assertEqual(worktree._entry_kind(str(target / "node_modules")), "missing")

    def test_the_opt_in_route_still_works_when_it_is_genuinely_asked_for(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "source", root / "checkout"
            source.mkdir()
            target.mkdir()
            if worktree.dependency_resolution(str(target))["resolves"]:
                self.skipTest("an ancestor of the temp directory carries node_modules")
            plan = worktree.dependency_setup(str(target), dependency_source=str(source),
                                             accept_shared_dependencies=True, apply=False)
            self.assertFalse(plan["dependency_link"]["applied"])
            self.assertEqual(plan["dependency_link"]["source"], worktree.canonical(source))

    def test_a_plain_setup_reports_where_dependencies_come_from(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "node_modules").mkdir()
            nested = root / ".worktrees" / "agent"
            nested.mkdir(parents=True)
            (nested / "package.json").write_text("{}", encoding="utf-8")
            plan = worktree.dependency_setup(str(nested))
            self.assertTrue(plan["dependencies"]["resolves"])
            self.assertIn("no install and no link are needed", plan["note"])

    def test_the_engine_surface_gates_the_junction_the_same_way(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "node_modules").mkdir()
            nested = root / ".worktrees" / "agent"
            nested.mkdir(parents=True)
            repo = {"common": "COMMON"}
            with mock.patch.object(gitworkspace, "identify", return_value={"common": "COMMON"}):
                with self.assertRaises(gitworkspace.GitError) as caught:
                    gitworkspace.worktree_setup(
                        repo, str(nested), dependency_source=str(root / "node_modules"),
                        accept_shared_dependencies=True, apply=True)
            self.assertIn("already resolves it upward", str(caught.exception))
            self.assertEqual(worktree._entry_kind(str(nested / "node_modules")), "missing")


class RemovalSafetyTests(unittest.TestCase):
    """`remove --force` following a link out of the worktree is the 783 MB bug."""

    def test_scan_finds_an_escaping_link_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside, inside = root / "outside", root / "checkout"
            outside.mkdir()
            (outside / "precious.txt").write_bytes(b"do not delete")
            (inside / "nested").mkdir(parents=True)
            make_link(inside / "nested" / "node_modules", outside)
            scan = worktree.removal_scan(str(inside))
            self.assertEqual(len(scan["escaping"]), 1)
            self.assertFalse(scan["force_safe"])
            # The scan read the link; it never walked through it.
            self.assertTrue((outside / "precious.txt").exists())

    def test_a_link_that_stays_inside_the_worktree_does_not_block_a_force(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "real").mkdir()
            make_link(root / "alias", root / "real")
            scan = worktree.removal_scan(str(root))
            self.assertEqual(len(scan["links"]), 1)
            self.assertEqual(scan["escaping"], [])
            self.assertTrue(scan["force_safe"])

    def test_plan_remove_refuses_force_through_an_escaping_link(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside, inside = root / "outside", root / "checkout"
            outside.mkdir()
            inside.mkdir()
            make_link(inside / "node_modules", outside)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside), force=True)
                self.assertFalse(plan["safe"])
                self.assertIn("deletes through them", plan["refusals"][0])
                with mock.patch.object(worktree.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        worktree.remove(str(root), str(inside), force=True)
                run.assert_not_called()

    def test_an_ordinary_worktree_removes_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            inside.mkdir(parents=True)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertTrue(plan["safe"])
            self.assertEqual(plan["refusals"], [])
            self.assertNotIn("--force", plan["command"])

    def test_a_dirty_worktree_is_not_removed_by_accident(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            inside.mkdir(parents=True)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(True, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertFalse(plan["safe"])
            self.assertIn("uncommitted", plan["refusals"][0])

    def test_removing_the_main_checkout_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(folder)):
                with self.assertRaises(ValueError) as caught:
                    worktree.plan_remove(folder, folder)
            self.assertIn("main checkout", str(caught.exception))


class PlacementTests(unittest.TestCase):
    """A worktree outside the repository root is the shape that invites a junction."""

    def test_default_placement_is_under_the_repository_root(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(folder)):
                plan = worktree.plan_add(folder, "agent-x", base="main")
            self.assertTrue(plan["inside_repository_root"])
            self.assertFalse(plan["dependency_junction"])
            self.assertEqual(plan["path"],
                             worktree.canonical(Path(folder) / worktree.WORKTREES_DIR / "agent-x"))
            self.assertEqual(plan["branch"], "agent-x")
            self.assertIn("worktree", plan["command"])

    def test_a_destination_outside_the_root_is_refused_and_says_why(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, elsewhere = Path(folder) / "repo", Path(folder) / "elsewhere"
            root.mkdir()
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(root)):
                with self.assertRaises(ValueError) as caught:
                    worktree.plan_add(str(root), "agent-x", path=str(elsewhere))
                message = str(caught.exception)
                self.assertIn("outside the repository root", message)
                self.assertIn("783 MB", message)
                # Still reachable deliberately, so this is a guard and not a wall.
                plan = worktree.plan_add(str(root), "agent-x", path=str(elsewhere),
                                         allow_outside_root=True)
            self.assertFalse(plan["inside_repository_root"])

    def test_a_name_that_is_not_a_single_segment_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(folder)):
                for bad in ("a/b", "a\\b", " leading", "trailing "):
                    with self.assertRaises(ValueError):
                        worktree.plan_add(folder, bad)

    def test_an_existing_destination_is_refused_rather_than_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            existing = Path(folder) / worktree.WORKTREES_DIR / "agent-x"
            existing.mkdir(parents=True)
            (existing / "work.txt").write_text("mine", encoding="utf-8")
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(folder)):
                with self.assertRaises(ValueError) as caught:
                    worktree.plan_add(folder, "agent-x")
            self.assertIn("already exists", str(caught.exception))
            self.assertEqual((existing / "work.txt").read_text(encoding="utf-8"), "mine")

    def test_a_worktree_inside_dot_git_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with mock.patch.object(worktree, "repository_root",
                                   return_value=worktree.canonical(root)):
                with self.assertRaises(ValueError) as caught:
                    worktree.plan_add(str(root), "agent-x", path=str(root / ".git" / "agent-x"))
            self.assertIn(".git", str(caught.exception))


class BundledRuntimeDiscoveryTests(unittest.TestCase):
    """The same upward rule, applied to the other gitignored dependency directory.

    ``engine/runtime`` is gitignored exactly like ``node_modules``, so it exists
    in the main checkout and in no worktree. When the verification runner looked
    for it only beside the checkout it was given, running from a worktree fell
    through to the system interpreter — which it launches with ``-I``, dropping
    user site-packages — and every engine-importing module died at
    ``import typing_extensions`` with an error that named neither the runtime
    nor the worktree.
    """

    @staticmethod
    def _runner():
        # Loaded by path because the filename has hyphens and is not importable
        # as a module name. ⚠ It must be registered in sys.modules BEFORE it is
        # executed: @dataclass resolves annotations through
        # sys.modules[cls.__module__], and without the entry that lookup returns
        # None and the decorator raises AttributeError on __dict__.
        import importlib.util
        import sys
        name = "orgtree_run_python_verification"
        if name in sys.modules:
            return sys.modules[name]
        path = Path(__file__).resolve().parent.parent / "tools" / "run-python-verification.py"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            del sys.modules[name]
            raise
        return module

    def test_a_worktree_finds_the_runtime_owned_by_the_checkout_above_it(self) -> None:
        runner = self._runner()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worktree_path = root / ".worktrees" / "agent"
            worktree_path.mkdir(parents=True)
            candidates = [str(c) for c in runner.bundled_runtime_candidates(worktree_path)]
            expected = str(runner._canonical(root / "engine" / "runtime" / "python.exe"))
            self.assertIn(expected, candidates)
            # The worktree's own location is still tried first, so a checkout
            # that does own a runtime keeps using its own.
            own = str(runner._canonical(worktree_path / "engine" / "runtime" / "python.exe"))
            self.assertEqual(candidates[0], own)
            self.assertLess(candidates.index(own), candidates.index(expected))

    def test_the_walk_terminates_at_the_filesystem_root(self) -> None:
        runner = self._runner()
        with tempfile.TemporaryDirectory() as folder:
            candidates = runner.bundled_runtime_candidates(Path(folder))
            self.assertTrue(candidates)
            # One entry per ancestor inclusive, and no repeats.
            self.assertEqual(len(candidates), len({str(c) for c in candidates}))
            # The last candidate belongs to the filesystem root, which is how
            # the loop is known to terminate rather than to have been cut short.
            # Each candidate is <dir>/engine/runtime/python.exe, so parents[2]
            # is the <dir> it was built from.
            self.assertEqual(str(candidates[-1].parents[2]),
                             str(runner._canonical(Path(folder)).anchor))


if __name__ == "__main__":
    unittest.main()
