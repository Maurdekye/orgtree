"""Staging the protected service payload, in temp folders only.

Most cases inject a fake security reader so a non-elevated test can model a
protected tree. One Windows case creates a folder with a protected DACL at
creation (a variant that also grants this test account, so it can clean up)
and reads the real ACL of a copied file: only the protected entries, nothing
inherited from the temp folder. Nothing is installed; Program Files is never
touched.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.winservice import payload_guard as g
from engine.winservice import payload_stage as s

SAFE = g.Security(g.SID_SYSTEM, True, (g.Ace(0, 0, 0x1F01FF, g.SID_SYSTEM),
                                       g.Ace(0, 0, 0x1200A9, "S-1-5-32-545")))
UNSAFE = g.Security("S-1-5-21-1-2-3-1001", True, (g.Ace(0, 0, 0x1F01FF, "S-1-5-21-1-2-3-1001"),))


def plain_mkdir(path):
    Path(path).mkdir()


class StageTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.source = self.base / "install" / "resources"
        (self.source / "engine" / "runtime").mkdir(parents=True)
        (self.source / "engine" / "service_main.py").write_text("main\n", encoding="utf-8")
        (self.source / "engine" / "runtime" / "python.exe").write_bytes(b"MZ\x90")
        (self.source / "ui").mkdir()
        (self.source / "ui" / "index.html").write_text("<!doctype html>", encoding="utf-8")
        self.root = self.base / "Orgtree Engine Service"

    def stage(self, version="3.0.0-alpha.0", reader=lambda p: SAFE, **kw):
        return s.stage_payload(self.source, self.root, version, read_security=reader, make_dir=plain_mkdir, **kw)

    def residue(self):
        return sorted(p.name for p in self.root.iterdir()) if self.root.exists() else []

    def test_stages_an_exact_copy_and_publishes_it_under_its_identity(self):
        staged = self.stage()
        self.assertEqual(staged.path.parent, self.root)
        self.assertEqual(staged.path.name, f"payload-3.0.0-alpha.0-{staged.payload_id[:8]}")
        manifest = json.loads((staged.path / g.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(sorted(manifest["files"]), ["resources/engine/runtime/python.exe",
                                                     "resources/engine/service_main.py", "resources/ui/index.html"])
        self.assertEqual(g.manifest_id(manifest), staged.payload_id)
        self.assertEqual((staged.path / "resources" / "engine" / "runtime" / "python.exe").read_bytes(), b"MZ\x90")
        self.assertTrue(g.check_installed_payload(staged.path, staged.payload_id, read_security=lambda p: SAFE).ok)
        self.assertEqual(self.residue(), [staged.path.name], "no staging folder may remain")

    def test_an_unprotected_source_is_refused_and_nothing_is_created(self):
        # A per-user install tree: the owner is an ordinary account.
        with self.assertRaisesRegex(s.StagingError, "cannot be trusted"):
            self.stage(reader=lambda p: UNSAFE if self.source in (p, *p.parents) else SAFE)
        self.assertFalse(self.root.exists(), "no payload root for an untrusted source")

    def test_an_unprotected_root_is_refused(self):
        self.root.mkdir()
        with self.assertRaisesRegex(s.StagingError, "root is not protected"):
            self.stage(reader=lambda p: UNSAFE if p == self.root else SAFE)
        self.assertEqual(self.residue(), [])

    def test_a_link_in_the_source_is_refused_and_staging_is_cleaned(self):
        if os.name != "nt":
            raise unittest.SkipTest("junctions are Windows-only")
        outside = self.base / "outside"; outside.mkdir()
        subprocess.run(["cmd", "/c", "mklink", "/J", str(self.source / "engine" / "linked"), str(outside)],
                       check=True, capture_output=True)
        with self.assertRaises(s.StagingError):
            self.stage()
        self.assertEqual(self.residue(), [])

    def test_a_copy_that_differs_from_the_source_is_never_published(self):
        real_copy = shutil.copyfile
        def corrupting(src, dst, **kw):
            real_copy(src, dst, **kw)
            if Path(dst).name == "service_main.py":
                Path(dst).write_text("swapped during copy\n", encoding="utf-8")
        with mock.patch.object(s.shutil, "copyfile", corrupting):
            with self.assertRaisesRegex(s.StagingError, "does not match the source"):
                self.stage()
        self.assertEqual(self.residue(), [])

    def test_bad_version_labels_and_non_resources_sources_are_refused(self):
        for version in ("", "../x", "a b", "x" * 65, "-lead"):
            with self.subTest(version=version), self.assertRaises(s.StagingError):
                self.stage(version=version)
        with self.assertRaisesRegex(s.StagingError, "not an Orgtree resources folder"):
            s.stage_payload(self.source / "engine", self.root, "1", read_security=lambda p: SAFE, make_dir=plain_mkdir)

    def test_restaging_the_same_bytes_reuses_the_published_payload(self):
        first = self.stage()
        again = self.stage()
        self.assertEqual(again, first)
        self.assertEqual(self.residue(), [first.path.name])

    def test_a_published_folder_that_no_longer_verifies_is_refused(self):
        first = self.stage()
        (first.path / "resources" / "ui" / "index.html").write_text("tampered", encoding="utf-8")
        with self.assertRaisesRegex(s.StagingError, "does not verify"):
            self.stage()

    def test_a_failed_final_check_unpublishes_the_payload(self):
        with mock.patch.object(s.guard, "check_installed_payload",
                               return_value=g.Report(problems=["forced failure"])):
            with self.assertRaisesRegex(s.StagingError, "final check"):
                self.stage()
        self.assertEqual(self.residue(), [])

    def test_remove_payload_deletes_only_our_own_payload_folders(self):
        staged = self.stage()
        stranger = self.root / "payload-x-00000000"; stranger.mkdir()  # no manifest: not ours
        other = self.base / "elsewhere"; other.mkdir()
        for bad in (stranger, other, self.root / "not-a-payload"):
            with self.subTest(bad=bad.name), self.assertRaises(s.StagingError):
                s.remove_payload(self.root, bad)
        self.assertTrue(stranger.exists() and other.exists())
        s.remove_payload(self.root, staged.path)
        self.assertFalse(staged.path.exists())
        self.assertEqual(s.list_payloads(self.root), [stranger])


class ProtectedCreationTests(unittest.TestCase):
    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("Windows-only")

    def test_the_production_sddl_is_well_formed_and_names_the_trusted_principals(self):
        import ctypes
        from ctypes import wintypes as w
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(w.ULONG)]
        descriptor = ctypes.c_void_p()
        self.assertTrue(advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            s.PROTECTED_SDDL, 1, ctypes.byref(descriptor), None))
        ctypes.WinDLL("kernel32").LocalFree(descriptor)
        self.assertTrue(s.PROTECTED_SDDL.startswith("O:BA"))
        self.assertIn(":PAI(", s.PROTECTED_SDDL, "protected from inheritance, children inherit")
        self.assertIn("(A;OICI;0x1200a9;;;BU)", s.PROTECTED_SDDL, "Users read and execute only")
        self.assertNotIn(";;;AU)", s.PROTECTED_SDDL)
        self.assertNotIn(";;;CO)", s.PROTECTED_SDDL)
        self.assertNotIn(";;;WD)", s.PROTECTED_SDDL)

    def test_files_copied_under_a_protected_folder_carry_only_its_entries(self):
        # Real ACLs. The folder's DACL is the production one plus this test
        # account (so cleanup works without elevation); the owner is left to
        # default because only an elevated process may set Administrators.
        me = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True,
                            check=True).stdout.strip().split(",")[-1].strip('"')
        sddl = s.PROTECTED_SDDL.replace("O:BAG:BA", "") + f"(A;OICI;FA;;;{me})"
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "protected"
            s.create_protected_dir(folder, sddl)
            with self.assertRaises(OSError, msg="an existing path is never adopted"):
                s.create_protected_dir(folder, sddl)
            (folder / "sub").mkdir()
            target = folder / "sub" / "copied.py"
            shutil.copyfile(__file__, target)
            security = g.read_file_security(target)
            self.assertEqual({a.sid for a in security.aces},
                             {g.SID_SYSTEM, g.SID_ADMINISTRATORS, g.SID_TRUSTED_INSTALLER, "S-1-5-32-545", me},
                             "nothing from the temp folder's own ACL may be inherited")
            users = [a for a in security.aces if a.sid == "S-1-5-32-545"]
            self.assertEqual([a.mask & g.PAYLOAD_WRITE_MASK for a in users], [0])
            problems = g.judge(str(target), security, g.PAYLOAD_WRITE_MASK)
            self.assertTrue(problems and all(me in p for p in problems),
                            "only the test account's own entry and ownership are flagged")


if __name__ == "__main__":
    unittest.main()
