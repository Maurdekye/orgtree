"""The P03 harness channel protocol, ``orgtree.p03-harness/v1`` (owner: WS7).

Binding at M1 (M1-INTERFACE-CONTRACT.md §3, artifact r2 on
``p03-plan-private-service-and-narrow-prototype-on``). WS2 implements the
server side in the store service's qualification-only harness endpoint; WS7's
harness is the client. This module is the single definition of every frame:
both sides validate against it, and a frame that fails validation is refused,
never guessed at.

Transport: loopback TCP, length-prefixed JSON (4-byte big-endian unsigned
length, then that many bytes of UTF-8 JSON, one object per frame), as agreed for
the main channel (M1 §2 row 4). The first frame from the harness is ``hello``
with the per-run token; the service answers ``handshake`` or closes.

Harness -> service:
- ``hello``   {token, protocol}
- ``plan``    {run_id, holds: [Hold...], controls: [control id...]}
              A hold names ONE (op_tag, point) and ONE action. ``controls`` ARMS
              those unsafe controls for this run only: ``controls::fire(id)``
              returns true only for an armed id (and then emits
              ``control_executed`` at its site).
- ``release`` {op_tag, point}
- ``finish``  {}  : drain and end every trace stream; the service answers ``finished``.

Service -> harness:
- ``handshake`` {protocol, qualification, build_sha, points: [...], controls: [...]}
- ``arrived``   {point, op_tag, operation_id, attempt, backend_pid, txid_if_assigned, seq}
- ``trace``     {records: [trace record...]}   (orgtree.p03-trace/v1, see trace.py)
- ``finished``  {streams: [stream name...], records: [...]}
- ``error``     {detail}

Actions (WS2's ``HookAction``): ``hold`` (block until ``release``),
``fail_next`` (the next statement fails with ``sqlstate``, as if the server
had raised it), ``drop_conn`` (close the socket without COMMIT or ROLLBACK),
``sleep`` (``ms``). ``kill_backend`` is NOT an executor action: the harness
itself calls ``pg_terminate_backend(backend_pid)`` on the pid an ``arrived``
frame reported (M1 §3), so a hold precedes it.

Point names: ``<family>.<verb>.<point>``; every operation has the generic points
in ``GENERIC_POINTS`` plus ``stmt.<label>.before`` / ``.after``. Control ids:
``<schedule>.<variant>`` (e.g. ``Q-ST4.probe_outside_txn``).
"""
from __future__ import annotations

import json
import re
import struct
from typing import Any

PROTOCOL = "orgtree.p03-harness/v1"
GENERIC_POINTS = ("admitted", "begin", "after_anchor", "after_claim", "before_commit",
                  "after_commit", "before_effects")
RECEIPT_LOOKUP_POINTS = ("receipt.lookup.after_inflight_check", "receipt.lookup.before_fence")
ACTIONS = ("hold", "fail_next", "drop_conn", "sleep")
HARNESS_ONLY_ACTIONS = ("kill_backend",)
MAX_FRAME = 16 * 1024 * 1024

POINT_RE = re.compile(r"^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$")
CONTROL_RE = re.compile(r"^Q-[A-Z]+[0-9]+[a-z]?\.[a-z0-9_]+$")
SQLSTATE_RE = re.compile(r"^[0-9A-Z]{5}$")

#: frame type -> (required fields, direction)
FRAMES: dict[str, tuple[tuple[str, ...], str]] = {
    "hello": (("token", "protocol"), "to_service"),
    "plan": (("run_id", "holds", "controls"), "to_service"),
    "release": (("op_tag", "point"), "to_service"),
    "finish": ((), "to_service"),
    "handshake": (("protocol", "qualification", "build_sha", "points", "controls"), "to_harness"),
    "arrived": (("point", "op_tag", "operation_id", "attempt", "backend_pid",
                 "txid_if_assigned", "seq"), "to_harness"),
    "trace": (("records",), "to_harness"),
    "finished": (("streams", "records"), "to_harness"),
    "error": (("detail",), "to_harness"),
}


def generic_points(family_verb: str, stmt_labels: "tuple[str, ...] | list[str]" = ()) -> list[str]:
    """Every generic point of one operation, e.g. ``staffing.hire``."""
    out = [f"{family_verb}.{p}" for p in GENERIC_POINTS]
    for label in stmt_labels:
        out += [f"{family_verb}.stmt.{label}.before", f"{family_verb}.stmt.{label}.after"]
    return out


def hold_errors(h: Any) -> list[str]:
    if not isinstance(h, dict):
        return ["hold is not an object"]
    errors = [f"hold: missing {f}" for f in ("op_tag", "point", "action", "timeout_ms") if f not in h]
    action = h.get("action")
    if action in HARNESS_ONLY_ACTIONS:
        errors.append(f"hold: {action} is done by the harness, not the executor")
    elif action not in ACTIONS:
        errors.append(f"hold: unknown action {action!r}")
    if not isinstance(h.get("op_tag"), str) or not h.get("op_tag"):
        errors.append("hold: op_tag must be a non-empty string")
    if not isinstance(h.get("point"), str) or not POINT_RE.match(h.get("point") or ""):
        errors.append(f"hold: bad point name {h.get('point')!r}")
    if not isinstance(h.get("timeout_ms"), int) or h.get("timeout_ms", 0) <= 0:
        errors.append("hold: timeout_ms must be a positive integer")
    if action == "fail_next" and not SQLSTATE_RE.match(str(h.get("sqlstate", ""))):
        errors.append("hold: fail_next needs a five-character sqlstate")
    if action == "sleep" and (not isinstance(h.get("ms"), int) or h.get("ms", 0) <= 0):
        errors.append("hold: sleep needs a positive integer ms")
    return errors


def frame_errors(frame: Any) -> list[str]:
    """Everything wrong with one frame's shape. Empty list: valid."""
    if not isinstance(frame, dict):
        return ["frame is not a JSON object"]
    kind = frame.get("type")
    if kind not in FRAMES:
        return [f"unknown frame type {kind!r}"]
    required, _direction = FRAMES[kind]
    errors = [f"{kind}: missing {f}" for f in required if f not in frame]
    if kind in ("hello", "handshake") and frame.get("protocol") != PROTOCOL:
        errors.append(f"{kind}: protocol {frame.get('protocol')!r} is not {PROTOCOL}")
    if kind == "handshake" and not isinstance(frame.get("qualification"), bool):
        errors.append("handshake: qualification must be true or false")
    if kind == "plan":
        holds = frame.get("holds")
        if not isinstance(holds, list):
            errors.append("plan: holds must be a list")
        else:
            seen = set()
            for h in holds:
                errors += hold_errors(h)
                key = (h.get("op_tag"), h.get("point")) if isinstance(h, dict) else None
                if key in seen:
                    errors.append(f"plan: two holds for {key}")
                seen.add(key)
        controls = frame.get("controls")
        if not isinstance(controls, list) or not all(
                isinstance(c, str) and CONTROL_RE.match(c) for c in controls):
            errors.append("plan: controls must be a list of <schedule>.<variant> ids")
    if kind == "arrived" and not isinstance(frame.get("backend_pid"), int):
        errors.append("arrived: backend_pid must be an integer")
    return errors


def plan_against_handshake(plan: dict[str, Any], handshake: dict[str, Any]) -> list[str]:
    """What a valid plan asks that this build cannot do. Non-empty: refuse the run."""
    errors = []
    if handshake.get("qualification") is not True:
        errors.append("the build reports no qualification pause points: refusing to drive it")
    points = set(handshake.get("points") or ())
    unknown = sorted({h["point"] for h in plan.get("holds", [])} - points)
    if unknown:
        errors.append(f"the plan names pause points the build does not have: {unknown}")
    controls = set(handshake.get("controls") or ())
    missing = sorted(set(plan.get("controls", [])) - controls)
    if missing:
        errors.append(f"the plan arms controls the build does not have: {missing}")
    return errors


def encode(frame: dict[str, Any]) -> bytes:
    errors = frame_errors(frame)
    if errors:
        raise ValueError("; ".join(errors))
    body = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise ValueError(f"frame of {len(body)} bytes exceeds {MAX_FRAME}")
    return struct.pack(">I", len(body)) + body


def decode(buffer: bytes) -> "tuple[dict[str, Any] | None, bytes]":
    """One frame from the front of ``buffer``: (frame, rest), or (None, buffer) if incomplete."""
    if len(buffer) < 4:
        return None, buffer
    (n,) = struct.unpack(">I", buffer[:4])
    if n > MAX_FRAME:
        raise ValueError(f"frame length {n} exceeds {MAX_FRAME}")
    if len(buffer) < 4 + n:
        return None, buffer
    frame = json.loads(buffer[4:4 + n].decode("utf-8"))
    errors = frame_errors(frame)
    if errors:
        raise ValueError("; ".join(errors))
    return frame, buffer[4 + n:]
