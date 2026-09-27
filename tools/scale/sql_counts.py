"""Harness-only counters at HTTP boundaries; preserves the real threadpool.

Value bytes are UTF-8 bytes of fetched scalar values (JSON for structured
values), NOT PG wire bytes or physical page reads. Parameter bytes include
all bound values; write_parameter_bytes covers explicit INSERT/UPDATE/DELETE.
No SQL text, payloads or stacks are retained.
"""
import contextvars
import json
import threading
import time

current = contextvars.ContextVar("scale_sql_counts", default=None)
muted = contextvars.ContextVar("scale_sql_nested_fetch", default=False)


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
            if name == "execute":
                counts["statements"] += 1
                params = args[1] if len(args) > 1 else kwargs.get("params")
                values = params.values() if isinstance(params, dict) else (params or ())
                size = sum(value_bytes(v) for v in values)
                counts["parameter_bytes"] += size
                query = args[0] if args else kwargs.get("query", "")
                if not isinstance(query, (str, bytes)):
                    query = query.as_string(self.connection)
                if isinstance(query, bytes):
                    query = query.decode("utf-8")
                if query.lstrip().split(" ", 1)[0].upper() in ("INSERT", "UPDATE", "DELETE"):
                    counts["write_parameter_bytes"] += size
            token = muted.set(True)
            try:
                result = original(self, *args, **kwargs)
            except Exception as exc:
                if getattr(exc, "sqlstate", None) == "55P03":
                    counts["lock_timeout_55P03"] += 1
                raise
            finally:
                muted.reset(token)
            if name != "execute":
                rows = ([result] if result is not None else []) if name == "fetchone" else result
                counts["rows"] += len(rows)
                counts["value_bytes"] += sum(sum(value_bytes(v) for v in row) for row in rows)
            return result
        setattr(psycopg.Cursor, name, measured)
    for name in ("execute", "fetchone", "fetchmany", "fetchall"):
        wrap(name)
    original_iter = psycopg.Cursor.__iter__
    originals["__iter__"] = original_iter
    def iterate(self):
        for row in original_iter(self):
            counts = current.get()
            if counts is not None and not muted.get():
                counts["rows"] += 1
                counts["value_bytes"] += sum(value_bytes(v) for v in row)
            yield row
    psycopg.Cursor.__iter__ = iterate
    return lambda: [setattr(psycopg.Cursor, name, fn) for name, fn in originals.items()]


def empty():
    return dict(statements=0, rows=0, value_bytes=0, parameter_bytes=0,
                write_parameter_bytes=0, lock_timeout_55P03=0)


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
