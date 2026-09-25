"""An in-process FAKE executor that speaks the pause-point contract (WS7 design §1).

Test scaffolding for the harness, NEVER product evidence: it has no SQL, no
PostgreSQL and no isolation levels. It exists so the harness's own verdict
logic is exercised, including its meta-controls, before the native executor
lands:

- a build without qualification points is refused;
- a removed barrier (``barriers=False``) must turn a schedule into FAILED
  ("interleaving not achieved"), never PASSED;
- a control switched on WITHOUT its executed record (``silent_controls``) must be
  a FAILED control;
- an unflushed stream tail (``unclean_tail``) or a dropped record
  (``drop_records``) must make the run incomplete-contact.

Model: each operation runs in its own thread as one "transaction" on one fake
backend pid. Its statements are declared per op kind. A statement with a
``lock`` key takes an exclusive row lock held until commit (like SELECT ... FOR
UPDATE); a second holder WAITS, and ``sample_waits`` reports it as the lock view
would. Values live in a dict ``rows``. The generic pause points are
``<kind>.begin``, ``<kind>.stmt.<label>.before`` / ``.after``,
``<kind>.before_commit`` and ``<kind>.after_commit``.
"""
from __future__ import annotations

from dataclasses import dataclass
import itertools
import queue
import threading
import time
from typing import Any, Callable

from .trace import SCHEMA


@dataclass(frozen=True)
class Stmt:
    label: str
    relations: tuple[str, ...]
    mode: str
    #: exclusive row lock key taken by this statement (None: no lock)
    lock: "str | None" = None
    #: (rows, ctx, args) -> None: the statement's effect on the fake rows
    apply: "Callable[[dict, dict, dict], None] | None" = None
    #: a control that, when switched on, makes this statement skip its lock
    skip_lock_control: "str | None" = None


class _Stream:
    def __init__(self, name: str) -> None:
        self.name = name
        self._seq = itertools.count(1)
        self.records: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def emit(self, kind: str, **fields: Any) -> dict[str, Any]:
        with self._lock:
            rec = {"schema": SCHEMA, "stream": self.name, "seq": next(self._seq),
                   "mono_ns": time.monotonic_ns(), "kind": kind, **fields}
            self.records.append(rec)
            return rec


class FakeExecutor:
    def __init__(self, op_kinds: dict[str, list[Stmt]], *, qualification: bool = True,
                 barriers: bool = True, controls: "set[str] | None" = None,
                 silent_controls: bool = False, unclean_tail: bool = False,
                 drop_records: int = 0, run_id: str = "fake-run") -> None:
        self.op_kinds = op_kinds
        self.qualification = qualification
        self.barriers = barriers
        self.controls = set(controls or ())
        self.silent_controls = silent_controls
        self.unclean_tail = unclean_tail
        self.drop_records = drop_records
        self.run_id = run_id
        self.rows: dict[str, Any] = {}
        self.stream = _Stream("fake-executor")
        self._events: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self._plan: dict[tuple[str, str], dict[str, Any]] = {}
        self._gates: dict[tuple[str, str], threading.Event] = {}
        self._locks: dict[str, int] = {}          # lock key -> holder pid
        self._waiting: dict[int, tuple[int, str]] = {}  # waiter pid -> (holder pid, key)
        self._cv = threading.Condition()
        self._pids = itertools.count(40001)
        self._threads: list[threading.Thread] = []
        self._rows_lock = threading.Lock()

    # -- the contract -------------------------------------------------------
    def points(self) -> list[str]:
        out = []
        for kind, stmts in self.op_kinds.items():
            out += [f"{kind}.begin", f"{kind}.before_commit", f"{kind}.after_commit"]
            for s in stmts:
                out += [f"{kind}.stmt.{s.label}.before", f"{kind}.stmt.{s.label}.after"]
        return out

    def handshake(self) -> dict[str, Any]:
        return {"qualification": self.qualification, "build": "fake",
                "points": self.points() if self.qualification else [],
                "controls": sorted(self.controls)}

    def install_plan(self, plan: list[dict[str, Any]]) -> None:
        for p in plan:
            key = (p["op_tag"], p["point"])
            self._plan[key] = p
            self._gates[key] = threading.Event()

    def start(self, tag: str, op_kind: str, args: dict[str, Any]) -> None:
        t = threading.Thread(target=self._run, args=(tag, op_kind, args), daemon=True)
        self._threads.append(t)
        t.start()

    def next_event(self, timeout: float) -> "dict[str, Any] | None":
        try:
            return self._events.get(timeout=timeout)
        except queue.Empty:
            return None

    def release(self, tag: str, point: str) -> None:
        gate = self._gates.get((tag, point))
        if gate is not None:
            gate.set()
        self.stream.emit("release", point=point, op_tag=tag)

    def sample_waits(self) -> list[dict[str, Any]]:
        with self._cv:
            return [{"waiter_pid": w, "holder_pid": h, "relation": key, "mode": "exclusive"}
                    for w, (h, key) in self._waiting.items()]

    def finish(self, timeout: float = 2.0) -> dict[str, Any]:
        for gate in self._gates.values():   # never leave a thread parked
            gate.set()
        for t in self._threads:
            t.join(timeout)
        records = list(self.stream.records)
        if self.drop_records:
            self.stream.emit("drop", count=self.drop_records)
        end = self.stream.emit("stream_end", last_seq=0, clean=not self.unclean_tail)
        end["last_seq"] = end["seq"]
        records = list(self.stream.records)
        events = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except queue.Empty:
                break
        return {"records": records, "streams": [self.stream.name], "events": events,
                "rows": dict(self.rows)}

    # -- one operation --------------------------------------------------------
    def _point(self, tag: str, op_id: str, attempt: int, pid: int, point: str) -> None:
        if not self.barriers:
            return
        plan = self._plan.get((tag, point))
        if plan is None or plan.get("action") != "hold":
            return
        rec = self.stream.emit("arrived", point=point, op_tag=tag, operation_id=op_id,
                               attempt=attempt, backend_pid=pid)
        self._events.put(rec)
        self._gates[(tag, point)].wait(timeout=float(plan.get("timeout_s", 5.0)) + 5.0)

    def _take(self, key: str, pid: int) -> None:
        with self._cv:
            while self._locks.get(key) not in (None, pid):
                self._waiting[pid] = (self._locks[key], key)
                self._cv.wait(timeout=0.05)
            self._waiting.pop(pid, None)
            self._locks[key] = pid

    def _release_all(self, pid: int) -> None:
        with self._cv:
            for k in [k for k, h in self._locks.items() if h == pid]:
                del self._locks[k]
            self._cv.notify_all()

    def _run(self, tag: str, kind: str, args: dict[str, Any]) -> None:
        op_id = f"op-{tag}"
        pid = next(self._pids)
        attempt = 1
        emit = self.stream.emit
        begin = emit("op_begin", run_id=self.run_id, operation_id=op_id, attempt=attempt,
                     op_kind=kind, op_tag=tag, backend_pid=pid)
        self._events.put(begin)
        emit("tx_begin", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}",
             backend_pid=pid, isolation="fake", factory="fake-pool")
        self._point(tag, op_id, attempt, pid, f"{kind}.begin")
        ctx: dict[str, Any] = {}
        for s in self.op_kinds[kind]:
            self._point(tag, op_id, attempt, pid, f"{kind}.stmt.{s.label}.before")
            if s.lock:
                if s.skip_lock_control and s.skip_lock_control in self.controls:
                    if not self.silent_controls:
                        emit("control_executed", control_id=s.skip_lock_control,
                             operation_id=op_id, op_tag=tag)
                else:
                    self._take(s.lock, pid)
            if s.apply:
                with self._rows_lock:
                    s.apply(self.rows, ctx, args)
            emit("stmt", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}", backend_pid=pid,
                 stmt_label=s.label, fingerprint=f"fake:{kind}:{s.label}", mode=s.mode,
                 relations=list(s.relations), sqlstate="00000")
            self._point(tag, op_id, attempt, pid, f"{kind}.stmt.{s.label}.after")
        self._point(tag, op_id, attempt, pid, f"{kind}.before_commit")
        self._release_all(pid)
        emit("tx_end", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}", backend_pid=pid,
             outcome="commit", sqlstate="00000")
        self._point(tag, op_id, attempt, pid, f"{kind}.after_commit")
        end = emit("op_end", operation_id=op_id, attempt=attempt, outcome="commit",
                   contacts=len(self.op_kinds[kind]), op_tag=tag)
        self._events.put(end)
