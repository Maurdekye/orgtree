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

NO VALUES FROM EXCEPTIONS (review f1): an exception's message can carry
any value the code handled (a token, a message body), so in the FILE the
message line of every printed traceback is reduced to the exception type
and its length (`RuntimeError: <message withheld, 72 chars>`), and so are
the lines that continue it; the frames (file, line, function, source line)
are kept. Every persisted line also has token-shaped strings replaced
(`_scrub`: `sk-…`, `Bearer …`, `token=…`/`key: …`-style pairs, long opaque
runs). The original stream still gets everything unchanged. LIMIT: a
free-form line the engine prints itself (`[orgtree] save failed: {e}`) is
kept as printed apart from `_scrub`.

BOUNDED: the file rotates to `.1` … `.{KEEP}` before a line would take it
past MAX_BYTES (counted in encoded bytes, line by line, so one large write
cannot overshoot), and a single line is cut at MAX_LINE_BYTES.
NEVER IN THE WAY: a write to the file that fails is dropped silently and the
original stream is always written first.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any, TextIO

MAX_BYTES = int(float(os.environ.get("ORGTREE_ENGINE_LOG_MAX_MB", "10")) * 1024 * 1024)
KEEP = 4
NAME = Path("diagnostics") / "engine.log"
#: One persisted line is cut to this many bytes.
MAX_LINE_BYTES = 8192
#: A traceback's message state ends after this long without a line.
_TB_QUIET_S = 0.5

_SECRETS = [
    (re.compile(r"\b(sk|pk|rk|ghp|gho|ghs|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{12,}"), "<redacted>"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[-._~+/A-Za-z0-9]{8,}=*"), r"\1 <redacted>"),
    (re.compile(r"(?i)\b([\w-]*(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|"
                r"credential|cookie|session[-_]?id)[\w-]*)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)"),
     r"\1\2<redacted>"),
    (re.compile(r"\b[A-Za-z0-9_\-+/]{40,}={0,2}"), "<redacted>"),
]


def _scrub(line: str) -> str:
    """Token-shaped strings replaced (best effort; see the module note)."""
    for rx, rep in _SECRETS:
        line = rx.sub(rep, line)
    return line


_EXC_LINE = re.compile(r"^([A-Za-z_][\w.]*)(?::\s?(.*))?$")
_GROUP = re.compile(r"^(\s*\|\s?)(.*)$")
_CHAIN = ("During handling of the above exception", "The above exception was the direct cause")


def _withheld(line: str) -> str:
    m = _EXC_LINE.match(line)
    if m is None:
        return f"<exception line withheld, {len(line)} chars>"
    msg = m.group(2)
    return m.group(1) if not msg else f"{m.group(1)}: <message withheld, {len(msg)} chars>"


class _Redactor:
    """Per-stream traceback state: what of each printed line may be kept.

    `text` keeps the line; after `Traceback (most recent call last):` the
    indented frame lines are kept and the first unindented line is the
    exception line, which is withheld, and so is every line after it (a
    multi-line message, notes) until a chain header, a new traceback, a
    blank line followed by one, an `[`/`{`-led line (the engine's own tagged
    and protocol lines) or a quiet gap."""

    def __init__(self) -> None:
        self.state = "text"
        self.last = 0.0

    def line(self, ln: str) -> str | None:
        now = time.monotonic()
        if self.state != "text" and now - self.last > _TB_QUIET_S:
            self.state = "text"
        self.last = now
        if ln.startswith("Traceback (most recent call last):") \
                or "Exception Group Traceback (most recent call last):" in ln:
            self.state = "tb"
            return ln
        if self.state == "text":
            return ln
        if self.state == "tb":
            g = _GROUP.match(ln)
            if g is not None:                       # an exception group's nested block
                inner = g.group(2)
                if inner and not inner[:1].isspace() and not inner.startswith(("Traceback", "+")) \
                        and _EXC_LINE.match(inner):
                    return g.group(1) + _withheld(inner)
                return ln
            if ln[:1].isspace() or not ln:
                return ln
            self.state = "exc"
            return _withheld(ln)
        # state "exc": after the exception line
        if not ln or ln.startswith(_CHAIN):
            return ln
        if ln.startswith(("[", "{")):
            self.state = "text"
            return ln
        return None


class _File:
    """The shared, rotating log file; one per process."""

    def __init__(self, path: Path, max_bytes: int, keep: int) -> None:
        self.path, self.max_bytes, self.keep = path, max_bytes, keep
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(path, "ab")
        self.size = self.fh.tell()

    def _rotate(self) -> None:
        self.fh.close()
        for i in range(self.keep, 0, -1):
            src = self.path if i == 1 else self.path.with_name(f"{self.path.name}.{i - 1}")
            if src.exists():
                os.replace(src, self.path.with_name(f"{self.path.name}.{i}"))
        self.fh = open(self.path, "ab")
        self.size = 0

    def write_lines(self, stream: str, lines: list[str]) -> None:
        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            with self.lock:
                for ln in lines:
                    b = f"{ts}Z {stream} {_scrub(ln)}".encode("utf-8", "replace")
                    if len(b) > MAX_LINE_BYTES:
                        cut = len(b) - MAX_LINE_BYTES
                        b = b[:MAX_LINE_BYTES] + f" …[{cut} bytes cut]".encode()
                    b += b"\n"
                    if self.size and self.size + len(b) > self.max_bytes:
                        self._rotate()
                    self.fh.write(b)
                    self.size += len(b)
                self.fh.flush()
        except Exception:                                       # noqa: BLE001
            pass


class _Tee:
    """A text stream that writes through to `orig` and copies whole lines to
    the log file. Everything else (fileno, encoding, isatty…) is `orig`'s."""

    def __init__(self, orig: TextIO, log: _File, name: str) -> None:
        self._orig, self._log, self._name = orig, log, name
        self._partial = ""
        self._lock = threading.Lock()
        self._redact = _Redactor()

    def write(self, s: str) -> int:
        n = self._orig.write(s)
        try:
            with self._lock:
                buf = self._partial + s
                *done, self._partial = buf.split("\n")
                done = [k for k in map(self._redact.line, done) if k is not None]
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
