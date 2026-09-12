"""W08: verification receipts that bind a result to the tree it was measured in.

Every rule here is asserted in BOTH POLARITIES, because each one of them can
pass vacuously. A staleness check that always says "stale" would satisfy a
one-sided test while being useless, so `current` is proved first and the three
ways of being historical are proved against it. A log decoder that always
returned replacement characters would "read" UTF-16 while losing the content,
so every encoding is asserted to round-trip EXACTLY. And the negative controls
run against real git repositories built in temp directories rather than against
a mocked runner, because the incidents this package exists to close (a tree
mid-rebase, a dirty worktree, a rebase that silently changed a patch) are facts
about git and a mock would only assert my own assumptions back at me.

No ORGTREE_DATA is needed by design: `workevidence` imports nothing that reaches
`store`, which is what lets the receipt tool run from any checkout. That
property is itself asserted (test_module_imports_without_a_data_root).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine" / "backend"))

from orgtree import workevidence as we          # noqa: E402

GIT = ["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid",
       "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"]


def git(cwd: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run([*GIT, *args], cwd=str(cwd), capture_output=True,
                       text=True)
    if check and r.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed in {cwd}: "
                             f"{r.stderr or r.stdout}")
    return (r.stdout or "").strip()


class TempRepo:
    """A real git repository, so the git-shaped assertions are about git."""

    def __init__(self, prefix: str = "w08-repo-") -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix=prefix)
        self.path = Path(self._tmp.name)
        git(self.path, "init", "--initial-branch=main", "-q")

    def write(self, name: str, text: str) -> None:
        (self.path / name).write_text(text, encoding="utf-8")

    def commit(self, name: str, text: str, message: str) -> str:
        self.write(name, text)
        git(self.path, "add", name)
        git(self.path, "commit", "-q", "-m", message)
        return git(self.path, "rev-parse", "HEAD")

    def close(self) -> None:
        self._tmp.cleanup()


class LogDecodingTests(unittest.TestCase):
    """AC4, first half: UTF-8 and UTF-16 logs parse correctly.

    The reported incident (AP17): PowerShell redirects a log as UTF-16 while a
    Python-written suite log is UTF-8, and a comparison script fell over on the
    second one with valid results inside it.
    """

    TEXT = "PASS 7/7 — 100% · ok\nnext line\ttabbed"

    def test_every_encoding_round_trips_exactly(self):
        for label, raw, expect_bom in (
            ("utf-8", self.TEXT.encode("utf-8"), False),
            ("utf-8-sig", b"\xef\xbb\xbf" + self.TEXT.encode("utf-8"), True),
            ("utf-16-bom", self.TEXT.encode("utf-16"), True),
            ("utf-16-le", self.TEXT.encode("utf-16-le"), False),
            ("utf-16-be", self.TEXT.encode("utf-16-be"), False),
        ):
            with self.subTest(label):
                got = we.decode_log(raw)
                self.assertEqual(got["text"], self.TEXT,
                                 f"{label} did not round-trip exactly")
                self.assertEqual(got["replacements"], 0,
                                 f"{label} lost characters to replacement")
                self.assertEqual(got["had_bom"], expect_bom)
                self.assertEqual(got["bytes"], len(raw))

    def test_powershell_shaped_utf16_without_a_bom_is_still_read(self):
        # `cmd > file.log` under PowerShell 5.1 writes UTF-16LE with no BOM,
        # which is the exact case a naive UTF-8 read turns into mojibake
        raw = "ok\r\nfine\r\n".encode("utf-16-le")
        got = we.decode_log(raw)
        self.assertEqual(got["encoding"], "utf-16-le")
        self.assertEqual(got["text"], "ok\r\nfine\r\n")

    def test_undecodable_bytes_are_counted_not_fatal(self):
        got = we.decode_log(b"result: ok \xfa\xfb done")
        self.assertGreater(got["replacements"], 0,
                           "the damage must be reported, not hidden")
        self.assertIn("result: ok", got["text"],
                      "the readable part of the log survives")
        self.assertIn("done", got["text"])

    def test_the_hash_is_over_the_raw_bytes_and_survives_excerpting(self):
        raw = ("x" * (we.LOG_STORED + 500)).encode("utf-8")
        full = we.decode_log(raw)
        stored = we.stored_log(full)
        self.assertEqual(stored["sha256"], full["sha256"],
                         "the stored copy must still identify the whole log")
        self.assertLess(len(stored["text"]), len(full["text"]))
        self.assertIn("LOG EXCERPT", stored["text"],
                      "a shortened log SAYS it was shortened")
        self.assertIn(str(len(full["text"])), stored["text"],
                      "and says how long the whole of it is")
        # the control: a short log is not touched at all
        short = we.decode_log(b"tiny")
        self.assertEqual(we.stored_log(short)["text"], "tiny")

    def test_text_input_is_refused(self):
        # decoding something already decoded means somebody else guessed first
        with self.assertRaises(we.ReceiptError):
            we.decode_log("already a string")      # type: ignore[arg-type]


class ResultClassTests(unittest.TestCase):
    """AC4, second half: an expected negative, a crash and a check that never
    ran are three different things."""

    def test_the_five_classes_are_distinct_and_only_two_are_green(self):
        self.assertEqual(len(set(we.RESULTS)), 5)
        self.assertEqual(we.GREEN, {"passed", "expected_negative"})
        for r in we.RESULTS:
            self.assertIn(r, we.RESULT_MEANS, f"{r} has no stated meaning")

    def test_a_suite_with_an_unexecuted_check_is_not_green(self):
        ran = we.receipt(candidate="abc1234", checkout=".",
                         command=["pytest", "-k", "a"], execution="independent",
                         result="passed", tree=self._tree())
        fired = we.receipt(candidate="abc1234", checkout=".",
                           command=["pytest", "-k", "neg"],
                           execution="independent",
                           result="expected_negative", tree=self._tree())
        never = we.receipt(candidate="abc1234", checkout=".", command=[],
                           execution="source_inspection",
                           result="not_executed", note="packaging step",
                           tree=self._tree())
        # the positive control FIRST: a pass plus a fired negative control is green
        self.assertTrue(we.summarize([ran, fired])["green"])
        summary = we.summarize([ran, fired, never])
        self.assertFalse(summary["green"],
                         "ten checks minus two that never ran is not eight green")
        self.assertEqual(len(summary["not_executed"]), 1)
        self.assertIn("never ran", summary["says"])
        self.assertEqual(summary["independently_executed"], 2,
                         "the unexecuted one is not counted as executed")

    def test_contradictory_receipts_are_refused(self):
        with self.assertRaises(we.ReceiptError) as cm:
            we.receipt(candidate="abc1234", checkout=".", command=[],
                       execution="independent", result="passed",
                       tree=self._tree())
        self.assertIn("command", str(cm.exception),
                      "an independent claim with no command is unreplayable")
        with self.assertRaises(we.ReceiptError):
            we.receipt(candidate="abc1234", checkout=".", command=["x"],
                       execution="independent", result="not_executed",
                       tree=self._tree())
        for bad in ("green", "ok", "", "PASSED"):
            with self.subTest(bad), self.assertRaises(we.ReceiptError):
                we.receipt(candidate="abc1234", checkout=".", command=["x"],
                           execution="independent", result=bad,
                           tree=self._tree())
        for bad in ("ran_it", "", "INDEPENDENT"):
            with self.subTest(bad), self.assertRaises(we.ReceiptError):
                we.receipt(candidate="abc1234", checkout=".", command=["x"],
                           execution=bad, result="passed", tree=self._tree())

    def test_a_candidate_must_be_a_sha_and_the_refusal_echoes_it(self):
        from orgtree import workevidence
        with self.assertRaises(workevidence.ShaError) as cm:
            we.receipt(candidate="my-branch", checkout=".", command=["x"],
                       execution="independent", result="passed",
                       tree=self._tree())
        self.assertIn("my-branch", str(cm.exception),
                      "the rejected value is echoed exactly, typo and all")

    @staticmethod
    def _tree() -> dict[str, object]:
        return {"checkout": ".", "commit": "a" * 40, "base": None,
                "state": we.TREE_CLEAN, "dirty_paths": [], "dirty_count": 0,
                "in_progress": "", "fingerprint": "sha256:fixed",
                "observed_at": "2026-09-12T00:00:00+00:00", "detail": ""}


class TreeStateTests(unittest.TestCase):
    """AC1: a dirty or changed tree is disclosed, and a half-applied rebase is
    not mistaken for either of the commits it sits between."""

    def setUp(self) -> None:
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.head = self.repo.commit("a.txt", "one\n", "first")

    def test_a_clean_tree_reports_clean_and_its_commit(self):
        st = we.tree_state(str(self.repo.path))
        self.assertEqual(st["state"], we.TREE_CLEAN)
        self.assertEqual(st["commit"], self.head)
        self.assertEqual(st["dirty_count"], 0)
        self.assertEqual(st["in_progress"], "")
        self.assertTrue(st["fingerprint"].startswith("sha256:"))
        self.assertEqual(st["detail"], "", "a clean read has nothing to disclose")

    def test_an_uncommitted_edit_changes_the_state_and_the_fingerprint(self):
        clean = we.tree_state(str(self.repo.path))
        self.repo.write("a.txt", "one\ntwo\n")
        dirty = we.tree_state(str(self.repo.path))
        self.assertEqual(dirty["state"], we.TREE_DIRTY)
        self.assertEqual(dirty["commit"], clean["commit"],
                         "same commit — that is exactly why the tree matters")
        self.assertEqual(dirty["dirty_count"], 1)
        self.assertTrue(any("a.txt" in p for p in dirty["dirty_paths"]))
        self.assertNotEqual(dirty["fingerprint"], clean["fingerprint"],
                            "a receipt taken now cannot be read as one taken "
                            "against the clean commit")

    def test_an_untracked_file_counts_as_dirty(self):
        self.repo.write("scratch.log", "noise\n")
        st = we.tree_state(str(self.repo.path))
        self.assertEqual(st["state"], we.TREE_DIRTY)
        self.assertTrue(any("scratch.log" in p for p in st["dirty_paths"]))

    def test_a_half_applied_rebase_is_unresolved_not_dirty(self):
        # the statereview-05 incident: reading a shared worktree DURING a rebase
        # yielded a mixture of old and new imports and an inaccurate verdict
        git(self.repo.path, "checkout", "-q", "-b", "feature")
        self.repo.commit("a.txt", "one\nfeature\n", "feature edit")
        git(self.repo.path, "checkout", "-q", "main")
        self.repo.commit("a.txt", "one\nmain\n", "main edit")
        git(self.repo.path, "checkout", "-q", "feature")
        r = subprocess.run([*GIT, "rebase", "main"], cwd=str(self.repo.path),
                           capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0,
                            "control: this rebase is supposed to conflict")
        st = we.tree_state(str(self.repo.path))
        self.assertEqual(st["state"], we.TREE_UNRESOLVED)
        self.assertEqual(st["in_progress"], "rebase")
        self.assertIn("rebase", st["detail"])
        self.assertIn("mixture", st["detail"],
                      "the disclosure says what is wrong with the measurement")
        git(self.repo.path, "rebase", "--abort", check=False)
        settled = we.tree_state(str(self.repo.path))
        self.assertEqual(settled["state"], we.TREE_CLEAN,
                         "control: aborting the rebase settles the tree again")

    def test_a_directory_that_is_not_a_repository_is_unresolved_with_a_reason(self):
        with tempfile.TemporaryDirectory(prefix="w08-nonrepo-") as d:
            st = we.tree_state(d)
            self.assertEqual(st["state"], we.TREE_UNRESOLVED)
            self.assertIsNone(st["commit"])
            self.assertTrue(st["detail"], "an unreadable tree says why")

    def test_base_of_records_the_parent_of_the_candidate(self):
        second = self.repo.commit("a.txt", "one\ntwo\n", "second")
        st = we.tree_state(str(self.repo.path), base_of=second)
        self.assertEqual(st["base"], self.head)
        # and a root commit has no parent, which is disclosed rather than faked
        root = we.tree_state(str(self.repo.path), base_of=self.head)
        self.assertIsNone(root["base"])
        self.assertIn("parent", root["detail"])


class StalenessDisclosureTests(unittest.TestCase):
    """AC1: prior evidence stays historical instead of being relabelled current.

    The incident (statereview-01): a passing log from BEFORE an edit was read as
    evidence for after it, and produced an all-green claim.
    """

    def setUp(self) -> None:
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.first = self.repo.commit("a.txt", "one\n", "first")
        self.rc = we.receipt(candidate=self.first, checkout=str(self.repo.path),
                             command=["python", "-m", "unittest", "x"],
                             execution="independent", result="passed")

    def test_an_unchanged_tree_reads_as_current(self):
        d = we.disclose(self.rc, we.tree_state(str(self.repo.path)))
        self.assertEqual(d["status"], "current")
        self.assertTrue(d["current"])
        self.assertIn(self.first[:12], d["says"])

    def test_a_new_commit_makes_the_old_receipt_historical(self):
        self.repo.commit("a.txt", "one\ntwo\n", "second")
        d = we.disclose(self.rc, we.tree_state(str(self.repo.path)))
        self.assertEqual(d["status"], "commit_changed")
        self.assertFalse(d["current"])
        self.assertIn("HISTORICAL", d["says"])

    def test_an_uncommitted_edit_makes_it_historical_too(self):
        self.repo.write("a.txt", "one\nedited but not committed\n")
        d = we.disclose(self.rc, we.tree_state(str(self.repo.path)))
        self.assertEqual(d["status"], "tree_changed")
        self.assertFalse(d["current"])
        self.assertIn("working tree has", d["says"])

    def test_disclosure_never_edits_the_receipt(self):
        before = json.dumps(self.rc, sort_keys=True, default=str)
        self.repo.commit("a.txt", "one\ntwo\n", "second")
        we.disclose(self.rc, we.tree_state(str(self.repo.path)))
        we.disclose(self.rc, we.tree_state(str(self.repo.path)))
        self.assertEqual(json.dumps(self.rc, sort_keys=True, default=str),
                         before,
                         "the fix is to keep the old record and disclose the "
                         "difference, never to refresh it")

    def test_an_unsettled_tree_is_neither_current_nor_simply_stale(self):
        unresolved = dict(we.tree_state(str(self.repo.path)))
        unresolved["state"] = we.TREE_UNRESOLVED
        d = we.disclose(self.rc, unresolved)       # type: ignore[arg-type]
        self.assertEqual(d["status"], "tree_unresolved")
        self.assertIn("re-run", d["says"])


class RangeDiffTests(unittest.TestCase):
    """AC2, second half: a range-diff record carries old AND new base and tip."""

    def setUp(self) -> None:
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.base = self.repo.commit("a.txt", "one\n", "base")
        git(self.repo.path, "checkout", "-q", "-b", "work")
        self.old_tip = self.repo.commit("b.txt", "feature\n", "the candidate")
        git(self.repo.path, "checkout", "-q", "main")
        self.new_base = self.repo.commit("c.txt", "unrelated main work\n",
                                         "main moved")

    def test_a_clean_rebase_is_recorded_as_identical_with_all_four_endpoints(self):
        git(self.repo.path, "checkout", "-q", "work")
        git(self.repo.path, "rebase", "main")
        new_tip = git(self.repo.path, "rev-parse", "HEAD")
        rd = we.range_diff(str(self.repo.path), self.base, self.old_tip,
                           self.new_base, new_tip)
        self.assertIs(rd["identical"], True, rd["detail"])
        self.assertEqual(rd["old_base"], self.base)
        self.assertEqual(rd["old_tip"], self.old_tip)
        self.assertEqual(rd["new_base"], self.new_base)
        self.assertEqual(rd["new_tip"], new_tip)
        self.assertIn("identical", rd["detail"])
        self.assertNotEqual(self.old_tip, new_tip,
                            "control: the rebase really did rewrite the commit")

    def test_a_rebase_that_changed_the_patch_is_not_identical(self):
        git(self.repo.path, "checkout", "-q", "work")
        git(self.repo.path, "rebase", "main")
        # the "rebase" a human does by hand, that quietly changes the content
        self.repo.write("b.txt", "feature, and something extra\n")
        git(self.repo.path, "add", "b.txt")
        git(self.repo.path, "commit", "-q", "--amend", "-m", "the candidate")
        tampered = git(self.repo.path, "rev-parse", "HEAD")
        rd = we.range_diff(str(self.repo.path), self.base, self.old_tip,
                           self.new_base, tampered)
        self.assertIs(rd["identical"], False, rd["detail"])
        self.assertIn("differ", rd["detail"])

    def test_git_not_answering_is_unknown_rather_than_a_difference(self):
        calls: list[list[str]] = []

        def dead(argv: list[str], cwd: str) -> tuple[int | None, str, str]:
            calls.append(argv)
            return None, "", "git is not installed or not on PATH"

        we.set_git_for_tests(dead)
        self.addCleanup(we.set_git_for_tests, None)
        rd = we.range_diff(str(self.repo.path), self.base, self.old_tip,
                           self.new_base, self.old_tip)
        self.assertIsNone(rd["identical"],
                          "'git did not run' must never read as 'the patches "
                          "differ' — or as 'they match'")
        self.assertIn("git is not installed", rd["detail"])
        self.assertTrue(calls, "control: the runner really was consulted")

    def test_every_endpoint_is_validated_before_git_runs(self):
        for bad in ("main", "HEAD~1", "", "zzzz123"):
            with self.subTest(bad), self.assertRaises(we.ShaError):
                we.range_diff(str(self.repo.path), self.base, self.old_tip,
                              self.new_base, bad)


class ReplayRecipeTests(unittest.TestCase):
    """AC2, first half: a probe is replayable against the reader's checkout, and
    one that is not says so."""

    def test_a_command_with_an_explicit_checkout_flag_is_portable(self):
        r = we.replay_recipe(command=["python", "probe.py", "--repo-root",
                                      "E:/somewhere"], candidate="abc1234")
        self.assertTrue(r["portable"])
        self.assertIn("any worktree", r["detail"])
        self.assertIn("abc1234", r["steps"][0])

    def test_a_command_without_one_is_disclosed_as_unportable(self):
        r = we.replay_recipe(command=["python", "probe.py"], candidate="abc1234")
        self.assertFalse(r["portable"],
                         "a probe that reads whatever tree it starts in is not "
                         "portable, and pretending otherwise is the defect")
        self.assertIn("does NOT take", r["detail"])
        self.assertIn("git worktree add", r["steps"][0],
                      "so the recipe tells the reader to pin one first")

    def test_the_flag_name_is_honoured(self):
        r = we.replay_recipe(command=["probe", "--tree=/x"], candidate="abc1234",
                             checkout_flag="--tree")
        self.assertTrue(r["portable"], "--tree=<path> is the same flag")


class PortableToolTests(unittest.TestCase):
    """AC2: the receipt tool runs against ANOTHER checkout and binds the result
    to THAT checkout's commit.

    The other checkout is a real git repository holding a minimal copy of the
    two modules the tool needs, which is what a reviewer's pinned worktree is:
    somebody else's tree, at somebody else's commit, that the tool must measure
    instead of its own.
    """

    TOOL = REPO / "tools" / "verification-receipt.py"

    def setUp(self) -> None:
        self.other = TempRepo("w08-other-checkout-")
        self.addCleanup(self.other.close)
        pkg = self.other.path / "engine" / "backend" / "orgtree"
        pkg.mkdir(parents=True)
        (pkg / "__init__.py").write_text("", encoding="utf-8")
        src = REPO / "engine" / "backend" / "orgtree"
        for name in ("workevidence.py", "workfields.py"):
            (pkg / name).write_bytes((src / name).read_bytes())
        git(self.other.path, "add", "-A")
        git(self.other.path, "commit", "-q", "-m", "the pinned candidate")
        self.candidate = git(self.other.path, "rev-parse", "HEAD")

    def _run(self, *args: str) -> tuple[int, dict[str, object], str]:
        r = subprocess.run([sys.executable, str(self.TOOL), *args],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace",
                           # a data root is deliberately NOT provided: the tool
                           # must work without one
                           env={k: v for k, v in os.environ.items()
                                if k != "ORGTREE_DATA"})
        try:
            body = json.loads(r.stdout)
        except json.JSONDecodeError:
            body = {}
        return r.returncode, body, (r.stderr or "") + (r.stdout or "")

    def test_it_measures_the_checkout_it_was_pointed_at(self):
        code, rc, raw = self._run("--repo-root", str(self.other.path),
                                  "--", sys.executable, "-c",
                                  "print('the probe ran')")
        self.assertEqual(code, 0, raw)
        self.assertEqual(rc["result"], "passed")
        tree = rc["tree"]                            # type: ignore[index]
        self.assertEqual(tree["commit"], self.candidate,      # type: ignore[index]
                         "the receipt names the OTHER checkout's commit, not "
                         "the one the tool happens to live in")
        self.assertEqual(rc["candidate"], self.candidate)
        self.assertEqual(tree["state"], "clean")              # type: ignore[index]
        logs = rc["logs"]                            # type: ignore[index]
        self.assertTrue(any("the probe ran" in str(lg.get("text"))
                            for lg in logs),          # type: ignore[union-attr]
                        "the command's own output is captured as a log")

    def test_a_negative_control_that_fires_is_green_and_one_that_does_not_is_not(self):
        code, rc, raw = self._run("--repo-root", str(self.other.path),
                                  "--expect-fail", "--", sys.executable, "-c",
                                  "raise SystemExit(3)")
        self.assertEqual(rc["result"], "expected_negative", raw)
        self.assertTrue(rc["green"])
        self.assertEqual(code, 0, "a control that fired is a pass for the suite")
        code, rc, raw = self._run("--repo-root", str(self.other.path),
                                  "--expect-fail", "--", sys.executable, "-c",
                                  "pass")
        self.assertEqual(rc["result"], "failed", raw)
        self.assertFalse(rc["green"],
                         "a negative control that did NOT fire is the worst "
                         "possible thing to report as green")
        self.assertEqual(code, 1)

    def test_a_command_that_cannot_start_is_crashed_not_failed(self):
        code, rc, raw = self._run("--repo-root", str(self.other.path), "--",
                                  "this-binary-does-not-exist-w08")
        self.assertEqual(rc["result"], "crashed", raw)
        self.assertEqual(code, 1)
        runner = rc["runner"]                        # type: ignore[index]
        self.assertIsNone(runner["exit_code"],       # type: ignore[index]
                          "there was no exit code, so none is recorded")

    def test_a_dirty_tree_is_disclosed_on_stderr_and_in_the_record(self):
        (self.other.path / "uncommitted.txt").write_text("edit", encoding="utf-8")
        code, rc, raw = self._run("--repo-root", str(self.other.path), "--",
                                  sys.executable, "-c", "pass")
        tree = rc["tree"]                            # type: ignore[index]
        self.assertEqual(tree["state"], "dirty")     # type: ignore[index]
        self.assertEqual(tree["dirty_count"], 1)     # type: ignore[index]
        self.assertIn("dirty tree", raw,
                      "the operator running it is told, not just the record")

    def test_a_reported_result_needs_no_command_but_must_say_so(self):
        code, rc, raw = self._run("--repo-root", str(self.other.path),
                                  "--candidate", self.candidate,
                                  "--execution", "owner_report",
                                  "--result", "passed",
                                  "--note", "the owner reported this")
        self.assertEqual(rc["execution"], "owner_report", raw)
        self.assertEqual(rc["command"], [],
                         "nothing was run here, and the record shows it")
        self.assertEqual(code, 0)

    def test_a_directory_that_is_not_an_orgtree_checkout_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="w08-empty-") as d:
            code, _rc, raw = self._run("--repo-root", d, "--", sys.executable,
                                       "-c", "pass")
            self.assertNotEqual(code, 0)
            self.assertIn("does not look like an orgtree checkout", raw)

    def test_the_range_diff_mode_produces_a_receipt(self):
        base = git(self.other.path, "rev-parse", "HEAD")
        second = self.other.commit("x.txt", "x\n", "second")
        code, rc, raw = self._run("--repo-root", str(self.other.path),
                                  "--range-diff", base, second, base, second)
        self.assertEqual(code, 0, raw)
        self.assertIs(rc["range_diff"]["identical"], True)   # type: ignore[index]
        self.assertEqual(rc["result"], "passed")


class IsolationTests(unittest.TestCase):
    """The property the whole tool rests on: this module needs no data root."""

    def test_module_imports_without_a_data_root(self):
        env = {k: v for k, v in os.environ.items() if k != "ORGTREE_DATA"}
        r = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, r'%s');"
             "from orgtree import workevidence as w;"
             "print(w.validate_sha('abc1234'));"
             "print(w.decode_log(b'ok')['encoding'])"
             % str(REPO / "engine" / "backend")],
            capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0,
                         f"workevidence must import with no ORGTREE_DATA: "
                         f"{r.stderr}")
        self.assertIn("abc1234", r.stdout)
        self.assertIn("utf-8", r.stdout)

    def test_the_sha_rule_is_one_rule_under_two_names(self):
        # workitems re-exports it; they must be the SAME object, not a copy
        # that could drift. (workitems needs a data root, so this runs in a
        # subprocess with one.)
        with tempfile.TemporaryDirectory(prefix="w08-dataroot-") as d:
            env = {**os.environ, "ORGTREE_DATA": d}
            r = subprocess.run(
                [sys.executable, "-c",
                 "import sys; sys.path.insert(0, r'%s');"
                 "from orgtree import workitems, workevidence;"
                 "print(workitems.validate_sha is workevidence.validate_sha);"
                 "print(workitems.ShaError is workevidence.ShaError)"
                 % str(REPO / "engine" / "backend")],
                capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.split(), ["True", "True"],
                             "the re-export must be the same object")


if __name__ == "__main__":
    unittest.main()
