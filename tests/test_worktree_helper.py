"""Focused W10 safety controls (no Git repository mutation required)."""
from __future__ import annotations

import contextlib
import io
import json
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


class UnforcedRemovalTests(unittest.TestCase):
    """The un-forced removal is the one an agent actually reaches.

    ⚠ MEASURED, not assumed (git 2.52.0.windows.1, worktree under the repository
    root, ``node_modules`` junction pointing outside it): ``git worktree remove``
    with NO flags exited 0 and emptied the junction's target, exactly as
    ``--force`` did. ``--force`` overrides the dirty/untracked CHECK; it does not
    change how Git deletes the tree.

    That matters because a ``node_modules`` junction is gitignored, so ``status``
    calls the worktree clean and none of the force-only refusals apply. Gating
    the link check on ``force`` guarded the careful route and left the default
    one wide open. These cases pin the correction: the link check is not about
    ``force`` and must never be put back behind it.
    """

    def _escaping_worktree(self, root: Path) -> Path:
        outside, inside = root / "outside", root / "checkout"
        outside.mkdir()
        (outside / "precious.txt").write_bytes(b"do not delete")
        inside.mkdir()
        make_link(inside / "node_modules", outside)
        return inside

    def test_plan_remove_refuses_an_unforced_removal_through_an_escaping_link(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertFalse(plan["force"])
            self.assertFalse(plan["safe"])
            self.assertIn("deletes through them", plan["refusals"][0])
            # The message must not claim this was a --force refusal, because it
            # was not; an agent told "refusing --force" on a plain remove drops
            # the flag it never passed and believes it has worked around it.
            self.assertNotIn("refusing --force", plan["refusals"][0])
            self.assertIn("WITHOUT --force", plan["refusals"][0])

    def test_remove_never_runs_git_when_a_link_escapes_and_no_force_was_asked(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)), \
                    mock.patch.object(worktree.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    worktree.remove(str(root), str(inside))
            run.assert_not_called()
            self.assertTrue((root / "outside" / "precious.txt").exists())

    def test_a_clean_worktree_is_still_refused_because_the_junction_is_gitignored(self) -> None:
        # The exact live shape: git reports nothing to commit, so every
        # force-only refusal is silent, and only the link check stands between
        # the removal and somebody else's dependency tree.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertFalse(plan["dirty"])
            self.assertFalse(plan["unmerged"])
            self.assertEqual(len(plan["refusals"]), 1)
            self.assertFalse(plan["safe"])

    def test_a_truncated_scan_refuses_without_force_too(self) -> None:
        stopped = {"worktree": "w", "links": [], "escaping": [], "entries_scanned": 1,
                   "truncated": True, "removal_safe": False, "force_safe": False}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            inside.mkdir(parents=True)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)), \
                    mock.patch.object(worktree, "removal_scan", return_value=stopped):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertFalse(plan["safe"])
            self.assertIn("would be a guess", plan["refusals"][0])

    def test_force_still_means_discard_changes_and_never_means_cross_a_link(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(True, False, True)):
                forced = worktree.plan_remove(str(root), str(inside), force=True)
                plain = worktree.plan_remove(str(root), str(inside))
            # force clears the dirty refusal...
            self.assertFalse(any("uncommitted" in r for r in forced["refusals"]))
            self.assertTrue(any("uncommitted" in r for r in plain["refusals"]))
            # ...and clears nothing about the link, in either direction.
            self.assertFalse(forced["safe"])
            self.assertFalse(plain["safe"])
            self.assertTrue(any("deletes through them" in r for r in forced["refusals"]))
            self.assertTrue(any("deletes through them" in r for r in plain["refusals"]))

    def test_a_worktree_with_a_real_installed_dependency_tree_is_still_removable(self) -> None:
        """⚠ The regression the un-gating nearly introduced.

        A junctioned ``node_modules`` is a reparse point and is never descended
        into, so it scans small. A REAL one is walked, and measured at 61,324
        entries it used to blow a 50,000-entry budget - which, once the
        truncation refusal stopped depending on ``--force``, would have made
        every worktree anybody ran ``npm install`` in permanently unremovable,
        with no way out in the message. Those are exactly the checkouts that
        need cleaning up. Reported by worktree-setup in review.
        """
        self.assertGreater(worktree.SCAN_LIMIT, 61324,
                           "the budget must clear a real installed node_modules")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            (inside / "node_modules" / "pkg").mkdir(parents=True)
            (inside / "node_modules" / "pkg" / "index.js").write_bytes(b"")
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertEqual(plan["refusals"], [])
            self.assertTrue(plan["safe"])

    def test_accept_unscanned_waives_only_the_unknown(self) -> None:
        stopped = {"worktree": "w", "links": [], "escaping": [], "entries_scanned": 1,
                   "truncated": True, "removal_safe": False, "force_safe": False}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            inside.mkdir(parents=True)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)), \
                    mock.patch.object(worktree, "removal_scan", return_value=stopped):
                waived = worktree.plan_remove(str(root), str(inside), accept_unscanned=True)
            self.assertTrue(waived["safe"])
            self.assertEqual(waived["refusals"], [])

    def test_accept_unscanned_never_waives_a_link_the_scan_actually_found(self) -> None:
        # The distinction the flag exists to preserve: "I could not finish
        # looking" is waivable, "I looked and found a door out of the tree" is
        # not. Overloading one word into both is the original defect.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside),
                                            force=True, accept_unscanned=True)
            self.assertFalse(plan["safe"])
            self.assertTrue(any("deletes through them" in r for r in plan["refusals"]))

    def test_the_refusal_points_at_a_command_that_can_actually_do_the_job(self) -> None:
        # It used to name cleanup-preview, which cannot: the CLI passed it no
        # `owned` list, so every candidate came back preserved. Reachable only
        # via --force before; this change makes it the default experience.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)):
                plan = worktree.plan_remove(str(root), str(inside))
            self.assertIn("cleanup-scan", plan["refusals"][0])
            self.assertNotIn("cleanup-preview", plan["refusals"][0])

    def test_removal_safe_is_reported_beside_the_older_force_safe_name(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = self._escaping_worktree(root)
            scan = worktree.removal_scan(str(inside))
            self.assertFalse(scan["removal_safe"])
            self.assertEqual(scan["removal_safe"], scan["force_safe"])


class CleanupScanTests(unittest.TestCase):
    """Enumeration was the missing half: nothing produced a candidate list.

    ``cleanup_preview`` could always validate a path, but the CLI called it with
    no ``owned`` argument, so every candidate came back "not registered as an
    owned link" and no cleanup could ever be run from the command line.
    """

    def test_an_escaping_dependency_link_is_found_and_selected(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scanned, outside = root / "scratch", root / "real"
            outside.mkdir()
            (outside / "precious.txt").write_bytes(b"the real dependency tree")
            (scanned / "agent" / "wt").mkdir(parents=True)
            make_link(scanned / "agent" / "wt" / "node_modules", outside)
            plan = worktree.cleanup_scan(str(scanned))
            self.assertEqual(plan["selection"]["selected"], 1)
            self.assertEqual(plan["unlinkable"], 1)
            # Found by reading the entry, never by walking through it.
            self.assertTrue((outside / "precious.txt").exists())

    def test_a_link_that_stays_inside_the_scanned_root_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "real").mkdir()
            (root / "wt").mkdir()
            make_link(root / "wt" / "node_modules", root / "real")
            plan = worktree.cleanup_scan(str(root))
            self.assertEqual(plan["selection"]["selected"], 0)
            self.assertEqual(plan["unlinkable"], 0)
            self.assertEqual(plan["preserved"], 1)

    def test_a_link_with_another_name_is_listed_but_not_selected(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside = root / "elsewhere"
            outside.mkdir()
            (root / "wt").mkdir()
            make_link(root / "wt" / "cache", outside)
            plan = worktree.cleanup_scan(str(root))
            self.assertEqual(plan["selection"]["links_found"], 1)
            self.assertEqual(plan["selection"]["selected"], 0)
            self.assertEqual(plan["preserved"], 1)

    def test_a_real_dependency_directory_is_recorded_and_not_descended(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            heavy = root / "wt" / "node_modules" / "pkg"
            heavy.mkdir(parents=True)
            (heavy / "index.js").write_bytes(b"")
            survey = worktree.find_reparse_points(str(root))
            self.assertEqual(survey["links"], [])
            self.assertTrue(any(worktree.canonical(p) == worktree.canonical(root / "wt" / "node_modules")
                                for p in survey["skipped_directories"]))

    def test_the_entry_budget_is_reported_rather_than_applied_quietly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index in range(6):
                (root / f"d{index}").mkdir()
            survey = worktree.find_reparse_points(str(root), limit=2)
            self.assertTrue(survey["truncated"])
            self.assertFalse(survey["complete"])

    def test_the_depth_bound_is_reported_rather_than_applied_quietly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a" / "b").mkdir(parents=True)
            survey = worktree.find_reparse_points(str(root), max_depth=2)
            self.assertTrue(survey["depth_limited"])
            self.assertFalse(survey["exhaustive"])

    def test_a_depth_bound_is_a_scope_statement_and_a_truncation_is_a_failure(self) -> None:
        # Folding these into one flag makes the useful one useless: on any real
        # tree something is always deeper than the bound, so a combined flag
        # reads False forever and stops meaning anything.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a" / "b").mkdir(parents=True)
            bounded = worktree.find_reparse_points(str(root), max_depth=2)
            self.assertTrue(bounded["complete"], "the requested depth WAS fully examined")
            self.assertFalse(bounded["exhaustive"], "but something below it was not")
            for index in range(6):
                (root / f"d{index}").mkdir()
            stopped = worktree.find_reparse_points(str(root), limit=2)
            self.assertFalse(stopped["complete"], "running out of budget is a real failure")

    def test_the_plan_states_the_safe_order_and_names_the_tool_that_destroys(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            plan = worktree.cleanup_scan(str(Path(folder)))
            self.assertEqual([s["step"] for s in plan["remediation"]], [1, 2])
            self.assertIn("rmdir", plan["remediation"][0]["command"])
            # Doing it the other way round IS the incident, and a recursive
            # delete is the tool that follows the link instead of removing it.
            self.assertIn("Remove-Item -Recurse", plan["remediation"][0]["never"])

    def test_a_truncated_scan_says_INCOMPLETE_in_the_plan_the_operator_reads(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index in range(6):
                (root / f"d{index}").mkdir()
            plan = worktree.cleanup_scan(str(root), limit=2)
            self.assertFalse(plan["complete"])
            self.assertIn("INCOMPLETE", plan["note"])
            self.assertIn("--limit", plan["note"])

    def test_a_depth_bounded_scan_states_its_scope_without_crying_incomplete(self) -> None:
        # It did everything it was asked to do. Calling that INCOMPLETE would
        # make the word meaningless, since a real tree always has something
        # below any bound - and then a genuinely truncated scan reads the same
        # as a healthy one.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a" / "b").mkdir(parents=True)
            plan = worktree.cleanup_scan(str(root), max_depth=2)
            self.assertTrue(plan["complete"])
            self.assertFalse(plan["exhaustive"])
            self.assertFalse(plan["census"])
            self.assertNotIn("INCOMPLETE", plan["note"])
            self.assertIn("not descended into", plan["note"])

    def test_a_bounded_scan_leads_with_the_undercount_not_a_footnote(self) -> None:
        """⚠ A bounded scan that still selected something is the dangerous shape.

        It looks like a finished cleanup. Whoever runs it is reading for a
        number, so the caveat has to arrive before the remediation steps rather
        than after them. Raised by worktree-setup after measuring 5 links below
        a depth-4 bound in the primary scratch root and 49 in the second.
        """
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside, scanned = root / "elsewhere", root / "scratch"
            outside.mkdir()
            (scanned / "shallow").mkdir(parents=True)
            make_link(scanned / "shallow" / "node_modules", outside)
            (scanned / "a" / "b" / "c").mkdir(parents=True)
            plan = worktree.cleanup_scan(str(scanned), max_depth=3)
            self.assertEqual(plan["selection"]["selected"], 1)
            self.assertFalse(plan["census"])
            self.assertTrue(plan["note"].startswith("⚠"), plan["note"][:60])
            self.assertIn("NOT in its counts", plan["note"])
            self.assertIn("leave the deeper ones in place", plan["note"])

    def test_census_is_true_only_when_nothing_at_all_was_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "flat").mkdir()
            plan = worktree.cleanup_scan(str(root))
            self.assertTrue(plan["census"])
            self.assertNotIn("⚠", plan["note"])

    def test_raising_depth_without_budget_finds_fewer_links_not_more(self) -> None:
        """The coupling that made a depth-6 scan find 11 links where depth 4 found 77.

        Pinned because the conclusion is counter-intuitive and a future reader
        tuning these constants will otherwise reach for depth alone.
        """
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside = root / "elsewhere"
            outside.mkdir()
            # A wide shallow tree: deepening the walk spends budget on entries
            # that contain nothing, before the scan ever reaches the link.
            for index in range(12):
                padding = root / f"wide{index}" / "deeper"
                padding.mkdir(parents=True)
                for leaf in range(8):
                    (padding / f"leaf{leaf}").mkdir()
            make_link(root / "wide0" / "node_modules", outside)
            shallow = worktree.find_reparse_points(str(root), max_depth=2, limit=60)
            deep = worktree.find_reparse_points(str(root), max_depth=9, limit=60)
            self.assertEqual(len(shallow["links"]), 1)
            self.assertTrue(deep["truncated"])
            self.assertLessEqual(len(deep["links"]), len(shallow["links"]))

    def test_scan_then_apply_unlinks_the_link_and_leaves_the_target(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            scanned, outside = root / "scratch", root / "real"
            outside.mkdir()
            (outside / "precious.txt").write_bytes(b"the real dependency tree")
            (scanned / "wt").mkdir(parents=True)
            link = scanned / "wt" / "node_modules"
            make_link(link, outside)
            plan = worktree.cleanup_scan(str(scanned))
            applied = worktree.apply_cleanup(plan, confirm=True)
            self.assertEqual(len(applied["removed"]), 1)
            self.assertFalse(link.exists())
            # The whole point: the link is gone, the target is untouched.
            self.assertTrue((outside / "precious.txt").exists())
            self.assertEqual((outside / "precious.txt").read_bytes(), b"the real dependency tree")

    def test_a_plan_survives_a_json_round_trip_because_that_is_how_it_is_run(self) -> None:
        # The operator runs `cleanup-scan > plan.json` and then
        # `cleanup-apply plan.json`, so the identity tuple reaches apply as a
        # list. If that comparison were type-sensitive the plan would preserve
        # everything and the cleanup would silently do nothing.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside = root / "real"
            outside.mkdir()
            (outside / "precious.txt").write_bytes(b"x")
            (root / "scratch" / "wt").mkdir(parents=True)
            make_link(root / "scratch" / "wt" / "node_modules", outside)
            plan = json.loads(json.dumps(worktree.cleanup_scan(str(root / "scratch"))))
            applied = worktree.apply_cleanup(plan, confirm=True)
            self.assertEqual(len(applied["removed"]), 1)
            self.assertTrue((outside / "precious.txt").exists())

    def test_applying_without_confirmation_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(ValueError):
                worktree.apply_cleanup(worktree.cleanup_scan(str(root)))

    def test_the_cli_defaults_match_the_api_defaults(self) -> None:
        """⚠ A CLI default below the API default is an invisible undercount.

        This shipped once: ``--limit`` defaulted to ``SCAN_LIMIT`` (the
        per-worktree budget) while ``cleanup_scan`` defaults to
        ``SCAN_ROOT_LIMIT`` (the whole-root one, 5x larger). The command
        truncated a 572,301-entry root at 400,000 and reported 64 links where
        the library call on the same root reported 82 - and the operator running
        the cleanup is on the command line.
        """
        args = worktree.build_parser().parse_args(["cleanup-scan", "some-root"])
        self.assertEqual(args.limit, worktree.SCAN_ROOT_LIMIT)
        self.assertEqual(args.max_depth, worktree.DEFAULT_SCAN_DEPTH)
        self.assertEqual(args.name, worktree.DEPENDENCY_DIR)
        # `remove` scans ONE worktree and correctly keeps the smaller budget;
        # the two must not be conflated in either direction.
        removal = worktree.build_parser().parse_args(["remove", "some-worktree"])
        self.assertFalse(removal.accept_unscanned)
        # And the whole-root budget must actually be the larger of the two,
        # otherwise the names are backwards and this test passes vacuously.
        self.assertGreater(worktree.SCAN_ROOT_LIMIT, worktree.SCAN_LIMIT)

    def test_the_cli_wires_scan_and_apply_together(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside = root / "real"
            outside.mkdir()
            (outside / "precious.txt").write_bytes(b"x")
            (root / "scratch" / "wt").mkdir(parents=True)
            link = root / "scratch" / "wt" / "node_modules"
            make_link(link, outside)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                worktree.main(["cleanup-scan", str(root / "scratch")])
            plan_path = root / "plan.json"
            plan_path.write_text(stream.getvalue(), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                worktree.main(["cleanup-apply", str(plan_path), "--confirm"])
            self.assertFalse(link.exists())
            self.assertTrue((outside / "precious.txt").exists())

    def test_the_cli_refuses_to_apply_without_confirm(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            plan_path = Path(folder) / "plan.json"
            plan_path.write_text(json.dumps({"targets": []}), encoding="utf-8")
            errors = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
                code = worktree.main(["cleanup-apply", str(plan_path)])
            self.assertEqual(code, 2)
            self.assertIn("confirmation", errors.getvalue())

    def test_a_refusal_reaches_the_reader_as_a_sentence_not_a_traceback(self) -> None:
        # The refusals in this tool are written to be acted on: they name the
        # hazard and the command that resolves it. A traceback buries that under
        # a stack the reader did not ask for.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside, inside = root / "outside", root / "checkout"
            outside.mkdir()
            inside.mkdir()
            make_link(inside / "node_modules", outside)
            errors = io.StringIO()
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
                code = worktree.main(["remove", str(inside), "--repository", str(root)])
            self.assertEqual(code, 2)
            self.assertIn("refused:", errors.getvalue())
            self.assertIn("deletes through them", errors.getvalue())
            self.assertNotIn("Traceback", errors.getvalue())

    def test_a_git_failure_is_an_error_and_not_reported_as_a_refusal(self) -> None:
        # A refusal is this tool declining; a RuntimeError is git breaking.
        # Printing "refused" over the second sends the reader looking for a
        # policy to satisfy when nothing judged their request. Raised by
        # worktree-setup in review.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inside = root / ".worktrees" / "agent"
            inside.mkdir(parents=True)
            broken = subprocess.CompletedProcess([], 1, "", "fatal: git said no")
            errors = io.StringIO()
            with mock.patch.object(worktree, "repository_root", return_value=worktree.canonical(root)), \
                    mock.patch.object(worktree, "_status", return_value=(False, False, True)), \
                    mock.patch.object(worktree.subprocess, "run", return_value=broken), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
                code = worktree.main(["remove", str(inside), "--repository", str(root)])
            self.assertEqual(code, 1)
            self.assertIn("error: fatal: git said no", errors.getvalue())
            self.assertNotIn("refused:", errors.getvalue())


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
