"""PROC-03 — codexrun.py's close() must terminate the whole process tree.

Before this fix, `AppServerClient.close()` killed only the parent `codex`
process; any child that process itself forked (a shell, a tool subprocess)
survived as an orphan. `close()` now spawns with
`start_new_session=(os.name != "nt")` and kills the whole POSIX process
group via `os.killpg(pid, signal.SIGKILL)`, the same pattern gitrunner.py's
already-proven `_stop()` uses.

`test_prefix_kill_pattern_orphans_grandchild` is a frozen control: it
replicates the EXACT pre-fix Popen/kill shape (no `start_new_session`, a
bare `proc.kill()`), independent of whatever codexrun.py's close() does
today, so it keeps demonstrating the vulnerability class this fix closes
regardless of production code state.

`test_close_reaps_grandchild_via_process_group` drives the REAL
`AppServerClient.close()` against a real child and its grandchild: RED before
the fix (grandchild survives), GREEN after.

    python -m unittest tests.test_codexrun_process_tree -v
"""
import contextlib
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from engine.backend.orgtree import codexrun


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
    # it — the shape codexrun.py's own child (a shell, a tool subprocess)
    # can leave behind.
    return ["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"]


@unittest.skipIf(os.name == "nt", "POSIX process-group termination only")
class CodexProcessTreeTerminationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="codexrun-proctree-")
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
        PROC-03 closes, demonstrated independent of codexrun.py's current
        close() so it stays evidence regardless of production code state."""
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

    def test_close_reaps_grandchild_via_process_group(self):
        """RED before the fix, GREEN after: AppServerClient.close() must kill
        the whole process tree, not just the parent."""
        pidfile = Path(self.tmp.name) / "grandchild2.pid"
        argv_head = ["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"]
        codex_proc = codexrun.AppServerClient(argv_head, cwd=self.tmp.name)
        try:
            self.assertTrue(_eventually(pidfile.exists, timeout=5),
                             "grandchild never wrote its pid file")
            grandchild_pid = int(pidfile.read_text().strip())
            self.assertTrue(_eventually(lambda: _is_alive(grandchild_pid), timeout=2),
                             "grandchild never started")
            codex_proc.close()
            self.assertTrue(_eventually(lambda: not _is_alive(grandchild_pid), timeout=2),
                             "close() left the grandchild running")
        finally:
            with contextlib.suppress(Exception):
                if codex_proc.proc.poll() is None:
                    codex_proc.proc.kill()
                    codex_proc.proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
