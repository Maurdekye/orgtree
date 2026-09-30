"""The engine's GIL switch interval: short enough that a request doing many
small syscalls is not held hostage by busy threads.

Measured 2026-09-30 on a copy of the live org: the window's gating request
(`GET /foreground-tree`) took 3-5 s live on every poll for ~90 ms of CPU. Its
per-agent annotation does ~1000 file operations, each of which releases the
GIL and, at CPython's default 5 ms switch interval, waits up to 5 ms to take
it back while any other thread runs Python (the live engine keeps ~0.8 core
busy). `engine.launch.load_app` now sets 0.5 ms before anything else.

Run:  python tools/run-python-verification.py tests/test_gil_switch_interval.py
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine import launch


def _stat_storm_seconds(interval: float, *, stats: int = 300) -> float:
    """Wall time of `stats` os.stat calls on one thread while another thread
    runs pure Python, at the given switch interval."""
    old = sys.getswitchinterval()
    sys.setswitchinterval(interval)
    stop = threading.Event()

    def burn() -> None:
        while not stop.is_set():
            sum(range(500))

    busy = threading.Thread(target=burn, daemon=True)
    try:
        with tempfile.NamedTemporaryFile() as f:
            busy.start()
            time.sleep(0.05)
            started = time.perf_counter()
            for _ in range(stats):
                os.stat(f.name)
            return time.perf_counter() - started
    finally:
        stop.set()
        busy.join()
        sys.setswitchinterval(old)


class GilSwitchIntervalTests(unittest.TestCase):
    def setUp(self):
        old = sys.getswitchinterval()
        self.addCleanup(sys.setswitchinterval, old)

    def test_tune_gil_sets_the_short_interval(self):
        sys.setswitchinterval(0.005)
        launch.tune_gil()
        self.assertAlmostEqual(sys.getswitchinterval(), launch.GIL_SWITCH_INTERVAL_S, places=6)
        self.assertLessEqual(launch.GIL_SWITCH_INTERVAL_S, 0.001)

    def test_load_app_tunes_before_anything_else(self):
        # load_app refuses a missing ORGTREE_DATA at once; the interval must
        # already be set by then, so no later refactor can move it behind the
        # api import (whose module-level threads start with the default).
        sys.setswitchinterval(0.005)
        env = {k: v for k, v in os.environ.items() if k != "ORGTREE_DATA"}
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                launch.load_app()
        self.assertAlmostEqual(sys.getswitchinterval(), launch.GIL_SWITCH_INTERVAL_S, places=6)

    def test_short_interval_ends_the_syscall_convoy(self):
        # The measured mechanism, not just the setting: with one busy thread,
        # 300 stats wait ~5 ms each at the default and ~0.5 ms tuned.
        default = _stat_storm_seconds(0.005)
        tuned = _stat_storm_seconds(launch.GIL_SWITCH_INTERVAL_S)
        self.assertGreater(default, 0.3, f"control did not convoy: {default:.3f} s")
        self.assertLess(tuned, default / 3, f"tuned {tuned:.3f} s vs default {default:.3f} s")


if __name__ == "__main__":
    unittest.main()
