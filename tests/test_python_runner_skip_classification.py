"""A skip is never inferred from free text, and an empty pass is never invisible.

THE DEFECT THIS PINS. `_classify_failure` used to turn a whole module into a
`skip` whenever `skip` or `skipped` appeared anywhere in its combined stdout and
stderr. A skip exits 0 and counts zero passes, so a module that fully passed was
reported green with nothing counted.

THE GUARD THAT NEVER FIRED, because it is the part everyone reads wrongly. The
classifier tests the child's structured marker BEFORE the regex, which reads as
"a well-formed run is unaffected". It is not. The child initialises its result
as ``{"phase": "pass", "marker": None, ...}`` and only its ``except`` branches
ever assign a marker, so EVERY passing module arrives at the classifier with
``marker=None`` -- indistinguishable, to that code, from no payload at all --
and fell straight through to the regex. Measured before the fix on an ordinary
module with three passing assertions, a normal exit, the marker emitted exactly
as designed, and one line of output containing the word: phase=skip, passed=0,
exit 0, with ``Ran 3 tests ... OK`` sitting in its own captured stderr.

WHY THIS FILE LEANS ON A CONTROL RATHER THAN ON GREEN. This is a ticket about a
control that fails open, and a green suite is exactly what it produced while
broken. So §1b reproduces the pre-fix classifier verbatim and shows it
misclassifying THE SAME inputs the fixed one handles: without that, §1 would
pass just as happily against inputs that never triggered the bug at all.

An incidental property worth naming: this very module prints "skip" and
"skipped" many times. Before the fix, running it through the runner would have
reported it as wholly skipped with zero passes.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "tools" / "run-python-verification.py"
SPEC = importlib.util.spec_from_file_location("python_verification_runner_skip", RUNNER)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def _legacy_classify(exit_code: int | None, stdout: str, stderr: str, marker: str | None = None) -> str:
    """The classifier EXACTLY as it stood before the fix, for the negative control.

    Copied from `_classify_failure` at tools/run-python-verification.py before
    2026-09-19. The one line that matters is the `re.search(r"\\bSKIP(?:PED)?\\b"
    ...)` disjunct: everything else is carried along unchanged so the control
    differs from the real thing in that one respect and no other.
    """
    text = f"{stdout}\n{stderr}"
    if re.search(r"(?:ERROR:.*tearDown|(?:File .*|in )tear[_]?Down|Exception ignored in:.*atexit)", text):
        return "teardown_failure"
    if marker in {"skip", "assertion_failure", "import_failure", "teardown_failure", "execution_failure"}:
        return marker
    if exit_code == 5 or re.search(r"\bSKIP(?:PED)?\b", text, re.IGNORECASE):
        return "skip"
    if re.search(r"(?:AssertionError|^FAIL:|^FAILED)", text, re.MULTILINE):
        return "assertion_failure"
    if re.search(r"(?:ModuleNotFoundError|ImportError)", text):
        return "import_failure"
    return "execution_failure" if exit_code not in (None, 0) else "pass"


# The two real-world shapes, kept in one place so §1 and §1b provably run the
# SAME inputs through the fixed and the legacy classifier.
WORD_IN_STDOUT = ("repair tool: 4 malformed rows skipped", "Ran 3 tests in 0.001s\n\nOK\n")
PARTIAL_SKIP = ("", "Ran 5 tests in 0.002s\n\nOK (skipped=2)\n")
# Upper case, and in stdout rather than stderr. Note the word form: the legacy
# regex was `\bSKIP(?:PED)?\b`, so "SKIPPING" would NOT have matched it and this
# input would have been inert. §1b caught exactly that when this line first read
# "SKIPPING", which is what a control is for.
UPPERCASE_WORD = ("SKIPPED the optional fixture", "Ran 9 tests in 0.010s\n\nOK\n")


class SkipIsNeverInferredFromText(unittest.TestCase):
    def test_1_passing_module_whose_output_says_skipped_is_a_pass(self) -> None:
        """§1 — the exact case that was reported from the field."""
        for label, (out, err) in (
            ("word in stdout", WORD_IN_STDOUT),
            ("unittest's own OK (skipped=2)", PARTIAL_SKIP),
            ("uppercase, different word form", UPPERCASE_WORD),
        ):
            with self.subTest(label):
                # marker=None is what a CLEAN PASS actually delivers. Passing
                # None here is not a shortcut for "no payload" -- it is the
                # real value the passing path produces, and the whole defect.
                self.assertEqual(runner._classify_failure(0, out, err, None), "pass")
                # And with no payload at all, which is the case the old
                # description thought was the only one affected.
                self.assertEqual(runner._classify_failure(0, out, err), "pass")

    def test_1b_negative_control_the_pre_fix_classifier_gets_all_three_wrong(self) -> None:
        """§1b — THE CONTROL. Without this, §1 proves nothing about these inputs.

        If this test ever goes green, the inputs above have stopped exercising
        the defect and §1 has quietly become decoration.
        """
        for label, (out, err) in (
            ("word in stdout", WORD_IN_STDOUT),
            ("unittest's own OK (skipped=2)", PARTIAL_SKIP),
            ("uppercase, different word form", UPPERCASE_WORD),
        ):
            with self.subTest(label):
                self.assertEqual(_legacy_classify(0, out, err, None), "skip",
                                 "the control must actually fire on this input")

    def test_1c_the_free_text_inference_is_gone_from_the_source(self) -> None:
        """§1b's control is a local copy, so pin the real file too.

        Without this, the fix could be reverted in the source while §1b's
        private copy went on demonstrating a bug the shipped code had back.
        """
        source = RUNNER.read_text(encoding="utf-8")
        self.assertNotIn('re.search(r"\\bSKIP(?:PED)?\\b"', source)

    def test_2_exit_code_five_is_still_honoured(self) -> None:
        """§2 — pytest's real "no tests collected" signal is not collateral damage."""
        self.assertEqual(runner._classify_failure(5, "", "", None), "skip")
        self.assertEqual(runner._classify_failure(5, "", ""), "skip")

    def test_3_a_real_failure_is_still_a_failure(self) -> None:
        """§3 — removing the skip disjunct must not make anything fail-open.

        Text that used to be swallowed by the skip branch now reaches the
        failure branches, which is the fail-CLOSED direction.
        """
        self.assertEqual(runner._classify_failure(1, "", "AssertionError: nope", None), "assertion_failure")
        self.assertEqual(runner._classify_failure(1, "", "ModuleNotFoundError: x", None), "import_failure")
        self.assertEqual(runner._classify_failure(1, "", "", None), "execution_failure")
        # A module that both fails and mentions skipping is a FAILURE. The old
        # order returned "skip" here and exited 0.
        self.assertEqual(runner._classify_failure(1, "3 rows skipped", "AssertionError: nope", None),
                         "assertion_failure")
        self.assertEqual(_legacy_classify(1, "3 rows skipped", "AssertionError: nope", None), "skip")

    def test_4_a_found_payload_is_not_confused_with_its_marker_field(self) -> None:
        """§4 — the exact confusion that caused the defect, pinned directly."""
        payload = json.dumps({"phase": "pass", "marker": None, "import_provenance": {"orgtree": "x"}})
        found, marker, clean, provenance = runner._parse_child(
            f"module output\n__ORGTREE_VERIFY_RESULT__{payload}")
        self.assertTrue(found, "a clean pass DOES deliver a payload")
        self.assertIsNone(marker, "and its marker field is None, which is not the same question")
        self.assertEqual(clean, "module output")
        self.assertEqual(provenance, {"orgtree": "x"})

        missing = runner._parse_child("module output with no payload at all")
        self.assertFalse(missing[0])
        self.assertIsNone(missing[1])

    def test_5_tests_ran_is_summed_and_absent_when_unstated(self) -> None:
        """§5 — the count that makes an empty pass visible."""
        self.assertEqual(runner._tests_ran("", "Ran 3 tests in 0.1s\n\nOK\n"), 3)
        self.assertEqual(runner._tests_ran("Ran 1 test in 0.1s\n", "Ran 4 tests in 0.2s\n"), 5,
                         "a module driving two unittest runs must not be undercounted")
        self.assertIsNone(runner._tests_ran("said nothing", ""))
        self.assertEqual(runner._tests_ran("", "Ran 0 tests in 0.0s\n\nOK\n"), 0)


class EndToEndThroughTheRealRunner(unittest.TestCase):
    """The unit tests above pin the classifier. These pin the REPORT.

    "0 passed must never render as green" is a claim about the receipt, and only
    driving the whole runner can settle it.
    """

    maxDiff = None

    def setUp(self) -> None:
        self.fixture = Path(tempfile.mkdtemp(prefix="orgtree-skipclass-"))
        self.addCleanup(self._remove)

    def _remove(self) -> None:
        import shutil
        shutil.rmtree(self.fixture, ignore_errors=True)

    def _write(self, name: str, body: str) -> Path:
        path = self.fixture / name
        path.write_text(textwrap.dedent(body), encoding="utf-8")
        return path

    def _run(self, *paths: Path) -> dict:
        completed = subprocess.run(
            [sys.executable, str(RUNNER), *(str(p) for p in paths),
             "--repo-root", str(ROOT), "--data-root", str(self.fixture / "data")],
            cwd=str(ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=600,
            env={**os.environ, "PYTHONNOUSERSITE": "1"},
        )
        raw = completed.stdout
        self.assertIn("{", raw, f"runner produced no receipt; stderr={completed.stderr[-2000:]}")
        return json.loads(raw[raw.index("{"):])

    PASSING_BODY = '''
        import sys
        import unittest


        class T(unittest.TestCase):
            def test_one(self):
                self.assertEqual(1, 1)

            def test_two(self):
                self.assertEqual(2, 2)

            def test_three(self):
                self.assertEqual(3, 3)


        if __name__ == "__main__":
        %(pre)s
            result = unittest.main(exit=False, verbosity=0).result
            raise SystemExit(0 if result.wasSuccessful() else 1)
    '''

    def test_a_passing_module_that_prints_the_word_reports_its_real_passes(self) -> None:
        """The field case, end to end, with a clean control beside it.

        The control is what makes this meaningful: both modules are identical
        except for one print, so a difference in the reported phase can only
        come from that print.
        """
        noisy = self._write("noisy.py", self.PASSING_BODY % {
            "pre": '    print("repair tool: 4 malformed rows skipped")'})
        quiet = self._write("quiet.py", self.PASSING_BODY % {"pre": "    pass"})

        receipt = self._run(noisy, quiet)
        by_name = {Path(m["module"]).name: m for m in receipt["modules"]}

        self.assertEqual(by_name["quiet.py"]["phase"], "pass", "CONTROL: the identical module without the word")
        self.assertEqual(by_name["noisy.py"]["phase"], "pass")
        self.assertEqual(by_name["noisy.py"]["tests_ran"], 3, "and its three passes are COUNTED, not lost")
        self.assertEqual(receipt["summary"]["passed"], 2)
        self.assertEqual(receipt["summary"]["skipped"], 0)

    def test_a_genuine_partial_skip_keeps_its_passes(self) -> None:
        """Forty passes must not be thrown away because three cases skipped."""
        module = self._write("partial.py", '''
            import unittest


            class T(unittest.TestCase):
                def test_one(self):
                    self.assertEqual(1, 1)

                def test_two(self):
                    self.assertEqual(2, 2)

                def test_three(self):
                    self.assertEqual(3, 3)

                @unittest.skip("deliberate")
                def test_skipped_one(self):
                    pass

                @unittest.skip("deliberate")
                def test_skipped_two(self):
                    pass


            if __name__ == "__main__":
                result = unittest.main(exit=False, verbosity=0).result
                raise SystemExit(0 if result.wasSuccessful() else 1)
        ''')
        record = self._run(module)["modules"][0]
        self.assertEqual(record["phase"], "pass")
        self.assertEqual(record["tests_ran"], 5, "unittest counts the skipped cases in its own Ran line")
        self.assertIn("OK (skipped=2)", record["stderr"],
                      "POSITIVE CONTROL: the text that used to trigger the misclassification is really there")

    def test_a_module_with_no_tests_is_visibly_distinct_from_one_that_passed(self) -> None:
        """"0 passed" has to be shown, not left for a reader to notice."""
        empty = self._write("empty.py", '''
            print("I ran nothing at all")
        ''')
        real = self._write("real.py", self.PASSING_BODY % {"pre": "    pass"})

        receipt = self._run(empty, real)
        by_name = {Path(m["module"]).name: m for m in receipt["modules"]}

        self.assertIsNone(by_name["empty.py"]["tests_ran"])
        self.assertEqual(by_name["real.py"]["tests_ran"], 3)
        named = [Path(m).name for m in receipt["summary"]["non_failing_modules_without_tests"]]
        self.assertEqual(named, ["empty.py"],
                         "the module that proved nothing is named in the summary; the one that passed is not")

    def test_a_missing_structured_result_is_reported_rather_than_guessed_around(self) -> None:
        """A run with only an exit code to go on must say so."""
        # os._exit leaves the interpreter without running the child script's
        # `print("__ORGTREE_VERIFY_RESULT__"...)`, which is how the payload goes
        # missing in the field: a hard exit, a crash after the tests ran.
        silent = self._write("silent.py", '''
            import os
            import sys
            import unittest


            class T(unittest.TestCase):
                def test_one(self):
                    self.assertEqual(1, 1)

                def test_two(self):
                    self.assertEqual(2, 2)

                def test_three(self):
                    self.assertEqual(3, 3)


            if __name__ == "__main__":
                result = unittest.main(exit=False, verbosity=0).result
                sys.stdout.flush()
                sys.stderr.flush()
                os._exit(0 if result.wasSuccessful() else 1)
        ''')
        normal = self._write("normal.py", self.PASSING_BODY % {"pre": "    pass"})

        receipt = self._run(silent, normal)
        by_name = {Path(m["module"]).name: m for m in receipt["modules"]}

        self.assertFalse(by_name["silent.py"]["structured_result"])
        self.assertTrue(by_name["normal.py"]["structured_result"], "CONTROL: the ordinary module does deliver one")
        named = [Path(m).name for m in receipt["summary"]["modules_without_structured_result"]]
        self.assertEqual(named, ["silent.py"])
        # Losing the payload must not cost the module its passes any more.
        self.assertEqual(by_name["silent.py"]["phase"], "pass")
        self.assertEqual(by_name["silent.py"]["tests_ran"], 3)

    def test_exit_code_five_still_reaches_skip_without_a_payload(self) -> None:
        """The one text-free skip signal that is real, proved on the hard path."""
        module = self._write("nocollect.py", '''
            import os
            import sys

            print("no tests were collected")
            sys.stdout.flush()
            os._exit(5)
        ''')
        record = self._run(module)["modules"][0]
        self.assertEqual(record["phase"], "skip")
        self.assertFalse(record["structured_result"], "and it got there on the exit code alone")


if __name__ == "__main__":
    unittest.main(verbosity=2)
