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
any value the code handled (a token, a message body), so before a line is
persisted:
  * every value of the exception being handled in the writing thread (or
    when the line's first part was written) is withheld from it, short
    values as whole words (`_values`: str/repr of the exception and its args,
    line by line, across its cause/context chain and exception-group
    members). The engine prints errors from inside its `except` blocks
    (`[orgtree] save failed: {e}`, `traceback.format_exc()`), and the
    uncaught-exception hooks are wrapped (`_hooks`) so the exception they
    print counts as being handled;
  * the exception line of a printed traceback is reduced to its type and
    length (`RuntimeError: <message withheld, 72 chars>`); frames are kept;
  * token-shaped strings are blanked (`_scrub`).
The original stream still gets everything unchanged. LIMIT: a value copied
out of an exception and printed after its `except` block has ended is
only `_scrub`bed.

BOUNDED: the file rotates to `.1` … `.{KEEP}` before a line would take it
past its cap (counted in encoded bytes, line by line, so one large write
cannot overshoot), and one persisted record, newline and cut marker
included, is at most min(MAX_LINE_BYTES, the cap).
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
#: Exception values shorter than this are withheld only as whole words
#: (a 1-2 character value would otherwise blank parts of ordinary words).
_SHORT_VALUE = 3

_SECRETS = [
    (re.compile(r"\b(sk|pk|rk|ghp|gho|ghs|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{12,}"), "<redacted>"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[-._~+/A-Za-z0-9]{8,}=*"), r"\1 <redacted>"),
    # Match each key once. Retrying inside hyphenated keys, or backtracking
    # across repeated "token" words, can hold the GIL for minutes before the
    # persisted line is cut to its byte limit. The lookahead classifies the
    # whole key; the possessive key match cannot repartition it on failure.
    (re.compile(r"(?i)(?<![\w-])(?=[\w-]*(?:token|secret|password|passwd|api[-_]?key|apikey|"
                r"authorization|credential|cookie|session[-_]?id))"
                r"([\w-]++)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)"),
     r"\1\2<redacted>"),
    (re.compile(r"\b[A-Za-z0-9_\-+/]{40,}={0,2}"), "<redacted>"),
]


def _scrub(line: str) -> str:
    """Token-shaped strings replaced (best effort; see the module note)."""
    for rx, rep in _SECRETS:
        line = rx.sub(rep, line)
    return line


_hook_exc = threading.local()
_busy = threading.local()


def _values() -> list[str]:
    """Every text fragment of the exception(s) the current thread is
    handling (or an uncaught-exception hook is printing), longest first."""
    roots = [sys.exc_info()[1], getattr(_hook_exc, "value", None)]
    seen: set[int] = set()
    out: set[str] = set()
    todo = [e for e in roots if isinstance(e, BaseException)]
    while todo:                          # `seen` stops a cycle; no size cap
        e = todo.pop()
        if id(e) in seen:
            continue
        seen.add(id(e))
        texts: list[str] = []
        for f in (str, repr):
            try:
                texts.append(f(e))
            except Exception:                                   # noqa: BLE001
                pass
        for a in getattr(e, "args", ()) or ():
            try:
                texts += [str(a), repr(a)]
            except Exception:                                   # noqa: BLE001
                pass
        for n in getattr(e, "__notes__", None) or ():
            texts.append(str(n))
        for t in texts:
            for part in t.splitlines():
                part = part.strip()
                if part:
                    out.add(part)
        todo += [x for x in (e.__cause__, e.__context__) if x is not None]
        todo += [x for x in getattr(e, "exceptions", ()) or () if isinstance(x, BaseException)]
    return sorted(out, key=len, reverse=True)


def _withhold(line: str, values: list[str] | set[str]) -> str:
    for v in sorted(values, key=len, reverse=True):
        if v not in line:
            continue
        if len(v) >= _SHORT_VALUE:
            line = line.replace(v, "<withheld>")
        else:
            line = re.sub(r"(?<!\w)" + re.escape(v) + r"(?!\w)", "<withheld>", line)
    return line


_EXC_LINE = re.compile(r"^([A-Za-z_][\w.]*)(?::\s?(.*))?$")
_GROUP = re.compile(r"^(\s*\|\s?)(.*)$")


def _withheld(line: str) -> str:
    m = _EXC_LINE.match(line)
    if m is None:
        return f"<exception line withheld, {len(line)} chars>"
    msg = m.group(2)
    return m.group(1) if not msg else f"{m.group(1)}: <message withheld, {len(msg)} chars>"


class _Redactor:
    """Per-stream traceback state. After `Traceback (most recent call
    last):` the indented frame lines are kept and the first unindented line
    is the exception line, kept as its type only (inside an exception
    group's `| ` block likewise). The message's other lines are covered by
    `_values`, whatever they start with and however long the gap."""

    def __init__(self) -> None:
        self.tb = False

    def line(self, ln: str) -> str:
        if ln.startswith("Traceback (most recent call last):") \
                or "Exception Group Traceback (most recent call last):" in ln:
            self.tb = True
            return ln
        if not self.tb:
            return ln
        g = _GROUP.match(ln)
        if g is not None:                           # an exception group's nested block
            inner = g.group(2)
            if inner and not inner[:1].isspace() and not inner.startswith(("Traceback", "+")) \
                    and _EXC_LINE.match(inner):
                return g.group(1) + _withheld(inner)
            return ln
        if ln[:1].isspace() or not ln:
            return ln
        self.tb = False
        return _withheld(ln)


def _hooks() -> None:
    """Make the exception an uncaught-exception hook prints count as being
    handled (`_values`) while it prints."""
    def wrap(orig: Any, get: Any) -> Any:
        def hook(*a: Any) -> Any:
            _hook_exc.value = get(*a)
            try:
                return orig(*a)
            finally:
                _hook_exc.value = None
        hook.__wrapped__ = orig                     # type: ignore[attr-defined]
        return hook
    sys.excepthook = wrap(sys.excepthook, lambda t, v, tb: v)
    sys.unraisablehook = wrap(sys.unraisablehook, lambda u: u.exc_value)
    threading.excepthook = wrap(threading.excepthook, lambda a: a.exc_value)


class _File:
    """The shared, rotating log file; one per process."""

    def __init__(self, path: Path, max_bytes: int, keep: int) -> None:
        self.path, self.max_bytes, self.keep = path, max_bytes, keep
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(path, "ab")
        self.size = self.fh.tell()

    def _reopen(self) -> None:
        self.fh = open(self.path, "ab")
        self.size = self.fh.tell()

    def _rotate(self) -> None:
        self.fh.close()
        try:
            for i in range(self.keep, 0, -1):
                src = self.path if i == 1 else self.path.with_name(f"{self.path.name}.{i - 1}")
                if src.exists():
                    os.replace(src, self.path.with_name(f"{self.path.name}.{i}"))
        finally:
            # A failed rename must not poison every later write. The main file
            # may still contain its old bytes, so recover its actual size.
            self._reopen()

    def write_lines(self, stream: str, lines: list[str]) -> None:
        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            with self.lock:
                # If reopening failed during rotation, retry on the next line.
                if self.fh.closed:
                    self._reopen()
                limit = max(64, min(MAX_LINE_BYTES, self.max_bytes))
                for ln in lines:
                    b = f"{ts}Z {stream} {_scrub(ln)}".encode("utf-8", "replace")
                    if len(b) + 1 > limit:
                        mark = f" …[{len(b)} bytes, cut]".encode()
                        keep = limit - len(mark) - 1
                        b = b[:keep].decode("utf-8", "ignore").encode() + mark
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
        #: the handled-exception values of the writes a partial line came from
        self._pvals: set[str] = set()
        self._lock = threading.Lock()
        self._redact = _Redactor()

    def write(self, s: str) -> int:
        n = self._orig.write(s)
        if getattr(_busy, "on", False):
            # output produced while inspecting an exception (a custom
            # __str__ that prints): console only, never the file, and no
            # second trip into the lock this thread may hold
            return n
        try:
            _busy.on = True
            try:
                vals = set(_values())            # outside the lock: str() may print
            finally:
                _busy.on = False
            with self._lock:
                buf = self._partial + s
                *done, self._partial = buf.split("\n")
                # a line finished after its except block still loses the
                # values that were being handled when its start was written
                allv = vals | self._pvals
                self._pvals = allv if self._partial else set()
                if done:
                    done = [self._redact.line(_withhold(k, allv)) for k in done]
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
    _hooks()
    return log.path
