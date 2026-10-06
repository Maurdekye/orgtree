"""Durable record of slow, org-wide and failed org transactions.

Item engine-logging-persist-the-engine-s-output-and-r (user request
2026-10-03). The live org jammed for ~9 minutes that morning and nothing
could say which transaction held the org-wide `node:*` lock: lock timeouts
name only the waiting statement, and the engine kept no record of how long
any transaction waited for or held its locks.

`orgtx` marks every attempt's lock points (`mark`, from `orgtx._pause`) and
calls `finish` when the attempt ends. `finish` appends ONE JSON line to
`<data>/diagnostics/slow-transactions.jsonl` when the attempt

  * waited for its locks >= THRESHOLD_MS, or held them >= THRESHOLD_MS,
  * took `nodes=ALL` or `whole` (org-wide, rare, and what other transactions
    queue behind),
  * or ended in an exception (a lock timeout, deadlock, serialization
    failure or any error).

A line carries: UTC time, pid, org slug, the caller label (`label()`), the
lock plan summary (flags, counts, up to 20 node ids, section names, logs),
wait/hold ms and the outcome (a failure: its type, SQLSTATE and where it
was raised, never its message). The hold is split (PostgreSQL backends)
into `load_ms` (loading the org), `body_ms` (the caller's code inside the
transaction), `commit_ms` (save and COMMIT) and `cpu_ms` (the holding
thread's CPU), and a hold past SAMPLE_AFTER_S carries `stacks`: the most
frequent Python stacks of the holding thread, sampled every SAMPLE_S
(item 3-2-0-engine-transactions-stay-open-for-10-17-s). On a LOCK TIMEOUT it also carries
`blockers`: the other database sessions most likely to block it, those
holding the plan's own lock keys first (pid, their own caller label from
`application_name`, state, transaction age, what they wait on, who blocks
them). Every org transaction tags its session with its caller label
(`app_name`, `SET LOCAL application_name` in the BEGIN batch), which is
what makes a blocker nameable.

PRIVACY: plan names are node ids and section names; labels are route
templates, tool verbs or function names. No statement text is recorded
except the leading word of orgtree's own lock statements, and no exception
message, so no message body, token or key can reach the file.

NEVER FAILS A TRANSACTION: every entry point swallows its own errors, and
the cost when nothing is logged is a few clock reads per attempt. The file
rotates to `.1`/`.2` past MAX_BYTES (three files at most).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from typing import Any, Sequence

#: Log an attempt that waited for or held its locks at least this long.
THRESHOLD_MS = float(os.environ.get("ORGTREE_TXLOG_MS", "1000"))
#: Rotation cap per file; the current file and two rotated ones are kept.
MAX_BYTES = int(float(os.environ.get("ORGTREE_TXLOG_MAX_MB", "10")) * 1024 * 1024)
KEEP = 2
#: Node ids listed per plan (the counts are always exact).
MAX_IDS = 20
#: Blocker sessions listed per lock timeout.
MAX_BLOCKERS = 20
#: The prefix every org transaction's application_name carries.
APP_PREFIX = "orgtree:"

_LOCK = threading.Lock()
_SKIP_FILES = ("orgtx.py", "halt.py", "txlog.py", "contextlib.py", "lifecycle_tx.py",
               "pgdoor.py", "settingstx.py", "tx.py")
_SAFE = re.compile(r"[^A-Za-z0-9 _./{}:@#-]")


def path() -> str:
    from . import store
    return os.path.join(store.DATA_ROOT, "diagnostics", "slow-transactions.jsonl")


def label() -> str:
    """Who is running this transaction: the HTTP route template or agent
    tool verb of the request being served (`stateprobe`), else the nearest
    calling function outside the transaction machinery (a background loop)."""
    try:
        from . import stateprobe
        op = stateprobe.current_op()
        if op and op != "(unlabelled)":
            return _clean(op)
    except Exception:                                           # noqa: BLE001
        pass
    try:
        f = sys._getframe(2)
        for _ in range(16):
            if f is None:
                break
            name = os.path.basename(f.f_code.co_filename)
            if name not in _SKIP_FILES:
                return _clean(f"{name[:-3] if name.endswith('.py') else name}.{f.f_code.co_name}")
            f = f.f_back
    except Exception:                                           # noqa: BLE001
        pass
    return "(unknown)"


def _clean(s: str) -> str:
    return _SAFE.sub("_", str(s))[:80]


def app_name(tx: Any) -> str:
    """The SQL literal for `SET LOCAL application_name` (quotes doubled; the
    label is already restricted to safe characters)."""
    name = (APP_PREFIX + str(getattr(tx, "log_label", "") or "(unknown)"))[:63]
    return "'" + name.replace("'", "''") + "'"


def mark(point: str, tx: Any) -> None:
    """Record when an attempt reached a lock point (orgtx._pause, plus
    `loaded` from the PostgreSQL backends once the org is loaded and the
    body is about to run). At `after_lock` the holding thread is also
    registered with the sampler and its CPU clock read."""
    try:
        tx.log_marks[point] = time.perf_counter()
        if point == "after_lock":
            tx.log_marks["cpu_after_lock"] = time.thread_time()
            _hold_start()
    except Exception:                                           # noqa: BLE001
        pass


# ------------------------------------------------------- holder sampling
#
# Item 3-2-0-engine-transactions-stay-open-for-10-17-s (2026-10-06): the log
# said turn:run held its locks 17.5 s while taking only shared locks and a
# reservation call sat IDLE IN TRANSACTION for 10.5 s, and nothing could say
# what the holding thread was doing. While a transaction holds its locks, a
# sampler thread looks at the holder's Python stack every SAMPLE_S once the
# hold passes SAMPLE_AFTER_S; a logged line carries the most frequent stacks.
# A stack is file:line function names only (no values), so it is as safe to
# write as the label. The sampler sleeps while nothing is held long.

#: Start sampling a hold once it is this old (seconds).
SAMPLE_AFTER_S = float(os.environ.get("ORGTREE_TXLOG_SAMPLE_AFTER_S", "0.5"))
#: Sampling interval (seconds).
SAMPLE_S = float(os.environ.get("ORGTREE_TXLOG_SAMPLE_S", "0.1"))
#: Distinct stacks kept per hold, and listed per line.
MAX_STACKS = 50
TOP_STACKS = 5
#: Frames per stack: the innermost ones, plus the innermost orgtree frames
#: outside the transaction machinery (who is doing the work).
INNER_FRAMES = 4
CALLER_FRAMES = 6

_HOLDS: dict[int, dict[str, Any]] = {}
_HOLDS_LOCK = threading.Lock()
_WAKE = threading.Event()
_sampler: threading.Thread | None = None
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))


def _hold_start() -> None:
    global _sampler
    ident = threading.get_ident()
    with _HOLDS_LOCK:
        held = _HOLDS.get(ident)
        if held is not None:            # a nested org_tx on another org: one hold
            held["depth"] += 1
        else:
            _HOLDS[ident] = {"t0": time.perf_counter(), "n": 0, "stacks": {}, "depth": 1}
        if _sampler is None or not _sampler.is_alive():
            _sampler = threading.Thread(target=_sample_loop, name="txlog-sampler",
                                        daemon=True)
            _sampler.start()
    _WAKE.set()


def _hold_end(txs: Sequence[Any]) -> dict[str, Any] | None:
    """The attempt's hold, once its outermost registration ends; nothing
    when the attempt never reached `after_lock` (it registered nothing)."""
    if not any("after_lock" in (getattr(t, "log_marks", None) or {}) for t in txs):
        return None
    with _HOLDS_LOCK:
        held = _HOLDS.get(threading.get_ident())
        if held is None:
            return None
        held["depth"] -= 1
        if held["depth"] > 0:
            return None
        return _HOLDS.pop(threading.get_ident(), None)


def discard(txs: Sequence[Any]) -> None:
    """An attempt ended without a log line (orgtx's expected endings): stop
    sampling its thread."""
    try:
        _hold_end(txs)
    except Exception:                                           # noqa: BLE001
        pass


def _stack_key(frame: Any) -> str:
    inner: list[str] = []
    callers: list[str] = []
    f = frame
    depth = 0
    while f is not None and depth < 200:
        co = f.f_code
        fn = co.co_filename
        name = os.path.basename(fn)
        here = f"{name}:{f.f_lineno} {co.co_name}"
        if len(inner) < INNER_FRAMES:
            inner.append(here)
        elif (len(callers) < CALLER_FRAMES and name not in _SKIP_FILES
              and os.path.abspath(fn).startswith(_PKG_DIR)):
            callers.append(here)
        f = f.f_back
        depth += 1
    return _clean_stack(" < ".join(inner + (["..."] if callers else []) + callers))


def _clean_stack(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _./{}:<@#-]", "_", s)[:600]


def _sample_once() -> bool:
    """One pass over the held transactions; True while any is held."""
    now = time.perf_counter()
    with _HOLDS_LOCK:
        due = [(i, h) for i, h in _HOLDS.items() if now - h["t0"] >= SAMPLE_AFTER_S]
        anything = bool(_HOLDS)
    if not due:
        return anything
    frames = sys._current_frames()                  # pyright: ignore[reportPrivateUsage]
    for ident, h in due:
        f = frames.get(ident)
        if f is None:
            continue
        key = _stack_key(f)
        stacks = h["stacks"]
        if key not in stacks and len(stacks) >= MAX_STACKS:
            key = "(other)"
        stacks[key] = stacks.get(key, 0) + 1
        h["n"] += 1
    del frames
    return True


def _sample_loop() -> None:
    while True:
        try:
            if not _sample_once():
                _WAKE.wait(5.0)
                _WAKE.clear()
                continue
        except Exception:                                       # noqa: BLE001
            pass
        time.sleep(SAMPLE_S)


def _split(m: dict[str, float], locked: float | None, now: float,
           cpu_now: float) -> dict[str, Any]:
    """Where the held time went: loading the org, the caller's body, the
    save and COMMIT, and the holding thread's CPU over the hold (CPU far
    below the hold means it waited: database, disk, the GIL, a sleep)."""
    out: dict[str, Any] = {}
    if locked is None:
        return out
    loaded = m.get("loaded")
    pre = m.get("before_commit")
    if loaded is not None:
        out["load_ms"] = round((loaded - locked) * 1000.0, 1)
        out["body_ms"] = round(((pre if pre is not None else now) - loaded) * 1000.0, 1)
    if pre is not None:
        out["commit_ms"] = round((now - pre) * 1000.0, 1)
    cpu0 = m.get("cpu_after_lock")
    if cpu0 is not None:
        out["cpu_ms"] = round((cpu_now - cpu0) * 1000.0, 1)
    return out


def _plan(tx: Any) -> dict[str, Any]:
    nodes = sorted(tx.lock_nodes)
    share = sorted(tx.share_nodes)
    return {"all_nodes": bool(tx.all_nodes), "whole": bool(tx.whole),
            "nodes": len(nodes), "node_ids": nodes[:MAX_IDS],
            "share_nodes": len(share), "share_node_ids": share[:MAX_IDS],
            "sections": sorted(tx.lock_sections),
            "share_sections": sorted(tx.share_sections),
            "logs": sorted(str(x if isinstance(x, str) else x[0]) for x in tx.logs)}


def finish(txs: list[Any], started: float, exc: BaseException | None) -> None:
    """One attempt of `org_tx` ended (committed, replayed or raised)."""
    try:
        now = time.perf_counter()
        cpu_now = time.thread_time()
        hold = _hold_end(txs)
        for tx in txs:
            m = getattr(tx, "log_marks", None) or {}
            begin = m.get("before_lock", started)
            locked = m.get("after_lock")
            wait_ms = ((locked if locked is not None else now) - begin) * 1000.0
            hold_ms = ((now - locked) * 1000.0) if locked is not None else 0.0
            wide = bool(tx.all_nodes or tx.whole)
            if exc is None and not wide and wait_ms < THRESHOLD_MS and hold_ms < THRESHOLD_MS:
                continue
            row: dict[str, Any] = {
                "org": tx.slug, "label": getattr(tx, "log_label", "") or "(unknown)",
                "wait_ms": round(wait_ms, 1), "hold_ms": round(hold_ms, 1),
                "outcome": ("replayed" if tx.replayed else "committed") if exc is None
                else type(exc).__name__,
                "plan": _plan(tx)}
            row.update(_split(m, locked, now, cpu_now))
            if hold and hold["n"]:
                top = sorted(hold["stacks"].items(), key=lambda kv: -kv[1])[:TOP_STACKS]
                row["samples"] = hold["n"]
                row["sample_ms"] = round(SAMPLE_S * 1000.0)
                row["stacks"] = [{"n": n, "stack": k} for k, n in top]
            if exc is not None:
                row.update(_error(exc))
                from .orgtx import LockTimeout
                if isinstance(exc, LockTimeout):
                    row["blockers"] = blockers(txs)
            emit(row)
    except Exception:                                           # noqa: BLE001
        pass


def _error(exc: BaseException) -> dict[str, Any]:
    """What failed, WITHOUT the exception's message: a message can carry any
    value the body handled (a token, a message body), so only the type, the
    SQLSTATE and the code location where it was raised are kept."""
    out: dict[str, Any] = {}
    try:
        seen: set[int] = set()
        e: BaseException | None = exc
        while e is not None and id(e) not in seen:      # the driver's error is the cause
            seen.add(id(e))
            state = getattr(e, "sqlstate", None)
            if isinstance(state, str) and re.fullmatch(r"[0-9A-Z]{5}", state):
                out["sqlstate"] = state
                break
            e = e.__cause__ or e.__context__
        tb = exc.__traceback__
        while tb is not None and tb.tb_next is not None:
            tb = tb.tb_next
        if tb is not None:
            co = tb.tb_frame.f_code
            out["raised_at"] = _clean(f"{os.path.basename(co.co_filename)}:"
                                      f"{tb.tb_lineno}:{co.co_name}")
    except Exception:                                           # noqa: BLE001
        pass
    return out


def _keys(tx: Any) -> list[tuple[str, bool]]:
    """The advisory-lock names (`kind:name`) the attempt's plan takes, each
    with whether it is taken exclusively; both PostgreSQL backends key them
    `(org_id, hashtext(name))`."""
    from . import orgtx
    try:
        return [(f"{kind}:{name}", bool(ex))
                for kind, name, ex in orgtx._lock_plan(tx)]   # pyright: ignore[reportPrivateUsage]
    except Exception:                                           # noqa: BLE001
        return [(f"org:{orgtx._ORG_KEY}", bool(tx.whole))]   # pyright: ignore[reportPrivateUsage]


def blockers(txs: Sequence[Any] = ()) -> list[dict[str, Any]] | str:
    """The OTHER database sessions that can be blocking `txs`, most likely
    first, each with who blocks it. A separate short connection (the
    timed-out one is in a failed transaction), bounded by statement_timeout.

    The timed-out session no longer waits, so `pg_blocking_pids` of it says
    nothing; instead sessions are ranked: 0 = holds one of the exact
    advisory keys the plan asked for in a CONFLICTING mode (either side
    exclusive; every org_tx holds the org key shared), 1 = holds an
    advisory lock in the same org, 2 = holds or waits for any advisory lock, 3 = any other open
    transaction (a plain row lock). MAX_BLOCKERS are kept, by rank then
    transaction age, so older unrelated sessions cannot push the holder out.
    Statement text is reduced to the leading word of orgtree's own lock
    statements."""
    try:
        from . import store
        if store.STORE_BACKEND != "postgres":
            return []
        from . import pgstore
        org_ids: list[int] = []
        key_orgs: list[int] = []
        key_names: list[str] = []
        key_excl: list[bool] = []
        for tx in txs:
            oid = getattr(tx, "log_org_id", None)
            if oid is None:
                continue
            org_ids.append(int(oid))
            for k, ex in _keys(tx):
                key_orgs.append(int(oid))
                key_names.append(k)
                key_excl.append(ex)
        with pgstore.connect() as c:
            c.execute("SET statement_timeout = '2s'")
            rows = c.execute(
                "WITH want AS (SELECT o::oid AS k1, hashtext(n)::oid AS k2, x "
                "  FROM unnest(%s::int[], %s::text[], %s::bool[]) AS w(o, n, x)), "
                "adv AS (SELECT l.pid, bool_or(l.granted) AS holds, "
                "  bool_or(NOT l.granted) AS waits, "
                "  min(CASE WHEN l.granted AND l.objsubid = 2 AND EXISTS ("
                "        SELECT 1 FROM want w WHERE w.k1 = l.classid AND w.k2 = l.objid "
                "        AND (w.x OR l.mode = 'ExclusiveLock')) THEN 0 "
                "      WHEN l.objsubid = 2 AND l.classid = ANY(%s::int[]::oid[]) THEN 1 "
                "      ELSE 2 END) AS rank "
                "  FROM pg_locks l WHERE l.locktype = 'advisory' GROUP BY l.pid) "
                "SELECT a.pid, a.application_name, a.state, a.wait_event_type, "
                "round(extract(epoch FROM now() - a.xact_start) * 1000), "
                "pg_blocking_pids(a.pid), coalesce(adv.holds, false), "
                "coalesce(adv.waits, false), left(a.query, 40), coalesce(adv.rank, 3) "
                "FROM pg_stat_activity a LEFT JOIN adv ON adv.pid = a.pid "
                "WHERE a.pid <> pg_backend_pid() "
                "AND (adv.pid IS NOT NULL OR a.xact_start IS NOT NULL) "
                "ORDER BY coalesce(adv.rank, 3), a.xact_start NULLS LAST LIMIT %s",
                (key_orgs, key_names, key_excl, org_ids, MAX_BLOCKERS)).fetchall()
        out = []
        for pid, app, state, wait, age, by, holds, waits, q, rank in rows:
            q = str(q or "")
            kind = ("lock block" if q.startswith("DO $orgtx_")
                    else "advisory lock" if q.startswith("SELECT pg_advisory")
                    else (q.split(None, 1)[0].upper() if q.strip() else ""))
            out.append({"pid": pid, "label": _clean(app or ""), "state": state,
                        "waiting_on": wait, "xact_ms": age, "blocked_by": list(by or []),
                        "holds_advisory": bool(holds), "waits_advisory": bool(waits),
                        "holds_plan_key": rank == 0, "same_org": rank <= 1,
                        "statement": _clean(kind)[:20]})
        return out
    except Exception as e:                                      # noqa: BLE001
        return f"unavailable: {type(e).__name__}"


def emit(row: dict[str, Any]) -> None:
    """Append one line, rotating first when the file is over the cap."""
    try:
        p = path()
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "pid": os.getpid(), **row}
        line = json.dumps(row, sort_keys=True, default=str) + "\n"
        with _LOCK:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            try:
                if os.path.getsize(p) > MAX_BYTES:
                    for i in range(KEEP, 0, -1):
                        src = p if i == 1 else f"{p}.{i - 1}"
                        if os.path.exists(src):
                            os.replace(src, f"{p}.{i}")
            except OSError:
                pass                       # no file yet, or a racing reader
            with open(p, "a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:                                           # noqa: BLE001
        pass
