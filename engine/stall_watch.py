"""Write every thread's stack to disk when the engine stops answering.

On 2026-09-30 the live engine stopped answering every request for ten minutes
while its process stayed alive (item v3-orgtree-froze-and-crashed-around-09-40-09-50z),
and it left no trace of WHERE it was stuck: the engine keeps no log of its own,
and the hung process was killed before anyone could look. This watch makes the
next one leave that trace.

A daemon thread asks the engine's own liveness route (``/api/desktop/alive``), over real HTTP, every
PROBE_INTERVAL. That route is a plain ``def``, so an answer needs the event
loop AND a free worker thread: it fails on a blocked loop and on a starved
thread pool alike. When a probe has not answered after STALL_AFTER, a timer
thread writes every thread's stack from Python (``sys._current_frames``),
holding the GIL like any other Python code.

It deliberately does NOT use ``faulthandler.dump_traceback_later``: that walks
other threads' frames WITHOUT the GIL, which is only safe in a process that is
already crashing. Review of this item measured it segfaulting a busy process
in 3 of 3 runs, and the dump fires on a slow-but-alive engine, not only a dead
one. The cost is that a thread holding the GIL forever leaves no dump; in the
09:35Z incident the GIL was free (the engine's net poller kept polling).

The file is ``<data>/diagnostics/engine-stall-stacks.txt`` and rotates to
``.1`` at start once it passes MAX_BYTES. The service host's liveness watch
(engine/service_host.py) is what ENDS a hang; this only explains it.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import threading
import time
import traceback
from typing import Callable
import urllib.error
import urllib.request

PROBE_INTERVAL = 30.0
STALL_AFTER = 60.0
MAX_BYTES = 8 * 1024 * 1024
DUMP = Path("diagnostics") / "engine-stall-stacks.txt"


def alive_probe(port: int, token: str, timeout: float) -> Callable[[], bool]:
    def probe() -> bool:
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/desktop/alive",
                                         headers={"X-Orgtree-Desktop-Token": token})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response.read()
                return response.status == 200
        except (urllib.error.URLError, OSError, ValueError):
            return False
    return probe


def format_all_stacks() -> str:
    """Every thread's stack, most recent call LAST (Python's own order)."""
    names = {thread.ident: thread.name for thread in threading.enumerate()}
    parts = []
    for ident, frame in sys._current_frames().items():
        parts.append(f"--- thread {names.get(ident, '?')} ({ident}), most recent call last ---\n")
        parts.append("".join(traceback.format_stack(frame)))
    return "".join(parts)


class StallWatch:
    def __init__(self, path: Path, probe: Callable[[], bool], *,
                 interval: float = PROBE_INTERVAL, stall_after: float = STALL_AFTER) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if path.stat().st_size > MAX_BYTES:
                os.replace(path, path.with_name(path.name + ".1"))
        except OSError:
            pass
        self.path, self._probe = path, probe
        self.interval, self.stall_after = interval, stall_after
        self._stream = path.open("ab", buffering=0)
        self._stop = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True, name="engine-stall-watch").start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.check_once()

    def _dump(self) -> None:
        self._dumped = True
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            self._stream.write((f"\n=== {stamp} pid {os.getpid()}: the engine did not answer its liveness "
                                f"route within {self.stall_after:g}s; every thread's stack follows ===\n"
                                + format_all_stacks()).encode("utf-8", "replace"))
        except (OSError, ValueError):
            pass

    def check_once(self) -> bool:
        """One probe. True when it answered before the dump fired (nothing written)."""
        timer = threading.Timer(self.stall_after, self._dump)
        timer.daemon = True
        timer.name = "engine-stall-dump"
        self._dumped = False
        began = time.monotonic()
        timer.start()
        try:
            answered = self._probe()
        finally:
            timer.cancel()
            timer.join()
        elapsed = time.monotonic() - began
        if not self._dumped:
            return answered
        try:
            self._stream.write(f"=== the probe {'answered' if answered else 'failed'} after {elapsed:.1f}s ===\n"
                               .encode())
        except (OSError, ValueError):
            pass
        return False


def start_stall_watch(data: Path, port: int, token: str) -> StallWatch | None:
    """Best effort: a watch that cannot open its file must not stop the engine."""
    try:
        watch = StallWatch(data / DUMP, alive_probe(port, token, STALL_AFTER + 60.0))
    except OSError:
        return None
    watch.start()
    return watch
