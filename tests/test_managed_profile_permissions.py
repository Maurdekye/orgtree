"""Exercise managed profile writes under the operator's unelevated token."""
import ctypes
import os
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from ctypes import wintypes as w

from engine.backend.orgtree.managed_profiles import create_profile


@unittest.skipUnless(os.name == "nt", "Windows token/ACL regression")
class ProfilePermissions(unittest.TestCase):
    def test_desktop_token_can_persist_login_while_old_creation_is_denied(self):
        if not ctypes.windll.shell32.IsUserAnAdmin():
            self.skipTest("Elevated/S4U creation reproduction requires an administrator token")
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.CloseHandle.argtypes = [w.HANDLE]
        advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
        advapi.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
        advapi.ImpersonateLoggedOnUser.argtypes = [w.HANDLE]
        class SidAttributes(ctypes.Structure):
            _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", w.DWORD)]
        advapi.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p)]
        advapi.CreateRestrictedToken.argtypes = [w.HANDLE, w.DWORD, w.DWORD,
            ctypes.POINTER(SidAttributes), w.DWORD, ctypes.c_void_p,
            w.DWORD, ctypes.c_void_p, ctypes.POINTER(w.HANDLE)]
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        token, linked = w.HANDLE(), w.HANDLE()
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0xF, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            size, elevation = w.DWORD(), w.DWORD()
            if not advapi.GetTokenInformation(token, 18, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            if elevation.value == 2:
                if not advapi.GetTokenInformation(token, 19, ctypes.byref(linked), ctypes.sizeof(linked), ctypes.byref(size)):
                    raise ctypes.WinError(ctypes.get_last_error())
            else:
                # S4U service tokens have no linked UAC token. Disable the
                # Administrators SID and privileges explicitly instead.
                sid = ctypes.c_void_p()
                if not advapi.ConvertStringSidToSidW("S-1-5-32-544", ctypes.byref(sid)):
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    disabled = SidAttributes(sid, 0)
                    if not advapi.CreateRestrictedToken(token, 1, 1, ctypes.byref(disabled), 0, None, 0, None, ctypes.byref(linked)):
                        raise ctypes.WinError(ctypes.get_last_error())
                finally:
                    kernel.LocalFree(sid)
            base = create_profile(tempfile.gettempdir(), "orgtree-acl-test")
            old = tempfile.mkdtemp(prefix="old-", dir=base)
            fixed = create_profile(base, "claude")
            if not advapi.ImpersonateLoggedOnUser(linked):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                # The broken algorithm is a positive control for the actual
                # access check, not a string assertion about an ACL or SID.
                with self.assertRaises(PermissionError):
                    Path(old, "credential-fixture.txt").write_text("fixture-only")
                root = Path(fixed)
                (root / "credential-fixture.txt").write_text("fixture-only")
                self.assertEqual((root / "credential-fixture.txt").read_text(), "fixture-only")
                child = root / "child"
                child.mkdir()
                (child / "metadata.txt").write_text("fixture-only")
                self.assertEqual((child / "metadata.txt").read_text(), "fixture-only")
            finally:
                if not advapi.RevertToSelf():
                    raise ctypes.WinError(ctypes.get_last_error())
        finally:
            if linked.value:
                kernel.CloseHandle(linked)
            kernel.CloseHandle(token)

    def test_invalid_provider_cannot_escape_profile_root(self):
        with self.assertRaises(ValueError):
            create_profile(tempfile.gettempdir(), "../outside")

    def test_profile_acl_excludes_inherited_and_other_user_access(self):
        path = create_profile(tempfile.gettempdir(), "orgtree-acl-private")
        escaped = path.replace("'", "''")
        script = (
            f"$a=Get-Acl -LiteralPath '{escaped}';"
            "$sid=[Security.Principal.SecurityIdentifier];"
            "@{owner=$a.GetOwner($sid).Value;protected=$a.AreAccessRulesProtected;"
            "entries=@($a.GetAccessRules($true,$true,$sid)|ForEach-Object {"
            "@{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;"
            "rights=$_.FileSystemRights.ToString();inheritance=$_.InheritanceFlags.ToString()}})}|ConvertTo-Json -Depth 4")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                check=True, capture_output=True, text=True, timeout=15,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        acl = json.loads(result.stdout)
        self.assertTrue(acl["protected"])
        self.assertTrue(acl["owner"].startswith("S-1-5-21-"))
        self.assertEqual({e["sid"] for e in acl["entries"]}, {acl["owner"], "S-1-5-18", "S-1-5-32-544"})
        for entry in acl["entries"]:
            self.assertFalse(entry["inherited"])
            self.assertEqual(entry["rights"], "FullControl")
            self.assertIn("ContainerInherit", entry["inheritance"])
            self.assertIn("ObjectInherit", entry["inheritance"])


if __name__ == "__main__":
    unittest.main()
