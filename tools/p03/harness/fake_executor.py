"""An in-process FAKE executor that speaks the harness protocol (``protocol.py``).

Test scaffolding for the harness, NEVER product evidence: it has no SQL, no
PostgreSQL and no isolation levels. It exists so the harness's own verdict
logic is exercised, including its meta-controls, before the native executor
lands:

- a build without qualification points is refused;
- a removed barrier (``barriers=False``) must turn a schedule into FAILED
  ("interleaving not achieved"), never PASSED;
- a control armed WITHOUT its executed record (``silent_controls``) must be a
  FAILED control;
- an unflushed stream tail (``unclean_tail``) or a dropped record
  (``drop_records``) must make the run incomplete-contact.

Model: each operation runs in its own thread as one "transaction" on one fake
backend pid. Its statements are declared per op kind. A statement with a
``lock`` key takes an exclusive row lock held until commit (like SELECT ... FOR
UPDATE); a second holder WAITS, and ``sample_waits`` reports it as the lock view
would. Values live in a dict ``rows``, updated only at commit from the
operation's write set, so a rolled-back attempt leaves nothing. Points follow
the protocol's generic set (``protocol.GENERIC_POINTS``) plus
``stmt.<label>.before``/``.after``. Actions: ``hold``, ``fail_next`` (the next
statement fails with that SQLSTATE; 40001/40P01 are retried as a new attempt,
anything else ends the operation in ``error``), ``drop_conn`` (the outcome is
``unknown``) and ``sleep``. A control fires only if the run's plan ARMS it.
"""
from __future__ import annotations

from dataclasses import dataclass
import itertools
import queue
import threading
import time
from typing import Any, Callable

from .protocol import GENERIC_POINTS, PROTOCOL, frame_errors, generic_points
from .trace import SCHEMA

RETRYABLE = ("40001", "40P01")
MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class Stmt:
    label: str
    relations: tuple[str, ...]
    mode: str
    #: exclusive row lock key taken by this statement (None: no lock)
    lock: "str | None" = None
    #: (rows, ctx, writes, args) -> None: reads ``rows``, stages writes in ``writes``
    apply: "Callable[[dict, dict, dict, dict], None] | None" = None
    #: a control id (``<schedule>.<variant>``) that, when armed, skips the lock
    skip_lock_control: "str | None" = None
    #: the row-lock mode the statement's lock is (``for_update``, ``for_share``, ...)
    lock_mode: "str | None" = None


class _Stream:
    def __init__(self, name: str) -> None:
        self.name = name
        self._seq = itertools.count(1)
        self.records: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def emit(self, kind: str, **fields: Any) -> dict[str, Any]:
        with self._lock:
            seq = next(self._seq)
            if kind == "stream_end":
                fields["last_seq"] = seq
            rec = {"schema": SCHEMA, "stream": self.name, "seq": seq,
                   "mono_ns": time.monotonic_ns(), "kind": kind, **fields}
            self.records.append(rec)
            return rec


class _Abort(Exception):
    def __init__(self, sqlstate: str, outcome: str = "rollback") -> None:
        super().__init__(sqlstate)
        self.sqlstate, self.outcome = sqlstate, outcome


class FakeExecutor:
    def __init__(self, op_kinds: dict[str, list[Stmt]], *, qualification: bool = True,
                 barriers: bool = True, silent_controls: bool = False,
                 unclean_tail: bool = False, drop_records: int = 0,
                 declared: "dict[str, Any] | None" = None,
                 server_extra: "dict[str, dict[str, int]] | None" = None,
                 hidden_statements: int = 0, skip_stmts: "set[str] | None" = None,
                 factory: str = "fake-pool") -> None:
        """Fault options for the Q-C5 oracle's meta-controls:
        ``server_extra``: relation -> pg_stat_xact_user_tables counters the SERVER
        reports for every transaction but no statement names (a trigger);
        ``hidden_statements``: transactions run on the first backend outside any
        traced operation (a pooled connection used behind the trace's back);
        ``skip_stmts``: statement labels silently not executed (a deleted anchor);
        ``factory``: the factory name the backends report as having opened them."""
        self.op_kinds = op_kinds
        self.qualification = qualification
        self.barriers = barriers
        self.silent_controls = silent_controls
        self.unclean_tail = unclean_tail
        self.drop_records = drop_records
        self.declared = declared if declared is not None else self.derived_declared()
        self.server_extra = dict(server_extra or {})
        self.hidden_statements = hidden_statements
        self.skip_stmts = set(skip_stmts or ())
        self.factory = factory
        self.rows: dict[str, Any] = {}
        self.stream = _Stream("fake-executor")
        self._events: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self._holds: dict[tuple[str, str], dict[str, Any]] = {}
        self._gates: dict[tuple[str, str], threading.Event] = {}
        self._armed: set[str] = set()
        self._run_id = ""
        self._locks: dict[str, int] = {}                 # lock key -> holder pid
        self._waiting: dict[int, tuple[int, str]] = {}   # waiter pid -> (holder pid, key)
        self._cv = threading.Condition()
        self._pids = itertools.count(40001)
        self._threads: list[threading.Thread] = []
        self._rows_lock = threading.Lock()
        self._tx_count: dict[int, int] = {}              # backend pid -> transactions begun

    # -- the protocol ---------------------------------------------------------
    def points(self) -> list[str]:
        out: list[str] = []
        for kind, stmts in self.op_kinds.items():
            out += generic_points(kind, [s.label for s in stmts])
        return out

    def controls(self) -> list[str]:
        return sorted({s.skip_lock_control for stmts in self.op_kinds.values()
                       for s in stmts if s.skip_lock_control})

    def derived_declared(self) -> dict[str, Any]:
        """Every statement's relations and modes, all required: what this fake does."""
        out: dict[str, Any] = {}
        for kind, stmts in self.op_kinds.items():
            rels: dict[str, Any] = {}
            for s in stmts:
                for rel in s.relations:
                    r = rels.setdefault(rel, {"modes": [], "required": True})
                    for m in (s.mode, s.lock_mode):
                        if m and m not in r["modes"]:
                            r["modes"].append(m)
            out[kind] = {"relations": rels, "p01_contract": None, "source": "fake"}
        return out

    def handshake(self) -> dict[str, Any]:
        return {"type": "handshake", "protocol": PROTOCOL, "qualification": self.qualification,
                "build_sha": "fake", "points": self.points() if self.qualification else [],
                "controls": self.controls() if self.qualification else [],
                "declared": self.declared if self.qualification else {}}

    def install_plan(self, plan: dict[str, Any]) -> None:
        errors = frame_errors(plan)
        if errors:
            raise ValueError("; ".join(errors))
        self._run_id = plan["run_id"]
        self._armed = set(plan["controls"])
        for h in plan["holds"]:
            key = (h["op_tag"], h["point"])
            self._holds[key] = h
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
        # the server's own view of every backend: its transaction count
        for i, (pid, n) in enumerate(sorted(self._tx_count.items())):
            self.stream.emit("conn_activity", backend_pid=pid, factory=self.factory,
                             transactions=n + (self.hidden_statements if i == 0 else 0))
        if self.drop_records:
            self.stream.emit("drop", count=self.drop_records)
        self.stream.emit("stream_end", clean=not self.unclean_tail)
        events = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except queue.Empty:
                break
        return {"type": "finished", "records": list(self.stream.records),
                "streams": [self.stream.name], "events": events, "rows": dict(self.rows)}

    # -- one operation --------------------------------------------------------
    def _fire(self, control_id: "str | None", tag: str, op_id: str) -> bool:
        """``controls::fire``: true only for a control the plan armed; records it at the site."""
        if not control_id or control_id not in self._armed:
            return False
        if not self.silent_controls:
            self.stream.emit("control_executed", control_id=control_id, operation_id=op_id,
                             op_tag=tag)
        return True

    def _point(self, tag: str, op_id: str, attempt: int, pid: int, point: str,
               pending: dict[str, Any]) -> None:
        if not self.barriers:
            return
        h = self._holds.get((tag, point))
        if h is None:
            return
        action = h["action"]
        if action == "hold":
            rec = self.stream.emit("arrived", point=point, op_tag=tag, operation_id=op_id,
                                   attempt=attempt, backend_pid=pid, txid_if_assigned=None)
            self._events.put(rec)
            self._gates[(tag, point)].wait(timeout=h["timeout_ms"] / 1000 + 5.0)
        elif action == "fail_next" and attempt == 1:
            pending["sqlstate"] = h["sqlstate"]
        elif action == "drop_conn" and attempt == 1:
            raise _Abort("08006", outcome="unknown")
        elif action == "sleep":
            time.sleep(h["ms"] / 1000)

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

    def _attempt(self, tag: str, kind: str, args: dict[str, Any], op_id: str, pid: int,
                 attempt: int) -> None:
        emit = self.stream.emit
        pending: dict[str, Any] = {}
        point = lambda name: self._point(tag, op_id, attempt, pid, f"{kind}.{name}", pending)  # noqa: E731
        emit("tx_begin", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}",
             backend_pid=pid, isolation="fake", factory=self.factory)
        with self._rows_lock:
            self._tx_count[pid] = self._tx_count.get(pid, 0) + 1
        for name in GENERIC_POINTS[1:4]:        # begin, after_anchor, after_claim
            point(name)
        ctx: dict[str, Any] = {}
        writes: dict[str, Any] = {}
        server: dict[str, dict[str, int]] = {}
        for s in self.op_kinds[kind]:
            if s.label in self.skip_stmts:
                continue
            point(f"stmt.{s.label}.before")
            if s.lock and not self._fire(s.skip_lock_control, tag, op_id):
                self._take(s.lock, pid)
            code = pending.pop("sqlstate", "00000")
            if code == "00000" and s.apply:
                with self._rows_lock:
                    s.apply(self.rows, ctx, writes, args)
            emit("stmt", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}",
                 backend_pid=pid, stmt_label=s.label, fingerprint=f"fake:{kind}:{s.label}",
                 mode=s.mode, relations=list(s.relations), sqlstate=code,
                 lock_mode=s.lock_mode)
            if code != "00000":
                raise _Abort(code)
            for rel in s.relations:          # what the server's per-xact view would count
                t = server.setdefault(rel, {"relname": rel})
                key = "idx_scan" if s.mode == "read" else "n_tup_upd"
                t[key] = t.get(key, 0) + 1
            point(f"stmt.{s.label}.after")
        for rel, counters in self.server_extra.items():
            server.setdefault(rel, {"relname": rel}).update(counters)
        emit("xact_stats", operation_id=op_id, attempt=attempt, backend_pid=pid,
             tables=list(server.values()))
        point("before_commit")
        with self._rows_lock:
            self.rows.update(writes)
        self._release_all(pid)
        emit("tx_end", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}", backend_pid=pid,
             outcome="commit", sqlstate="00000")
        point("after_commit")
        point("before_effects")

    def _run(self, tag: str, kind: str, args: dict[str, Any]) -> None:
        op_id = f"op-{tag}"
        pid = next(self._pids)
        emit = self.stream.emit
        self._events.put(emit("op_begin", run_id=self._run_id, operation_id=op_id, attempt=1,
                              op_kind=kind, op_tag=tag, backend_pid=pid))
        self._point(tag, op_id, 1, pid, f"{kind}.admitted", {})
        outcome, attempt = "error", 1
        while attempt <= MAX_ATTEMPTS:
            try:
                self._attempt(tag, kind, args, op_id, pid, attempt)
                outcome = "commit"
                break
            except _Abort as abort:
                self._release_all(pid)
                emit("tx_end", operation_id=op_id, attempt=attempt, conn_id=f"c{pid}",
                     backend_pid=pid, outcome=abort.outcome, sqlstate=abort.sqlstate)
                if abort.sqlstate in RETRYABLE and attempt < MAX_ATTEMPTS:
                    emit("retry", operation_id=op_id, attempt=attempt + 1,
                         retry_cause="serialization" if abort.sqlstate == "40001" else "deadlock",
                         sqlstate=abort.sqlstate)
                    attempt += 1
                    continue
                outcome = abort.outcome if abort.outcome == "unknown" else "error"
                break
        self._events.put(emit("op_end", operation_id=op_id, attempt=attempt, outcome=outcome,
                              contacts=len(self.op_kinds[kind]), op_tag=tag))
