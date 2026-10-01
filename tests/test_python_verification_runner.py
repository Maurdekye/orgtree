"""Focused tests for the isolated Python verification runner."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("python_verification_runner", ROOT / "tools" / "run-python-verification.py")
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


class PythonVerificationRunner(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Path(tempfile.mkdtemp(prefix="orgtree-runner-fixture-"))
        self.data = self.fixture / "data"

    def tearDown(self) -> None:
        runner._cleanup(self.fixture)

    def module(self, name: str, source: str) -> str:
        path = self.fixture / name
        path.write_text(source, encoding="utf-8")
        return str(path)

    def execute(self, path: str, baseline: set[str] | None = None):
        interpreter = runner.select_interpreter(ROOT, os.environ.get("ORGTREE_V2_PYTHON") or os.sys.executable)
        run_root, _ = runner.make_data_root(ROOT, str(self.data))
        return runner.run_modules([path], repo_root=ROOT, interpreter=interpreter, data_root=run_root, baseline=baseline)

    def test_each_module_gets_private_data_root_and_pass_receipt(self):
        path = self.module("pass.py", "from pathlib import Path\nimport os\nPath(os.environ['ORGTREE_DATA']).joinpath('seen').write_text('ok')\n")
        [result] = self.execute(path)
        self.assertEqual(result.phase, "pass")
        self.assertNotEqual(Path(result.data_root), self.data)
        self.assertFalse(Path(result.data_root).exists())
        self.assertIn(str(ROOT), result.import_roots)

    def test_module_directory_is_pinned_for_embedded_sibling_guards(self):
        self.module("release_guards.py", "VALUE = 'pinned-sibling'\n")
        path = self.module("verifier.py", "from release_guards import VALUE\nassert VALUE == 'pinned-sibling'\n")
        [result] = self.execute(path)
        self.assertEqual(result.phase, "pass")
        self.assertTrue(any(Path(root).samefile(self.fixture) for root in result.import_roots))

    def _runtime_fixture(self):
        data = self.fixture / "engine-data"
        data.mkdir()
        runtime = self.fixture / "runtime"
        (runtime / "engine").mkdir(parents=True)
        (runtime / "engine" / "launch.py").write_text("# fixture\n", encoding="utf-8")
        python = runtime / "python.exe"
        python.write_text("fixture", encoding="utf-8")
        identity = {
            "protocol": 1,
            "pid": 4242,
            "dataRootId": str(data.resolve()),
            "runtimeRoot": str(runtime.resolve()),
            "pythonExecutable": str(python.resolve()),
            "buildIdentity": {"commit": "a" * 40, "provenance": "packaged"},
        }
        return data, runtime, python, identity

    def test_discovery_accepts_boot_host_and_desktop_owned_topologies(self):
        data, runtime, python, identity = self._runtime_fixture()
        token = "ab" * 32
        descriptor = data / "engine-attach.json"
        descriptor.write_text(json.dumps({
            "type": "attach", "protocol": 1, "port": 2345, "enginePid": 4242,
            "hostPid": 4241, "dataRootId": str(data.resolve()), "token": token,
        }), encoding="utf-8")
        target = runner.discover_engine(data, expected_runtime_root=runtime,
            identity_request=lambda endpoint, supplied: identity,
            process_probe=lambda pid: str(python))
        self.assertEqual(target.mode, "boot-host")
        descriptor.unlink()
        target = runner.discover_engine(data, endpoint="http://127.0.0.1:2345", token=token,
            expected_runtime_root=runtime, identity_request=lambda endpoint, supplied: identity,
            process_probe=lambda pid: str(python))
        self.assertEqual(target.mode, "desktop-owned")

    def test_discovery_refuses_stale_identity_and_non_authoritative_port(self):
        data, runtime, python, identity = self._runtime_fixture()
        (data / "engine-port.json").write_text('{"port":2345}', encoding="utf-8")
        with self.assertRaisesRegex(runner.RuntimeDiscoveryError, "not authoritative"):
            runner.discover_engine(data)
        token = "ab" * 32
        bad = dict(identity, pid=4243)
        with self.assertRaisesRegex(runner.RuntimeDiscoveryError, "process"):
            runner.discover_engine(data, endpoint="http://127.0.0.1:2345", token=token,
                expected_pid=4242, expected_runtime_root=runtime,
                identity_request=lambda endpoint, supplied: bad,
                process_probe=lambda pid: str(python))

    def test_classifies_skip_assertion_and_import_failures(self):
        for name, source, expected in (
            ("skip.py", "from unittest import SkipTest\nraise SkipTest('environment')\n", "skip"),
            ("assertion.py", "assert False, 'red'\n", "assertion_failure"),
            ("import.py", "import module_that_does_not_exist\n", "import_failure"),
        ):
            [result] = self.execute(self.module(name, source))
            self.assertEqual(result.phase, expected)
            if expected == "skip":
                self.assertIsNone(result.failure_id)
            else:
                self.assertEqual(result.failure_id, f"{name}:{expected}")

    def test_exact_baseline_id_is_the_only_tolerated_failure(self):
        path = self.module("assertion.py", "assert False, 'red'\n")
        [result] = self.execute(path, {"assertion.py:assertion_failure"})
        self.assertTrue(result.baseline_match)
        [result] = self.execute(path, {"assertion.py:execution_failure"})
        self.assertFalse(result.baseline_match)

    def test_relative_interpreter_is_resolved_from_checkout(self):
        relative = "tests/test_python_verification_runner.py"
        selected_identity = runner.Interpreter(
            path=str(ROOT / relative), version="3.10.11", version_info=(3, 10, 11),
            implementation="CPython", executable=str(ROOT / relative),
        )
        with patch.object(runner, "_probe_interpreter", return_value=selected_identity) as probe:
            runner.select_interpreter(ROOT, relative)
        probe.assert_called_once_with((ROOT / relative).resolve())

    def test_v2_protected_roots_cannot_be_used_as_data_parent(self):
        protected = self.fixture / "production-profile"
        with patch.dict(os.environ, {"ORGTREE_V2_PROFILE": str(protected)}, clear=False):
            with self.assertRaises(ValueError):
                runner.make_data_root(ROOT, str(protected))

    def test_teardown_failure_is_not_counted_as_assertion_failure(self):
        source = """
import unittest
class Broken(unittest.TestCase):
    def test_ok(self):
        pass
    def tearDown(self):
        raise RuntimeError('tearDown broke')
if __name__ == '__main__':
    unittest.main()
"""
        [result] = self.execute(self.module("teardown.py", source))
        self.assertEqual(result.phase, "teardown_failure")

    # --------------------------------------------------- the result-protocol line
    #
    # The child reports its phase and provenance on a line of stdout beginning
    # with a marker. A module whose last write had no trailing newline used to
    # leave that marker mid-line, so the payload was never found: the run
    # reported EMPTY import_provenance -- the one field that proves which build
    # was tested -- and leaked the whole protocol line into the reported stdout.
    # `print("x", end="")` was enough, with no encoding involved.

    MARKER = "__ORGTREE_VERIFY_RESULT__"

    def test_unterminated_final_write_still_reports_provenance(self):
        path = self.module(
            "unterminated.py",
            "import sys\nprint('a normal line')\nsys.stdout.write('tail with no newline')\n")
        [result] = self.execute(path)
        self.assertEqual(result.phase, "pass")
        # The defect, pinned: this was {} before the fix.
        self.assertIn("orgtree", result.import_provenance)
        self.assertIn("engine", result.import_provenance)
        # And the protocol line must not be reported as the module's output.
        self.assertEqual(result.stdout, "a normal line\ntail with no newline")
        self.assertNotIn(self.MARKER, result.stdout)

    def test_a_marker_the_module_prints_itself_does_not_win(self):
        """The rule is LAST marker line wins, and it is a rule, not an accident.

        The child emits its own marker after the module has finished, so a
        module's copy -- a test covering this protocol, a log echoing it -- can
        only ever appear earlier. Anything the module claims is overridden
        rather than trusted.
        """
        forged = json.dumps({"phase": "skip", "marker": "skip",
                             "import_provenance": {"orgtree": "C:/Program Files/forged"}})
        path = self.module(
            "forged_marker.py",
            f"print({self.MARKER + forged!r})\nprint('after the forgery')\n")
        [result] = self.execute(path)
        # The forged payload claimed skip; the real one says pass.
        self.assertEqual(result.phase, "pass")
        self.assertNotIn("forged", json.dumps(result.import_provenance))
        self.assertTrue(str(result.import_provenance["orgtree"]).startswith(str(ROOT)))
        # Every marker line is stripped from the reported stdout, the module's
        # own included -- unchanged behaviour, asserted so it stays that way.
        self.assertEqual(result.stdout, "after the forgery")

    def test_a_forged_marker_left_unterminated_does_not_win_either(self):
        """The nastier ordering: the forgery is the module's last write, so the
        child's separator turns it into its own line. Last-wins still holds."""
        forged = json.dumps({"phase": "skip", "marker": "skip",
                             "import_provenance": {"orgtree": "C:/Program Files/forged"}})
        path = self.module(
            "forged_tail.py",
            f"import sys\nsys.stdout.write({self.MARKER + forged!r})\n")
        [result] = self.execute(path)
        self.assertEqual(result.phase, "pass")
        self.assertNotIn("forged", json.dumps(result.import_provenance))
        self.assertEqual(result.stdout, "")

    def test_output_that_already_parsed_is_reported_byte_identical(self):
        """The separator the child now writes must not show up in the report.

        Without the parent dropping exactly one empty line before the marker,
        every already-parsing module would gain a trailing blank line -- a
        change to a field callers read, for a fix they did not ask for.
        """
        path = self.module("ordinary.py", "print('one')\nprint('two')\n")
        [result] = self.execute(path)
        self.assertEqual(result.stdout, "one\ntwo")

    def test_a_blank_line_the_module_printed_itself_survives(self):
        """Only the child's own separator is dropped, not the module's blanks."""
        path = self.module("blanks.py", "import sys\nsys.stdout.write('one\\n\\n')\n")
        [result] = self.execute(path)
        self.assertEqual(result.stdout, "one\n")

    # ------------------------------------------------------- child stream decoding
    #
    # A byte the ambient Windows code page has no character for used to kill the
    # reader thread, leave the stream None, and take the WHOLE run's JSON with
    # it -- every module's result, not just the noisy one -- with a traceback
    # that named no module. A caller reading the exit code saw "the tests
    # failed"; a caller parsing the JSON got nothing. The bytes below are
    # undefined in cp1252, so these tests fail on the unfixed runner.

    UNDECODABLE = r"b'\x81\x8d\x90\x9d'"

    def test_child_stderr_that_the_code_page_cannot_decode_keeps_the_verdict(self):
        source = (
            "import sys, unittest\n"
            f"sys.stderr.buffer.write({self.UNDECODABLE})\n"
            "sys.stderr.buffer.flush()\n"
            "class T(unittest.TestCase):\n"
            "    def test_named_failure(self):\n"
            "        self.assertEqual(1, 2)\n"
            "unittest.main()\n"
        )
        [result] = self.execute(self.module("noisy_stderr.py", source))
        # The module's REAL verdict, which is what the crash destroyed.
        self.assertEqual(result.phase, "assertion_failure")
        self.assertEqual(result.failure_id, "noisy_stderr.py:assertion_failure")
        self.assertIn("test_named_failure", result.stderr)
        # The undecodable bytes arrive as replacement characters rather than
        # ending the run. Asserting this pins `errors="replace"`: dropping it
        # for a strict decode brings the crash straight back.
        self.assertIn("�", result.stderr)
        self.assertIsInstance(result.stdout, str)

    def test_child_stdout_that_the_code_page_cannot_decode_keeps_provenance(self):
        # Newline-terminated, which is what a noisy module actually emits. The
        # child's result protocol is a line prefix on this same stream, so an
        # unterminated write would run into it and cost the run its provenance
        # -- true of any unterminated write, ASCII included, and not this
        # ticket's defect. Recorded on the item rather than changed here.
        source = (
            "import sys\n"
            f"sys.stdout.buffer.write({self.UNDECODABLE} + b'\\n')\n"
            "sys.stdout.buffer.flush()\n"
        )
        [result] = self.execute(self.module("noisy_stdout.py", source))
        self.assertEqual(result.phase, "pass")
        self.assertIn("�", result.stdout)
        # Proves the noise did not cost the run its provenance.
        self.assertIn("orgtree", result.import_provenance)

    def test_a_stream_that_was_never_captured_is_reported_not_fatal(self):
        """The second half of the defect, which the encoding fix alone hides.

        `subprocess` reads each pipe on its own thread; a thread that dies
        leaves the attribute None instead of raising, and the failure surfaces
        later as a TypeError that destroys every module's result. With the
        decode fixed, a dead reader is no longer reachable from a stray byte --
        so this drives the None directly, to keep the guard under test rather
        than trusting an unreachable branch.
        """
        real = runner.subprocess.run

        def lost_streams(*args, **kwargs):
            completed = real(*args, **kwargs)
            return runner.subprocess.CompletedProcess(
                completed.args, completed.returncode, stdout=None, stderr=None)

        path = self.module("quiet.py", "print('hello')\n")
        # Select the interpreter and the data root BEFORE patching: the
        # interpreter probe shells out too, and patching around it would test
        # the probe's own guard instead of this one.
        interpreter = runner.select_interpreter(
            ROOT, os.environ.get("ORGTREE_V2_PYTHON") or sys.executable)
        run_root, _ = runner.make_data_root(ROOT, str(self.data))
        with patch.object(runner.subprocess, "run", side_effect=lost_streams):
            [result] = runner.run_modules(
                [path], repo_root=ROOT, interpreter=interpreter, data_root=run_root)
        self.assertIn("was not captured", result.stdout)
        self.assertIn("was not captured", result.stderr)
        # A missing stream must not read as a module that printed nothing, and
        # the module must still get a verdict rather than taking the run down.
        self.assertNotEqual(result.stdout, "")
        self.assertIn(result.phase, {"pass", "execution_failure"})

    def execute_cached(self, path: str, pycache: Path):
        interpreter = runner.select_interpreter(ROOT, os.environ.get("ORGTREE_V2_PYTHON") or os.sys.executable)
        run_root, _ = runner.make_data_root(ROOT, str(self.data))
        return runner.run_modules([path], repo_root=ROOT, interpreter=interpreter, data_root=run_root,
                                  pycache_dir=pycache)

    def test_pycache_dir_keeps_bytecode_out_of_the_sources_and_recompiles_an_edit(self):
        pycache = self.fixture / "pycache"
        helper = self.module("cached_helper.py", "VALUE = 'first'\n")
        settled = time.time() - 60   # a source edited under 2 s ago is never cached
        os.utime(helper, (settled, settled))
        path = self.module("uses_helper.py",
                           "from cached_helper import VALUE\nprint('VALUE=' + VALUE)\n")
        [result] = self.execute_cached(path, pycache)
        self.assertEqual(result.phase, "pass", result.stderr)
        self.assertIn("VALUE=first", result.stdout)
        cached = list(pycache.rglob("cached_helper.*.pyc"))
        self.assertEqual(len(cached), 1, "the imported helper is compiled into the prefix tree")
        self.assertFalse(list(self.fixture.glob("__pycache__")), "nothing is written beside the sources")
        # An edit of a different size must be recompiled, never served stale.
        Path(helper).write_text("VALUE = 'second, and longer'\n", encoding="utf-8")
        [result] = self.execute_cached(path, pycache)
        self.assertEqual(result.phase, "pass", result.stderr)
        self.assertIn("VALUE=second, and longer", result.stdout)

    def test_a_same_size_edit_in_the_same_second_is_never_served_stale(self):
        # The mutation-testing shape: edit, run, edit again within the second
        # the first edit carries, same size. A pyc keys on (mtime in whole
        # seconds, size), so if the first run had cached bytecode the second
        # would silently run the old code. The mtime is pinned into the
        # future so "edited within the last 2 s" holds however slow the run.
        pycache = self.fixture / "pycache"
        helper = Path(self.module("mutant.py", "VALUE = 'AAAA'\n"))
        pinned = time.time() + 30
        os.utime(helper, (pinned, pinned))
        path = self.module("uses_mutant.py", "from mutant import VALUE\nprint('VALUE=' + VALUE)\n")
        [result] = self.execute_cached(path, pycache)
        self.assertIn("VALUE=AAAA", result.stdout, result.stderr)
        self.assertFalse(list(pycache.rglob("mutant.*.pyc")), "a just-edited source was cached")
        helper.write_text("VALUE = 'BBBB'\n", encoding="utf-8")
        os.utime(helper, (pinned, pinned))
        [result] = self.execute_cached(path, pycache)
        self.assertIn("VALUE=BBBB", result.stdout, result.stderr)

    def test_the_shared_pycache_drops_stale_entries(self):
        cache = self.fixture / "prune"
        old, new = cache / "a" / "old.cpython-313.pyc", cache / "a" / "new.cpython-313.pyc"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"x")
        new.write_bytes(b"x")
        aged = time.time() - runner.PYCACHE_MAX_AGE_S - 60
        os.utime(old, (aged, aged))
        runner.pycache_root(ROOT, str(cache))
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())
        with patch.object(runner, "PYCACHE_MAX_BYTES", 0):
            runner.pycache_root(ROOT, str(cache))
        self.assertTrue(cache.is_dir())
        self.assertFalse(new.exists(), "past the size cap the cache is dropped whole")

    def test_without_a_pycache_dir_nothing_is_compiled_to_disk(self):
        self.module("plain_helper.py", "VALUE = 1\n")
        [result] = self.execute(self.module("uses_plain.py", "from plain_helper import VALUE\n"))
        self.assertEqual(result.phase, "pass", result.stderr)
        self.assertFalse(list(self.fixture.rglob("*.pyc")))

    def test_pycache_dir_is_refused_inside_the_checkout_and_off_means_none(self):
        self.assertIsNone(runner.pycache_root(ROOT, "off"))
        self.assertIsNone(runner.pycache_root(ROOT, None))
        with self.assertRaisesRegex(ValueError, "outside the checkout"):
            runner.pycache_root(ROOT, str(ROOT / "build" / "pycache"))
        with self.assertRaisesRegex(ValueError, "outside the checkout"):
            runner.pycache_root(ROOT, str(ROOT.parent))
        self.assertEqual(runner.pycache_root(ROOT, str(self.fixture / "p")), runner._canonical(self.fixture / "p"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
