"""Forced-interleaving schedules: the plan, the driver, the ACHIEVED order and the verdict.

r7 §8.1: "A pass of the form 'no waits', 'no aborts' or 'no violation' proves
nothing unless the transactions actually overlapped. Every concurrency schedule
forces its interleaving with barriers or pauses at named statements, runs each
order it names, and records the interleaving it achieved ... A run whose
recorded interleaving is not the one intended is a failed run, not a pass."

The harness talks to an executor through the pause-point contract (WS7 design
§1). The executor side is anything implementing ``Channel``: the native
store-service's harness channel, or ``fake_executor.FakeExecutor`` for testing
the harness itself.

Event names used in scripts and intended orders:
- ``arrived:<tag>:<point>``: operation ``tag`` reached pause point ``point`` and
  is held there;
- ``released:<tag>:<point>``: the harness released it;
- ``wait:<waiter>:<holder>``: OBSERVED (sampled from the database's lock view) that
  ``waiter``'s backend was waiting on ``holder``'s;
- ``end:<tag>``: the operation finished (its outcome is in the trace).
Each observed event gets the harness's own monotone sequence number, in the
order the harness observed it. That order is the achieved order.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Any, Callable, Protocol

from .protocol import frame_errors, plan_against_handshake
from .trace import stream_health

PASSED, FAILED, REFUSED = "PASSED", "FAILED", "REFUSED"


class Channel(Protocol):
    def handshake(self) -> dict[str, Any]: ...
    def install_plan(self, plan: dict[str, Any]) -> None: ...
    def start(self, tag: str, op_kind: str, args: dict[str, Any]) -> None: ...
    def next_event(self, timeout: float) -> "dict[str, Any] | None": ...
    def release(self, tag: str, point: str) -> None: ...
    def sample_waits(self) -> list[dict[str, Any]]: ...
    def finish(self) -> dict[str, Any]: ...


@dataclass
class Order:
    """One order a schedule names: the script that forces it, and what it must achieve."""
    name: str
    #: steps: ("start", tag) | ("arrive", tag, point) | ("release", tag, point)
    #:        | ("await_wait", waiter, holder) | ("await_end", tag)
    script: list[tuple[str, ...]]
    #: constraints: ("before", event_a, event_b) | ("present", event)
    #:              | ("absent", event) | ("outcome", tag, outcome)
    #:              | ("sqlstate", tag, code)
    intended: list[tuple[str, ...]]
    #: unsafe controls this order ARMS through the plan (``<schedule>.<variant>``);
    #: empty for a safe-build order
    controls: list[str] = field(default_factory=list)
    #: non-hold executor actions at points (protocol holds with action fail_next,
    #: drop_conn or sleep), e.g. {"op_tag": "A", "point": ..., "action": "fail_next",
    #: "sqlstate": "40001"}
    faults: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Schedule:
    schedule_id: str
    #: tag -> (op_kind, args)
    ops: dict[str, tuple[str, dict[str, Any]]]
    orders: list[Order]
    #: (records, achieved, final) -> True when the schedule's PASS condition holds.
    #: ``final`` is what the channel's ``finish()`` returned (for example the state
    #: read back after the run); the verdict is read from observations, not inferred
    pass_condition: Callable[[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]], bool]
    #: seconds to wait for any one expected event before the run fails
    step_timeout: float = 5.0
    plan_timeout: float = 5.0
    notes: str = ""


@dataclass
class RunResult:
    schedule_id: str
    order: str
    verdict: str
    reasons: list[str]
    achieved: list[dict[str, Any]]
    records: list[dict[str, Any]]
    health: dict[str, Any]
    pass_condition_held: "bool | None"
    handshake: dict[str, Any] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {"schedule": self.schedule_id, "order": self.order, "verdict": self.verdict,
                "reasons": self.reasons, "pass_condition_held": self.pass_condition_held,
                "achieved": [e["event"] for e in self.achieved],
                "complete_contact": self.health.get("complete")}


def _plan_for(schedule_id: str, order: Order, timeout: float) -> dict[str, Any]:
    """The protocol ``plan`` frame: every point the script waits at is a HOLD, plus
    the order's fault actions and the controls it arms."""
    ms = max(1, int(timeout * 1000))
    holds = [{"op_tag": step[1], "point": step[2], "action": "hold", "timeout_ms": ms}
             for step in order.script if step[0] == "arrive"]
    holds += [{"timeout_ms": ms, **f} for f in order.faults]
    return {"type": "plan", "run_id": f"{schedule_id}/{order.name}", "holds": holds,
            "controls": list(order.controls)}


class _Recorder:
    """Keeps the achieved order: every event the harness observes, in its own sequence."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self._seen: set[str] = set()
        self.pids: dict[int, str] = {}

    def add(self, name: str, **detail: Any) -> None:
        if name in self._seen:
            return
        self._seen.add(name)
        self.events.append({"hseq": len(self.events) + 1, "event": name,
                            "mono_ns": time.monotonic_ns(), **detail})

    def has(self, name: str) -> bool:
        return name in self._seen

    def position(self, name: str) -> "int | None":
        for e in self.events:
            if e["event"] == name:
                return e["hseq"]
        return None


def _absorb(recorder: _Recorder, event: dict[str, Any]) -> None:
    kind = event.get("kind")
    if kind == "arrived":
        if isinstance(event.get("backend_pid"), int):
            recorder.pids[event["backend_pid"]] = event["op_tag"]
        recorder.add(f"arrived:{event['op_tag']}:{event['point']}",
                     backend_pid=event.get("backend_pid"), attempt=event.get("attempt"))
    elif kind == "op_begin":
        if isinstance(event.get("backend_pid"), int):
            recorder.pids[event["backend_pid"]] = event["op_tag"]
    elif kind == "op_end":
        recorder.add(f"end:{event['op_tag']}", outcome=event.get("outcome"))


def _sample(channel: Channel, recorder: _Recorder) -> None:
    for w in channel.sample_waits():
        waiter = recorder.pids.get(w.get("waiter_pid"))
        holder = recorder.pids.get(w.get("holder_pid"))
        if waiter and holder:
            recorder.add(f"wait:{waiter}:{holder}", relation=w.get("relation"),
                         mode=w.get("mode"))


def _await(channel: Channel, recorder: _Recorder, name: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while not recorder.has(name):
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        event = channel.next_event(min(left, 0.02))
        if event is not None:
            _absorb(recorder, event)
        _sample(channel, recorder)
    return True


def compare(intended: list[tuple[str, ...]], achieved: list[dict[str, Any]],
            records: list[dict[str, Any]]) -> list[str]:
    """Every way the achieved interleaving differs from the intended one."""
    pos = {e["event"]: e["hseq"] for e in achieved}
    outcomes = {e["event"][len("end:"):]: e.get("outcome") for e in achieved
                if e["event"].startswith("end:")}
    tag_of = {r.get("operation_id"): r.get("op_tag") for r in records if r.get("kind") == "op_begin"}
    problems = []
    for c in intended:
        if c[0] == "before":
            a, b = pos.get(c[1]), pos.get(c[2])
            if a is None or b is None:
                missing = [x for x, p in ((c[1], a), (c[2], b)) if p is None]
                problems.append(f"interleaving not achieved: {', '.join(missing)} never observed")
            elif not a < b:
                problems.append(f"interleaving not achieved: {c[1]} was not before {c[2]}")
        elif c[0] == "present":
            if c[1] not in pos:
                problems.append(f"interleaving not achieved: {c[1]} never observed")
        elif c[0] == "absent":
            if c[1] in pos:
                problems.append(f"interleaving not achieved: {c[1]} observed but must not be")
        elif c[0] == "outcome":
            if outcomes.get(c[1]) != c[2]:
                problems.append(f"{c[1]} ended {outcomes.get(c[1])!r}, intended {c[2]!r}")
        elif c[0] == "sqlstate":
            seen = {r.get("sqlstate") for r in records
                    if tag_of.get(r.get("operation_id")) == c[1] and r.get("kind") in (
                        "stmt", "tx_end", "retry")}
            if c[2] not in seen:
                problems.append(f"{c[1]} never saw SQLSTATE {c[2]}")
        else:
            problems.append(f"unknown intended-order constraint {c[0]!r}")
    return problems


def run_order(channel: Channel, schedule: Schedule, order: Order) -> RunResult:
    """Drive one order of one schedule and judge it. Never returns PASSED on a guess."""
    recorder = _Recorder()
    hs = channel.handshake()
    plan = _plan_for(schedule.schedule_id, order, schedule.plan_timeout)
    reasons = [f"invalid plan: {e}" for e in frame_errors(plan)]
    reasons += plan_against_handshake(plan, hs)
    if reasons:
        return RunResult(schedule.schedule_id, order.name, REFUSED, reasons, [], [],
                         {"complete": False, "problems": ["not run"]}, None, hs)
    channel.install_plan(plan)
    for step in order.script:
        op = step[0]
        if op == "start":
            kind, args = schedule.ops[step[1]]
            channel.start(step[1], kind, args)
        elif op == "arrive":
            name = f"arrived:{step[1]}:{step[2]}"
            if not _await(channel, recorder, name, schedule.step_timeout):
                reasons.append(f"interleaving not achieved: {step[1]} never reached {step[2]}")
                break
        elif op == "release":
            channel.release(step[1], step[2])
            recorder.add(f"released:{step[1]}:{step[2]}")
        elif op == "await_wait":
            name = f"wait:{step[1]}:{step[2]}"
            if not _await(channel, recorder, name, schedule.step_timeout):
                reasons.append(f"interleaving not achieved: {step[1]} was never seen "
                               f"waiting on {step[2]}")
                break
        elif op == "await_end":
            if not _await(channel, recorder, f"end:{step[1]}", schedule.step_timeout):
                reasons.append(f"interleaving not achieved: {step[1]} never ended")
                break
        else:
            reasons.append(f"unknown script step {op!r}")
            break
    final = channel.finish()
    for event in final.get("events", []):
        _absorb(recorder, event)
    records = final.get("records", [])
    health = stream_health(records, final.get("streams", []))
    if not reasons:
        reasons += compare(order.intended, recorder.events, records)
    if not health["complete"]:
        reasons.append("incomplete-contact run: " + "; ".join(health["problems"][:3]))
    held = None
    if not reasons:
        held = bool(schedule.pass_condition(records, recorder.events, final))
        if not held:
            reasons.append("the schedule's pass condition failed")
    verdict = PASSED if not reasons else FAILED
    return RunResult(schedule.schedule_id, order.name, verdict, reasons, recorder.events,
                     records, health, held, hs)
