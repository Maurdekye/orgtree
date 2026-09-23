"""Actual SQLite contacts on the PRIMARY STORE path, for the operation census.

⚠ WHAT THIS OBSERVES, AND ONLY THIS. `store._open_conn` is the one connection
factory of the primary store: every `store._POOL` connection, the migration
candidate and `history.py`'s pooled reads all come out of it. It now passes
`factory=ObservedConnection` to its `sqlite3.connect` call, so the connections
the store actually uses are this module's class, and every contact they make
passes through a method defined here:

  * connect      `ObservedConnection.__init__` — an attempt, and whether it
                 raised (a `?mode=rw` open of a deleted database is a real
                 failed contact, not a missing one);
  * checkout     `store._Pool.acquire` handing a connection to a caller;
  * statement    `execute` / `executemany` / `executescript`, on the connection
                 AND on its cursors, plus `commit()` / `rollback()` — each one
                 an attempt with its outcome;
  * engine step  SQLite's own trace callback, which fires when the engine
                 actually starts running a statement. It is the cross-check:
                 a step with no observed call in progress on that connection is
                 a HIDDEN access and is counted as one.

⚠ WHY THE CONNECTION METHODS ARE OVERRIDDEN AND NOT ONLY THE CURSOR'S. On
Python 3.10 `Connection.execute` is implemented by calling `self.cursor()` and
then that cursor's `execute`, so a cursor subclass alone would see it. On 3.12
and later it does NOT: the C implementation runs the statement on a base
cursor directly and a cursor subclass never hears of it. The shipped runtime is
3.13 and the test interpreter is 3.10, so the only shape that observes the same
thing on both is this one: the connection's three statement methods are
redefined here as `self.cursor().<method>(...)` — the equivalence the sqlite3
documentation itself gives — and all observation lives in `ObservedCursor`.
Nothing is counted twice, because the base cursor's C methods never call back
into Python.

THE PRIVACY BOUNDARY IS THE SAME MECHANISM AS `census._build`'s. A contact is
reduced, on the spot, to members of closed literal sets (`KINDS`, `FIELDS`)
and integers. The statement's first keyword is read to choose a `KINDS` member
and the text is then dropped; SQL text, parameters, the database path, the
slug, row values, error messages and durations have no field to live in. The
trace callback's argument — which on 3.12+ is the statement with its bound
values EXPANDED into it — is never read at all; it is only counted.

WHAT IT REFUSES TO CLAIM. It never reports rows examined, pages read, physical
IO or lock wait: there is no field for any of them, and no duration is kept
from which one could be guessed. `statements` counts ATTEMPTS at the Python
API; `engine_steps` counts what SQLite began to execute; the two are not
expected to be equal (an `executescript` is one attempt and many steps, a
trigger re-reports its parent, a statement refused at prepare is an attempt
and no step, a no-op `commit()` outside a transaction is an attempt and no
step). Connections opened anywhere but `store._open_conn` — see
`UNINSTRUMENTED` — are not observed at all, and neither are PostgreSQL, the
Rust engine or any other process.

⚠ OFF MEANS OFF. Capture is the census's own flag and it is off by default.
While it is off, an observed statement still passes through three extra
Python-level calls (the connection method, the cursor method and the
`_capture_on()` check) before the base method runs — that is the cost of
observing at the actual boundary, and it has not been measured in the
product. No trace callback is installed while off, and one left from an
earlier enabled window is removed on the connection's next statement. The
statement itself is never altered, retried or reordered, and an observation
failure is counted rather than raised: a census may never fail the operation
it measures.
"""
from __future__ import annotations

import re
import sqlite3
import threading
import weakref
from contextvars import ContextVar, Token
from typing import Any, Callable

#: What a statement attempt is, from its first keyword. A closed set: anything
#: that does not match one of these names is `other`, never its own word.
KINDS = ("select", "with", "insert", "update", "delete", "replace", "begin",
         "commit", "rollback", "savepoint", "release", "pragma", "ddl",
         "maintenance", "attach", "other")
_KEYWORD_KIND = {
    "select": "select", "values": "select", "with": "with",
    "insert": "insert", "update": "update", "delete": "delete",
    "replace": "replace", "begin": "begin", "commit": "commit", "end": "commit",
    "rollback": "rollback", "savepoint": "savepoint", "release": "release",
    "pragma": "pragma", "create": "ddl", "drop": "ddl", "alter": "ddl",
    "vacuum": "maintenance", "analyze": "maintenance", "reindex": "maintenance",
    "attach": "attach", "detach": "attach",
}

#: The integer fields of one attempt's contact evidence, and the complete list
#: of them. `census._build` copies exactly these names and nothing else.
FIELDS = ("connects", "connect_failed", "checkouts", "statements",
          "statement_failed", "statement_busy", "engine_steps", "hidden_steps",
          "linked_threads")

#: Process-wide contact counters: evidence that could NOT be joined to an
#: attempt's record, or that the observer itself refused. Merged into the
#: census snapshot's `counters` under a `db_` prefix.
COUNTER_NAMES = ("unattributed", "late", "hidden_unattributed",
                 "self_recursion", "observe_failed")

#: Which primary store this process runs. `store` sets it at import from
#: `ORGTREE_STORE`; until then it is `unknown`, and an attempt's evidence says
#: so rather than letting zero SQLite contacts read as "touched nothing".
STORES = ("sqlite", "json", "unknown")
_primary_store = "unknown"

#: The census's capture flag, installed by `census` at import (this module
#: cannot import `census`, which imports it). The default is OFF.
_capture_on: "Callable[[], bool]" = lambda: False

#: ⚠ THE CONNECTION PATHS THIS MODULE DOES NOT OBSERVE, stated as data so the
#: gap travels with the numbers. Every `sqlite3.connect` call site in this
#: repository's `engine/` tree OUTSIDE the `engine/mailhub` submodule, except
#: `store._open_conn`, is listed here by file and enclosing symbol;
#: `tests/test_census_sqlite_contacts.py` scans that tree and refuses a site
#: that is in neither place. Each of these opens its own database file with
#: the stock connection class; none of it is counted anywhere in the census.
#:
#: ⚠ THE SCAN IS A GUARD, NOT A PROOF. It matches `sqlite3.connect(...)` and
#: `from sqlite3 import connect` under any alias. It does not see
#: `sqlite3.dbapi2.connect`, `getattr(sqlite3, "connect")`, a direct
#: `sqlite3.Connection(...)` construction, or a connection opened by code that
#: is not Python source in this tree.
INSTRUMENTED = (("engine/backend/orgtree/store.py", "_open_conn"),)
UNINSTRUMENTED = (
    ("engine/backend/orgtree/antigravity_provenance.py", "_Read.__init__"),
    ("engine/backend/orgtree/chat_window.py", "project_tail"),
    ("engine/backend/orgtree/desktop_import.py", "_read_document"),
    ("engine/backend/orgtree/desktop_import.py", "_write_candidate"),
    ("engine/backend/orgtree/filedelivery.py", "snapshot"),
    ("engine/backend/orgtree/reply_events.py", "_connect"),
    ("engine/backend/orgtree/reply_events.py", "count"),
    ("engine/backend/orgtree/toolwait.py", "_db"),
    ("engine/backend/orgtree/transcript_records.py", "database"),
    ("engine/mailhub_runtime.py", "MailhubRuntime._migrate_store"),
)

#: ⚠ THE BUNDLED MAIL HUB'S OWN SQLITE STORE, declared separately because it is
#: a separate PROCESS (`MailhubRuntime` runs `python -m mailhub.serve`) built
#: from a separately versioned git SUBMODULE (`engine/mailhub`). Nothing in
#: this process can observe it, and the submodule is absent from checkouts
#: that did not initialise it, so the tree scan above excludes it and these
#: entries are pinned by their own test instead — checked against the
#: submodule source when it is present, declared regardless.
OTHER_PROCESSES = (
    ("engine/mailhub/mailhub/db.py", "connect"),
    ("engine/mailhub/hubtool.py", "_db"),
)

_COUNTERS_LOCK = threading.Lock()
_COUNTERS: "dict[str, int]" = {name: 0 for name in COUNTER_NAMES}

#: The attempt this thread's contacts belong to. Bound by `census.bind` for a
#: request while capture is on, and by `adopt` in a worker thread that was
#: explicitly handed an attempt's tally. `asyncio.to_thread` and the anyio
#: threadpool copy the context, so a sync handler sees its request's tally.
_TALLY: "ContextVar[Tally | None]" = ContextVar("orgtree_census_tally",
                                                default=None)

#: Re-entrancy guard. While this thread is inside the observer's own
#: bookkeeping, a contact it causes is the INSTRUMENT's, not the operation's:
#: it is run untouched, not tallied, and counted in `self_recursion`.
_GUARD = threading.local()


def _bump(name: str, n: int = 1) -> None:
    try:
        with _COUNTERS_LOCK:
            _COUNTERS[name] += n
    except Exception:                                          # noqa: BLE001
        pass


def counters() -> "dict[str, int]":
    with _COUNTERS_LOCK:
        return dict(_COUNTERS)


def reset_counters() -> None:
    with _COUNTERS_LOCK:
        for name in COUNTER_NAMES:
            _COUNTERS[name] = 0


def set_primary_store(backend: str) -> None:
    global _primary_store
    _primary_store = backend if backend in STORES else "unknown"


def install_capture_flag(flag: "Callable[[], bool]") -> None:
    global _capture_on
    _capture_on = flag


# ----------------------------------------------------------- per attempt

class Tally:
    """One attempt's contact evidence. Created by `census.bind` only while
    capture is on; sealed by `census.observe` when the attempt's record is
    built. ⚠ A CONTACT AFTER THE SEAL IS NOT ADDED — the record it would
    belong to is already written — and is counted in `db_late` instead, which
    is where a managed tool's work after its ten-second yield ends up."""

    __slots__ = ("_lock", "_sealed", "_n", "_kinds", "_kind_failed", "store")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sealed = False
        self._n = {name: 0 for name in FIELDS}
        self._kinds: "dict[str, int]" = {}
        self._kind_failed: "dict[str, int]" = {}
        self.store = _primary_store

    def add(self, field: str, kind: "str | None" = None,
            failed: bool = False) -> bool:
        """False when sealed — the caller counts it as late."""
        with self._lock:
            if self._sealed:
                return False
            self._n[field] += 1
            if kind is not None:
                self._kinds[kind] = self._kinds.get(kind, 0) + 1
                if failed:
                    self._kind_failed[kind] = self._kind_failed.get(kind, 0) + 1
            return True

    def seal(self) -> "dict[str, Any]":
        """Close the tally and return its evidence, assembled from closed
        names only. Idempotent: a second seal returns the same numbers."""
        with self._lock:
            self._sealed = True
            out: "dict[str, Any]" = {"store": self.store}
            out.update(self._n)
            out["kinds"] = {k: self._kinds[k] for k in KINDS if k in self._kinds}
            out["kind_failed"] = {k: self._kind_failed[k] for k in KINDS
                                  if k in self._kind_failed}
            return out


def bind(tally: "Tally | None") -> Token:
    return _TALLY.set(tally)


def unbind(token: Token) -> None:
    _TALLY.reset(token)


def current() -> "Tally | None":
    """The tally this thread's contacts go to — for a caller that hands work
    to a thread it starts itself (see `toolwait.invoke`)."""
    return _TALLY.get()


def adopt(tally: "Tally | None") -> None:
    """Bind an attempt's tally in a thread that did not inherit the context.
    Called once at the top of such a thread; the thread's own context is
    discarded with it, so no reset is needed."""
    if tally is None:
        return
    _TALLY.set(tally)
    if not tally.add("linked_threads"):
        _bump("late")


def _note(field: str, kind: "str | None" = None, failed: bool = False) -> None:
    """Credit one contact to this thread's attempt, or count why it could not
    be credited. Never raises."""
    try:
        tally = _TALLY.get()
        if tally is None:
            _bump("unattributed")
        elif not tally.add(field, kind, failed):
            _bump("late")
    except Exception:                                          # noqa: BLE001
        _bump("observe_failed")


def note_checkout() -> None:
    """`store._Pool.acquire` handed a connection to a caller."""
    if _capture_on():
        _note("checkouts")


# -------------------------------------------------------- classification

_LEAD = re.compile(r"(?:\s+|--[^\n]*(?:\n|$)|/\*.*?(?:\*/|$))*", re.S)
_WORD = re.compile(r"[A-Za-z]+")


def kind_of(sql: Any) -> str:
    """A `KINDS` member for a statement, from its first keyword only. The
    text is not kept, and nothing but the returned literal leaves here."""
    if not isinstance(sql, str):
        return "other"
    lead = _LEAD.match(sql)
    word = _WORD.match(sql, lead.end() if lead else 0)
    if word is None:
        return "other"
    return _KEYWORD_KIND.get(word.group(0).lower(), "other")


def _is_busy(error: BaseException) -> bool:
    """SQLITE_BUSY / SQLITE_LOCKED. 3.11+ carries the code; 3.10 has only the
    message, which is read here for this one test and never stored."""
    code = getattr(error, "sqlite_errorcode", None)
    if isinstance(code, int):
        return (code & 0xFF) in (5, 6)
    if not isinstance(error, sqlite3.OperationalError):
        return False
    text = str(error)
    return text.startswith(("database is locked", "database table is locked",
                            "database is busy"))


# ------------------------------------------------------------ the observer

def _untrace(conn: "ObservedConnection") -> None:
    try:
        conn.set_trace_callback(None)
    except Exception:                                          # noqa: BLE001
        pass
    conn._census_traced = False


def _ensure_trace(conn: "ObservedConnection") -> None:
    """Install SQLite's statement callback on this connection. Weakly bound:
    the connection holds the callback, and a callback holding the connection
    would be a cycle that keeps a closed pool connection alive."""
    if conn._census_traced:
        return
    ref = weakref.ref(conn)

    def _step(_statement: Any) -> None:
        # ⚠ `_statement` IS NEVER READ. On 3.12+ it is the SQL with its bound
        # values expanded into it. It is counted, and that is all.
        try:
            if not _capture_on():
                return
            owner = ref()
            if owner is None:
                return
            if owner._census_in_call > 0:
                _note("engine_steps")
            elif _TALLY.get() is None:
                _bump("hidden_unattributed")
            else:
                # SQLite ran a statement on an observed connection while no
                # observed method was running on it — something reached the
                # engine around the boundary this module claims to watch.
                _note("hidden_steps")
        except Exception:                                      # noqa: BLE001
            _bump("observe_failed")

    try:
        conn.set_trace_callback(_step)
        conn._census_traced = True
    except Exception:                                          # noqa: BLE001
        _bump("observe_failed")


def _run(conn: "ObservedConnection", sql: Any, call: "Callable[[], Any]") -> Any:
    """Run one statement attempt, observed. The statement runs exactly as the
    unobserved path would; only bookkeeping is added around it."""
    if not _capture_on():
        if conn._census_traced:
            _untrace(conn)
        return call()
    if getattr(_GUARD, "active", False):
        # The observer's own bookkeeping reached SQLite. Not the operation's.
        _bump("self_recursion")
        return call()
    _GUARD.active = True
    try:
        kind = kind_of(sql)
        _ensure_trace(conn)
    except Exception:                                          # noqa: BLE001
        _bump("observe_failed")
        kind = "other"
    finally:
        _GUARD.active = False
    conn._census_in_call += 1
    failed = busy = False
    try:
        return call()
    except BaseException as error:
        failed = True
        try:
            busy = _is_busy(error)
        except Exception:                                      # noqa: BLE001
            busy = False
        raise
    finally:
        conn._census_in_call -= 1
        _GUARD.active = True
        try:
            _note("statements", kind, failed)
            if failed:
                _note("statement_failed")
            if busy:
                _note("statement_busy")
        finally:
            _GUARD.active = False


class ObservedCursor(sqlite3.Cursor):
    """Every statement a store cursor runs, observed. See the module
    docstring for why the connection's own methods route here."""

    def execute(self, sql: str, parameters: Any = (), /) -> "ObservedCursor":
        base = super().execute
        return _run(self.connection, sql, lambda: base(sql, parameters))

    def executemany(self, sql: str, seq_of_parameters: Any, /) -> "ObservedCursor":
        base = super().executemany
        return _run(self.connection, sql, lambda: base(sql, seq_of_parameters))

    def executescript(self, sql_script: str, /) -> "ObservedCursor":
        base = super().executescript
        return _run(self.connection, sql_script, lambda: base(sql_script))


class ObservedConnection(sqlite3.Connection):
    """The primary store's connection class (`store._open_conn` passes it as
    `factory=`). Behaves exactly as `sqlite3.Connection` does; see the module
    docstring for what it adds."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._census_in_call = 0
        self._census_traced = False
        on = _capture_on()
        try:
            super().__init__(*args, **kwargs)
        except BaseException:
            if on:
                _note("connects")
                _note("connect_failed")
            raise
        if on:
            _note("connects")
            _ensure_trace(self)

    def cursor(self, factory: Any = ObservedCursor) -> Any:
        # A caller supplying its own cursor class gets it, unobserved — and
        # the trace callback then counts its statements as hidden steps.
        return super().cursor(factory)

    def execute(self, sql: str, parameters: Any = (), /) -> Any:
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql: str, seq_of_parameters: Any, /) -> Any:
        return self.cursor().executemany(sql, seq_of_parameters)

    def executescript(self, sql_script: str, /) -> Any:
        return self.cursor().executescript(sql_script)

    def commit(self) -> None:
        base = super().commit
        _run(self, "commit", base)

    def rollback(self) -> None:
        base = super().rollback
        _run(self, "rollback", base)


#: The limits a reader must carry away with contact numbers. Published in the
#: census payload beside `LIMITS`.
LIMITS = (
    "db contact evidence covers ONLY connections made by store._open_conn "
    "(the primary store). Every path in contact_coverage.uninstrumented, the "
    "bundled mail hub's store (contact_coverage.other_processes), PostgreSQL, "
    "the Rust engine and any other process are not observed.",
    "db is present only on attempts that began while capture was on; its "
    "absence means not observed, never zero contacts.",
    "statements counts API-level attempts; engine_steps counts statements "
    "SQLite began to execute. They are not expected to be equal.",
    "No rows examined, pages read, physical IO or lock wait is measured, and "
    "no duration is kept from which one could be inferred.",
    "Contacts on threads that were not handed the attempt are counted in "
    "counters.db_unattributed; contacts after an attempt's record was built "
    "(for example a managed tool's work after its yield) in counters.db_late. "
    "Neither is joined to any record.",
    "hidden_steps and counters.db_hidden_unattributed count statements SQLite "
    "ran on an observed connection outside any observed call; they can only "
    "be seen on a connection whose trace was installed while capture was on.",
)


def coverage() -> "dict[str, Any]":
    """What the contact evidence covers, as data."""
    return {
        "primary_store": _primary_store,
        "instrumented": [{"path": p, "symbol": s} for p, s in INSTRUMENTED],
        "uninstrumented": [{"path": p, "symbol": s} for p, s in UNINSTRUMENTED],
        "other_processes": [{"path": p, "symbol": s, "process": "mailhub"}
                            for p, s in OTHER_PROCESSES],
        "complete": False,
        "kinds": list(KINDS),
        "fields": list(FIELDS),
    }
