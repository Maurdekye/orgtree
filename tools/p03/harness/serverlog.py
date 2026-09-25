"""Q-C5 hidden-access check from the SERVER's own statement log (p03-lead ruling
2026-09-25 08:23Z, decision 3 on ``p03-ws7-contact-tracing-and-the-qualification-ha``).

PostgreSQL keeps no per-backend transaction counter, so on QUALIFICATION clusters
only the server logs every top-level statement (``log_destination='jsonlog'``,
``log_statement='all'``, ``log_replication_commands=on``, and
``log_parameter_max_length=0`` / ``_on_error=0`` so no bind values reach disk).
This module reconciles that log with the trace:

- every logged statement except transaction control must match, IN ORDER, a
  traced statement on the same session (same pid and backend start), compared
  by the value-free fingerprint (``fingerprint`` here equals store-trace's
  ``sink::fingerprint``). A logged statement with no traced counterpart is
  HIDDEN ACCESS: FAIL;
- a traced statement the server never logged is a fabricated contact: FAIL;
- a logged session that no ``conn_opened`` record names is an unregistered
  connection: FAIL;
- no log for the run window: hidden access cannot be ruled out: FAIL;
- a pid that ``conn_opened`` shows under two backend starts in one run cannot
  be attributed (statement records carry the pid, not the backend start): its
  statements FAIL as unattributable, never guessed. (If this happens in practice,
  the collector should add backend_start to statement records.)

Limit, stated in every report: statements executed by triggers and functions
are not top-level and never appear in this log. They are covered by
``store_schema::DECLARED_SERVER_SIDE`` and the ``trace.xact_stats`` rows, not by
this check.

The exact shape of extended-protocol lines ("execute <name>: ...") must be
verified on a real cluster before this is relied on (ruling point 2); the
``statement_text`` parser below accepts the documented forms and reports any
other ``statement``-severity line as unparsed rather than dropping it.
"""
from __future__ import annotations

from collections import defaultdict
import json
import re
from typing import Any, Iterable

LIMIT = ("statements run by triggers and functions are not top-level and never reach the "
         "server statement log; they are covered by DECLARED_SERVER_SIDE and trace.xact_stats")
CONTROL = re.compile(r"^\s*(begin|commit|rollback|start\s+transaction|end|savepoint|release"
                     r"|rollback\s+to)\b", re.I)
STATEMENT = re.compile(r"^(?:statement|execute(?:\s+(?:<unnamed>|\S+))?(?:/\S+)?)\s*:\s(.*)$", re.S)


def fingerprint(sql: str) -> str:
    """FNV-1a 64 over the whitespace-collapsed, ASCII-lowercased SQL.

    Byte-for-byte the algorithm of ``engine/native/store-trace/src/sink.rs``
    ``fingerprint``: whitespace runs become one space, leading and trailing
    whitespace are dropped (the server log's extended-protocol lines keep a
    trailing space: measured, serverlog_probe.py), ASCII letters are lowercased,
    and the UTF-8 bytes are hashed."""
    h = 0xcbf29ce484222325
    prev_space = True
    for ch in sql.rstrip():
        c = " " if ch.isspace() else (ch.lower() if ch.isascii() else ch)
        if c == " " and prev_space:
            continue
        prev_space = c == " "
        for b in c.encode("utf-8"):
            h ^= b
            h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{h:016x}"


def session_key(session_id: str) -> "tuple[int, int] | None":
    """PostgreSQL's ``%c`` session id is ``<backend start, epoch seconds, hex>.<pid hex>``."""
    try:
        start, pid = session_id.split(".")
        return int(start, 16), int(pid, 16)
    except (ValueError, AttributeError):
        return None


def statement_text(entry: dict[str, Any]) -> "str | None":
    message = entry.get("message") or ""
    m = STATEMENT.match(message)
    return m.group(1) if m else None


def parse(lines: Iterable[str]) -> tuple[list[dict[str, Any]], list[str]]:
    entries, bad = [], []
    for n, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            bad.append(f"line {n}: not JSON")
    return entries, bad


def reconcile(records: list[dict[str, Any]], log_lines: "Iterable[str] | None",
              factories: Iterable[str]) -> dict[str, Any]:
    failures: list[str] = []
    report: dict[str, Any] = {"limit": LIMIT}
    if log_lines is None:
        return {"verdict": "FAILED", "limit": LIMIT,
                "failures": ["no server statement log for the run window: hidden access cannot "
                             "be ruled out"]}
    entries, bad = parse(log_lines)
    failures += [f"server log {b}" for b in bad]
    registered = set(factories)
    # sessions the trace knows: (backend_start seconds, pid) -> factory
    opened: dict[tuple[int, int], str] = {}
    for r in records:
        if r.get("kind") == "conn_opened" and isinstance(r.get("backend_pid"), int) \
                and isinstance(r.get("backend_start"), int):
            key = (r["backend_start"] // 1_000_000, r["backend_pid"])
            opened[key] = r.get("factory")
            if r.get("factory") not in registered:
                failures.append(f"session {key}: opened by unregistered factory {r.get('factory')!r}")
    by_pid: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for key in opened:
        by_pid[key[1]].append(key)
    # traced statements per session, in trace order
    traced: dict[tuple[int, int], list[str]] = defaultdict(list)
    for r in sorted((r for r in records if r.get("kind") == "stmt"),
                    key=lambda r: (str(r.get("stream")), r.get("seq", 0))):
        pid = r.get("backend_pid")
        keys = by_pid.get(pid, []) if isinstance(pid, int) else []
        if len(keys) != 1:
            failures.append(f"traced statement {r.get('stmt_label')} on pid {pid!r}: "
                            f"{'no' if not keys else 'several'} sessions for that pid; cannot attribute")
            continue
        traced[keys[0]].append(r["fingerprint"])
    # logged statements per session, in log order
    logged: dict[tuple[int, int], list[str]] = defaultdict(list)
    # every session that ran ANY statement, transaction control included: each one
    # must be a registered connection (the harness registers its own sessions too)
    active: set[tuple[int, int]] = set()
    unparsed = 0
    for e in entries:
        key = session_key(str(e.get("session_id", "")))
        if key is None:
            failures.append(f"log entry without a valid session_id: {str(e)[:120]}")
            continue
        if e.get("error_severity") not in (None, "LOG"):
            continue
        sql = statement_text(e)
        if sql is None:
            if str(e.get("message", "")).startswith(("statement", "execute")):
                unparsed += 1
                failures.append(f"session {key}: unparsed statement line {e.get('message')!r:.120}")
            continue
        active.add(key)
        if CONTROL.match(sql):
            continue
        logged[key].append(fingerprint(sql))
    for key in sorted(active | set(traced)):
        if key not in opened:
            failures.append(f"session {key}: in the server log but opened by no registered "
                            f"factory (unregistered connection)")
            continue
        lg, tr = logged.get(key, []), traced.get(key, [])
        i = j = 0
        while i < len(lg) or j < len(tr):
            if i < len(lg) and j < len(tr) and lg[i] == tr[j]:
                i += 1
                j += 1
            elif i < len(lg) and lg[i] not in tr[j:]:
                failures.append(f"session {key}: hidden access: the server ran {lg[i]} "
                                f"with no traced counterpart")
                i += 1
            elif j < len(tr) and tr[j] not in lg[i:]:
                failures.append(f"session {key}: the trace claims {tr[j]} but the server never "
                                f"logged it")
                j += 1
            else:
                failures.append(f"session {key}: statement order differs between the server log "
                                f"and the trace at log #{i}, trace #{j}")
                break
    report.update({"verdict": "PASSED" if not failures else "FAILED", "failures": failures,
                   "sessions": len(active | set(traced)), "unparsed": unparsed})
    return report
