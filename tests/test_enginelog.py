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
import io
from pathlib import Path
import re
import sys
import tempfile
import threading
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
                   mock.patch.object(enginelog, "_INSTALLED", None)]
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
        self.assertIn("RuntimeError: <message withheld, 14 chars>", log)
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

    def test_token_shaped_strings_are_scrubbed_from_any_line(self):
        self.install()
        print("[orgtree] call failed: Authorization: Bearer abcdefgh12345678 "
              "api_key=sk-live0123456789abcdef password='hunter2 x'")
        log = self.text()
        for s in ("abcdefgh12345678", "sk-live0123456789abcdef", "hunter2"):
            self.assertNotIn(s, log)
        self.assertIn("[orgtree] call failed:", log)
        self.assertIn("hunter2", self.out.getvalue())

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
        self.assertIn("bytes cut]", last)
        self.assertIn("xy " * 2000, self.out.getvalue())

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


if __name__ == "__main__":
    unittest.main()
