"""Conservative workaround for agy's historical LastRunErrorDetails lookup.

Only a resumed conversation, captured BEFORE launch, can supply evidence.
Missing/unsupported evidence preserves the CLI failure. No credentials or
conversation writes. Field numbers come from agy 1.1.27's embedded descriptors.

EVERY OUTCOME IS SAID OUT LOUD, content-free. The first production turn this
ran on (2026-09-07 11:28Z) declined silently and cost a 7018 s wall before
anyone could tell WHICH predicate said no: every decline was a bare
`return None` and capture() swallowed five exception types. So capture() and
reconcile() each emit exactly ONE line per turn through `_emit` (stderr, which
the launcher retains as backend.err.log; ASCII only, see api.py's cp1252
note): the outcome, a reason code, and step indices / counts. Never a prompt,
a response, an error text or anything from the conversation. One line per
turn is the whole budget; nothing is logged per wire event.

THE ONE TOLERANCE, measured not assumed: the installed CLI streams the final
response with exactly one trailing "\n" that it does not store (39 of 39
retained turns in one conversation: wire == stored + "\n", never wire ==
stored; redteam-opus, 2026-09-07). reconcile() therefore accepts the wire
text when it equals the stored body OR the stored body plus exactly one
"\n" - and nothing else. No rstrip, no strip: two newlines, a leading
newline, "\r\n", a trailing space or any other single-byte difference still
decline, and the suite proves each of those.

TWO SHAPES OF AN ORDINARY TURN, admitted 2026-09-07 after the 13:56Z decline
(redteam-opus, from the retained conversation and the retained journal):

  A FAILED TOOL CALL IS NOT A FAILED TURN. Stored: type 132, status 7, with
  error_details and NO RunError. On the wire: step_update{step_type:"tool",
  state:"ERROR"} - the state vocabulary is ACTIVE|DONE|ERROR (antigravityrun's
  header, from measured probes), antigravityrun._fold and supervisor.py both
  already branch on it, and this turn's journal holds three such records
  (13:52:52.345Z, 13:53:22.947Z, 13:55:37.939Z) whose store rows are
  5173/5181/5216. 45 of 2476 tool results in that one conversation are errors.
  The old rule - every appended row must be status 3 with empty error_details
  - had this exactly backwards: it rejected these healthy turns, and it would
  NOT have caught a real quota error, which is itself stored status 3. What
  actually separates the two is the RunError (payload field 24), which is now
  checked first and unconditionally.

  A COMPACTION SUMMARY (stored type 23) is written mid-turn once a turn grows
  long enough; it is status 3, carries no error and no RunError, and points at
  the previous summary and the turn's own user step. No wire step_update has
  ever been observed for one, so 23 is admitted in the store and deliberately
  left out of WIRE_TYPE: if the CLI ever does emit one, it declines by name
  rather than raising KeyError.

Neither relaxation touches identity, the prompt match, the historical match,
completeness or the final-response checks. A quota error inside the interval
still declines, twice over: `step_run_error` on the store side, and
`wire_nontool_error` if the wire reports it on a model step.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
from typing import Any

MAX_ROWS = 2048
MAX_ERRORS = 32
MAX_BLOB = 1_048_576
MAX_BYTES = 8_388_608
MAX_EVENTS = 16384
QUOTA = re.compile(r"Individual quota reached\.[^\r\n]{0,400}\Z")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
#: the CLI's own trailing newline on a streamed final response (see header)
WIRE_TAIL = b"\n"
#: stored step_type -> the `step_type` string the wire uses for it. The wire
#: vocabulary is user_input|agent_response|tool (antigravityrun's header, from
#: measured probes). 101 is kept as it was found. 23 (compaction) is
#: deliberately ABSENT: no wire step_update has ever been observed for one, so
#: an emitted 23 declines by name instead of raising KeyError.
WIRE_TYPE = {14: "user_input", 15: "agent_response", 132: "tool", 101: "system_message"}
#: the stored status of a tool step the CLI reported as ERROR on the wire
TOOL_FAILED = 7
#: bounds for the durable outcome record
MAX_RECORDS = 400
MAX_RECORD_BYTES = 262144
_record_lock = threading.Lock()


def _emit(line: str) -> None:
    """The retained channel: stderr -> backend.err.log. ASCII only."""
    try:
        print("[agy-provenance] " + line.encode("ascii", "replace").decode("ascii"),
              file=sys.stderr, flush=True)
    except Exception:                                            # noqa: BLE001
        pass


class _Decline(Exception):
    """A predicate said no. `reason` is a content-free code; `detail` holds
    only indices and counts - never text from the conversation or the wire."""

    def __init__(self, reason: str, **detail: Any):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


_SAFE = re.compile(r"[0-9,?]{0,64}\Z")


def _fmt(detail: dict[str, Any]) -> str:
    """Only validated numbers, this module's own index lists and '?' reach
    the line. A value that came from the store or the wire as anything else
    (a protobuf field of the wrong wire type, a text SQL column) is a
    marker, never the value: content-free means the bytes cannot leak
    through the diagnostic either."""
    def safe(v: Any) -> str:
        if isinstance(v, bool):
            return "?"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, str) and _SAFE.fullmatch(v):
            return v
        return "nonnumeric"
    return "".join(f" {k}={safe(v)}" for k, v in detail.items())


def _records_path() -> str:
    from . import providers                                     # lazy: no new import edge
    return os.path.join(providers.antigravity_probe_dir(), "provenance.ndjson")


def _rotate_records(path: str) -> None:
    """Keep the record bounded: one older generation, then drop."""
    if not os.path.exists(path):
        return
    if os.path.getsize(path) < MAX_RECORD_BYTES:
        with open(path, encoding="utf-8") as handle:
            if sum(1 for _ in handle) < MAX_RECORDS:
                return
    os.replace(path, path + ".1")


def _record(outcome: str, reason: str, detail: dict[str, Any]) -> None:
    """The SAME outcome as `_emit`, durably. stderr goes to backend.err.log,
    which the launcher truncates on every restart - that is precisely how the
    2026-09-07 13:56Z decline was lost before anyone could read it.

    BEST EFFORT AND LAST. Called only after the verdict is already decided,
    and every failure is swallowed here, so a full disk or a read-only root
    cannot change what reconcile() returns. Content-free: the values go
    through the same `safe()` filter as the log line, so nothing from the
    store or the wire can reach the file either."""
    try:
        row: dict[str, Any] = {"v": 1, "at": round(time.time(), 3),
                               "outcome": outcome, "reason": reason}
        for key, value in detail.items():
            if isinstance(value, bool) or not isinstance(value, int):
                # everything that is not a plain integer goes through the same
                # filter as the log line, so it lands as its own index list or
                # as a marker - never as bytes from the store or the wire
                text = _fmt({key: value}).strip()
                value = text.split("=", 1)[1] if "=" in text else "?"
            row[str(key)[:24]] = value
        line = json.dumps(row, ensure_ascii=True)
        if len(line) > 1024:                    # a line this long is a bug, not a record
            return
        path = _records_path()
        with _record_lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _rotate_records(path)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except Exception:                                            # noqa: BLE001
        pass


def read_records() -> list[dict[str, Any]]:
    """Every retained outcome, oldest first, across both generations."""
    out: list[dict[str, Any]] = []
    try:
        base = _records_path()
    except Exception:                                            # noqa: BLE001
        return out
    for path in (base + ".1", base):
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed: object = json.loads(line)
                    except ValueError:
                        continue              # a torn line, not a reason to stop
                    if isinstance(parsed, dict) and parsed.get("outcome"):
                        out.append({str(k): v for k, v in parsed.items()})  # type: ignore[misc]
        except OSError:
            pass
    return out


def _varint(b: bytes, pos: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        byte = b[pos]; pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError("invalid protobuf varint")


def _fields(b: bytes) -> dict[int, list[bytes | int]]:
    if len(b) > MAX_BLOB:
        raise ValueError("payload bound")
    result: dict[int, list[bytes | int]] = {}
    pos = 0
    while pos < len(b):
        tag, pos = _varint(b, pos)
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError("invalid field")
        if wire == 0:
            value, pos = _varint(b, pos)
        elif wire in (1, 2, 5):
            if wire == 2:
                size, pos = _varint(b, pos)
            else:
                size = 8 if wire == 1 else 4
            if pos + size > len(b):
                raise ValueError("truncated field")
            value = b[pos:pos + size]; pos += size
        else:
            raise ValueError("unsupported wire type")
        result.setdefault(number, []).append(value)
    return result


def _one(fields: dict[int, list[bytes | int]], key: int,
         default: bytes | int = b"") -> bytes | int:
    values = fields.get(key, [default])
    if len(values) != 1:
        raise ValueError("ambiguous scalar")
    return values[0]


def _blob(fields: dict[int, list[bytes | int]], key: int) -> bytes:
    value = _one(fields, key)
    if not isinstance(value, bytes):
        raise ValueError("not a message/string")
    return value


def conversation_path(cid: str, env: dict[str, str]) -> Path | None:
    if not UUID.fullmatch(cid):
        return None
    home = env.get("USERPROFILE" if os.name == "nt" else "HOME")
    if not home:
        return None
    return Path(home) / ".gemini/antigravity-cli/conversations" / (cid + ".db")


def _identity(path: Path) -> tuple[int, int]:
    stat = path.stat()
    if not path.is_file() or Path(str(path) + "-wal").exists() or Path(str(path) + "-journal").exists():
        raise ValueError("database not a stable standalone file")
    return stat.st_dev, stat.st_ino


class _Read:
    def __init__(self, path: Path, cid: str):
        self.path = path
        self.identity = _identity(path)
        self.before = path.stat()
        self.db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=.1)
        self.work = 0
        self.bytes = 0
        self.db.set_progress_handler(self._budget, 1000)
        try:
            rows = self.db.execute("SELECT cascade_id FROM trajectory_meta LIMIT 2").fetchall()
            if rows != [(cid,)]:
                raise ValueError("wrong conversation")
        except Exception:
            self.db.close()
            raise

    def _budget(self) -> int:
        self.work += 1000
        return int(self.work > 200_000)

    def close(self) -> None:
        self.db.close()
        after = self.path.stat()
        if (_identity(self.path) != self.identity or after.st_size != self.before.st_size
                or after.st_mtime_ns != self.before.st_mtime_ns):
            raise ValueError("database changed during read")

    def rows(self, suffix: str, args: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        # Reject oversized blobs before SQLite copies them into Python.
        sql = ("SELECT idx,step_type,status,step_format,"
               "length(metadata),length(error_details),length(step_payload),"
               "CASE WHEN length(metadata)<=? THEN metadata END,"
               "CASE WHEN length(error_details)<=? THEN error_details END,"
               "CASE WHEN length(step_payload)<=? THEN step_payload END FROM steps " + suffix)
        result = []
        for row in self.db.execute(sql, (MAX_BLOB, MAX_BLOB, MAX_BLOB, *args)):
            sizes = [v or 0 for v in row[4:7]]
            self.bytes += sum(sizes)
            if max(sizes) > MAX_BLOB or self.bytes > MAX_BYTES or len(result) >= MAX_ROWS:
                raise ValueError("read bound")
            if row[3] != 0 or row[9] is None:
                raise ValueError("unsupported step format")
            result.append((row[0], row[1], row[2], row[7] or b"", row[8] or b"", row[9]))
        return result


def _fingerprint(row: tuple[Any, ...]) -> str:
    digest = hashlib.sha256()
    for value in row:
        data = value if isinstance(value, bytes) else str(value).encode()
        digest.update(len(data).to_bytes(8, "little")); digest.update(data)
    return digest.hexdigest()


def _payload(row: tuple[Any, ...]) -> dict[int, list[bytes | int]]:
    payload = _fields(row[5])
    if _one(payload, 1, 0) != row[1] or _one(payload, 4, 0) != row[2]:
        raise ValueError("column/payload disagreement")
    return payload


def _quota_error(row: tuple[Any, ...]) -> str | None:
    if row[1] != 17:
        return None
    run_error = _fields(_blob(_payload(row), 24))
    details = _fields(_blob(run_error, 3))
    if _one(details, 4, 0) != 0:  # CortexErrorDetails.is_benign
        return None
    message = _blob(details, 1).decode("utf-8").strip()
    return message if QUOTA.fullmatch(message) else None


@dataclass(frozen=True)
class Boundary:
    path: Path
    cid: str
    identity: tuple[int, int]
    index: int
    fingerprint: str
    errors: tuple[tuple[int, str, str], ...]


def capture(cid: str | None, env: dict[str, str]) -> Boundary | None:
    """Best effort, before Popen: never fail a turn for unavailable evidence.
    Says once, content-free, whether evidence was captured and if not why."""
    reader = None
    try:
        if not cid:
            raise _Decline("no_conversation")
        if not UUID.fullmatch(cid):
            raise _Decline("unqualified_conversation")
        path = conversation_path(cid, env)
        if path is None:
            raise _Decline("no_home")
        if not path.is_file():
            raise _Decline("no_database")
        reader = _Read(path, cid or "")
        last = reader.rows("ORDER BY idx DESC LIMIT 1")
        if len(last) != 1:
            raise _Decline("empty_store")
        errors = []
        for row in reader.rows("WHERE step_type=17 ORDER BY idx DESC LIMIT ?", (MAX_ERRORS,)):
            message = _quota_error(row)
            if message:
                errors.append((row[0], message, _fingerprint(row)))
        boundary = Boundary(path, cid or "", reader.identity, last[0][0], _fingerprint(last[0]), tuple(errors))
        reader.close(); reader = None
        if not errors:
            raise _Decline("no_historical_quota_error", boundary=boundary.index)
        _emit(f"capture: captured boundary={boundary.index} historical_errors={len(errors)}"
              f" newest_error_step={errors[0][0]}")
        return boundary
    except _Decline as d:
        _emit(f"capture: none reason={d.reason}{_fmt(d.detail)}")
        return None
    except (OSError, sqlite3.Error, ValueError, IndexError, TypeError) as exc:
        _emit(f"capture: none reason=exception:{type(exc).__name__}")
        return None
    finally:
        if reader is not None:
            reader.db.close()


def reconcile(boundary: Boundary | None, prompt: str, cid: str | None,
              result: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return content-free correction evidence, or preserve the raw ERROR.
    Every decline names its predicate in one retained line (see header)."""
    reader = None
    try:
        if boundary is None:
            raise _Decline("no_boundary")
        if cid != boundary.cid or result.get("conversation_id") != cid:
            raise _Decline("conversation_mismatch")
        if result.get("status") != "ERROR":
            raise _Decline("result_not_error")
        if len(events) > MAX_EVENTS:
            raise _Decline("event_bound", events=len(events))
        error = result.get("error")
        if not isinstance(error, str) or not QUOTA.fullmatch(error.strip()):
            raise _Decline("error_not_quota")
        matches = [e for e in boundary.errors if e[1] == error.strip()]
        if not matches:
            raise _Decline("error_not_historical", historical_errors=len(boundary.errors))
        old_index, _, old_hash = matches[0]
        reader = _Read(boundary.path, boundary.cid)
        if reader.identity != boundary.identity:
            raise _Decline("database_replaced")
        last = reader.rows("WHERE idx=?", (boundary.index,))
        old = reader.rows("WHERE idx=?", (old_index,))
        if len(last) != 1 or _fingerprint(last[0]) != boundary.fingerprint:
            raise _Decline("boundary_changed", boundary=boundary.index)
        if len(old) != 1 or _fingerprint(old[0]) != old_hash:
            raise _Decline("historical_changed", historical=old_index)
        rows = reader.rows("WHERE idx>? ORDER BY idx LIMIT ?", (boundary.index, MAX_ROWS + 1))
        if len(rows) < 2:
            raise _Decline("interval_too_short", boundary=boundary.index, rows=len(rows))
        if rows[0][1] != 14:
            raise _Decline("first_not_user", boundary=boundary.index, first=rows[0][0])
        if [r[0] for r in rows] != list(range(boundary.index + 1, boundary.index + 1 + len(rows))):
            raise _Decline("noncontiguous", boundary=boundary.index, rows=len(rows), last=rows[-1][0])
        payloads = []
        for i, row in enumerate(rows):
            # 23 is the CLI's mid-turn compaction summary: status 3, no error,
            # no RunError, written between two ordinary steps whenever a turn
            # grows long enough (observed at 5200 and 4874 of the retained
            # conversation). Excluding it made every long turn uncorrectable.
            if row[1] not in (14, 15, 23, 101, 132):
                raise _Decline("step_type", step=row[0], step_type=row[1])
            if i and row[1] == 14:
                raise _Decline("second_user", step=row[0])
            payload = _payload(row)
            # THE DISCRIMINATOR, and it comes first: a current run error - the
            # thing a replayed historical one must never be confused with -
            # writes this field. The retained conversation carries exactly one
            # (idx 4555, type 17, STATUS 3, HTTP 429 in its details) and not
            # one row above it in 680.
            if payload.get(24):  # RunError oneof, independent of SQL step_type.
                raise _Decline("step_run_error", step=row[0])
            # A FAILED TOOL CALL IS NOT A FAILED TURN. It is stored status 7
            # with error_details and NO RunError (rejected just above), the CLI
            # reports it as step_update{step_type:"tool", state:"ERROR"}, and
            # the turn runs on - 45 of 2476 tool results in one conversation.
            # The old `status == 3` rule had this backwards: it rejected these
            # and would not have caught the real error, which is status 3.
            failed_tool = row[1] == 132 and row[2] == TOOL_FAILED
            if row[2] != 3 and not failed_tool:
                raise _Decline("step_status", step=row[0], status=row[2])
            if row[4] and not failed_tool:
                raise _Decline("step_error_details", step=row[0])
            payloads.append(payload)
        user = _fields(_blob(payloads[0], 19))
        if _blob(user, 2).decode("utf-8") != prompt:
            raise _Decline("prompt_mismatch", step=rows[0][0])
        final = rows[-1]
        if final[1] != 15:
            raise _Decline("final_not_response", final=final[0], step_type=final[1])
        response = _fields(_blob(payloads[-1], 20))
        body = _blob(response, 8) or _blob(response, 1)
        if not body.strip():
            raise _Decline("final_empty", final=final[0])
        if response.get(7):
            raise _Decline("final_has_tool_call", final=final[0])
        if _one(response, 12, 0) != 2:
            raise _Decline("final_stop_reason", final=final[0], stop_reason=_one(response, 12, 0))
        states: dict[int, str] = {}
        texts: dict[int, str] = {}
        text_size = 0
        by_index = {r[0]: r[1] for r in rows}
        final_seen = False
        seen = 0
        for event in events:
            if event.get("event") == "error":
                raise _Decline("wire_error_event", events=seen)
            if event.get("event") != "step_update":
                continue
            seen += 1
            step = event.get("step_update")
            if not isinstance(step, dict):
                raise _Decline("wire_malformed", events=seen)
            index = step.get("step_index")
            if type(index) is not int or index not in by_index:
                raise _Decline("wire_step_outside_interval", events=seen,
                               step=index if type(index) is int else "?")
            if step.get("conversation_id") != cid:
                raise _Decline("wire_conversation_mismatch", step=index)
            if step.get("state") not in ("ACTIVE", "DONE", "ERROR"):
                raise _Decline("wire_step_state", step=index)
            kind = step.get("step_type")
            # `.get`, never `[]`: an unmapped stored type must decline BY NAME.
            # Indexing raised KeyError, which the handler below flattened to
            # `exception:KeyError` - a reason that says nothing about which
            # step or type did it. 23 is intentionally unmapped: no wire
            # step_update has ever been observed for a compaction step.
            expected = WIRE_TYPE.get(by_index[index])
            if expected is None:
                raise _Decline("wire_step_type_unmapped", step=index,
                               step_type=by_index[index])
            if kind != expected:
                raise _Decline("wire_step_type", step=index)
            # ERROR is terminal for a TOOL only. On a model or user step it is
            # a failed turn, which is the shape a real refusal takes, and it
            # must keep declining.
            if step["state"] == "ERROR" and kind != "tool":
                raise _Decline("wire_nontool_error", step=index)
            states[index] = step["state"]
            if kind == "agent_response":
                delta = step.get("text_delta", "")
                if not isinstance(delta, str):
                    raise _Decline("wire_text_malformed", step=index)
                text_size += len(delta)
                if text_size > MAX_BYTES:
                    raise _Decline("wire_text_bound", step=index, text_size=text_size)
                texts[index] = texts.get(index, "") + delta
            if index == final[0] and step["state"] == "DONE":
                final_seen = True
        if not final_seen:
            raise _Decline("final_not_done_on_wire", final=final[0], events=seen)
        # ACTIVE means the step never finished; DONE and ERROR are both
        # terminal (supervisor.py folds exactly those two as the end of a step).
        open_steps = sorted(i for i, state in states.items() if state == "ACTIVE")
        if open_steps:
            raise _Decline("wire_steps_open", steps=",".join(map(str, open_steps)))
        # THE ONE TOLERANCE (header): the streamed final text must equal the
        # stored body exactly, or the stored body plus exactly one "\n".
        wire = texts.get(final[0], "").encode("utf-8")
        if wire != body and wire != body + WIRE_TAIL:
            raise _Decline("final_text_mismatch", final=final[0], wire_bytes=len(wire),
                           stored_bytes=len(body))
        # Every emitted model/tool step must belong to this complete appended
        # interval, and each persisted model/tool step must have completed on wire.
        # A model step must have COMPLETED; a tool step must have ENDED, which
        # for a tool means DONE or ERROR (the store's status 7 above is the
        # same event seen from the other side).
        unseen = sorted(r[0] for r in rows
                        if (r[1] == 15 and states.get(r[0]) != "DONE")
                        or (r[1] == 132 and states.get(r[0]) not in ("DONE", "ERROR")))
        if unseen:
            raise _Decline("stored_steps_not_done_on_wire", steps=",".join(map(str, unseen)))
        reader.close(); reader = None
        _emit(f"reconcile: fired historical={old_index} boundary={boundary.index} final={final[0]}"
              f" events={seen} wire_tail={'lf' if wire != body else 'none'}")
        # The verdict is already decided; the record cannot reach back into it.
        _record("fired", "", {"historical": old_index, "boundary": boundary.index,
                              "final": final[0], "rows": len(rows), "events": seen,
                              "wire_lf": int(wire != body)})
        return {"kind": "historical_cli_quota_error", "historical_step": old_index,
                "boundary_step": boundary.index, "final_step": final[0]}
    except _Decline as d:
        _emit(f"reconcile: declined reason={d.reason}{_fmt(d.detail)}")
        _record("declined", d.reason, d.detail)
        return None
    except (OSError, sqlite3.Error, ValueError, IndexError, TypeError, KeyError) as exc:
        _emit(f"reconcile: declined reason=exception:{type(exc).__name__}")
        _record("declined", "exception:" + type(exc).__name__, {})
        return None
    finally:
        if reader is not None:
            reader.db.close()
