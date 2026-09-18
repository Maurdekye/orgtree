"""tools/assert_repo_import.py refuses to let a probe report the wrong code.

Every case here runs a real subprocess, because the defect being guarded is a
property of import resolution in a fresh interpreter and cannot be observed by
inspection.  The suite carries its own negative control: `test_hazard_...`
proves that WITHOUT the guard the same wrong path resolves `orgtree` somewhere
else with no ImportError at all.  If that control ever stops reproducing, the
failure tests below prove nothing, and the control failing is how you find out.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "tools" / "assert_repo_import.py"
BANNER = "IMPORT PROVENANCE FAILED"


def _run(script: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    """Run a script in a fresh interpreter, exactly as an ad-hoc probe would."""
    return subprocess.run([sys.executable, "-c", script], capture_output=True,
                          text=True, timeout=120, cwd=str(cwd or REPO))


def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HELPER), *args], capture_output=True,
                          text=True, timeout=120, cwd=str(REPO))


class ProvenanceGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # realpath: mkdtemp hands back the 8.3 short form on Windows, and the
        # guard reports the resolved path, so the two would never compare equal.
        cls.tmp = os.path.realpath(tempfile.mkdtemp(prefix="orgtree-provenance-"))
        # A stand-in for the installed build: any `orgtree` that is not this
        # checkout's. Using a fabricated one keeps the test true on a machine
        # with no desktop app installed, while exercising the same resolution.
        cls.foreign = Path(cls.tmp) / "foreign-site"
        (cls.foreign / "orgtree").mkdir(parents=True)
        (cls.foreign / "orgtree" / "__init__.py").write_text(
            "__version__ = 'not-the-checkout'\n", encoding="utf-8")
        (cls.foreign / "engine").mkdir(parents=True)
        (cls.foreign / "engine" / "__init__.py").write_text("", encoding="utf-8")
        # A repo root that does not exist: the typo, the removed worktree.
        cls.missing = str(Path(cls.tmp) / "not-a-checkout")
        # A tree that LOOKS like a checkout but is not a git repository, so the
        # commit cannot be read and no result could carry a provenance field.
        cls.ungit = Path(cls.tmp) / "ungit"
        (cls.ungit / "engine" / "backend" / "orgtree").mkdir(parents=True)
        (cls.ungit / "engine" / "backend" / "orgtree" / "__init__.py").write_text(
            "", encoding="utf-8")
        (cls.ungit / "engine" / "__init__.py").write_text("", encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------------------------------------------------------------- control

    def test_hazard_reproduces_without_the_guard(self):
        """The negative control. A wrong repo path degrades instead of failing:
        `orgtree` still imports, from somewhere else, silently."""
        result = _run(
            "import sys, importlib.util\n"
            f"sys.path.insert(0, r'{self.missing}\\engine\\backend')\n"
            f"sys.path.insert(1, r'{self.foreign}')\n"
            "spec = importlib.util.find_spec('orgtree')\n"
            "print('ORIGIN', spec.origin if spec else None)\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ORIGIN", result.stdout)
        origin = result.stdout.split("ORIGIN", 1)[1].strip()
        self.assertTrue(origin.startswith(str(self.foreign)),
                        f"control did not reproduce the hazard; origin was {origin!r}")
        self.assertNotIn("Error", result.stderr)

    # ------------------------------------------------------- failing directon

    def test_wrong_repo_root_fails_loudly_and_writes_no_result(self):
        out = Path(self.tmp) / "must-not-exist.json"
        result = _cli("--repo", self.missing, "--result", str(out))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(BANNER, result.stderr)
        self.assertIn(self.missing, result.stderr)
        self.assertFalse(out.exists(), "a result file was written despite the failure")

    def test_foreign_import_already_loaded_cannot_be_repaired(self):
        """sys.path repair cannot undo an import that already happened, so the
        guard must read the loaded module rather than re-resolve the name."""
        result = _run(
            "import sys\n"
            f"sys.path.insert(0, r'{self.foreign}')\n"
            "import orgtree\n"
            f"sys.path.insert(0, r'{REPO}\\tools')\n"
            "from assert_repo_import import assert_repo_import, ForeignImportError\n"
            "try:\n"
            f"    assert_repo_import(r'{REPO}', 'orgtree')\n"
            "except ForeignImportError:\n"
            "    print('REFUSED')\n"
            "else:\n"
            "    print('ACCEPTED')\n")
        self.assertIn("REFUSED", result.stdout, result.stdout + result.stderr)
        self.assertIn(BANNER, result.stderr)
        self.assertIn(str(self.foreign), result.stderr)

    def test_failure_is_printed_even_if_the_caller_swallows_it(self):
        """A guard whose only signal is an exception is a guard a bare `except`
        can silence. The message goes out before the raise."""
        result = _run(
            "import sys\n"
            f"sys.path.insert(0, r'{REPO}\\tools')\n"
            "from assert_repo_import import assert_repo_import\n"
            "try:\n"
            f"    assert_repo_import(r'{self.missing}')\n"
            "except Exception:\n"
            "    pass\n"
            "print('SWALLOWED')\n")
        self.assertIn("SWALLOWED", result.stdout)
        self.assertIn(BANNER, result.stderr)

    def test_unreadable_commit_is_a_failure_by_default(self):
        out = Path(self.tmp) / "ungit-result.json"
        result = _cli("--repo", str(self.ungit), "--result", str(out))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(BANNER, result.stderr)
        self.assertFalse(out.exists())

    def test_unreadable_commit_can_be_accepted_deliberately(self):
        out = Path(self.tmp) / "ungit-allowed.json"
        result = _cli("--repo", str(self.ungit), "--result", str(out),
                      "--allow-missing-commit")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(out.read_text(encoding="utf-8"))
        self.assertIsNone(payload["provenance"]["commit"])
        self.assertTrue(payload["provenance"]["commit_problem"],
                        "an absent commit must record WHY, not just be empty")

    # ------------------------------------------------------- passing directon

    def test_good_repo_root_prints_a_receipt_naming_the_resolved_path(self):
        result = _cli("--repo", str(REPO), "orgtree", "engine", "orgtree.store")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = str(REPO / "engine" / "backend" / "orgtree" / "store.py")
        self.assertIn("provenance OK: orgtree.store <- " + expected, result.stderr)
        self.assertIn("provenance OK: repo ", result.stderr)

    def test_result_file_carries_a_non_empty_commit(self):
        out = Path(self.tmp) / "good.json"
        result = _cli("--repo", str(REPO), "--result", str(out))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(out.read_text(encoding="utf-8"))
        commit = payload["provenance"]["commit"]
        self.assertIsInstance(commit, str)
        self.assertEqual(len(commit), 40)
        self.assertTrue(all(character in "0123456789abcdef" for character in commit))
        self.assertTrue(payload["provenance"]["import_provenance"]["orgtree"]
                        .startswith(str(REPO)))

    def test_receipt_goes_to_stderr_so_a_probe_can_print_json(self):
        result = _cli("--repo", str(REPO))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "",
                         "the receipt must not pollute a probe's stdout")

    def test_guard_places_the_roots_so_a_probe_need_not(self):
        """The two-line contract: a script outside the checkout calls the guard
        and can then import the engine, with no sys.path handling of its own."""
        result = _run(
            "import sys\n"
            f"sys.path.insert(0, r'{self.foreign}')\n"
            f"sys.path.insert(0, r'{REPO}\\tools')\n"
            "from assert_repo_import import assert_repo_import\n"
            f"p = assert_repo_import(r'{REPO}')\n"
            "from orgtree import store\n"
            "print('STORE', store.__file__)\n"
            "print('SHA', p.commit)\n",
            cwd=Path(self.tmp))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("STORE " + str(REPO / "engine" / "backend" / "orgtree" / "store.py"),
                      result.stdout)
        self.assertEqual(len(result.stdout.split("SHA", 1)[1].strip()), 40)

    def test_refuse_only_mode_validates_without_touching_sys_path(self):
        """`tests/import_provenance.py` refuses rather than repairs on purpose;
        the same behaviour stays available here for callers that want it, so a
        caller that placed the roots itself can be checked and not altered."""
        result = _run(
            "import sys\n"
            f"sys.path.insert(0, r'{REPO}\\engine\\backend')\n"
            f"sys.path.insert(1, r'{REPO}')\n"
            f"sys.path.insert(0, r'{REPO}\\tools')\n"
            "from assert_repo_import import assert_repo_import\n"
            "before = list(sys.path)\n"
            f"assert_repo_import(r'{REPO}', 'orgtree', 'engine', insert_path=False)\n"
            "print('CHANGED', sys.path != before)\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("CHANGED False", result.stdout)

    def test_verdict_matches_what_the_interpreter_actually_resolves(self):
        """The second control, and the one that found a live third fallback.

        A bare subprocess here resolves `orgtree` through whatever this
        interpreter already has on its path.  On this machine that is NOT
        nothing: the bundled runtime lives at ``engine/runtime/`` which is
        gitignored, so a worktree has none, the runner falls back to the MAIN
        checkout's ``python.exe``, and its ``python313._pth`` lists ``../backend``
        relative to THAT checkout.  A bare probe run from a worktree therefore
        measures the main checkout, silently.  Rather than assume any of that,
        this asks the interpreter where `orgtree` comes from and requires the
        guard's verdict to agree -- so it holds on a machine that behaves
        differently, and fails if the guard and reality ever diverge.
        """
        observed = _run("import importlib.util\n"
                        "spec = importlib.util.find_spec('orgtree')\n"
                        "print('ORIGIN', spec.origin if spec else 'NONE')\n")
        self.assertEqual(observed.returncode, 0, observed.stderr)
        origin = observed.stdout.split("ORIGIN", 1)[1].strip()
        verdict = _run(
            "import sys\n"
            f"sys.path.insert(0, r'{REPO}\\tools')\n"
            "from assert_repo_import import assert_repo_import, ProvenanceError\n"
            "try:\n"
            f"    assert_repo_import(r'{REPO}', 'orgtree', insert_path=False)\n"
            "except ProvenanceError:\n"
            "    print('REFUSED')\n"
            "else:\n"
            "    print('ACCEPTED')\n")
        inside = origin != "NONE" and Path(origin).resolve().is_relative_to(REPO)
        self.assertIn("ACCEPTED" if inside else "REFUSED", verdict.stdout,
                      f"guard disagreed with the real resolution {origin!r}")

    def test_stamp_attaches_provenance_without_discarding_the_payload(self):
        sys.path.insert(0, str(REPO / "tools"))
        from assert_repo_import import assert_repo_import
        provenance = assert_repo_import(str(REPO), "orgtree", quiet=True)
        stamped = provenance.stamp({"ms": 8.2})
        self.assertEqual(stamped["ms"], 8.2)
        self.assertEqual(len(stamped["provenance"]["commit"]), 40)
        self.assertEqual(stamped["provenance"]["checked_by"],
                         "tools/assert_repo_import.py")


if __name__ == "__main__":
    unittest.main()
