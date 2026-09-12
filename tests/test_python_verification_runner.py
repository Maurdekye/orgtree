"""Focused tests for the isolated Python verification runner."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
