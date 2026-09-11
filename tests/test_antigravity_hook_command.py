"""The Antigravity PreToolUse hook command must SURVIVE THE CLI'S SHELL.

The live failure this pins (2026-09-11, every Flash tool call on the seat):

    '\\"C:\\…\\Orgtree v2\\…\\orgtree-rights.cmd\\"' is not recognized as an
    internal or external command
    — antigravity/logs/orgtree/<agent>.log, command_hook_executor.go:75

The CLI is a Go binary and hands `hooks.json`'s `command` to `cmd` as ONE
argv element, so syscall.EscapeArg backslash-escapes any quote the generator
put in it; cmd does not understand `\\"` and tries to run a file whose name
literally begins with one.

These tests drive the REAL cmd.exe with the REAL raw command line Go would
build, so they exercise the actual defect rather than a model of it. The
first test is the POSITIVE CONTROL: the shape that shipped must still fail
here, or the rest of the file is measuring nothing.
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

BS = chr(92)
DQ = chr(34)
ALLOW_CALL = {"toolCall": {"name": "view_file"}}
DENY_CALL = {"toolCall": {"name": "run_command"}}
#: a scratch path shaped like the operator's own — the space is the defect
SPACED = "Orgtree v2"
#: the throwaway ORGTREE_DATA this process bound to, made once (see setUpClass)
_ROOT = None


def escape_arg(s):
    """Go's syscall.EscapeArg (go/src/syscall/exec_windows.go), transcribed.

    This is the half of the bug that lives outside orgtree: it is why the
    generator may not emit a quote of its own."""
    if s == "":
        return DQ + DQ
    n = len(s)
    has_space = False
    for ch in s:
        if ch in (DQ, BS):
            n += 1
        elif ch in (" ", "\t"):
            has_space = True
    if has_space:
        n += 2
    if n == len(s):
        return s
    out = []
    if has_space:
        out.append(DQ)
    slashes = 0
    for ch in s:
        if ch == BS:
            slashes += 1
            out.append(ch)
            continue
        if ch == DQ:
            out.append(BS * (slashes + 1))
            out.append(DQ)
        else:
            out.append(ch)
        slashes = 0
    if has_space:
        out.append(BS * slashes)
        out.append(DQ)
    return "".join(out)


def run_hook(command, payload, slash_s):
    """Fire `command` exactly as the CLI would: cmd.exe, one escaped argv
    element, the pending tool call on stdin. `slash_s` picks the `/s /c`
    envelope over `/c` — the log cannot tell which the CLI uses, so both are
    required to pass."""
    comspec = os.environ.get("COMSPEC") or "cmd.exe"
    line = "%s %s%s" % (escape_arg(comspec), "/s /c " if slash_s else "/c ",
                        escape_arg(command))
    proc = subprocess.run(line, input=json.dumps(payload).encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc


def decision_of(proc):
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace")).get("decision")
    except Exception:                                        # noqa: BLE001
        return None


class HookCommandTests(unittest.TestCase):
    """Everything here needs a real cmd.exe; elsewhere it DECLARES ITSELF
    INERT rather than passing quietly."""

    @classmethod
    def setUpClass(cls):
        if os.name != "nt":
            raise unittest.SkipTest(
                "INERT off Windows: this pins cmd.exe quoting, and there is "
                "no cmd.exe here to measure")
        # ⚠ store.DATA_ROOT BINDS AT IMPORT TIME, and this process may well
        # have inherited the LIVE root (it does whenever the suite is run
        # from inside the desktop). Assignment, never setdefault — setdefault
        # would KEEP the live value. The root is made ONCE per process so a
        # second setUpClass (a re-run in the same interpreter) checks the
        # binding it actually has instead of inventing one it cannot have.
        global _ROOT
        if _ROOT is None:
            _ROOT = tempfile.mkdtemp(prefix="orgtree-agyhook-")
            os.environ["ORGTREE_DATA"] = _ROOT
        from engine.backend.orgtree import antigravityrun, store
        # CHECKED, not assumed, before a single byte is written
        if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
            raise AssertionError(
                "store bound outside the fixture: %s" % store.DATA_ROOT)
        cls.agy = antigravityrun

    def _workspace(self, denied_rights=None):
        """A real `write_workspace` run, in a scratch path WITH A SPACE."""
        base = tempfile.mkdtemp(prefix="agyhook-")
        cwd = os.path.join(base, SPACED, "data", "scratch", "orgtree", "seat")
        os.makedirs(cwd, exist_ok=True)
        # guard against a vacuous fixture: no space, nothing under test
        self.assertIn(" ", cwd, "fixture lost its space")
        out = self.agy.write_workspace(
            cwd, identity="# seat", mcp_servers={},
            rights=denied_rights if denied_rights is not None
            else {"bash": False, "edit": False},
            python=sys.executable)
        return cwd, out

    def _command_from_disk(self, cwd):
        """The command the CLI will actually read, taken from the file."""
        with open(os.path.join(cwd, ".agents", "hooks.json"),
                  encoding="utf-8") as f:
            doc = json.load(f)
        return doc["orgtree-rights"]["PreToolUse"][0]["hooks"][0]["command"]

    def _needs_short_names(self, cwd):
        """Defending the `cmd /s /c` envelope needs a space-free alias, and
        8dot3 name creation is switchable per volume. Where it is off, SAY SO
        — the fix degrades to `cmd /c` only, and a test that quietly passed
        would be hiding exactly that."""
        wrapper = os.path.abspath(
            os.path.join(cwd, ".agents", "orgtree-rights.cmd"))
        if not self.agy._short_path(wrapper):
            self.skipTest(
                "INERT on this volume: 8dot3 name creation is off, so no "
                "space-free alias exists for a spaced scratch path. The bare "
                "path still carries the `cmd /c` envelope (covered by the "
                "sibling tests); `cmd /s /c` cannot be defended here.")

    # ── the positive control ─────────────────────────────────────────────

    def test_shipped_quoted_shape_still_fails(self):
        """If this ever passes, cmd's behaviour changed and every assertion
        below has stopped meaning anything."""
        cwd, _ = self._workspace()
        wrapper = os.path.abspath(
            os.path.join(cwd, ".agents", "orgtree-rights.cmd"))
        shipped = DQ + wrapper + DQ
        for slash_s in (False, True):
            proc = run_hook(shipped, ALLOW_CALL, slash_s)
            err = proc.stderr.decode("utf-8", "replace")
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("is not recognized", err)
            self.assertIsNone(decision_of(proc))

    # ── the fix ──────────────────────────────────────────────────────────

    def test_generated_command_carries_no_quote(self):
        """The whole defect in one assertion: a quote of ours is fatal under
        BOTH cmd envelopes, so there must never be one."""
        cwd, out = self._workspace()
        command = self._command_from_disk(cwd)
        self.assertTrue(out["hooks"])
        self.assertNotIn(DQ, command)

    def test_generated_command_is_space_free(self):
        cwd, _ = self._workspace()
        self._needs_short_names(cwd)
        self.assertNotIn(" ", self._command_from_disk(cwd))

    def test_generated_command_points_at_the_real_wrapper(self):
        """An 8.3 alias is only safe if it opens the SAME file."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        wrapper = os.path.join(cwd, ".agents", "orgtree-rights.cmd")
        self.assertTrue(os.path.exists(command))
        self.assertTrue(os.path.samefile(command, wrapper))

    def _assert_allow_and_deny(self, command, slash_s):
        proc = run_hook(command, ALLOW_CALL, slash_s)
        self.assertEqual(proc.returncode, 0,
                         proc.stderr.decode("utf-8", "replace"))
        self.assertEqual(decision_of(proc), "allow")
        proc = run_hook(command, DENY_CALL, slash_s)
        self.assertEqual(proc.returncode, 0,
                         proc.stderr.decode("utf-8", "replace"))
        body = json.loads(proc.stdout.decode("utf-8", "replace"))
        self.assertEqual(body["decision"], "deny")
        self.assertIn("orgtree:", body["reason"])
        self.assertIn("no shell rights", body["reason"])

    def test_allow_and_deny_under_cmd_slash_c(self):
        """Allowed tools pass, denied tools are refused WITH THE REASON —
        the fix is worthless if it only restores the allow side."""
        cwd, out = self._workspace()
        self.assertIn("run_command", out["denied"])
        self._assert_allow_and_deny(self._command_from_disk(cwd), False)

    def test_allow_and_deny_under_cmd_slash_s_slash_c(self):
        """The log cannot say which envelope the CLI uses, so both are held."""
        cwd, out = self._workspace()
        self.assertIn("run_command", out["denied"])
        self._needs_short_names(cwd)
        self._assert_allow_and_deny(self._command_from_disk(cwd), True)

    def test_web_and_subagent_switches_still_deny(self):
        cwd, out = self._workspace(
            {"bash": True, "edit": True, "web": False, "subagents": False})
        command = self._command_from_disk(cwd)
        self.assertIn("search_web", out["denied"])
        for tool in ("search_web", "browser_subagent"):
            proc = run_hook(command, {"toolCall": {"name": tool}}, False)
            self.assertEqual(decision_of(proc), "deny", tool)
        proc = run_hook(command, {"toolCall": {"name": "run_command"}}, False)
        self.assertEqual(decision_of(proc), "allow",
                         "bash is ON here — denying it would be a false wall")

    def test_unknown_envelope_field_still_denies(self):
        """The hook reads `toolCall.name`; if the CLI ever renames that field
        the old script FAILED OPEN — allowed everything, quietly. These
        alternates make a rename deny as before instead."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for payload in ({"tool_name": "run_command"},
                        {"toolName": "run_command"}):
            proc = run_hook(command, payload, False)
            self.assertEqual(decision_of(proc), "deny", payload)

    # ── the pieces, directly ─────────────────────────────────────────────

    def test_full_rights_removes_the_hook_files(self):
        """A widened scope must take the wall down at the next spawn."""
        cwd, _ = self._workspace()
        self.assertTrue(os.path.exists(os.path.join(cwd, ".agents",
                                                    "hooks.json")))
        out = self.agy.write_workspace(
            cwd, identity="# seat", mcp_servers={},
            rights={"bash": True, "edit": True, "web": True,
                    "subagents": True}, python=sys.executable)
        self.assertEqual(out, {"hooks": False, "denied": []})
        for name in ("hooks.json", "orgtree-rights.py", "orgtree-rights.cmd"):
            self.assertFalse(os.path.exists(
                os.path.join(cwd, ".agents", name)), name)

    def test_short_path_refuses_what_it_cannot_confirm(self):
        """`_short_path` must return "" — never a guess — for a path it
        cannot resolve, because the caller falls back on that."""
        missing = os.path.join(tempfile.gettempdir(), "no such dir here",
                               "nope.cmd")
        self.assertEqual(self.agy._short_path(missing), "")

    def test_safe_path_is_left_alone(self):
        """No space, no metacharacter — the readable long path stays."""
        base = tempfile.mkdtemp(prefix="agyplain-")
        cwd = os.path.join(base, "orgtree_data", "seat")
        os.makedirs(cwd, exist_ok=True)
        self.assertNotIn(" ", cwd)
        self.agy.write_workspace(
            cwd, identity="# seat", mcp_servers={}, rights={"bash": False},
            python=sys.executable)
        command = self._command_from_disk(cwd)
        self.assertEqual(command, os.path.abspath(
            os.path.join(cwd, ".agents", "orgtree-rights.cmd")))

    def test_posix_branch_shell_quotes_instead(self):
        """`sh -c` word-splits, so THERE the quoting is ours to do — and it
        is SINGLE quoting, so a `$` in the path is not expanded away."""
        path = "/tmp/a b/$HOME's rights.sh"
        with mock.patch.object(self.agy.os, "name", "posix"):
            got = self.agy._hook_command(path)
        self.assertNotEqual(got, path, "an unquoted path would word-split")
        # what /bin/sh would hand the exec: exactly one word, still the path
        self.assertEqual(shlex.split(got), [path])


if __name__ == "__main__":
    unittest.main()
