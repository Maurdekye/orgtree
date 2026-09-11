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


def run_hook_raw(command, stdin_bytes, slash_s):
    """Fire `command` with ARBITRARY bytes on stdin — the shapes json.load
    never gets to parse."""
    comspec = os.environ.get("COMSPEC") or "cmd.exe"
    line = "%s %s%s" % (escape_arg(comspec), "/s /c " if slash_s else "/c ",
                        escape_arg(command))
    return subprocess.run(line, input=stdin_bytes,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


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

    def _write(self, cwd, rights):
        """`write_workspace`, with the ONE environmental refusal turned into
        a stated skip.

        On a volume with 8dot3 name creation switched off there is no
        space-free form of a spaced scratch path, and the generator now
        REFUSES rather than emit something cmd would re-split. That is the
        intended behaviour, not a defect — but it makes the spaced fixtures
        below unbuildable, so they must say so instead of erroring or, worse,
        passing on a path that never exercised the bug."""
        try:
            return self.agy.write_workspace(
                cwd, identity="# seat", mcp_servers={}, rights=rights,
                python=sys.executable)
        except self.agy.AntigravityError as exc:
            self.skipTest(
                "INERT on this volume: the fixture path cannot be expressed "
                "for cmd and the generator correctly refused it, so there is "
                "nothing to exercise here. Refusal itself is covered by the "
                "tests that force it. (%s)" % exc)

    def _workspace(self, denied_rights=None):
        """A real `write_workspace` run, in a scratch path WITH A SPACE."""
        base = tempfile.mkdtemp(prefix="agyhook-")
        cwd = os.path.join(base, SPACED, "data", "scratch", "orgtree", "seat")
        os.makedirs(cwd, exist_ok=True)
        # guard against a vacuous fixture: no space, nothing under test
        self.assertIn(" ", cwd, "fixture lost its space")
        out = self._write(cwd, denied_rights if denied_rights is not None
                          else {"bash": False, "edit": False})
        return cwd, out

    def _command_from_disk(self, cwd):
        """The command the CLI will actually read, taken from the file."""
        with open(os.path.join(cwd, ".agents", "hooks.json"),
                  encoding="utf-8") as f:
            doc = json.load(f)
        return doc["orgtree-rights"]["PreToolUse"][0]["hooks"][0]["command"]

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

    def test_renamed_envelope_field_is_still_read_both_ways(self):
        """`toolCall.name` is the measured envelope; the alternates are what
        a rename would land on.

        ⚠ THE DENY HALF ALONE PROVES NOTHING NOW. Since the hook fails closed,
        an envelope it does not recognise is denied anyway — so a test that
        only checked `run_command -> deny` passed just as happily with the
        aliases removed (caught by mutant M5). What the aliases actually buy
        is the ALLOW half: reading the renamed field is the difference between
        a seat that keeps working and one that denies its own read tools."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for field in ("tool_name", "toolName"):
            proc = run_hook(command, {field: "run_command"}, False)
            self.assertEqual(decision_of(proc), "deny", field)
            proc = run_hook(command, {field: "view_file"}, False)
            self.assertEqual(decision_of(proc), "allow", field)

    # ── the pieces, directly ─────────────────────────────────────────────

    def test_full_rights_removes_the_hook_files(self):
        """A widened scope must take the wall down at the next spawn."""
        cwd, _ = self._workspace()
        self.assertTrue(os.path.exists(os.path.join(cwd, ".agents",
                                                    "hooks.json")))
        out = self._write(cwd, {"bash": True, "edit": True, "web": True,
                                "subagents": True})
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
        self._write(cwd, {"bash": False})
        command = self._command_from_disk(cwd)
        self.assertEqual(command, os.path.abspath(
            os.path.join(cwd, ".agents", "orgtree-rights.cmd")))

    # ── an unreadable call is a DENIED call (coordinator review, 2026-09-11)

    #: every payload that carries no usable tool identity. Each one used to
    #: come out of the old `or`-chain as name == "" and be ALLOWED.
    UNREADABLE = (
        ("empty object", {}),
        ("toolCall present but empty", {"toolCall": {}}),
        ("name empty", {"toolCall": {"name": ""}}),
        ("name whitespace", {"toolCall": {"name": "   "}}),
        ("name is a number", {"toolCall": {"name": 7}}),
        ("name is null", {"toolCall": {"name": None}}),
        ("name is an object", {"toolCall": {"name": {"a": 1}}}),
        ("name is a list", {"toolCall": {"name": ["run_command"]}}),
        ("toolCall is a string", {"toolCall": "run_command"}),
        ("payload is a list", [{"name": "run_command"}]),
        ("payload is a string", "run_command"),
        ("payload is null", None),
        ("payload is a number", 0),
    )

    def test_unreadable_tool_identity_is_denied_with_a_reason(self):
        """The fail-open the review caught: anything the hook cannot
        positively identify as a named tool must be DENIED, because this hook
        is the only wall in front of --dangerously-skip-permissions."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for label, payload in self.UNREADABLE:
            proc = run_hook(command, payload, False)
            self.assertEqual(proc.returncode, 0, label)
            body = json.loads(proc.stdout.decode("utf-8", "replace"))
            self.assertEqual(body["decision"], "deny", label)
            # "a useful reason", not a bare refusal
            self.assertTrue(body["reason"].startswith("orgtree: "), label)
            self.assertIn("permission hook", body["reason"], label)
            self.assertIn("guessing", body["reason"], label)

    def test_unparseable_stdin_is_denied_with_a_reason(self):
        """json.load never even returns for these."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for label, blob in (("empty stdin", b""),
                            ("not json", b"<html>nope</html>"),
                            ("truncated json", b'{"toolCall": {"name": '),
                            ("nul bytes", b"\x00\x01\x02"),
                            ("bad utf-8", b'{"toolCall": {"name": "\xff\xfe"}}')):
            for slash_s in (False, True):
                proc = run_hook_raw(command, blob, slash_s)
                self.assertEqual(proc.returncode, 0,
                                 "%s: %s" % (label, proc.stderr[:200]))
                body = json.loads(proc.stdout.decode("utf-8", "replace"))
                self.assertEqual(body["decision"], "deny", label)
                self.assertIn("could not read", body["reason"], label)

    def test_non_ascii_arguments_are_still_read(self):
        """The other half of reading stdin as bytes: a tool call whose
        ARGUMENTS carry non-ASCII must still parse, or denying-the-unreadable
        would block ordinary work on any non-UTF-8 console codepage."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        blob = json.dumps({"toolCall": {"name": "view_file",
                                        "args": {"q": "café — ünïcode 中文"}}}
                          ).encode("utf-8")
        proc = run_hook_raw(command, blob, False)
        body = json.loads(proc.stdout.decode("utf-8", "replace"))
        self.assertEqual(body["decision"], "allow")
        blob = json.dumps({"toolCall": {"name": "run_command",
                                        "args": {"q": "日本語"}}}
                          ).encode("utf-8")
        proc = run_hook_raw(command, blob, False)
        self.assertEqual(decision_of(proc), "deny")

    def test_denying_the_unreadable_did_not_deny_everything(self):
        """THE CONTROL ON THE CONTROL. A hook that denies every payload would
        pass every assertion above and brick the seat — so the allowed tool
        must still come back allowed, through both envelopes."""
        cwd, out = self._workspace()
        command = self._command_from_disk(cwd)
        self.assertIn("run_command", out["denied"])
        for slash_s in (False, True):
            self._assert_allow_and_deny(command, slash_s)
        for tool in ("view_file", "grep_search", "list_dir", "find_by_name"):
            proc = run_hook(command, {"toolCall": {"name": tool}}, False)
            self.assertEqual(decision_of(proc), "allow", tool)

    def test_whitespace_padding_does_not_walk_past_a_denial(self):
        """`" run_command "` is the same tool; the wall is on the name, not
        on its spelling."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for spelling in (" run_command", "run_command ", "\trun_command\n"):
            proc = run_hook(command, {"toolCall": {"name": spelling}}, False)
            self.assertEqual(decision_of(proc), "deny", repr(spelling))

    # ── never emit an unsafe command (coordinator review, 2026-09-11) ────

    def test_no_alias_and_a_space_refuses_instead_of_falling_back(self):
        """THE CONTROLLED NO-ALIAS CASE. With 8dot3 off there is no
        space-free form — and a bare spaced path is NOT a safe best effort:
        `...\\Orgtree v2\\...` runs `...\\Orgtree` and hands it `v2\\...`, so
        a stray `Orgtree.exe` beside the data root would be executed."""
        # no filesystem needed: the alias lookup is stubbed out, which is
        # exactly the state of a volume with 8dot3 name creation switched off
        wrapper = ("C:" + BS + "data" + BS + SPACED + BS + ".agents" + BS
                   + "orgtree-rights.cmd")
        self.assertIn(" ", wrapper, "fixture lost its space")
        with mock.patch.object(self.agy, "_short_path",
                               staticmethod(lambda p: "")):
            with self.assertRaises(self.agy.AntigravityError) as caught:
                self.agy._hook_command(wrapper)
        self.assertIn("8dot3", str(caught.exception))

    def test_refusal_leaves_no_hooks_json_written(self):
        """A zero-byte or stale hooks.json is the one failure shape that
        loses enforcement WITHOUT looking broken: the CLI finds no hook and
        the seat is already running --dangerously-skip-permissions."""
        base = tempfile.mkdtemp(prefix="agyrefuse-")
        cwd = os.path.join(base, SPACED, "seat")
        os.makedirs(cwd, exist_ok=True)
        hooks = os.path.join(cwd, ".agents", "hooks.json")
        with mock.patch.object(self.agy, "_short_path",
                               staticmethod(lambda p: "")):
            with self.assertRaises(self.agy.AntigravityError):
                self.agy.write_workspace(
                    cwd, identity="# seat", mcp_servers={},
                    rights={"bash": False}, python=sys.executable)
        self.assertFalse(os.path.exists(hooks),
                         "refusal must not leave a hooks.json behind")

    def test_expansion_sigil_is_refused_outright(self):
        """`%VAR%` is substituted before `^` is even considered — measured,
        nothing rescues it — so it may never reach a command line."""
        for bad in ("C:" + BS + "%PATH%data" + BS + "x.cmd",
                    "C:" + BS + "a!B!c" + BS + "x.cmd",
                    "C:" + BS + "a,b=c" + BS + "x.cmd"):
            with mock.patch.object(self.agy, "_short_path",
                                   staticmethod(lambda p: "")):
                with self.assertRaises(self.agy.AntigravityError, msg=bad):
                    self.agy._hook_command(bad)

    def test_emitted_command_never_carries_a_raw_metacharacter(self):
        """Whatever shape comes out, every cmd metacharacter in it is either
        absent or caret-escaped. This is the invariant the review asked for."""
        cwd, _ = self._workspace()
        command = self._command_from_disk(cwd)
        for i, ch in enumerate(command):
            if ch in self.agy._CMD_ESCAPABLE:
                self.assertTrue(i and command[i - 1] == "^",
                                "unescaped %r in %r" % (ch, command))
            self.assertNotIn(ch, self.agy._CMD_INEXPRESSIBLE,
                             "inexpressible %r in %r" % (ch, command))

    def test_metacharacter_path_is_caret_escaped_and_actually_runs(self):
        """A `&` in the path is carried by `^`, not shrugged at — and the
        proof is the hook still allowing and still denying, through a real
        cmd.exe, under both envelopes."""
        base = tempfile.mkdtemp(prefix="agyamp-")
        cwd = os.path.join(base, "org&tree", "seat")     # no space: caret alone
        os.makedirs(cwd, exist_ok=True)
        out = self._write(cwd, {"bash": False, "edit": False})
        self.assertIn("run_command", out["denied"])
        command = self._command_from_disk(cwd)
        self.assertIn("^&", command)
        for slash_s in (False, True):
            self._assert_allow_and_deny(command, slash_s)

    def test_metacharacter_plus_space_goes_through_the_alias(self):
        """Caret alone cannot save a path that ALSO holds a space — the space
        forces EscapeArg to quote, and `^` is literal inside quotes. The 8.3
        alias drops the space first; then the caret carries the `&`."""
        base = tempfile.mkdtemp(prefix="agyampsp-")
        cwd = os.path.join(base, "org&tree v2", "seat")
        os.makedirs(cwd, exist_ok=True)
        self._write(cwd, {"bash": False, "edit": False})
        command = self._command_from_disk(cwd)
        self.assertNotIn(" ", command)
        for slash_s in (False, True):
            self._assert_allow_and_deny(command, slash_s)

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
