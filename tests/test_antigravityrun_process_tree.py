"""PROC-03 — antigravityrun.py's kill_tree() must terminate the whole
process tree.

Before this fix, `kill_tree()` killed only the parent `agy` CLI process;
any child that process itself forked (the CLI forks a language-server
child) survived as an orphan. `kill_tree()`'s spawn side now uses
`start_new_session=(os.name != "nt")` and the POSIX kill path uses
`os.killpg(pid, signal.SIGKILL)`, the same pattern gitrunner.py's
already-proven `_stop()` uses.

`test_prefix_kill_pattern_orphans_grandchild` is a frozen control: it
replicates the EXACT pre-fix Popen/kill shape (no `start_new_session`, a
bare `proc.kill()`), independent of whatever antigravityrun.py's
`kill_tree()` does today, so it keeps demonstrating the vulnerability
class this fix closes regardless of production code state.

`test_kill_tree_reaps_grandchild_via_process_group` drives the REAL
`kill_tree()` against a real child and its grandchild: RED before the
fix (grandchild survives), GREEN after.

    python -m unittest tests.test_antigravityrun_process_tree -v
"""
import contextlib
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("ORGTREE_DATA", tempfile.mkdtemp(prefix="antigravityrun-proctree-data-"))

from engine.backend.orgtree import antigravityrun  # noqa: E402


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _eventually(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return bool(predicate())


def _grandchild_argv(pidfile: Path) -> list[str]:
    # Backgrounds a real grandchild (sleep), records its pid, then waits on
    # it — the shape antigravityrun.py's own child (the CLI's
    # language-server child) can leave behind.
    return ["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"]


@unittest.skipIf(os.name == "nt", "POSIX process-group termination only")
class AntigravityKillTreeTerminationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="antigravityrun-proctree-")
        self.addCleanup(self.tmp.cleanup)

    def _spawn_grandchild(self, pidfile: Path, **popen_kwargs_extra):
        """Spawn a real /bin/sh parent that backgrounds a real sleep
        grandchild, and return (parent_proc, grandchild_pid) once the
        grandchild is confirmed running."""
        kwargs = dict(stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      stderr=subprocess.PIPE, cwd=self.tmp.name)
        kwargs.update(popen_kwargs_extra)
        proc = subprocess.Popen(_grandchild_argv(pidfile), **kwargs)
        self.assertTrue(_eventually(pidfile.exists, timeout=5),
                         "grandchild never wrote its pid file")
        grandchild_pid = int(pidfile.read_text().strip())
        self.assertTrue(_eventually(lambda: _is_alive(grandchild_pid), timeout=2),
                         "grandchild never started")
        return proc, grandchild_pid

    def test_prefix_kill_pattern_orphans_grandchild(self):
        """Control: the PRE-FIX shape (no start_new_session, a bare
        proc.kill()) never reaches the grandchild — the vulnerability
        PROC-03 closes, demonstrated independent of antigravityrun.py's
        current kill_tree() so it stays evidence regardless of production
        code state."""
        pidfile = Path(self.tmp.name) / "grandchild.pid"
        proc, grandchild_pid = self._spawn_grandchild(pidfile)
        try:
            proc.kill()          # the exact pre-fix POSIX kill path
            proc.wait(timeout=5)
            self.assertTrue(_is_alive(grandchild_pid),
                             "expected the pre-fix pattern to orphan the grandchild")
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.kill(grandchild_pid, 9)

    def test_kill_tree_reaps_grandchild_via_process_group(self):
        """RED before the fix, GREEN after: kill_tree() must kill the
        whole process tree, not just the parent."""
        pidfile = Path(self.tmp.name) / "grandchild2.pid"
        proc, grandchild_pid = self._spawn_grandchild(
            pidfile, start_new_session=(os.name != "nt"))
        try:
            antigravityrun.kill_tree(proc)
            self.assertTrue(_eventually(lambda: not _is_alive(grandchild_pid), timeout=2),
                             "kill_tree() left the grandchild running")
        finally:
            with contextlib.suppress(Exception):
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
