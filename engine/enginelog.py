"""The engine's own log: everything it writes to stdout and stderr, kept.

Item engine-logging-persist-the-engine-s-output-and-r (user request
2026-10-03). The engine's `[orgtree] …` lines, warnings and tracebacks went
only to its stdout/stderr, which the launcher reads for its protocol lines
and otherwise drops, so after the 2026-10-03 lock jam nothing the engine
had said could be read back.

`install(data)` wraps `sys.stdout` and `sys.stderr`: every write still goes
to the original stream UNCHANGED (the desktop parses the engine's stdout
protocol lines), and each completed line is also appended to
`<data>/diagnostics/engine.log`, prefixed with a UTC timestamp and the
stream name. Uncaught exceptions, in the main thread or any other, reach the
file because Python's default hooks write them to `sys.stderr`.

BOUNDED: the file rotates to `.1` … `.{KEEP}` when it passes MAX_BYTES.
NEVER IN THE WAY: a write to the file that fails is dropped silently and the
original stream is always written first.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, TextIO

MAX_BYTES = int(float(os.environ.get("ORGTREE_ENGINE_LOG_MAX_MB", "10")) * 1024 * 1024)
KEEP = 4
NAME = Path("diagnostics") / "engine.log"


class _File:
    """The shared, rotating log file; one per process."""

    def __init__(self, path: Path, max_bytes: int, keep: int) -> None:
        self.path, self.max_bytes, self.keep = path, max_bytes, keep
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(path, "a", encoding="utf-8", errors="replace")
        self.size = self.fh.tell()

    def _rotate(self) -> None:
        self.fh.close()
        for i in range(self.keep, 0, -1):
            src = self.path if i == 1 else self.path.with_name(f"{self.path.name}.{i - 1}")
            if src.exists():
                os.replace(src, self.path.with_name(f"{self.path.name}.{i}"))
        self.fh = open(self.path, "a", encoding="utf-8", errors="replace")
        self.size = 0

    def write_lines(self, stream: str, lines: list[str]) -> None:
        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            text = "".join(f"{ts}Z {stream} {ln}\n" for ln in lines)
            with self.lock:
                if self.size + len(text) > self.max_bytes and self.size:
                    self._rotate()
                self.fh.write(text)
                self.fh.flush()
                self.size += len(text.encode("utf-8", "replace"))
        except Exception:                                       # noqa: BLE001
            pass


class _Tee:
    """A text stream that writes through to `orig` and copies whole lines to
    the log file. Everything else (fileno, encoding, isatty…) is `orig`'s."""

    def __init__(self, orig: TextIO, log: _File, name: str) -> None:
        self._orig, self._log, self._name = orig, log, name
        self._partial = ""
        self._lock = threading.Lock()

    def write(self, s: str) -> int:
        n = self._orig.write(s)
        try:
            with self._lock:
                buf = self._partial + s
                *done, self._partial = buf.split("\n")
            if done:
                self._log.write_lines(self._name, done)
        except Exception:                                       # noqa: BLE001
            pass
        return n

    def flush(self) -> None:
        self._orig.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._orig, name)


_INSTALLED: _File | None = None


def install(data: Path, max_bytes: int = MAX_BYTES, keep: int = KEEP) -> Path | None:
    """Start keeping the engine log under `data`. Idempotent; best effort (a
    log that cannot be opened must not stop the engine). Returns its path."""
    global _INSTALLED
    if _INSTALLED is not None:
        return _INSTALLED.path
    try:
        log = _File(Path(data) / NAME, max_bytes, keep)
    except OSError:
        return None
    _INSTALLED = log
    log.write_lines("engine", [f"--- engine start pid {os.getpid()} ---"])
    sys.stdout = _Tee(sys.stdout, log, "out")   # type: ignore[assignment]
    sys.stderr = _Tee(sys.stderr, log, "err")   # type: ignore[assignment]
    return log.path
