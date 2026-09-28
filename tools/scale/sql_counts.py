"""Harness-only counters at HTTP boundaries; preserves the real threadpool.

Value bytes are UTF-8 bytes of fetched scalar values (JSON for structured
values), NOT PG wire bytes or physical page reads. Parameter bytes include
all bound values; write_parameter_bytes covers explicit INSERT/UPDATE/DELETE.
No SQL text, payloads or stacks are retained.
"""
import contextvars
import json
import os
import re
import threading
import time
import traceback

current = contextvars.ContextVar("scale_sql_counts", default=None)
muted = contextvars.ContextVar("scale_sql_nested_fetch", default=False)
#: ORGTREE_SCALE_SQL_STATEMENTS=1 (diagnosis only): also break each request's
#: rows down by statement -- collapsed SQL text (first 200 chars) plus the three
#: innermost orgtree frames that issued it -- so a growing read can be named.
BY_STATEMENT = os.environ.get("ORGTREE_SCALE_SQL_STATEMENTS") == "1"
last_statement = contextvars.ContextVar("scale_sql_last_statement", default=None)


def _statement_key(query):
    text = " ".join(str(query).split())[:200]
    frames = [f"{os.path.basename(f.filename)}:{f.lineno}:{f.name}"
              for f in traceback.extract_stack()[:-3]
              if os.path.basename(os.path.dirname(f.filename)) == "orgtree"]
    return text + " @ " + " < ".join(reversed(frames[-3:]))


def value_bytes(value):
    if value is None:
        return 0
    if isinstance(value, bytes):
        return len(value)
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


def install():
    import psycopg
    originals = {}
    def wrap(name):
        original = getattr(psycopg.Cursor, name)
        originals[name] = original
        def measured(self, *args, **kwargs):
            counts = current.get()
            if counts is None or muted.get():
                return original(self, *args, **kwargs)
            if name in ("execute", "executemany"):
                params = args[1] if len(args) > 1 else kwargs.get("params" if name == "execute" else "params_seq")
                batches = [params] if name == "execute" else list(params)
                if name == "executemany":
                    args = (args[0], batches, *args[2:])
                counts["statements"] += len(batches)
                counts["executemany_batches"] += name == "executemany"
                size = sum(value_bytes(v) for batch in batches for v in (
                    batch.values() if isinstance(batch, dict) else (batch or ())))
                counts["parameter_bytes"] += size
                query = args[0] if args else kwargs.get("query", "")
                if not isinstance(query, (str, bytes)):
                    query = query.as_string(self.connection)
                if isinstance(query, bytes):
                    query = query.decode("utf-8")
                # The product uses bound values: literals cannot disguise
                # keywords in the observed DML/CTE statements.
                if re.search(r"\b(INSERT|UPDATE|DELETE|MERGE)\b", query, re.I):
                    counts["write_parameter_bytes"] += size
                if BY_STATEMENT:
                    key = _statement_key(query)
                    last_statement.set(key)
                    counts.setdefault("by_statement", {}).setdefault(key, [0, 0, 0])[0] += len(batches)
            elif name in ("copy", "stream"):
                counts["unsupported_operations"] += 1
            token = muted.set(True)
            try:
                result = original(self, *args, **kwargs)
            except Exception as exc:
                if getattr(exc, "sqlstate", None) == "55P03":
                    counts["lock_timeout_55P03"] += 1
                raise
            finally:
                muted.reset(token)
            if name in ("fetchone", "fetchmany", "fetchall", "__next__"):
                rows = ([result] if result is not None else []) if name in ("fetchone", "__next__") else result
                counts["rows"] += len(rows)
                size = sum(sum(value_bytes(v) for v in row) for row in rows)
                counts["value_bytes"] += size
                key = last_statement.get() if BY_STATEMENT else None
                if key is not None:
                    entry = counts.setdefault("by_statement", {}).setdefault(key, [0, 0, 0])
                    entry[1] += len(rows)
                    entry[2] += size
            return result
        setattr(psycopg.Cursor, name, measured)
    for name in ("execute", "executemany", "fetchone", "fetchmany", "fetchall", "__next__", "copy", "stream"):
        wrap(name)
    # ORGTREE_LAZY_ROWS: a request that had to decode every node row
    try:
        from orgtree import store
    except ImportError:
        store = None
    if store is not None and hasattr(store, "LAZY_ROWS_HOOK"):
        def fallback(kind, _why=""):
            counts = current.get()
            if counts is not None:
                key = "lazy_post_load_changes" if kind == "post_load_change" else "lazy_fallbacks"
                counts[key] += 1
        store.LAZY_ROWS_HOOK = fallback
    return lambda: [setattr(psycopg.Cursor, name, fn) for name, fn in originals.items()]


def empty():
    return dict(statements=0, rows=0, value_bytes=0, parameter_bytes=0,
                write_parameter_bytes=0, lock_timeout_55P03=0, executemany_batches=0,
                unsupported_operations=0, lazy_fallbacks=0, lazy_post_load_changes=0)


class Boundary:
    def __init__(self, app, path):
        self.app, self.path, self.lock = app, path, threading.Lock()

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        counts = empty()
        token = current.set(counts)
        start, status = time.time(), None
        async def observe(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)
        try:
            return await self.app(scope, receive, observe)
        finally:
            current.reset(token)
            headers = dict(scope.get("headers", ()))
            row = dict(at=start, seconds=time.time()-start, path=scope["path"], status=status,
                       kind=headers.get(b"x-scale-kind", b"").decode(), **counts)
            with self.lock, self.path.open("a", encoding="utf-8") as target:
                target.write(json.dumps(row) + "\n")
