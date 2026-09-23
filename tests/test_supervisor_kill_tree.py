"""_wd_kill_tree() must kill the full process group, not just the launcher.

Regression coverage for D-07 (PROC-03 scope expansion): before this fix,
none of supervisor.py's 4 Claude-CLI Popen sites set `start_new_session`,
and `_wd_kill_tree()` terminated only the immediate child via a bare
`proc.kill()` — any grandchild the launcher forked was left running,
orphaned, when a turn was stopped.
"""
from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-kill-tree-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
from orgtree import supervisor as sup                                # noqa: E402


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _eventually(predicate, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.02)
    return bool(predicate())


class WdKillTreeTests(unittest.TestCase):
    def test_kill_tree_terminates_the_forked_grandchild(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orgtree-kill-tree-case-") as td:
            pidfile = Path(td) / "grandchild.pid"
            proc = subprocess.Popen(
                ["/bin/sh", "-c",
                 f'sleep 30 & echo $! > "{pidfile}"; wait'],
                start_new_session=True)
            try:
                self.assertTrue(
                    _eventually(pidfile.exists, timeout=2.0),
                    "grandchild never wrote its pid")
                grandchild_pid = int(pidfile.read_text().strip())
                self.assertTrue(_alive(grandchild_pid),
                                "grandchild did not start alive")

                sup._wd_kill_tree(proc)

                self.assertTrue(
                    _eventually(lambda: not _alive(grandchild_pid),
                                timeout=2.0),
                    "grandchild survived _wd_kill_tree()")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                if pidfile.exists():
                    try:
                        pid = int(pidfile.read_text().strip())
                        os.kill(pid, signal.SIGKILL)
                    except (OSError, ValueError):
                        pass


if __name__ == "__main__":
    unittest.main()
