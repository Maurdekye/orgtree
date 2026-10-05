"""The engine keeps its own log (engine/enginelog.py).

Item engine-logging-persist-the-engine-s-output-and-r: after the 2026-10-03
lock jam nothing the engine had printed could be read back. These pin:
  * stdout and stderr still reach the original streams byte for byte (the
    desktop parses the engine's stdout protocol lines);
  * every completed line is also in <data>/diagnostics/engine.log with a UTC
    timestamp and its stream; a partial line waits for its newline;
  * an uncaught exception in another thread lands in the file;
  * the file rotates past its cap and keeps at most KEEP old files;
  * installing twice is a no-op.

No database. Run:  python tools/run-python-verification.py tests/test_enginelog.py
"""
import ast
import io
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import enginelog

TS = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"


class EngineLog(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="enginelog-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.out, self.err = io.StringIO(), io.StringIO()
        patches = [mock.patch.object(sys, "stdout", self.out),
                   mock.patch.object(sys, "stderr", self.err),
                   mock.patch.object(enginelog, "_INSTALLED", None),
                   # install() wraps the uncaught-exception hooks
                   mock.patch.object(sys, "excepthook", sys.excepthook),
                   mock.patch.object(sys, "unraisablehook", sys.unraisablehook),
                   mock.patch.object(threading, "excepthook", threading.excepthook)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def install(self, **kw):
        path = enginelog.install(self.data, **kw)
        self.addCleanup(lambda: enginelog._INSTALLED and enginelog._INSTALLED.fh.close())
        return path

    def text(self, name="engine.log"):
        return (self.data / "diagnostics" / name).read_text(encoding="utf-8")

    def test_lines_pass_through_and_are_kept_with_timestamps(self):
        path = self.install()
        self.assertEqual(path, self.data / "diagnostics" / "engine.log")
        print('{"type":"ready","port":1}', flush=True)
        sys.stdout.write("half a ")
        print("[orgtree] something happened", file=sys.stderr)
        self.assertEqual(self.out.getvalue(), '{"type":"ready","port":1}\nhalf a ')
        self.assertEqual(self.err.getvalue(), "[orgtree] something happened\n")
        log = self.text()
        self.assertRegex(log, TS + r' out \{"type":"ready","port":1\}\n')
        self.assertRegex(log, TS + r" err \[orgtree\] something happened\n")
        self.assertNotIn("half a", log)             # waits for its newline
        sys.stdout.write("line\n")
        self.assertRegex(self.text(), TS + r" out half a line\n")

    def test_an_uncaught_thread_exception_is_kept(self):
        self.install()

        def boom():
            raise RuntimeError("thread blew up")
        t = threading.Thread(target=boom)
        t.start()
        t.join()
        log = self.text()
        self.assertIn("RuntimeError: <message withheld", log)
        self.assertNotIn("RuntimeError: thread blew up", log)
        self.assertIn("in boom", log)                   # the frames (and source) are kept
        self.assertRegex(log, TS + r" err Traceback \(most recent call last\):")
        self.assertIn("RuntimeError: thread blew up", self.err.getvalue())

    def test_exception_values_never_reach_the_file(self):
        # review f1: the uncaught-thread hook copied a token and a body
        self.install()
        token, body = "tok-" + "a1b2c3d4" * 2, "private message body 4711"

        def boom():
            try:
                raise KeyError("first " + body)
            except KeyError as e:
                raise RuntimeError("token=" + token + "\nsecond line " + body) from e
        t = threading.Thread(target=boom)
        t.start()
        t.join()
        log = self.text()
        self.assertIn(token, self.err.getvalue())      # the console is unchanged
        self.assertIn(body, self.err.getvalue())
        self.assertNotIn(token, log)
        self.assertNotIn(body, log)
        self.assertIn("KeyError: <message withheld", log)
        self.assertIn("RuntimeError: <message withheld", log)
        self.assertIn("The above exception was the direct cause", log)
        print("[orgtree] after the traceback", file=sys.stderr)
        self.assertIn("[orgtree] after the traceback", self.text())

    def _thread_fails(self, exc):
        def boom():
            raise exc
        t = threading.Thread(target=boom)
        t.start()
        t.join()
        return self.text()

    def test_an_error_print_inside_its_except_block_keeps_no_value(self):
        # review r3 (1): `[orgtree] save failed: {e}`, the engine's own pattern
        self.install()
        body = "private body 5049"
        try:
            raise ValueError(body + "\n[second " + body + "]")
        except ValueError as e:
            print(f"[orgtree] save failed: {e}")
            print(f"[orgtree] again: {e!r}", file=sys.stderr)
            import traceback
            print(f"[orgtree] stack: {traceback.format_exc()}")
        log = self.text()
        self.assertIn("[orgtree] save failed: <withheld>", log)
        self.assertNotIn(body, log)
        self.assertIn(body, self.out.getvalue())

    def test_bracketed_and_group_continuations_keep_no_value(self):
        # review r3 (2) and (3): a `[`-led continuation; a group member's lines
        self.install()
        a, b = "private body 2731", "private body 8052"
        log = self._thread_fails(RuntimeError("first line\n[" + a + "]"))
        log = self._thread_fails(ExceptionGroup("review group", [ValueError("first\n" + b)]))
        self.assertNotIn(a, log)
        self.assertNotIn(b, log)
        self.assertIn("Exception Group Traceback", log)
        self.assertIn(a, self.err.getvalue())
        self.assertIn(b, self.err.getvalue())

    def test_a_main_thread_uncaught_exception_keeps_no_value(self):
        # sys.excepthook runs after the stack unwound: nothing is "handled"
        # there, so install() wraps the hook
        self.install()
        body = "private body 6170"
        try:
            raise RuntimeError("x\n" + body)      # its second line is a value line
        except RuntimeError as e:
            exc = e
        sys.excepthook(type(exc), exc, exc.__traceback__)
        self.assertNotIn(body, self.text())
        self.assertIn(body, self.err.getvalue())

    def test_a_traceback_exception_line_keeps_no_value_whatever_the_timing(self):
        # review r3 (4): no timing state any more; a traceback printed as
        # text, with no exception being handled, still loses its value
        self.install()
        body = "private body 9018"
        for ln in ("Traceback (most recent call last):\n",
                   '  File "review.py", line 1, in example\n',
                   "RuntimeError: " + body + "\n"):
            sys.stderr.write(ln)
            time.sleep(0.3)
        self.assertNotIn(body, self.text())
        self.assertIn("RuntimeError: <message withheld, 17 chars>", self.text())

    def test_a_line_finished_after_its_except_block_keeps_no_value(self):
        # review r4: the newline arrives after the handler has ended
        self.install()
        body = "private body 3301"
        try:
            raise ValueError(body)
        except ValueError as e:
            sys.stdout.write(f"[orgtree] save failed: {e}")
        sys.stdout.write(" (retrying)\n")
        self.assertNotIn(body, self.text())
        self.assertIn("[orgtree] save failed: <withheld> (retrying)", self.text())
        print("[orgtree] later line " + body)    # nothing handled, nothing pending
        self.assertIn("later line " + body, self.text())

    def test_a_short_value_is_withheld_as_a_word(self):
        self.install()
        try:
            raise ValueError("Q7")
        except ValueError as e:
            print(f"[orgtree] code {e} in Q7X")
        self.assertIn("[orgtree] code <withheld> in Q7X", self.text())

    def test_every_member_of_a_large_group_is_withheld(self):
        # review r4: a 70-member group outran a 64-node traversal cap
        self.install()
        bodies = [f"member body {i:03d}" for i in range(70)]
        log = self._thread_fails(ExceptionGroup(
            "many", [ValueError("first\n" + b) for b in bodies]))
        self.assertFalse([b for b in bodies if b in log])
        self.assertIn(bodies[0], self.err.getvalue())

    def test_an_exception_that_prints_while_formatted_does_not_hang(self):
        # review r4: str() of the exception printed under the tee's lock
        self.install()

        class Loud(Exception):
            def __str__(self):
                print("[orgtree] formatting a Loud")
                return "loud private 5512"
        done = threading.Event()

        def run():
            try:
                raise Loud()
            except Loud as e:
                print(f"[orgtree] failed: {e}")
            done.set()
        t = threading.Thread(target=run, daemon=True)
        t.start()
        self.assertTrue(done.wait(5), "a printing __str__ deadlocked the tee")
        self.assertNotIn("loud private 5512", self.text())
        self.assertIn("[orgtree] failed: <withheld>", self.text())
        self.assertIn("loud private 5512", self.out.getvalue())

    def test_engine_prints_exception_values_only_while_handling_them(self):
        # the guarantee above rests on this: every print/write in the engine
        # that names an `except ... as <name>` variable, or calls format_exc /
        # print_exc, sits inside the except block that binds it
        root = Path(enginelog.__file__).resolve().parent
        bad, scanned = [], 0
        for path in sorted(root.rglob("*.py")):
            if "runtime" in path.parts:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
            except SyntaxError:
                continue
            scanned += 1
            bad += [f"{path.relative_to(root)}:{ln}: {n}" for ln, n in _outside_handler(tree)]
        self.assertGreater(scanned, 100)
        self.assertEqual(bad, [])
        probe = ast.parse("def f():\n    try:\n        g()\n    except Exception as e:\n"
                          "        print(f'ok {e}')\n    print(f'bad {e}')\n"
                          "    print(traceback.format_exc())\n")
        self.assertEqual(_outside_handler(probe), [(6, "e"), (7, "format_exc")])

    def test_token_shaped_strings_are_scrubbed_from_any_line(self):
        self.install()
        print("[orgtree] call failed: Authorization: Bearer abcdefgh12345678 "
              "api_key=sk-live0123456789abcdef password='hunter2 x'")
        log = self.text()
        for s in ("abcdefgh12345678", "sk-live0123456789abcdef", "hunter2"):
            self.assertNotIn(s, log)
        self.assertIn("[orgtree] call failed:", log)
        self.assertIn("hunter2", self.out.getvalue())

    def test_long_non_assignment_keys_do_not_stall_logging(self):
        # A separate interpreter bounds the old GIL-holding regex: an in-process
        # timer thread cannot interrupt it. Exercise both overlapping key words
        # and the word boundaries inside a long hyphenated key.
        source = (
            "import sys; from pathlib import Path; "
            "root=Path.cwd(); sys.path.insert(0,str(root/'tools')); "
            "from assert_repo_import import assert_repo_import; assert_repo_import(root); "
            "from engine.enginelog import _scrub; "
            "assert _scrub('a-'*100000+'!').endswith('!'); "
            "assert _scrub('token'*100000+'!').endswith('!')"
        )
        result = subprocess.run([sys.executable, '-I', '-c', source],
                                cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_secret_key_matching_preserves_redaction(self):
        for key in ('token', '-access-token', 'myTOKENsuffix', 'api-key',
                    'api_key', 'session-id', 'session_id', 'credential',
                    'my-cookie-value', '密token钥'):
            with self.subTest(key=key):
                scrubbed = enginelog._scrub(f"prefix {key}='secret value' suffix")
                self.assertNotIn('secret value', scrubbed)
                self.assertIn('suffix', scrubbed)
        self.assertNotIn('hunter2', enginelog._scrub('message=password=hunter2'))

    def test_one_multiline_write_respects_the_cap(self):
        # review f4: a single write of many lines was written in one piece
        self.install(max_bytes=2000, keep=2)
        text = "".join("ordinary diagnostic line %04d\n" % i for i in range(300))
        sys.stdout.write(text)
        self.assertEqual(self.out.getvalue(), text)
        for p in (self.data / "diagnostics").iterdir():
            self.assertLessEqual(p.stat().st_size, 2000, p.name)
        self.assertIn("line 0299", self.text())

    def test_the_cap_counts_encoded_bytes_and_cuts_a_huge_line(self):
        self.install(max_bytes=2000, keep=2)
        for _ in range(40):
            print("é€" * 20)                        # 100 bytes, 40 characters
        for p in (self.data / "diagnostics").iterdir():
            self.assertLessEqual(p.stat().st_size, 2000, p.name)
        with mock.patch.object(enginelog, "MAX_LINE_BYTES", 500):
            print("xy " * 2000)
        last = self.text().splitlines()[-1]
        self.assertLessEqual(len(last.encode("utf-8")), 540)
        self.assertIn("bytes, cut]", last)
        self.assertIn("xy " * 2000, self.out.getvalue())

    def test_one_line_is_bounded_by_a_cap_smaller_than_the_line_limit(self):
        # review r3 f4: cap 2000 < MAX_LINE_BYTES; the record includes its
        # timestamp, cut marker and newline
        self.install(max_bytes=2000, keep=2)
        print("ordinary diagnostic value " * 1000)
        print("é€" * 1000)
        for p in (self.data / "diagnostics").iterdir():
            self.assertLessEqual(p.stat().st_size, 2000, p.name)
        self.assertIn("bytes, cut]", self.text())

    def test_logging_recovers_after_rotation_rename_failure(self):
        path = self.install(max_bytes=1000, keep=2)
        log = enginelog._INSTALLED
        print("seed " + "word " * 86)
        before = self.text()
        with mock.patch.object(enginelog.os, "replace", side_effect=PermissionError("busy backup")) as replace:
            print("rotation " + "word " * 120)
        replace.assert_called_once()
        print("after rename failure")
        self.assertIn("after rename failure", self.text())
        self.assertTrue(self.text().startswith(before))
        self.assertIn("rotation", self.out.getvalue())
        self.assertFalse(log.fh.closed)
        self.assertLessEqual(path.stat().st_size, 1000)

    def test_logging_recovers_after_rotation_reopen_failure(self):
        path = self.install(max_bytes=1000, keep=2)
        print("seed " + "word " * 86)
        def unavailable(*args, **kwargs):
            # The old log was renamed but the replacement could not be opened.
            raise PermissionError("replacement unavailable")
        with mock.patch.object(enginelog, "open", unavailable, create=True):
            print("rotation " + "word " * 120)
        print("after reopen failure")
        self.assertIn("after reopen failure", self.text())
        self.assertIn("seed", self.text("engine.log.1"))
        self.assertLessEqual(path.stat().st_size, 1000)

    def test_logging_recovers_from_a_closed_output_handle(self):
        self.install()
        enginelog._INSTALLED.fh.close()
        print("after closed handle")
        self.assertIn("after closed handle", self.text())
        self.assertEqual(self.out.getvalue(), "after closed handle\n")

    def test_rotation_keeps_a_bounded_number_of_files(self):
        self.install(max_bytes=2000, keep=2)
        for i in range(200):
            print(f"line {i:04d} " + "x" * 40)
        files = sorted(p.name for p in (self.data / "diagnostics").iterdir())
        self.assertEqual(files, ["engine.log", "engine.log.1", "engine.log.2"])
        for name in files:
            self.assertLessEqual((self.data / "diagnostics" / name).stat().st_size, 2200)
        self.assertIn("line 0199", self.text())

    def test_install_twice_is_a_no_op(self):
        self.install()
        first = sys.stdout
        self.assertEqual(enginelog.install(self.data), self.data / "diagnostics" / "engine.log")
        self.assertIs(sys.stdout, first)
        print("once")
        self.assertEqual(len(re.findall(r" out once\n", self.text())), 1)


def _outside_handler(tree):
    """(line, name) of each print()/.write() naming an except-bound
    variable outside its handler, or calling format_exc/print_exc outside
    any handler."""
    bad = []

    def visit(node, handlers, names):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            names = {h.name for h in ast.walk(node) if isinstance(h, ast.ExceptHandler) and h.name}
            handlers = []
        elif isinstance(node, ast.ExceptHandler):
            for c in node.body:
                visit(c, handlers + [node.name], names)
            return
        elif isinstance(node, ast.Call):
            f = node.func
            fname = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""
            if fname in ("print", "write"):
                for a in list(node.args) + [k.value for k in node.keywords]:
                    for n in ast.walk(a):
                        if isinstance(n, ast.Name) and n.id in names and n.id not in handlers:
                            bad.append((node.lineno, n.id))
                        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) \
                                and n.func.attr in ("format_exc", "print_exc") and not handlers:
                            bad.append((node.lineno, n.func.attr))
        for c in ast.iter_child_nodes(node):
            visit(c, handlers, names)
    visit(tree, [], set())
    return bad

if __name__ == "__main__":
    unittest.main()
