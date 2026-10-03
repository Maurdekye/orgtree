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
        self.assertIn("RuntimeError: thread blew up", log)
        self.assertRegex(log, TS + r" err Traceback \(most recent call last\):")

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
