"""Launch audit negative controls never launch an external process."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from tools.scale.launch_guard import LaunchAudit, pin_git


class LaunchGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="scale-launch-audit-")
        self.root = Path(self.tmp.name)
        (self.root / "metrics").mkdir()
        self.git = str(self.root / "git.exe")
        self.claude = str(self.root / "claude.exe")
        self.agy = str(self.root / "agy.exe")
        self.unknown = str(self.root / "provider.exe")
        self.audit = LaunchAudit(self.root, git=self.git, providers=[self.claude], agy=self.agy)
        self.addCleanup(self.tmp.cleanup)

    def event(self, exe, *args, string=False):
        words = [exe, *args]
        return (exe, subprocess.list2cmdline(words) if string else words, None, None)

    def test_expected_git_identity_and_exact_read_form(self):
        for string in (False, True):
            self.audit("subprocess.Popen", self.event(self.git, "status", "--short", string=string))
        self.audit("subprocess.Popen", self.event(self.git, "-C", str(self.root), "rev-parse", "--abbrev-ref", "HEAD", string=True))
        self.audit("subprocess.Popen", self.event(self.git, "-C", str(self.root), "status", "--porcelain", "-uno", string=True))
        self.assertEqual(self.audit.snapshot()["git_reads"], 4)
        self.assertFalse((self.root / "metrics/qualification-invalid.json").exists())

    def test_git_words_inside_provider_prompt_do_not_bypass(self):
        for string in (False, True):
            with self.subTest(string=string):
                with self.assertRaises(FileNotFoundError):
                    self.audit("subprocess.Popen", self.event(self.unknown, "exec", "please run git status", string=string))
        self.assertEqual(self.audit.snapshot()["unexpected"], 2)
        self.assertTrue((self.root / "metrics/qualification-invalid.json").exists())

    def test_renderer_version_short_head_exact_form_only(self):
        for application in (self.git, None):
            words = [self.git, "rev-parse", "--short", "HEAD"]
            self.audit("subprocess.Popen", (application, subprocess.list2cmdline(words), None, None))
        for words in ([self.git, "rev-parse", "--short", "HEAD", "&&", self.unknown],
                      [self.git, "-c", "core.pager=provider", "rev-parse", "--short", "HEAD"],
                      [self.unknown, "rev-parse", "--short", "HEAD"]):
            with self.subTest(words=words), self.assertRaises(FileNotFoundError):
                self.audit("subprocess.Popen", (None, subprocess.list2cmdline(words), None, None))
        self.assertEqual(self.audit.snapshot()["git_reads"], 2)
        self.assertEqual(self.audit.snapshot()["unexpected"], 3)

    def test_known_capability_forms_only(self):
        cases = [(self.claude, ["--version"]), (self.agy, ["--version"]),
                 (self.agy, ["models"]), (self.agy, ["--log-file", "probe path.log", "models"])]
        for exe, tail in cases:
            with self.assertRaises(FileNotFoundError):
                self.audit("subprocess.Popen", self.event(exe, *tail, string=True))
        with self.assertRaises(FileNotFoundError):
            self.audit("subprocess.Popen", (None, subprocess.list2cmdline([self.agy, "--version"]), None, None))
        self.assertEqual(self.audit.snapshot()["capability_probes"], 5)
        self.assertEqual(self.audit.snapshot()["unexpected"], 0)
        self.assertFalse((self.root / "metrics/qualification-invalid.json").exists())

    def test_unknown_version_prompt_suffix_shell_and_spoofed_argv_fail(self):
        cases = [self.event(self.unknown, "--version"),
                 self.event(self.claude, "-p", "say --version"),
                 (None, subprocess.list2cmdline([self.unknown, "exec", "git status"]), None, None),
                 self.event(self.unknown, "exec", "agy", "models"),
                 self.event(self.git, "-c", "alias.x=!provider", "status"),
                 self.event(self.git, "status", "&&", self.unknown),
                 (self.unknown, [self.git, "status"], None, None),
                 ("git", ["git", "status"], None, None)]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(FileNotFoundError):
                self.audit("subprocess.Popen", args)
        with self.assertRaises(FileNotFoundError):
            self.audit("os.system", ("git status",))
        self.assertEqual(self.audit.snapshot()["unexpected"], len(cases) + 1)

    def test_git_pinning_only_rewrites_literal_argv_without_overrides(self):
        calls = []
        class FakePopen:
            def __init__(self, *a, **k):
                calls.append((a, k))
        launch = pin_git(FakePopen, self.git)
        self.assertTrue(issubclass(launch, FakePopen))
        launch(["git", "status"])
        actual = calls[-1][0][0]
        self.assertEqual(Path(actual[0]).resolve(), Path(self.git).resolve())
        self.audit("subprocess.Popen", (actual[0], actual, None, None))
        for args, options in [("git status", {}), (["git", "status"], {"shell": True}),
                              (["git", "status"], {"executable": self.unknown})]:
            launch(args, **options)
            self.assertEqual(calls[-1][0][0], args)
        launch(["git", "status"], -1, self.unknown)
        self.assertEqual(calls[-1][0][0], ["git", "status"])

    def test_audit_keeps_full_argv_and_persistent_marker(self):
        prompt = "git status " + "canary " * 150 + " --version"
        with self.assertRaises(FileNotFoundError):
            self.audit("subprocess.Popen", self.event(self.unknown, "exec", prompt, string=True))
        row = json.loads((self.root / "metrics/qualification-invalid.json").read_text())
        self.assertEqual(row["executable"], self.unknown)
        self.assertEqual(row["argv"], [self.unknown, "exec", prompt])
        self.assertFalse(row["capability_probe"])
        self.assertGreater(len(row["cmd"]), 500)


if __name__ == "__main__":
    unittest.main()
