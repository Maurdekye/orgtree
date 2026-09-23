"""_reclaim_orphan() must kill the full process group of a stale mailhub
child left over from a crashed prior engine run, not just its pidfile pid.

Regression coverage for T-02-05 (PROC-03 scope expansion): before this
fix, mailhub_runtime.py's start() did not set start_new_session, and
_reclaim_orphan() signaled the pidfile's pid with a plain SIGTERM
(os.kill(pid, 15)) — a single-process signal that does not reach a
forked grandchild.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
sys.path.insert(0, _ROOT)                      # engine.* from THIS worktree

from engine.mailhub_runtime import MailhubRuntime                    # noqa: E402


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


class _StandIn:
    """Exposes only the `.data_dir` attribute `_reclaim_orphan()` reads."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir


class ReclaimOrphanTests(unittest.TestCase):
    def test_reclaim_orphan_terminates_the_forked_grandchild(self) -> None:
        with tempfile.TemporaryDirectory(prefix="orgtree-reclaim-") as td:
            data_dir = Path(td)
            grandchild_pidfile = data_dir / "grandchild.pid"
            proc = subprocess.Popen(
                ["/bin/sh", "-c",
                 f'sleep 30 & echo $! > "{grandchild_pidfile}"; wait'],
                start_new_session=True)
            try:
                self.assertTrue(
                    _eventually(grandchild_pidfile.exists, timeout=2.0),
                    "grandchild never wrote its pid")
                grandchild_pid = int(grandchild_pidfile.read_text().strip())
                self.assertTrue(_alive(grandchild_pid),
                                "grandchild did not start alive")

                (data_dir / "hub.pid").write_text(str(proc.pid),
                                                  encoding="utf-8")
                MailhubRuntime._reclaim_orphan(_StandIn(data_dir))

                self.assertTrue(
                    _eventually(lambda: not _alive(grandchild_pid),
                                timeout=2.0),
                    "grandchild survived _reclaim_orphan()")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                if grandchild_pidfile.exists():
                    try:
                        pid = int(grandchild_pidfile.read_text().strip())
                        os.kill(pid, signal.SIGKILL)
                    except (OSError, ValueError):
                        pass


if __name__ == "__main__":
    unittest.main()
