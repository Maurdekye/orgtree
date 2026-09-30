"""The boot host starts the engine WITHOUT administrator rights.

The boot task's S4U logon gives an administrator account its full token even
at RunLevel Limited (measured 2026-09-30), so service_host.py must start
launch.py through engine.unelevated.popen_unelevated. The real-token tests
need an ELEVATED test process, which is exactly the environment the fix is
for; anywhere else they declare themselves UNEXECUTED via SkipTest rather
than passing vacuously. An agent shell spawned by the boot-task engine is
elevated, so on the machine the defect was measured on they run.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import unelevated

REPO = Path(__file__).resolve().parent.parent

# Runs in the child: report its own token, cwd and one environment value.
CHILD = r"""
import ctypes, json, os, sys
sys.path.insert(0, sys.argv[1])
from engine import unelevated
admins = ctypes.create_string_buffer(68)
size = ctypes.c_ulong(68)
ctypes.windll.advapi32.CreateWellKnownSid(26, None, admins, ctypes.byref(size))  # WinBuiltinAdministratorsSid
member = ctypes.c_int(0)
ctypes.windll.advapi32.CheckTokenMembership(None, admins, ctypes.byref(member))
print(json.dumps({"elevated": unelevated.process_is_elevated(),
                  "rid": unelevated.process_integrity_rid(),
                  "admin_member": bool(member.value),
                  "module": unelevated.__file__,
                  "cwd": os.getcwd(),
                  "marker": os.environ.get("ORGTREE_UNELEVATED_MARKER")}))
sys.stderr.write("child stderr ok\n")
sys.exit(7)
"""


class PolicyTests(unittest.TestCase):
    def test_a_caller_that_is_not_elevated_gets_plain_popen(self):
        sentinel = object()
        with patch.object(unelevated, "process_is_elevated", return_value=False), \
             patch.object(unelevated, "restricted_medium_token") as token, \
             patch.object(unelevated.subprocess, "Popen", return_value=sentinel) as popen:
            result = unelevated.popen_unelevated(["x"], cwd="c")
        self.assertIs(result, sentinel)
        popen.assert_called_once_with(["x"], cwd="c")
        token.assert_not_called()

    def test_service_host_starts_the_engine_through_popen_unelevated(self):
        source = (REPO / "engine" / "service_host.py").read_text(encoding="utf-8")
        launch = source[source.index('launcher = Path(__file__)'):source.index("ready: dict")]
        self.assertIn("popen_unelevated([sys.executable, str(launcher)]", launch)
        self.assertNotIn("subprocess.Popen(", launch)

    def test_the_environment_block_is_sorted_and_double_terminated(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows-only environment block")
        block = unelevated._environment_block({"b": "2", "A": "1"})
        self.assertEqual(block[:], "A=1\0b=2\0\0")
        self.assertIsNone(unelevated._environment_block(None))


class ElevatedSpawnTests(unittest.TestCase):
    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows tokens only")
        if not unelevated.process_is_elevated():
            raise unittest.SkipTest("UNEXECUTED: needs an elevated test process "
                                    "(run from an elevated shell or the boot-task engine)")

    def run_child(self):
        with tempfile.TemporaryDirectory() as cwd:
            env = {**os.environ, "ORGTREE_UNELEVATED_MARKER": "m-42"}
            env.pop("PYTHONPATH", None)
            child = unelevated.popen_unelevated(
                [sys.executable, "-c", CHILD, str(REPO)], cwd=cwd, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            out, err = child.communicate(timeout=60)
            return child, json.loads(out.decode()), err.decode(), cwd

    def test_the_child_runs_at_medium_without_administrators(self):
        child, report, _err, _cwd = self.run_child()
        self.assertEqual(report["module"], str(REPO / "engine" / "unelevated.py"))
        self.assertFalse(report["elevated"])
        self.assertEqual(report["rid"], unelevated.MEDIUM_RID)
        self.assertFalse(report["admin_member"], "Administrators must be deny-only in the child")
        self.assertEqual(child.returncode, 7)

    def test_pipes_cwd_and_environment_reach_the_child(self):
        _child, report, err, cwd = self.run_child()
        self.assertEqual(os.path.normcase(os.path.realpath(report["cwd"])),
                         os.path.normcase(os.path.realpath(cwd)))
        self.assertEqual(report["marker"], "m-42")
        self.assertIn("child stderr ok", err)

    def test_the_caller_keeps_its_rights_and_createprocess_is_restored(self):
        original = subprocess._winapi.CreateProcess
        self.run_child()
        self.assertIs(subprocess._winapi.CreateProcess, original)
        self.assertTrue(unelevated.process_is_elevated())
        self.assertEqual(unelevated.process_integrity_rid(), unelevated.HIGH_RID)

    def test_createprocess_is_restored_when_the_spawn_fails(self):
        original = subprocess._winapi.CreateProcess
        with self.assertRaises(OSError):
            unelevated.popen_unelevated([str(REPO / "no-such-program.exe")])
        self.assertIs(subprocess._winapi.CreateProcess, original)


if __name__ == "__main__":
    unittest.main()
