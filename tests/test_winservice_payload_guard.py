"""Service payload guard: owner/DACL/link checks and the sha256 manifest.

Pure judgments run on synthetic security entries. The real reader is exercised
read-only on this machine: a file this account created (NOT safe: the owner is
an ordinary user who holds full control) and Windows' own kernel32.dll with its
ancestors (safe). Nothing is installed and no ACL outside a temp folder is
changed.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.winservice import payload_guard as g

USER = "S-1-5-21-111-222-333-1001"
USERS = "S-1-5-32-545"
AUTH_USERS = "S-1-5-11"
CREATOR_OWNER = "S-1-3-0"
RX = 0x001200A9  # FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
FULL = 0x001F01FF


def allow(sid, mask, flags=0):
    return g.Ace(g.ACCESS_ALLOWED_ACE_TYPE, flags, mask, sid)


def deny(sid, mask):
    return g.Ace(0x1, 0, mask, sid)


SAFE = g.Security(g.SID_SYSTEM, True, (allow(g.SID_SYSTEM, FULL), allow(g.SID_ADMINISTRATORS, FULL),
                                       allow(g.SID_TRUSTED_INSTALLER, FULL), allow(USERS, RX)))


class JudgeTests(unittest.TestCase):
    def test_trusted_owner_and_read_execute_users_is_safe(self):
        self.assertEqual(g.judge("x", SAFE, g.PAYLOAD_WRITE_MASK), [])
        for owner in g.TRUSTED_SIDS:
            self.assertEqual(g.judge("x", g.Security(owner, True, SAFE.aces), g.PAYLOAD_WRITE_MASK), [])

    def test_an_ordinary_owner_is_refused(self):
        problems = g.judge("x", g.Security(USER, True, SAFE.aces), g.PAYLOAD_WRITE_MASK)
        self.assertEqual(len(problems), 1)
        self.assertIn("owner", problems[0])
        self.assertTrue(g.judge("x", g.Security(None, True, SAFE.aces), g.PAYLOAD_WRITE_MASK))

    def test_every_write_type_right_for_an_untrusted_principal_is_refused(self):
        for bit in (g.FILE_WRITE_DATA, g.FILE_APPEND_DATA, g.FILE_WRITE_EA, g.FILE_DELETE_CHILD,
                    g.FILE_WRITE_ATTRIBUTES, g.DELETE, g.WRITE_DAC, g.WRITE_OWNER,
                    g.ACCESS_SYSTEM_SECURITY, g.GENERIC_ALL, g.GENERIC_WRITE):
            for sid in (USER, USERS, AUTH_USERS, "S-1-1-0"):
                security = g.Security(g.SID_SYSTEM, True, SAFE.aces + (allow(sid, bit),))
                with self.subTest(bit=hex(bit), sid=sid):
                    problems = g.judge("x", security, g.PAYLOAD_WRITE_MASK)
                    self.assertEqual(len(problems), 1)
                    self.assertIn(sid, problems[0])

    def test_no_dacl_means_everyone_and_is_refused(self):
        problems = g.judge("x", g.Security(g.SID_SYSTEM, False, ()), g.PAYLOAD_WRITE_MASK)
        self.assertEqual(len(problems), 1)
        self.assertIn("no DACL", problems[0])

    def test_inherit_only_and_deny_entries_do_not_count_against_the_object(self):
        security = g.Security(g.SID_SYSTEM, True, SAFE.aces + (
            allow(CREATOR_OWNER, FULL, flags=g.INHERIT_ONLY_ACE | 0x3), deny(USER, FULL)))
        self.assertEqual(g.judge("x", security, g.PAYLOAD_WRITE_MASK), [])
        # the same entry WITHOUT inherit-only applies to the object: refused
        security = g.Security(g.SID_SYSTEM, True, SAFE.aces + (allow(CREATOR_OWNER, FULL, flags=0x3),))
        self.assertTrue(g.judge("x", security, g.PAYLOAD_WRITE_MASK))

    def test_unrecognised_entry_types_fail_closed(self):
        # An object allow entry (0x5) or callback object allow entry (0xB) with
        # no object type acts as a plain allow on a file; the guard does not
        # model them, so any unrecognised type is refused, even inherit-only.
        for ace_type in (0x5, 0xB, 0x6, 0x11, 0xFF):
            for flags in (0, g.INHERIT_ONLY_ACE):
                with self.subTest(ace_type=hex(ace_type), flags=flags):
                    security = g.Security(g.SID_SYSTEM, True, SAFE.aces + (g.Ace(ace_type, flags, 0, "unknown"),))
                    for mask in (g.PAYLOAD_WRITE_MASK, g.ANCESTOR_WRITE_MASK):
                        problems = g.judge("x", security, mask)
                        self.assertEqual(len(problems), 1)
                        self.assertIn(f"type 0x{ace_type:02x}", problems[0])

    def test_callback_deny_entries_are_ignored_like_plain_deny(self):
        security = g.Security(g.SID_SYSTEM, True, SAFE.aces + (g.Ace(g.ACCESS_DENIED_CALLBACK_ACE_TYPE, 0, FULL, USER),))
        self.assertEqual(g.judge("x", security, g.PAYLOAD_WRITE_MASK), [])

    def test_ancestors_tolerate_adding_entries_but_not_removal_or_reprotection(self):
        drive_root = g.Security(g.SID_TRUSTED_INSTALLER, True, SAFE.aces + (
            allow(AUTH_USERS, g.FILE_APPEND_DATA | g.FILE_WRITE_DATA | RX),))
        self.assertEqual(g.judge("C:\\", drive_root, g.ANCESTOR_WRITE_MASK), [])
        self.assertTrue(g.judge("C:\\", drive_root, g.PAYLOAD_WRITE_MASK),
                        "the same entry inside the payload would be unsafe")
        for bit in (g.FILE_DELETE_CHILD, g.DELETE, g.WRITE_DAC, g.WRITE_OWNER, g.GENERIC_ALL):
            with self.subTest(bit=hex(bit)):
                bad = g.Security(g.SID_SYSTEM, True, SAFE.aces + (allow(USERS, bit),))
                self.assertTrue(g.judge("C:\\Program Files", bad, g.ANCESTOR_WRITE_MASK))


class ValidateTests(unittest.TestCase):
    def tree(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / "payload"
        (root / "resources" / "engine" / "runtime").mkdir(parents=True)
        (root / "resources" / "engine" / "service_main.py").write_text("print()\n", encoding="utf-8")
        (root / "resources" / "engine" / "runtime" / "python.exe").write_bytes(b"MZ")
        return root

    def test_a_safe_tree_passes_and_every_object_is_checked(self):
        root = self.tree()
        seen = []
        report = g.validate(root, read_security=lambda p: seen.append(p) or SAFE)
        self.assertTrue(report.ok, report.problems)
        self.assertEqual(report.checked, 6 + len(g.ancestors(root)))
        self.assertIn(root / "resources" / "engine" / "runtime" / "python.exe", seen)

    def test_one_unsafe_file_fails_the_whole_payload_by_name(self):
        root = self.tree()
        bad = root / "resources" / "engine" / "service_main.py"
        unsafe = g.Security(g.SID_SYSTEM, True, SAFE.aces + (allow(USER, g.FILE_WRITE_DATA),))
        report = g.validate(root, read_security=lambda p: unsafe if p == bad else SAFE, check_ancestors=False)
        self.assertFalse(report.ok)
        self.assertEqual(len(report.problems), 1)
        self.assertIn(str(bad), report.problems[0])

    def test_unreadable_security_fails_closed(self):
        root = self.tree()
        def read(path):
            if path.name == "python.exe":
                raise PermissionError(5, "Access is denied")
            return SAFE
        report = g.validate(root, read_security=read, check_ancestors=False)
        self.assertFalse(report.ok)
        self.assertIn("cannot read", report.problems[0])

    def test_an_unsafe_ancestor_fails_the_payload(self):
        root = self.tree()
        parent = root.parent
        loose = g.Security(g.SID_SYSTEM, True, SAFE.aces + (allow(USERS, g.DELETE),))
        report = g.validate(root, read_security=lambda p: loose if p == parent else SAFE)
        self.assertFalse(report.ok)
        self.assertEqual([p for p in report.problems if str(parent) in p][:1], report.problems[:1])

    def test_relative_roots_are_refused(self):
        self.assertFalse(g.validate(Path("payload"), read_security=lambda p: SAFE).ok)

    def test_a_junction_inside_the_payload_is_refused_and_not_followed(self):
        if os.name != "nt":
            raise unittest.SkipTest("junctions are Windows-only")
        root = self.tree()
        outside = root.parent / "outside"
        outside.mkdir()
        (outside / "planted.py").write_text("x\n", encoding="utf-8")
        link = root / "resources" / "engine" / "linked"
        # A directory junction needs no privilege, so any user could make one
        # if they could write the payload; the guard must catch it.
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
        seen = []
        report = g.validate(root, read_security=lambda p: seen.append(p) or SAFE, check_ancestors=False)
        self.assertFalse(report.ok)
        self.assertTrue(any("junction" in p and str(link) in p for p in report.problems), report.problems)
        self.assertNotIn(link / "planted.py", seen, "the guard must not walk through a junction")


class RealSecurityTests(unittest.TestCase):
    """Read-only use of the real Windows reader."""

    def setUp(self):
        if os.name != "nt":
            raise unittest.SkipTest("Windows-only")

    def test_a_file_this_account_created_is_not_safe(self):
        # Negative control with real ACLs: an ordinary user owns it and holds
        # full control, exactly what a per-user install tree looks like.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "payload"
            root.mkdir()
            (root / "service_main.py").write_text("x\n", encoding="utf-8")
            report = g.validate(root, check_ancestors=False)
            self.assertFalse(report.ok)
            self.assertTrue(any("owner" in p for p in report.problems), report.problems)
            self.assertTrue(any("write-type access" in p for p in report.problems), report.problems)

    def test_windows_own_system_file_and_its_ancestors_are_safe(self):
        # Positive control with real ACLs: TrustedInstaller-owned, users may
        # only read and execute, and C:\\Windows\\System32 up to the drive root
        # admits no untrusted delete/rename/re-ACL.
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        kernel32 = system32 / "kernel32.dll"
        security = g.read_file_security(kernel32)
        self.assertEqual(security.owner, g.SID_TRUSTED_INSTALLER)
        self.assertEqual(g.judge(str(kernel32), security, g.PAYLOAD_WRITE_MASK), [])
        report = g.validate_ancestors(kernel32, g.read_file_security)
        self.assertTrue(report.ok, report.problems)
        self.assertEqual(report.checked, len(g.ancestors(kernel32)))

    def test_the_reader_fails_closed_on_a_missing_path(self):
        with self.assertRaises(OSError):
            g.read_file_security(Path(tempfile.gettempdir()) / "orgtree-payload-guard-does-not-exist")


class ManifestTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "payload"
        (self.root / "resources" / "engine").mkdir(parents=True)
        (self.root / "resources" / "engine" / "a.py").write_text("a\n", encoding="utf-8")
        (self.root / "resources" / "b.bin").write_bytes(b"\x00\x01")

    def test_manifest_lists_every_file_by_sha256_and_has_a_stable_id(self):
        manifest = g.build_manifest(self.root)
        self.assertEqual(sorted(manifest["files"]), ["resources/b.bin", "resources/engine/a.py"])
        self.assertEqual(len(manifest["files"]["resources/b.bin"]), 64)
        (self.root / g.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        again = g.build_manifest(self.root)
        self.assertEqual(again, manifest, "the manifest file itself is not part of the manifest")
        self.assertEqual(g.manifest_id(again), g.manifest_id(manifest))
        self.assertEqual(g.verify_manifest(self.root, manifest), [])

    def test_changed_missing_and_extra_files_are_all_reported(self):
        manifest = g.build_manifest(self.root)
        (self.root / "resources" / "engine" / "a.py").write_text("tampered\n", encoding="utf-8")
        (self.root / "resources" / "b.bin").unlink()
        (self.root / "resources" / "engine" / "planted.py").write_text("x\n", encoding="utf-8")
        self.assertEqual(g.verify_manifest(self.root, manifest),
                         ["resources/b.bin: missing", "resources/engine/a.py: changed",
                          "resources/engine/planted.py: not in the manifest"])
        self.assertNotEqual(g.manifest_id(g.build_manifest(self.root)), g.manifest_id(manifest))

    def test_unknown_manifest_schema_is_refused(self):
        self.assertEqual(g.verify_manifest(self.root, {"schema": "other", "files": {}}),
                         ["manifest has an unknown schema"])


class InstalledPayloadTests(unittest.TestCase):
    """The single entry point the service and the elevated helper call."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "payload"
        (self.root / "resources" / "engine").mkdir(parents=True)
        (self.root / "resources" / "engine" / "service_main.py").write_text("x\n", encoding="utf-8")
        manifest = g.build_manifest(self.root)
        (self.root / g.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        self.payload_id = g.manifest_id(manifest)

    def check(self, payload_id=None, reader=lambda p: SAFE, **kw):
        return g.check_installed_payload(self.root, payload_id or self.payload_id, read_security=reader, **kw)

    def test_a_protected_matching_payload_passes(self):
        report = self.check()
        self.assertTrue(report.ok, report.problems)

    def test_a_malformed_payload_id_is_refused_without_reading_anything(self):
        read = []
        for bad in ("", "ABC", "0" * 63, "G" * 64, None):
            report = g.check_installed_payload(self.root, bad, read_security=lambda p: read.append(p) or SAFE)
            self.assertFalse(report.ok, bad)
        self.assertEqual(read, [])

    def test_an_unsafe_acl_stops_before_the_manifest_is_trusted(self):
        manifest = self.root / g.MANIFEST_NAME
        unsafe = g.Security(USER, True, SAFE.aces)
        report = self.check(reader=lambda p: unsafe if p == manifest else SAFE)
        self.assertFalse(report.ok)
        self.assertEqual(len(report.problems), 1)
        self.assertIn("owner", report.problems[0])

    def test_a_different_recorded_id_is_refused(self):
        report = self.check(payload_id="0" * 64)
        self.assertFalse(report.ok)
        self.assertIn("does not match", report.problems[0])

    def test_tampered_bytes_are_refused_even_with_a_safe_acl(self):
        (self.root / "resources" / "engine" / "service_main.py").write_text("tampered\n", encoding="utf-8")
        report = self.check()
        self.assertEqual(report.problems, ["resources/engine/service_main.py: changed"])
        self.assertTrue(self.check(verify_hashes=False).ok, "hash checking is the part that caught it")

    def test_a_missing_or_garbled_manifest_is_refused(self):
        (self.root / g.MANIFEST_NAME).write_text("not json", encoding="utf-8")
        self.assertIn("unreadable manifest", self.check().problems[0])
        (self.root / g.MANIFEST_NAME).write_text("[1, 2]", encoding="utf-8")
        self.assertIn("does not match", self.check().problems[0])
        (self.root / g.MANIFEST_NAME).unlink()
        self.assertIn("unreadable manifest", self.check().problems[0])


if __name__ == "__main__":
    unittest.main()
