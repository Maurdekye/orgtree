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
k32.GetFinalPathNameByHandleW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong]
# The number alone proves nothing: the child's own pipes may sit at the same
# value. The stray is a uniquely named file, so only that file counts.
stray = int(os.environ.get("ORGTREE_UNELEVATED_STRAY", "0"))
stray_name = os.environ.get("ORGTREE_UNELEVATED_STRAY_NAME", "")
buf = ctypes.create_unicode_buffer(1024)
stray_open = bool(stray and stray_name and k32.GetFinalPathNameByHandleW(stray, buf, 1024, 0)
                  and stray_name in buf.value)
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

    def test_service_host_starts_the_engine_through_the_spawner(self):
        source = inspect.getsource(service_host.main)
        launch = source[source.index('launcher = Path(__file__)'):source.index("ready: dict")]
        self.assertIn("spawn = engine_spawner()", launch)
        self.assertIn("child = spawn(", launch)
        self.assertNotIn("subprocess.Popen(", launch)

    def test_the_engine_drops_admin_rights_unless_the_setting_is_on(self):
        with patch.object(service_host, "run_as_administrator_enabled", return_value=False):
            self.assertIs(service_host.engine_spawner(), unelevated.popen_unelevated)
        with patch.object(service_host, "run_as_administrator_enabled", return_value=True):
            self.assertIs(service_host.engine_spawner(), subprocess.Popen)


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
        # Only when the rights are really being dropped: with "Run Orgtree as
        # administrator" on, the engine keeps them and needs no repair.
        repair = source.index("repair_user_access(root)")
        self.assertLess(source.index("spawn = engine_spawner()"),
                        source.index("if spawn is popen_unelevated and process_is_elevated():"))
        self.assertLess(source.index("if spawn is popen_unelevated and process_is_elevated():"), repair)
        self.assertLess(repair, source.index("child = spawn("))

    def test_repair_candidates_are_the_root_its_folders_and_the_profiles(self):
        base = Path(tempfile.gettempdir()) / f"orgtree-candidates-{uuid.uuid4().hex}"
        self.addCleanup(shutil.rmtree, base, True)
        (base / "profiles" / "claude-a").mkdir(parents=True)
        (base / "orgs" / "deep" / "deeper").mkdir(parents=True)
        (base / "file.txt").write_text("x", encoding="utf-8")
        found = {Path(p).relative_to(base).as_posix() for p in unelevated.user_access_candidates(base)}
        self.assertEqual(found, {".", "profiles", "orgs", "profiles/claude-a"})


class RunAsAdministratorSettingTests(unittest.TestCase):
    """The setting is read from HKLM only; the registry is mocked, never written."""

    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("UNEXECUTED: the setting is a Windows registry value")
        import winreg
        self.winreg = winreg

    def read(self, value=None, error=None):
        opened = []

        class Key:
            def __enter__(self): return self
            def __exit__(self, *_): return False

        def open_key(hive, path, reserved, access):
            opened.append((hive, path, access))
            if error:
                raise error
            return Key()
        with patch.object(self.winreg, "OpenKey", open_key), \
             patch.object(self.winreg, "QueryValueEx", return_value=value):
            result = unelevated.run_as_administrator_enabled()
        return result, opened

    def test_only_dword_one_turns_it_on(self):
        dword, sz = self.winreg.REG_DWORD, self.winreg.REG_SZ
        self.assertTrue(self.read((1, dword))[0])
        for value in ((0, dword), (2, dword), ("1", sz), (1, self.winreg.REG_QWORD)):
            self.assertFalse(self.read(value)[0], value)

    def test_missing_or_unreadable_means_off(self):
        self.assertFalse(self.read(error=FileNotFoundError())[0])
        self.assertFalse(self.read(error=PermissionError())[0])

    def test_it_reads_the_protected_hklm_key_in_the_64_bit_view(self):
        _result, opened = self.read((1, self.winreg.REG_DWORD))
        hive, path, access = opened[0]
        self.assertEqual(hive, self.winreg.HKEY_LOCAL_MACHINE)
        self.assertEqual(path, r"SOFTWARE\Orgtree\Runtime")
        self.assertTrue(access & self.winreg.KEY_WOW64_64KEY)

    def test_the_real_registry_read_answers_a_boolean(self):
        self.assertIsInstance(unelevated.run_as_administrator_enabled(), bool)


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
        stray_name = f"orgtree-stray-{uuid.uuid4().hex}.txt"
        stray_file = open(Path(tempfile.gettempdir()) / stray_name, "w", encoding="utf-8")
        self.addCleanup(os.remove, stray_file.name)
        self.addCleanup(stray_file.close)
        os.set_inheritable(stray_file.fileno(), True)
        stray = msvcrt.get_osfhandle(stray_file.fileno())
        # A plain mkdir inherits %TEMP%'s user entry; mkdtemp's 0o700 folder
        # can be closed to the normal-user child (see AccessRepairTests).
        cwd = Path(tempfile.gettempdir()) / f"orgtree-unelevated-{uuid.uuid4().hex}"
        cwd.mkdir()
        self.addCleanup(shutil.rmtree, cwd, True)
        env = {**os.environ, "ORGTREE_UNELEVATED_MARKER": "m-42", "ORGTREE_UNELEVATED_STRAY": str(stray),
               "ORGTREE_UNELEVATED_STRAY_NAME": stray_name}
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


# Run elevated: make this process's default owner argv[2], then create argv[1]
# with Python's mkdir(0o700) and a file inside it, as an engine would.
MAKE_OWNED = r"""
import ctypes, os, sys
from ctypes import wintypes as w
k32, adv = ctypes.WinDLL("kernel32", use_last_error=True), ctypes.WinDLL("advapi32", use_last_error=True)
k32.GetCurrentProcess.restype = w.HANDLE
adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
adv.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
adv.SetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
token, sid = w.HANDLE(), ctypes.c_void_p()
assert adv.OpenProcessToken(k32.GetCurrentProcess(), 0x0080 | 0x0008, ctypes.byref(token))  # ADJUST_DEFAULT|QUERY
assert adv.ConvertStringSidToSidW(sys.argv[2], ctypes.byref(sid))
owner = ctypes.c_void_p(sid.value)
assert adv.SetTokenInformation(token, 4, ctypes.byref(owner), ctypes.sizeof(owner)), ctypes.get_last_error()  # TokenOwner
os.mkdir(sys.argv[1], 0o700)
with open(os.path.join(sys.argv[1], "creds.json"), "w", encoding="utf-8") as f:
    f.write("secret")
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
        profiles = self.root / "profiles"
        profiles.mkdir(parents=True)
        (self.root / "orgs").mkdir()

        user = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], check=True, capture_output=True,
                              text=True, creationflags=subprocess.CREATE_NO_WINDOW).stdout.strip().split(",")[-1].strip('"')
        # The live shape, made the way the product made it: Python's
        # mkdir(0o700) under a token whose DEFAULT OWNER is Administrators
        # gives owner BA and D:P(OW)(SY)(BA) (review-astra's shell does this).
        # The owner cannot be changed afterwards instead: Windows drops the
        # OWNER RIGHTS entry whenever a folder's owner changes (measured), so
        # a helper sets its own TokenOwner first, then creates the folder.
        self.locked = profiles / "claude-locked"      # an elevated engine's: owner Administrators
        self.owned = profiles / "claude-owned"        # the user's own: OWNER RIGHTS lets it in
        for folder, owner in ((self.locked, "S-1-5-32-544"), (self.owned, user)):
            subprocess.run(child_python.argv("-c", MAKE_OWNED, str(folder), owner), check=True,
                           capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(self.allowed(folder), {"S-1-3-4", "S-1-5-18", "S-1-5-32-544"},
                             "the fixture must carry the live D:P(OW)(SY)(BA)")

    def allowed(self, folder):
        """The SIDs the folder's own DACL allows (what the repair script reads)."""
        script = ("(Get-Item -LiteralPath $env:ORGTREE_FOLDER).GetAccessControl('Access')"
                  ".GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |"
                  " ForEach-Object { $_.IdentityReference.Value }")
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                             check=True, capture_output=True, text=True,
                             env={**os.environ, "ORGTREE_FOLDER": str(folder)},
                             creationflags=subprocess.CREATE_NO_WINDOW).stdout
        return set(out.split())

    def probe(self, folder=None):
        env = {**os.environ}
        env.pop("PYTHONPATH", None)
        child = unelevated.popen_unelevated(
            child_python.argv("-c", PROBE, str(folder or self.locked)), env=env,
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

    def test_a_folder_the_user_owns_under_owner_rights_is_left_alone(self):
        self.assertEqual(self.probe(self.owned), {"read": "secret", "write": "ok"},
                         "OWNER RIGHTS already lets the user's own folder in")
        self.assertNotIn(str(self.owned), unelevated.repair_user_access(self.root))
        self.assertEqual(self.allowed(self.owned), {"S-1-3-4", "S-1-5-18", "S-1-5-32-544"})


if __name__ == "__main__":
    unittest.main()
