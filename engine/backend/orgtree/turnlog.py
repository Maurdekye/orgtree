# pyright: strict
"""Turn events — the RECORDER (docs/turn-events.md). The schema, coercion,
shape helpers and offline readers live in `turnread.py` (pure) and are
re-exported here so capture sites and the suite see one module.

  · ONE RECORD PER TURN ATTEMPT, held by an attempt-specific Recorder handle
    (never a registry keyed by node: a late callback of attempt A must not
    reach attempt B's record — a closed recorder drops and counts).
  · ORDER: `seq` and `t_ms` are assigned INSIDE one lock, so the record's
    order holds across the reader, watchdog, pump and callback threads.
  · BOUNDED WHILE EMITTING: first HEAD and last TAIL events kept, the middle
    dropped and counted; list fields capped; the on-disk record capped.
  · FAIL-OPEN: open/emit/set/dispose/close never raise; they cannot change a
    turn's outcome, routing, retries or timing — but `close` is a synchronous
    write and does take its milliseconds on the caller's thread.
  · NO PROSE, NO IDENTIFIERS: no prompt, reply, tool arguments/results, error
    message, path, host, org, node, account or provider session id.
"""
from __future__ import annotations

import collections
import itertools
import json
import os
import threading
import time
from typing import Any, Mapping

from .turnread import (  # noqa: F401  (re-exported for the sites and the suite)
    B, CAP_BYTES, ERROR_CLASSES, F, FIELDS, HEAD, HEADER_FIELDS, I, KINDS,
    LIST_MAX, MAX_EVENTS, OUTCOMES, RING, SCHEMA, TAIL, TIERS, TOOLS,
    FieldSpec, L, S, _int, _vocab, assistant_shape, coerce, drift,
    fixture_name, fixture_path, freeze_shape, init_shape, is_fixture_name,
    list_records,
    load, record_dir, result_shape, seconds_of, summarize, tool_result_shape,
    window_of, _RECORD_RE, _STUB_RE)

_SEQ = itertools.count(1)    # per-process file sequence (name uniqueness)

# ------------------------------------------------------------------ recorder


class Recorder:
    """One attempt's record. Every public method is fail-open."""

    def __init__(self, root: str, org: str, node: str, **header: Any) -> None:
        self._lock = threading.Lock()
        self._t0 = time.monotonic()
        self._root, self._org, self._node = str(root), str(org), str(node)
        self._seq = 0
        self._head: list[dict[str, Any]] = []
        self._tail: collections.deque[dict[str, Any]] = collections.deque(
            maxlen=TAIL)
        self._dropped = 0
        self._dropped_kinds: dict[str, int] = {}
        self._errors = 0
        self._closed = False
        self._disposition: str | None = None
        self._fixture: str | None = None
        self._error_class: str | None = None
        self._paid_booked: bool | None = None
        self._cost: float | None = None
        self.token = f"{time.time_ns():x}-{next(_SEQ) % 10000:04d}"
        self.at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._stamp = int(time.time() * 1000)
        self._fseq = next(_SEQ) % 10000
        self._header: dict[str, Any] = {
            k: coerce(spec, header.get(k)) for k, spec in HEADER_FIELDS.items()}
        self._stub: str | None = None

    # ---- properties read by the sites (never by the inspector)
    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def disposition(self) -> str | None:
        return self._disposition

    def set(self, **header: Any) -> None:
        """Header fields learned after open (lane, tier, warm…)."""
        try:
            with self._lock:
                for k, v in header.items():
                    if k in HEADER_FIELDS and not self._closed:
                        self._header[k] = coerce(HEADER_FIELDS[k], v)
        except Exception:                                    # noqa: BLE001
            self._errors += 1

    def emit(self, kind: str, /, **fields: Any) -> bool:
        """Append one event. Returns False when dropped (closed recorder,
        unknown kind, or the bound) — the caller never needs the answer.
        `kind` is POSITIONAL-ONLY so a field named `kind` (agy_step, freeze)
        can never collide with it: a TypeError at the call site would be an
        exception on the production path (caught 2026-09-06, it stopped a
        connection freeze)."""
        try:
            spec = FIELDS.get(kind)
            with self._lock:
                if self._closed or spec is None:
                    return False
                return self._append_locked(kind, spec, fields)
        except Exception:                                    # noqa: BLE001
            self._errors += 1
            return False

    def _append_locked(self, kind: str, spec: dict[str, FieldSpec],
                       fields: Mapping[str, Any]) -> bool:
        """Stamp and append ONE event. Caller holds the lock: seq and t_ms
        are taken together here, so no thread can interleave between them,
        and `close` uses the same step for its `end` event without ever
        reopening the recorder to the public `emit`."""
        ev: dict[str, Any] = {
            "seq": self._seq + 1,
            "t_ms": int((time.monotonic() - self._t0) * 1000),
            "kind": kind}
        for k, fspec in spec.items():
            # a field can never shadow seq/t_ms/kind: the schema names none
            # of them, and the module asserts that at import
            if k in fields:
                ev[k] = coerce(fspec, fields[k])
        self._seq += 1
        if len(self._head) < HEAD:
            self._head.append(ev)
            return True
        if len(self._tail) == TAIL:
            old = self._tail[0]
            self._dropped += 1
            ok = str(old.get("kind"))
            self._dropped_kinds[ok] = self._dropped_kinds.get(ok, 0) + 1
        self._tail.append(ev)
        return True

    def dispose(self, outcome: str) -> None:
        """The FINAL disposition as the exit path knows it: the LAST call
        before close wins — except `unrecoverable`, which is STICKY. The
        unrecoverable branch marks the document and then falls through to
        the terminal door, which still bumps the hard-fail counter, drives
        the superior and disposes failed/abandoned (all of that is kept, as
        events); the record's outcome and filename name the diagnostic that
        matters. Recorder-side precedence only: nothing in the supervisor
        changes. `turnread.summarize` applies the same rule. Every call is
        also a `dispose` event, so the record shows each claim in order."""
        try:
            o = outcome if outcome in OUTCOMES else "unknown"
            with self._lock:
                if not self._closed and self._disposition != "unrecoverable":
                    self._disposition = o
            self.emit("dispose", outcome=o)
        except Exception:                                    # noqa: BLE001
            self._errors += 1

    def error(self, exc: Any) -> None:
        """The CLASS of the exception that ended the attempt — never its
        message, which is prose this module must not hold."""
        try:
            with self._lock:
                if not self._closed and exc is not None:
                    self._error_class = _vocab(type(exc).__name__,
                                               ERROR_CLASSES)
        except Exception:                                    # noqa: BLE001
            self._errors += 1

    def book(self, *, paid_booked: Any = None, cost_usd: Any = None) -> None:
        """What the attempt booked. An unknown cost is None (and
        `cost_known` false in the record), never 0.0."""
        try:
            with self._lock:
                if not self._closed:
                    self._paid_booked = (paid_booked is True
                                         if paid_booked is not None else None)
                    self._cost = coerce(F, cost_usd)
        except Exception:                                    # noqa: BLE001
            self._errors += 1

    def fixture(self, path: Any) -> None:
        """Correlate to the failfix record this attempt wrote (basename only,
        generated-name validated)."""
        try:
            name = fixture_name(path)
            with self._lock:
                if not self._closed and name:
                    self._fixture = name
            self.emit("fixture", written=name is not None)
        except Exception:                                    # noqa: BLE001
            self._errors += 1

    # ---- assembly
    def _events(self) -> list[dict[str, Any]]:
        return list(self._head) + list(self._tail)

    def _record(self, *, partial: bool, outcome: str | None,
                outcome_ms: int | None, error_class: str | None,
                paid_booked: bool | None, cost_usd: float | None) -> dict[str, Any]:
        events = self._events()
        return {
            "schema": SCHEMA, "at": self.at, "attempt": self.token,
            **self._header,
            "partial": partial,
            "events": events, "events_n": self._seq,
            "dropped": self._dropped,
            "dropped_kinds": dict(sorted(self._dropped_kinds.items())),
            "truncated": False,
            "outcome": outcome, "outcome_ms": outcome_ms,
            "error_class": error_class,
            "fixture": self._fixture,
            "paid_booked": paid_booked,
            "cost_usd": cost_usd, "cost_known": cost_usd is not None,
            "recorder_errors": self._errors,
        }

    # ---- files
    def _dir(self) -> str:
        return record_dir(self._root, self._org, self._node)

    def _names(self) -> tuple[str, str]:
        return (f"{self._stamp:013d}-{self._fseq:04d}",
                f"{self._stamp:013d}-{self._fseq:04d}.partial.json")

    def open(self) -> str | None:
        """Write the stub (a bounded, UNFINALIZED record: header, no events).
        A stub left behind means the record was never finalized — a live
        attempt, a finalization that raised, a write that failed, or a
        backend that died; it does not by itself say which."""
        try:
            d = self._dir()
            os.makedirs(d, exist_ok=True)
            _evict(d, RING - 1)
            rec = self._record(partial=True, outcome=None, outcome_ms=None,
                               error_class=None, paid_booked=None, cost_usd=None)
            rec["events"] = []
            path = os.path.join(d, self._names()[1])
            _write(path, rec)
            self._stub = path
            return path
        except Exception:                                    # noqa: BLE001
            self._errors += 1
            return None

    def close(self, *, outcome: str | None = None, error: Any = None,
              paid_booked: bool | None = None,
              cost_usd: Any = None) -> str | None:
        """Finalize: the full record replaces the stub. Idempotent; a second
        close is a no-op. Synchronous — takes its write time on the caller."""
        try:
            with self._lock:
                # ONE critical section: the closed flag, the disposition,
                # the `end` event and the SNAPSHOT of the events — so no
                # emit from another thread can land between them (the
                # 2026-09-06 review measured a late emit flipping a
                # completed turn's implied outcome to killed when `end` was
                # appended through the public emit with the flag lowered).
                # A second concurrent close sees the flag and returns None.
                if self._closed:
                    return None
                self._closed = True
                if outcome in OUTCOMES and self._disposition != "unrecoverable":
                    self._disposition = outcome
                o = self._disposition or "unknown"
                ms = int((time.monotonic() - self._t0) * 1000)
                try:
                    # `end` rides the events list so a tail-only reader
                    # still sees the disposition — summarize() never reads
                    # it. Its own guard: a failing append must not cost
                    # the record.
                    self._append_locked("end", FIELDS["end"],
                                        {"outcome": o, "outcome_ms": ms})
                except Exception:                            # noqa: BLE001
                    self._errors += 1
                ec: str | None = self._error_class
                if error is not None:
                    ec = _vocab(type(error).__name__, ERROR_CLASSES)
                cost = coerce(F, cost_usd) if cost_usd is not None else self._cost
                if paid_booked is None:
                    paid_booked = self._paid_booked
                rec = self._record(partial=False, outcome=o, outcome_ms=ms,
                                   error_class=ec,
                                   paid_booked=(paid_booked is True
                                                if paid_booked is not None
                                                else None),
                                   cost_usd=cost)
            blob = json.dumps(rec, ensure_ascii=False, indent=1)
            while len(blob.encode("utf-8")) > CAP_BYTES and len(rec["events"]) > 2:
                # cut from the MIDDLE, keeping the start and the end
                evs: list[dict[str, Any]] = rec["events"]
                cut = max(1, len(evs) // 8)
                mid = len(evs) // 2
                del evs[mid - cut // 2: mid - cut // 2 + cut]
                rec["dropped"] += cut
                rec["truncated"] = True
                blob = json.dumps(rec, ensure_ascii=False, indent=1)
            d = self._dir()
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, f"{self._names()[0]}-"
                                f"{self._header.get('lane') or 'other'}-{o}.json")
            _write(path, blob)
            if self._stub:
                try:
                    os.remove(self._stub)
                except OSError:
                    pass
            _evict(d, RING)
            return path
        except Exception:                                    # noqa: BLE001
            self._errors += 1
            self._closed = True
            return None


def _write(path: str, rec: Any) -> None:
    blob = rec if isinstance(rec, str) else json.dumps(
        rec, ensure_ascii=False, indent=1)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(blob)
    os.replace(tmp, path)


def _evict(d: str, keep: int) -> None:
    """Oldest records AND stubs beyond `keep` go — so repeated unfinalized
    attempts cannot accumulate stubs without bound."""
    names = sorted(n for n in os.listdir(d)
                   if _RECORD_RE.match(n) or _STUB_RE.match(n))
    for old in (names[:-keep] if keep > 0 and len(names) > keep else
                names if keep <= 0 else []):
        try:
            os.remove(os.path.join(d, old))
        except OSError:
            pass


def enabled() -> bool:
    return os.environ.get("ORGTREE_TURNLOG", "1") not in ("0", "false", "no")


def start(root: str, org: str, node: str, **header: Any) -> Recorder | None:
    """Open an attempt's recorder and write its stub. None when disabled or
    when even constructing one fails — every site tolerates None."""
    try:
        if not enabled():
            return None
        rec = Recorder(root, org, node, **header)
        rec.open()
        return rec
    except Exception:                                        # noqa: BLE001
        return None


def emit(rec: Recorder | None, kind: str, /, **fields: Any) -> None:
    """The site-side form: tolerates a missing recorder, and a recorder
    whose own guard has been replaced — nothing here reaches the caller."""
    try:
        if rec is not None:
            rec.emit(kind, **fields)
    except Exception:                                        # noqa: BLE001
        pass

