"""The boot host starts the engine WITHOUT administrator rights.

The boot task's S4U logon gives an administrator account its full token even
at RunLevel Limited (measured 2026-09-30), so service_host.py must start
launch.py through engine.unelevated.popen_unelevated. The real-token tests
need an ELEVATED test process, which is exactly the environment the fix is
for; anywhere else they declare themselves UNEXECUTED via SkipTest rather
than passing vacuously. An agent shell spawned by the boot-task engine is
elevated, so on the machine the defect was measured on they run.
"""

import inspect
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import child_python

from engine import service_host, unelevated

REPO = Path(__file__).resolve().parent.parent

# Runs in the child: report its own token, cwd and one environment value.
CHILD = r"""
import csv, ctypes, json, os, subprocess, sys
from engine import unelevated
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.GetHandleInformation.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
stray = int(os.environ.get("ORGTREE_UNELEVATED_STRAY", "0"))
flags = ctypes.c_ulong(0)
stray_open = bool(stray) and bool(k32.GetHandleInformation(stray, ctypes.byref(flags)))
privs = subprocess.run(["whoami", "/priv", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
privileges = sorted(row[0] for row in csv.reader(privs.splitlines()) if row)
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
                  "marker": os.environ.get("ORGTREE_UNELEVATED_MARKER"),
                  "stray_open": stray_open,
                  "privileges": privileges}))
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
        source = inspect.getsource(service_host.main)
        launch = source[source.index('launcher = Path(__file__)'):source.index("ready: dict")]
        self.assertIn("child = popen_unelevated(", launch)
        self.assertNotIn("subprocess.Popen(", launch)

    def test_the_environment_block_is_sorted_and_double_terminated(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows-only environment block")
        block = unelevated._environment_block({"b": "2", "A": "1"})
        self.assertEqual(block[:], "A=1\0b=2\0\0")
        self.assertIsNone(unelevated._environment_block(None))

    def test_the_environment_block_refuses_what_createprocess_refuses(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows-only environment block")
        self.assertEqual(unelevated._environment_block({"=C:": "C:\\x"})[:], "=C:=C:\\x\0\0")
        for env in ({"A=B": "1"}, {"": "1"}, {"A": "x\0y"}, {"A\0": "1"}):
            with self.assertRaises(ValueError, msg=repr(env)):
                unelevated._environment_block(env)

    def test_service_host_repairs_access_before_it_starts_the_engine(self):
        source = inspect.getsource(service_host.main)
        repair = source.index("repair_user_access(root)")
        self.assertLess(source.index("if process_is_elevated():"), repair)
        self.assertLess(repair, source.index("popen_unelevated("))

    def test_repair_candidates_are_the_root_its_folders_and_the_profiles(self):
        base = Path(tempfile.gettempdir()) / f"orgtree-candidates-{uuid.uuid4().hex}"
        self.addCleanup(shutil.rmtree, base, True)
        (base / "profiles" / "claude-a").mkdir(parents=True)
        (base / "orgs" / "deep" / "deeper").mkdir(parents=True)
        (base / "file.txt").write_text("x", encoding="utf-8")
        found = {Path(p).relative_to(base).as_posix() for p in unelevated.user_access_candidates(base)}
        self.assertEqual(found, {".", "profiles", "orgs", "profiles/claude-a"})


class ElevatedSpawnTests(unittest.TestCase):
    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows tokens only")
        if not unelevated.process_is_elevated():
            raise unittest.SkipTest("UNEXECUTED: needs an elevated test process "
                                    "(run from an elevated shell or the boot-task engine)")

    def run_child(self):
        import msvcrt
        # An INHERITABLE handle the child is not given: only Popen's handle
        # list may cross, so the child must not find it open.
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        self.addCleanup(os.close, write_fd)
        os.set_inheritable(write_fd, True)
        stray = msvcrt.get_osfhandle(write_fd)
        # A plain mkdir inherits %TEMP%'s user entry; mkdtemp's 0o700 folder
        # can be closed to the normal-user child (see AccessRepairTests).
        cwd = Path(tempfile.gettempdir()) / f"orgtree-unelevated-{uuid.uuid4().hex}"
        cwd.mkdir()
        self.addCleanup(shutil.rmtree, cwd, True)
        env = {**os.environ, "ORGTREE_UNELEVATED_MARKER": "m-42", "ORGTREE_UNELEVATED_STRAY": str(stray)}
        env.pop("PYTHONPATH", None)
        child = unelevated.popen_unelevated(
            child_python.argv("-c", CHILD), cwd=str(cwd), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out, err = child.communicate(timeout=60)
        return child, json.loads(out.decode()), err.decode(), str(cwd)

    def test_the_child_runs_at_medium_without_administrators(self):
        child, report, _err, _cwd = self.run_child()
        self.assertEqual(report["module"], str(REPO / "engine" / "unelevated.py"))
        self.assertFalse(report["elevated"])
        self.assertEqual(report["rid"], unelevated.MEDIUM_RID)
        self.assertFalse(report["admin_member"], "Administrators must be deny-only in the child")
        self.assertEqual(child.returncode, 7)

    def test_the_child_keeps_no_privilege_but_bypass_traverse(self):
        # An elevated token carries SeDebug, SeTakeOwnership, SeBackup,
        # SeRestore, SeLoadDriver... each one admin power on its own.
        _child, report, _err, _cwd = self.run_child()
        self.assertTrue(report["privileges"], "whoami /priv printed nothing")
        self.assertEqual(report["privileges"], ["SeChangeNotifyPrivilege"])

    def test_only_the_handle_list_is_inherited(self):
        _child, report, _err, _cwd = self.run_child()
        self.assertFalse(report["stray_open"], "an inheritable handle outside Popen's list reached the child")

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



# Run as the NORMAL-USER child: can it read the file, and create one?
PROBE = r"""
import json, os, sys
folder = sys.argv[1]
result = {}
try:
    with open(os.path.join(folder, "creds.json"), encoding="utf-8") as f:
        result["read"] = f.read()
except OSError as exc:
    result["read"] = f"denied: {exc.winerror}"
try:
    with open(os.path.join(folder, "new.txt"), "w", encoding="utf-8") as f:
        f.write("ok")
    result["write"] = "ok"
except OSError as exc:
    result["write"] = f"denied: {exc.winerror}"
print(json.dumps(result))
"""


class AccessRepairTests(unittest.TestCase):
    """A folder an ELEVATED engine left owned by Administrators under a
    protected SYSTEM/Administrators/OWNER RIGHTS DACL (Python's mkdir 0o700;
    one such profile folder is on the live data root) is closed to the
    normal-user engine until the host repairs it."""

    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: Windows ACLs only")
        if not unelevated.process_is_elevated():
            raise unittest.SkipTest("UNEXECUTED: needs an elevated test process "
                                    "(setting an Administrators owner needs admin rights)")
        base = Path(tempfile.gettempdir()) / f"orgtree-repair-{uuid.uuid4().hex}"
        base.mkdir()
        self.addCleanup(shutil.rmtree, base, True)
        self.root = base / "data"
        self.locked = self.root / "profiles" / "claude-locked"
        self.locked.mkdir(parents=True)
        (self.root / "orgs").mkdir()
        (self.locked / "creds.json").write_text("secret", encoding="utf-8")

        def icacls(*args):
            subprocess.run(["icacls", *args], check=True, capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        # The shape the live folder has: owner Administrators, protected DACL
        # of SYSTEM, Administrators and OWNER RIGHTS; the file inside inherits.
        icacls(str(self.locked), "/inheritance:r", "/grant:r",
               "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-3-4:(OI)(CI)F")
        icacls(str(self.locked / "creds.json"), "/reset")
        icacls(str(self.locked), "/setowner", "*S-1-5-32-544", "/T")

    def probe(self):
        env = {**os.environ}
        env.pop("PYTHONPATH", None)
        child = unelevated.popen_unelevated(
            child_python.argv("-c", PROBE, str(self.locked)), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out, err = child.communicate(timeout=60)
        self.assertEqual(child.returncode, 0, err.decode())
        return json.loads(out.decode())

    def test_the_locked_folder_is_closed_to_the_normal_user_until_repaired(self):
        before = self.probe()
        self.assertTrue(before["read"].startswith("denied"), before)
        self.assertTrue(before["write"].startswith("denied"), before)
        self.assertEqual(unelevated.repair_user_access(self.root), [str(self.locked)])
        self.assertEqual(self.probe(), {"read": "secret", "write": "ok"})

    def test_the_repair_touches_nothing_else_and_is_idempotent(self):
        self.assertEqual(unelevated.repair_user_access(self.root), [str(self.locked)])
        self.assertEqual(unelevated.repair_user_access(self.root), [])


if __name__ == "__main__":
    unittest.main()
