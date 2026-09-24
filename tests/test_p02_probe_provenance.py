"""P02: the contact probe refuses to measure code that is not the tree it was
asked to measure.

The probe puts its own tree's roots on ``sys.path`` and imports ``orgtree``. A
root the interpreter cannot import from (missing, or in a folder the safety
guards protect, where the read raises) does not make that import fail: the
runtime's ``._pth`` fallback answers with another checkout's ``orgtree``, and the
probe would measure that instead. Here the tool is copied to a root WITHOUT an
engine, so the fallback (or an ImportError) is what answers, and the run must
refuse, name the path it actually loaded, and write no output: through the
JSON-backend child (the child refuses, the parent stops) and in the main
process.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

ROOT = Path(__file__).resolve().parents[1]
BASE_TMP = os.environ.get("P02_HARNESS_TMP") or None
REFUSED = "P02 PROBE PROVENANCE REFUSED"
LOADED = re.compile(r"(\w+) was imported from (.+?), not from the tree under test \((.+?)\)")
UNIMPORTABLE = re.compile(r"(\w+) could not be imported at all \(expected (.+?)\)")


def _norm(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


class WrongRootRefuses(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="p02-wrong-root-", dir=BASE_TMP)
        cls.base = Path(cls._tmp.name)
        # the tool and its guards, at a root with no engine/ at all
        cls.fake = cls.base / "fake-root"
        (cls.fake / "tools").mkdir(parents=True)
        (cls.fake / "tests").mkdir()
        shutil.copy2(ROOT / "tools" / "p02_operation_contacts.py", cls.fake / "tools")
        shutil.copy2(ROOT / "tests" / "isolation_guards.py", cls.fake / "tests")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def run_probe(self, name: str, *extra: str) -> tuple[subprocess.CompletedProcess, Path]:
        out = self.base / name / "out"
        work = self.base / name / "work"
        proc = subprocess.run(
            [sys.executable, "-I", "-B", str(self.fake / "tools" / "p02_operation_contacts.py"),
             "--out", str(out), "--work", str(work), *extra],
            capture_output=True, text=True, timeout=600)
        return proc, out

    def assert_refused(self, proc: subprocess.CompletedProcess, out: Path) -> None:
        self.assertNotEqual(proc.returncode, 0, proc.stdout[-2000:])
        text = proc.stderr
        self.assertIn(REFUSED, text)
        # it names what it actually loaded (or that nothing could be imported),
        # and what it loaded is NOT the fake root's
        loaded, missing = LOADED.search(text), UNIMPORTABLE.search(text)
        self.assertTrue(loaded or missing, text[-2000:])
        if loaded:
            got, want = loaded.group(2), loaded.group(3)
            self.assertTrue(_norm(want).startswith(_norm(str(self.fake))), want)
            self.assertFalse(_norm(got).startswith(_norm(str(self.fake))), got)
            self.assertTrue(Path(got).is_file(), got)
        else:
            self.assertTrue(_norm(missing.group(2)).startswith(_norm(str(self.fake))))
        # and no output of any kind was written
        self.assertEqual(sorted(p.name for p in out.rglob("operation-contacts.*")), [])
        self.assertNotIn('"rows"', proc.stdout)

    def test_the_json_child_refuses_and_the_parent_stops(self):
        proc, out = self.run_probe("child")
        self.assert_refused(proc, out)
        self.assertIn("JSON-backend child exited", proc.stderr)

    def test_the_main_process_refuses(self):
        proc, out = self.run_probe("main", "--no-json-child")
        self.assert_refused(proc, out)
        self.assertNotIn("JSON-backend child exited", proc.stderr)


if __name__ == "__main__":
    unittest.main()
