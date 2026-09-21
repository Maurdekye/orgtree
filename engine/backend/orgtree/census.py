"""The all-operation census: one classified record per ATTEMPTED operation.

⚠ WHAT ONE RECORD IS, AND IT IS NOT A LOGICAL OPERATION. Schema 2 says so in
the record itself (`unit: "attempt"`). A row here is ONE HTTP ATTEMPT observed
by the access middleware. A logical operation may be several attempts (a retry,
a poll), and for the eight `mcptool.MANAGED_WAIT_TOOLS` it may OUTLIVE the
attempt entirely — `toolwait.invoke` answers HTTP 200 `{"state": "running"}`
after ten seconds while a daemon thread carries on and delivers the real
result, including a refusal, later as durable mail. Such a row is marked
`terminal: false` and is NEVER given `outcome: "ok"`. Joining attempts into
logical operations needs a causal key this stage does not have.

WHY THIS IS NOT A SETTING ON THE EXISTING INSTRUMENT. Three sinks already
observe requests and every one of them is biased in a way that makes the
question this census answers unanswerable:

  * `api._PROFILE_RECORDS` appends only while the operator toggle is on AND
    the handler contributed a stage, so uninstrumented and fast routes are
    absent by design;
  * `slowtrace` persists only `handler_ms >= 500`, which is the slow-only
    bias this census exists to remove — the architect's retained population
    of 18,723 rows has a smallest handler duration of 500.010 ms and 471
    rows with any lock timing at all;
  * `stateprobe` aggregates rather than enumerating, and ⚠ its `recent` ring
    carries NODE IDS (`store.py`'s `save_doc` hook passes
    `detail={"changed": changes.as_dict()}`, and `SaveChanges.as_dict()`
    includes `node_updates`/`node_inserts`/`node_deletes`). That is safe
    behind its operator-only gate and it is exactly why the census, which is
    agent-readable, is a separate sink rather than a widening of it.

So the census is its own bounded ring with its own schema version, its own
counters, its own enable flag and its own two permissions. It changes nothing
about what the three sinks above emit.

WHAT IT COSTS. `api.AccessRecord.__call__` already binds a profile dict for
EVERY request regardless of any toggle (its own comment: "⚠ ALWAYS BOUND"),
and `store.DOC_LOCK` already accumulates into it. So the stage and lock
numbers are collected today whether or not anybody reads them. The census's
marginal cost per request is one classification slot bind, one profile freeze,
one dict build and one `deque.append` — and, while capture is OFF, a single
integer increment. ⚠ THAT COST IS ARGUED HERE AND HAS NOT BEEN MEASURED. The
default stays off until it is; measuring it is a separate stage.

⚠ THAT INTEGER IS DELIBERATE AND IT IS NOT AN OVERSIGHT. `observed` counts
every request the middleware saw, enabled or not. It is the only honest
denominator across an enable/disable boundary, and it instruments the control
itself: a window whose `observed` did not advance is a window in which nothing
ran, and this module says so rather than publishing a clean latency from it. A
negative control that "passes" because it never executed is the failure this
team has been bitten by repeatedly; `observed` is what makes that visible here.

THE PRIVACY BOUNDARY IS A MECHANISM, NOT A PROMISE. Every value in a record is
one of exactly four kinds and there is no fifth:
  1. a route TEMPLATE, read off the route table by `api._route_label`;
  2. a finite number under a name in `_NUMERIC_FIELDS`, or `null`;
  3. a member of a catalogue enum (`census_classes`), checked by membership;
  4. a member of a census-local literal set (`RW`/`SCOPE`/`SCOPE_SRC`/
     `OUTCOME`/`METHOD`/`NONTERMINAL_REASON`), written from a literal.
Nothing else can enter a record. A slug, node id, mail id, seat id, token,
path, argument, prompt, body or caption has no field to live in, and giving
one a field would mean editing a set in this file. `_build` enforces this by
construction rather than by filtering afterwards: the record is assembled from
known-safe values, exactly as `api._access_emit` rebuilds its own sink row
from vetted fields rather than from the dict it just printed.

⚠ SCHEMA 2 CLOSED THE FIFTH KIND. Schema 1 recorded `scope["method"]` RAW off
the ASGI scope, which admits any RFC 9110 token — an arbitrary ASCII string in
an agent-readable sink, in a module whose whole contract is that there are
exactly four kinds of value. It now goes through `classes.validated_method`,
and every numeric goes through `_number`, including the five the middleware
passes directly (`status`, `handler_ms`, `total_ms`, `bytes`, `inflight`)
which schema 1 converted with a bare `int()`/`float()`.

⚠ A CENSUS WRITE MAY NEVER FAIL THE OPERATION IT MEASURES. `observe` swallows
its own errors — and, unlike a bare `except: pass`, it COUNTS them in
`rejected`, so a silently-degrading instrument shows up as a number instead of
as a clean-looking empty sink. It never runs under the document lock.

WHAT THIS MODULE DOES NOT MEASURE, stated here because the payload is read by
agents. It observes no storage contact: there is no database, connection,
cursor, transaction, relation or statement field, and `lock_*` is the
in-process document lock, not a database. `scope` is a source-based candidate
classification (`scope_src: "table"`) or a route-template shape
(`"route_shape"`) — `"declared"` means a handler said so, which is still not an
observation, and no handler declares today, so `provenance.declared_coverage`
is 0.0. No locality proportion may be drawn from this instrument.
"""
from __future__ import annotations

import collections
import math
import os
import secrets
import threading
import time
from contextvars import ContextVar, Token
from typing import Any

from . import census_classes as classes
from . import profiling

#: Bump on ANY change to record shape or field meaning. Published in every
#: snapshot so an analysis written against one schema cannot silently consume
#: another.
#:
#: 2 — attempt-level `unit`/`terminal`, closed `method`, `null` for an
#:     unmeasurable number, `no_response_start`, window generation, self-read
#:     exclusion and `diagnostic`, process `instance`, `provenance`.
SCHEMA_VERSION = 2

#: Off by default. The item allows on-by-default only if measured overhead is
#: negligible, and switching it on in a running product is a live behaviour
#: change that this seat is explicitly not authorized to make.
_ENABLED = os.environ.get("ORGTREE_OPERATION_CENSUS") == "1"

#: Bounded retention, in memory only: no file, no rotation to get wrong, no
#: disk-full failure mode, and the process can never grow past it.
_MIN_CAPACITY, _MAX_CAPACITY, _DEFAULT_CAPACITY = 64, 262_144, 8192


def _capacity_from_env() -> int:
    try:
        want = int(float(os.environ.get("ORGTREE_CENSUS_MAX", _DEFAULT_CAPACITY)))
    except (TypeError, ValueError):
        return _DEFAULT_CAPACITY
    return max(_MIN_CAPACITY, min(_MAX_CAPACITY, want))


_CAPACITY = _capacity_from_env()

#: ⚠ A REAL LOCK, not a GIL argument. `api._PROFILE_RECORDS` documents that
#: `list(deque)` is atomic under CPython and that the safety is GIL-derived.
#: This sink additionally maintains counters that must stay CONSISTENT WITH
#: each other and with the ring (`recorded`, `evicted` and `len(_RECORDS)` are
#: cross-checked by a test), and a read-modify-write of two integers is not
#: atomic even under the GIL. The hold is a handful of dict and int
#: operations, outside the document lock, on the thread that just finished a
#: request.
_LOCK = threading.Lock()
_RECORDS: "collections.deque[dict[str, Any]]" = collections.deque(maxlen=_CAPACITY)
_SEQ = 0

_COUNTER_NAMES = ("observed", "skipped_disabled", "skipped_self", "recorded",
                  "evicted", "rejected", "dropped_stale_window",
                  "dropped_capture_off", "nonterminal", "no_response_start",
                  "unclassified_tool", "unclassified_action",
                  "unclassified_scope", "unclassified_method")
_COUNTERS: "dict[str, int]" = {name: 0 for name in _COUNTER_NAMES}

#: Window origin. `_WINDOW_AT` is ONE wall clock published at snapshot level;
#: per-record time is an OFFSET from `_WINDOW_T0` (see `_build`).
#:
#: ⚠ `_WINDOW_GEN` IS THE FIX FOR THE RESET RACE, and it is load-bearing.
#: `observe` counts `observed` in one critical section, builds the record
#: outside the lock, and appends in a second. A `reset()` landing between the
#: two used to append a record measured against the OLD `_WINDOW_T0` into the
#: NEW window — its `t_ms` could exceed the window's own `window_ms`, it
#: consumed `seq 1` of a window it did not belong to, and its `observed` had
#: already been zeroed, so `recorded > observed` was reachable inside a single
#: window. That breaks this module's headline claim that `observed` is the
#: only honest denominator, at exactly the boundary an operator uses to take a
#: clean before/after measurement. The generation is captured with `observed`
#: and re-checked at append; a mismatch DROPS the record and COUNTS it.
_WINDOW_AT = time.time()
_WINDOW_T0 = time.perf_counter()
_WINDOW_GEN = 1

#: Numeric fields a record may carry from the profile dict, and the complete
#: list of them. A name outside this set cannot reach a record even if a
#: handler accumulates it into the profile dict — the same closed-allowlist
#: rule `api._PROFILE_ALLOWED_FIELDS` enforces, restated here because this
#: sink builds its own row rather than reusing that one.
#:
#: ⚠ SIX OF THESE ARE NOT WRITTEN BY ANYTHING YET. At this commit `profiling`
#: writes `lock_wait_ms` (in `TimedRLock.acquire`) and the stage fields; the
#: `lock_hold_ms`/`lock_acquires`/`lock_contended`/`lock_failed`/
#: `lock_max_depth` group arrives with the lock-boundary stage. An absent
#: field is simply skipped, so listing them here is forward compatibility and
#: not a claim that they are collected — a reader must not read their absence
#: as "no contention", only as "not measured".
_NUMERIC_FIELDS = (
    # stage decomposition, already collected by `profiling`
    "load_snapshot_ms", "tree_ms", "annotate_ms", "chat_read_ms",
    "history_work_ms", "org_load_ms", "org_save_ms", "mutate_ms",
    "org_load_cpu_ms", "org_save_cpu_ms", "mutate_cpu_ms",
    "chat_read_cpu_ms", "history_work_cpu_ms",
    # lock / transaction boundary
    "lock_wait_ms", "lock_hold_ms", "lock_acquires", "lock_contended",
    "lock_failed", "lock_max_depth",
)
#: Of those, the WALL stage fields that decompose handler time. Counts and CPU
#: re-measurements are excluded: letting either into the subtraction would
#: make `unattributed_ms` meaningless.
_WALL_STAGE_FIELDS = frozenset({
    "load_snapshot_ms", "tree_ms", "annotate_ms", "chat_read_ms",
    "history_work_ms", "org_load_ms", "org_save_ms", "mutate_ms",
})

#: Why a record is not terminal. A census-local literal set, like `RW` and
#: `OUTCOME`; only this module writes it.
NONTERMINAL_REASON = ("managed_yield",)

#: ⚠ THE CENSUS MUST NOT RECORD ITS OWN READS. `api._access_emit`'s bounded
#: sink already excludes its own route in so many words ("not this route
#: itself — a caller polling `/api/desktop/profile-timing`"); schema 1 had no
#: such exclusion, so a reader polling the census recorded its own polls as
#: ordinary operations and inflated the very denominator it was reading. The
#: READ doors are excluded from the ring and COUNTED in `skipped_self` — the
#: exclusion is visible rather than silent. `observed` still advances, because
#: it is the denominator of requests the middleware saw, not of records kept.
#:
#: The two operator CONTROL doors (the toggle and the reset) are POST, are not
#: reads, and stay in the ring marked `diagnostic: true` — an operator
#: changing capture state is a real operation somebody may need to see.
_SELF_ROUTES = frozenset({"/api/diagnostics/operation-census"})
_SELF_TOOLS = frozenset({"orgtree_operation_census"})
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

#: Routes whose records are marked as the instrument's own work rather than
#: the organization's. Prefix-matched on the TEMPLATE.
_DIAGNOSTIC_PREFIXES = ("/api/diagnostics", "/api/desktop/profile-timing")

#: The process incarnation, so a reader who sees a smaller `seq` knows the
#: process changed rather than reading it as "less happened". Resolved from
#: `api.INSTANCE` — the same stamp the shipped profile sink publishes, so the
#: two sinks can be correlated — by LAZY import, because `api` imports this
#: module and a module-scope import would be a cycle. The fallback is used but
#: NOT memoised, so a call made while `api` is still importing cannot pin the
#: wrong value for the life of the process.
_FALLBACK_INSTANCE = secrets.token_hex(8)
_INSTANCE: "str | None" = None


def instance() -> str:
    global _INSTANCE
    if _INSTANCE is None:
        value = None
        try:
            from . import api
            value = getattr(api, "INSTANCE", None)
        except Exception:                                      # noqa: BLE001
            value = None
        if not value:
            return _FALLBACK_INSTANCE
        _INSTANCE = str(value)
    return _INSTANCE


# ------------------------------------------------------- per-request slot

#: What the dispatch learned about THIS call: tool, action, sub, and any scope
#: a handler declared. A separate ContextVar from `profiling._CURRENT` on
#: purpose — the census must not change what the existing instrument emits,
#: and sharing its dict would put census keys into `profiling.snapshot`.
_CALL: "ContextVar[dict[str, Any] | None]" = ContextVar(
    "orgtree_census_call", default=None)


def bind() -> Token:
    """Open a classification slot for this request. Always called, cheaply,
    so a handler can `classify`/`declare` without knowing whether capture is
    on — the slot is one empty dict and is thrown away if nothing uses it."""
    return _CALL.set({})


def unbind(token: Token) -> None:
    _CALL.reset(token)


def classify(tool: "str | None", args: "Any", caller: "str | None") -> None:
    """Record WHICH operation this is, from validated command data only.

    Called from the agent gateway, where the tool name and its arguments are
    already in hand. Nothing here loads organization state: the architect is
    explicit that telemetry must "classify from validated command data without
    loading org state", and the only thing read out of `args` is membership in
    a catalogue enum plus the SHAPE of any target references.
    """
    slot = _CALL.get()
    if slot is None:
        return
    try:
        if not isinstance(tool, str) or tool not in classes.tool_names():
            # Not in the catalogue: dropped exactly as `api._access_emit`
            # drops an uncatalogued verb, and counted so the gap is visible.
            slot["tool_unknown"] = True
            return
        slot["tool"] = tool
        if not isinstance(args, dict):
            args = {}
        action, field = classes.validated_action(tool, args)
        if action is not None:
            slot["action"] = action
            slot["action_of"] = field
        sub = classes.validated_sub(tool, args, skip=field)
        if sub:
            slot["sub"] = sub
        n, all_self, external = classes.target_shape(args, caller)
        slot["targets"] = n
        slot["targets_self"] = all_self
        if external:
            # A target shape that leaves the organization beats the table:
            # `orgtree_message to="user"` is not agent-to-agent mail.
            slot["external_target"] = True
    except Exception:                                          # noqa: BLE001
        slot["classify_failed"] = True


def managed_state(result: "Any") -> None:
    """⚠ HTTP 200 IS NOT THIS OPERATION'S OUTCOME, and this is where the
    census learns that.

    The eight `mcptool.MANAGED_WAIT_TOOLS` run through `toolwait.invoke`,
    which waits `WAIT_S = 10.0` seconds and then, if the work is unfinished,
    answers HTTP 200 with `{"state": "running", "operation_id": …}` while a
    daemon thread continues and delivers the real result — a completion OR a
    refusal — later as durable mail. Schema 1 recorded that as
    `outcome: "ok"`, which is the exact logical-operation conflation this
    census exists to remove: the completion, the refusal, the lock waits and
    the commit are never observed here at all, because `observe` runs only in
    HTTP middleware.

    So a yielded call is marked NON-TERMINAL. It is not `ok`, it is not
    counted as a completion, and `outcome` falls back to `unknown` — which is
    the truth: at the moment this record is written, nobody knows. The
    `operation_id` that would join this attempt to its completion is NOT
    recorded; it is an identifier, and causal linkage is a later stage.
    """
    slot = _CALL.get()
    if slot is None:
        return
    try:
        if isinstance(result, dict) and result.get("state") == "running":
            slot["nonterminal"] = "managed_yield"
    except Exception:                                          # noqa: BLE001
        slot["classify_failed"] = True


def declare(rw: "str | None" = None, scope: "str | None" = None) -> None:
    """A handler states the read/write kind or ownership scope it ALREADY
    computed for authorization. Produces `scope_src: "declared"`.

    ⚠ `declared` IS STILL NOT AN OBSERVED CONTACT. It outranks the static
    table because the handler that authorized the call said so, rather than a
    table guessing from the verb — but it remains a declaration. Comparing a
    declaration against observed connection and statement activity is what
    would make it a measurement, and there is no contact instrumentation in
    this schema at all.

    ⚠ AND NOTHING IN THE PRODUCT CALLS THIS TODAY. That is deliberate rather
    than forgotten: wiring it means editing the handlers that compute
    authorization scope, which is outside this stage's file ownership. The
    consequence is published rather than hidden — `provenance.declared_coverage`
    in every snapshot is the fraction of served rows whose `scope_src` is
    `declared`, and it is 0.0 while this function has no caller. The API
    surface is kept so the later stage wires callers rather than re-inventing
    the door.

    Values outside the published enums are ignored rather than stored, so a
    future caller cannot introduce a new scope word by writing one.
    """
    slot = _CALL.get()
    if slot is None:
        return
    if isinstance(rw, str) and rw in classes.RW:
        slot["declared_rw"] = rw
    if isinstance(scope, str) and scope in classes.SCOPE:
        slot["declared_scope"] = scope


# ------------------------------------------------------------- the record

def _number(value: Any) -> "float | None":
    """A finite, non-boolean number, or None.

    `isinstance(True, int)` is True in Python, and `math.isfinite` is what
    rejects NaN/Infinity/-Infinity — all three are valid Python floats and
    `json.dumps` emits them as the non-standard literals `NaN`/`Infinity`,
    which is not the same promise as "a real number a reader can chart".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _count(value: Any) -> "int | None":
    """A finite non-boolean number as an int, or None. ⚠ `None` MEANS NOT
    MEASURABLE AND NEVER ZERO — a reader charting `bytes` must be able to tell
    a response that carried nothing from one whose size was never established."""
    number = _number(value)
    return None if number is None else int(number)


def _is_diagnostic(route: str, tool: "str | None") -> bool:
    if tool in _SELF_TOOLS:
        return True
    return any(route.startswith(prefix) for prefix in _DIAGNOSTIC_PREFIXES)


def _is_self_read(method: str, route: str, slot: "dict[str, Any] | None") -> bool:
    """The census reading itself. Excluded from the ring, counted in
    `skipped_self`."""
    if route in _SELF_ROUTES and method in _READ_METHODS:
        return True
    return bool(slot) and slot.get("tool") in _SELF_TOOLS


def _build(method: str, route: str, status: int, handler_ms: float,
           total_ms: float, nbytes: int, inflight: int,
           profile: "dict[str, Any] | None",
           slot: "dict[str, Any] | None",
           *, window_t0: "float | None" = None,
           ) -> "tuple[dict[str, Any], list[str]]":
    """Assemble one record from known-safe values, plus the list of counter
    names this record should advance.

    ASSEMBLED, NOT FILTERED. Nothing is copied wholesale from `profile` or
    `slot` and then cleaned up; each field is read by name, checked, and
    written. A field a future handler invents therefore cannot appear here by
    default — it has to be added to `_NUMERIC_FIELDS` on purpose.

    ⚠ `profile` SHOULD ALREADY BE A FROZEN COPY when this is called from
    `observe`; see `_freeze`. This function does not take `profiling`'s mutex
    itself, because it is also called directly by tests with a plain dict.
    """
    bumps: "list[str]" = []
    slot = slot or {}
    profile = profile or {}
    t0 = _WINDOW_T0 if window_t0 is None else window_t0

    verb = classes.validated_method(method)
    if verb == "other":
        # An unrecognised method token is a real event a reader should see —
        # it is just not a value this sink will echo back.
        bumps.append("unclassified_method")

    tool = slot.get("tool")
    tool = tool if isinstance(tool, str) else None
    if tool is None and slot.get("tool_unknown"):
        bumps.append("unclassified_tool")
    action = slot.get("action")
    action = action if isinstance(action, str) else None

    if tool is not None:
        rw, scope, src = classes.classify_tool(tool, action)
        if action is None:
            bumps.append("unclassified_action")
        if slot.get("external_target"):
            # Target shape is command data, not a table entry — it outranks
            # the table and says so.
            scope, src = "external", "table"
    else:
        rw, scope, src = classes.classify_route(verb, route)

    declared_rw, declared_scope = slot.get("declared_rw"), slot.get("declared_scope")
    if isinstance(declared_rw, str):
        rw = declared_rw
    if isinstance(declared_scope, str):
        scope, src = declared_scope, "declared"
    if scope == "unknown":
        bumps.append("unclassified_scope")

    op = ("tool:" + tool + (":" + action if action else "")) if tool \
        else (verb + " " + route)

    # ⚠ THE `-1.0` SENTINEL IS NOT A LATENCY. `api.AccessRecord.__call__`
    # initialises `handler_ms = -1.0` and assigns it only on
    # `http.response.start`, so a client disconnect leaves the sentinel in
    # place. Schema 1 recorded it as `-1.0` and subtracted the stage wall from
    # it, so any p50/p90/p99 over the ring silently included negative
    # durations; the slow-only sink escapes that only because it filters
    # `handler_ms >= 500`. A missing response start is now `null` with an
    # explicit flag, and it contributes no `unattributed_ms` at all.
    handler = _number(handler_ms)
    missing_start = handler is None or handler < 0.0
    if missing_start:
        handler = None
        bumps.append("no_response_start")

    code = _count(status)
    total = _number(total_ms)
    record: "dict[str, Any]" = {
        "v": SCHEMA_VERSION,
        # ⚠ ONE ROW IS ONE ATTEMPT, NOT ONE LOGICAL OPERATION. Stated in the
        # record so an analysis cannot quietly treat the two as the same.
        "unit": "attempt",
        "t_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        "method": verb,
        "route": route,
        "op": op,
        "rw": rw,
        "scope": scope,
        "scope_src": src,
        "outcome": classes.outcome_of(code if code is not None else 0),
        "terminal": True,
        "status": code if code is not None else 0,
        "handler_ms": None if handler is None else round(handler, 3),
        "total_ms": None if total is None else round(total, 3),
        "bytes": _count(nbytes),
        "inflight": _count(inflight),
    }
    if missing_start:
        record["no_response_start"] = True
    if _is_diagnostic(route, tool):
        # The instrument's own work, identified once so it is not read as the
        # organization's.
        record["diagnostic"] = True

    nonterminal = slot.get("nonterminal")
    if isinstance(nonterminal, str) and nonterminal in NONTERMINAL_REASON:
        # ⚠ NEVER `ok`. The HTTP status stays what it was — 200 is a true fact
        # about the transport — but the OPERATION's outcome is not known at
        # this point and the record says exactly that.
        record["terminal"] = False
        record["nonterminal_reason"] = nonterminal
        record["outcome"] = "unknown"
        bumps.append("nonterminal")

    if tool is not None:
        record["tool"] = tool
    if action is not None:
        record["action"] = action
        of = slot.get("action_of")
        if isinstance(of, str):
            record["action_of"] = of
    sub = slot.get("sub")
    if isinstance(sub, dict) and sub:
        record["sub"] = dict(sub)
    targets = slot.get("targets")
    if isinstance(targets, int):
        # A COUNT and a BOOLEAN. `census_classes.target_shape` compares the
        # target references against the caller and discards both operands;
        # no reference reaches this record.
        record["targets"] = targets
        record["targets_self"] = bool(slot.get("targets_self"))

    wall = 0.0
    for field in _NUMERIC_FIELDS:
        value = _number(profile.get(field))
        if value is None:
            continue
        record[field] = round(value, 3)
        if field in _WALL_STAGE_FIELDS:
            wall += value
    if handler is not None:
        # Deliberately UNCLAMPED, matching the existing instrument: a negative
        # value says two stage brackets covered the same interval, which is an
        # attribution bug worth seeing rather than rounding away. Omitted
        # entirely when there is no handler duration to decompose — a
        # subtraction from an unknown is not a number.
        record["unattributed_ms"] = round(handler - wall, 3)
    return record, bumps


def _freeze(profile: "dict[str, Any] | None") -> "dict[str, Any]":
    """A stable copy of the profile dict, taken under `profiling`'s OWN mutex.

    ⚠ ONE PROFILE DICT CAN HAVE TWO WRITERS, and schema 1 read the live one.
    A managed tool's worker thread rebinds the SAME dict (`toolwait.invoke`
    passes `profiling.current()` into the worker, which calls
    `profiling.bind(_profile)`) and keeps writing to it after the request has
    yielded. `_access_emit` has taken a `profiling.snapshot` copy for exactly
    this reason since the mutex was added — its own comment names the
    `RuntimeError: dictionary changed size during iteration` that arrives
    inside an `except Exception: pass` and makes a record vanish without a
    trace. The census read that live dict field by field with no mutex at all,
    so a published record could be built from two different instants.
    """
    return profiling.snapshot(profile)


# -------------------------------------------------------------- collection

def observe(method: str, route: str, status: int, handler_ms: float,
            total_ms: float, nbytes: int, inflight: int,
            profile: "dict[str, Any] | None" = None) -> None:
    """Record one ATTEMPTED operation. Called from the access middleware's
    `finally`, so a handler that raised is recorded exactly as one that
    returned — a request that fails is as much an operation as one that
    succeeds, and it is the one an outcome census must not lose.

    THREE CRITICAL SECTIONS, and the split is deliberate:

      1. count `observed` (the denominator advances for EVERY request the
         middleware saw, capture on or off), decide whether to capture at all,
         and take the window generation and origin;
      2. freeze the profile and build the record with no lock held, because
         the build is the expensive part and it must not sit in front of other
         request threads;
      3. append — but only if the window is still the one the record was
         measured against, and only if capture is still on. Either mismatch
         DROPS the record and counts it, so `recorded` can never exceed
         `observed` inside one window.
    """
    global _SEQ
    try:
        with _LOCK:
            _COUNTERS["observed"] += 1
            if not _ENABLED:
                _COUNTERS["skipped_disabled"] += 1
                return
            generation, origin = _WINDOW_GEN, _WINDOW_T0
        slot = _CALL.get()
        verb = classes.validated_method(method)
        if _is_self_read(verb, route, slot):
            with _LOCK:
                _COUNTERS["skipped_self"] += 1
            return
        record, bumps = _build(method, route, status, handler_ms, total_ms,
                               nbytes, inflight, _freeze(profile), slot,
                               window_t0=origin)
        with _LOCK:
            if generation != _WINDOW_GEN:
                # Built against a window that has since been reset. Its `t_ms`
                # is measured from an origin this window does not have and its
                # `observed` has already been zeroed; appending it here is how
                # `recorded > observed` became reachable.
                _COUNTERS["dropped_stale_window"] += 1
                return
            if not _ENABLED:
                # Capture was switched off while this record was being built.
                _COUNTERS["dropped_capture_off"] += 1
                return
            _SEQ += 1
            record["seq"] = _SEQ
            evicted = 1 if len(_RECORDS) == _RECORDS.maxlen else 0
            _RECORDS.append(record)
            _COUNTERS["recorded"] += 1
            _COUNTERS["evicted"] += evicted
            for name in bumps:
                _COUNTERS[name] += 1
    except Exception:                                          # noqa: BLE001
        # COUNTED, not merely swallowed. A bare `except: pass` here would make
        # a degrading instrument look like a quiet one; this makes it a number
        # a reader can see. The counter write is itself guarded, because the
        # only way to reach this line with the lock held would be a failure
        # inside the block above.
        try:
            with _LOCK:
                _COUNTERS["rejected"] += 1
        except Exception:                                      # noqa: BLE001
            pass


def enabled() -> bool:
    return _ENABLED


def set_enabled(on: bool) -> "dict[str, Any]":
    """Operator-only in practice — the permission lives on the route, not
    here. Returns the resulting state so a caller never has to assume."""
    global _ENABLED
    with _LOCK:
        _ENABLED = bool(on)
        state = _ENABLED
    return {"enabled": state, "schema_version": SCHEMA_VERSION}


def reset(capacity: "int | None" = None) -> None:
    """Start a fresh capture window: empties the ring, zeroes every counter,
    restarts the clock and OPENS A NEW GENERATION. Used by the operator to
    take a clean before/after measurement, and by tests.

    ⚠ `_SEQ` RESTARTS TOO, and that is why `evicted` is kept as its own
    counter rather than only derived from `records[0]["seq"] - 1`: after a
    reset the derivation would be right again, but between the two there must
    be no window in which one of them silently lies. `snapshot` publishes both
    and a test asserts they agree.

    ⚠ AND THE GENERATION IS WHY AN IN-FLIGHT `observe` CANNOT LAND HERE. See
    `_WINDOW_GEN`: a record built against the previous generation is dropped
    at append and counted in `dropped_stale_window`, rather than arriving in
    this window with a foreign clock origin and a sequence number it stole.
    """
    global _SEQ, _WINDOW_AT, _WINDOW_T0, _WINDOW_GEN, _CAPACITY, _RECORDS
    with _LOCK:
        if capacity is not None:
            _CAPACITY = max(_MIN_CAPACITY, min(_MAX_CAPACITY, int(capacity)))
            _RECORDS = collections.deque(maxlen=_CAPACITY)
        else:
            _RECORDS.clear()
        _SEQ = 0
        for name in _COUNTER_NAMES:
            _COUNTERS[name] = 0
        _WINDOW_AT = time.time()
        _WINDOW_T0 = time.perf_counter()
        _WINDOW_GEN += 1


def _provenance(rows: "list[dict[str, Any]]") -> "dict[str, Any]":
    """Where the `scope` values in THIS response came from, and what they are
    not.

    ⚠ PUBLISHED RATHER THAN LEFT TO A READER, because the failure this guards
    against is somebody dividing two numbers out of `records` and calling the
    result a locality proportion. `table` is a source-based candidate
    classification; `route_shape` is a template's shape; `declared` is a
    handler's own statement. NONE of them is an observed storage contact, and
    this schema has no field in which a contact could even be expressed.
    """
    counts = {name: 0 for name in classes.SCOPE_SRC}
    for row in rows:
        src = row.get("scope_src")
        if src in counts:
            counts[src] += 1
    total = len(rows)
    return {
        "scope_src_counts": counts,
        "declared_coverage": round(counts["declared"] / total, 6) if total else 0.0,
        "measures_storage_contacts": False,
        "unit": "attempt",
        "note": ("scope is a source-based candidate classification (table), a "
                 "route-template shape (route_shape), or a handler's own "
                 "statement (declared) - never an observed storage contact. "
                 "No handler declares at this schema, so declared_coverage is "
                 "0.0. This instrument proves no locality proportion and "
                 "publishes no denominator of logical operations."),
    }


#: The limits a reader must carry away with the numbers, in the payload rather
#: than in a document they may not have.
LIMITS = (
    "One record is one HTTP ATTEMPT (unit=attempt), not one logical operation.",
    "terminal=false means the operation had not finished when this row was "
    "written; its real result, including a refusal, is not in this sink.",
    "Non-HTTP work - workers, tasks, callbacks, hooks, websockets and restart "
    "recovery - is not observed at all.",
    "No storage contact is measured: there is no database, connection, cursor, "
    "transaction, relation or statement field, and lock_* is the in-process "
    "document lock, not a database.",
    "bytes is the HTTP response size, never a storage rows-or-bytes figure.",
    "Overhead is argued in census.py and has not been measured; the default "
    "is off because of that.",
    "Census read doors are excluded from the ring (counters.skipped_self), so "
    "records do not include the act of reading them.",
)


def snapshot(limit: "int | None" = None) -> "dict[str, Any]":
    """The census, oldest record first, with its own loss accounting.

    ⚠ READ `counters.observed` BEFORE READING ANY LATENCY HERE. It counts
    every request the middleware saw, capture on or off. If it did not advance
    across your window, nothing ran in that window and the timings below
    describe nothing — that is the whole reason it is published beside them
    rather than left for a caller to infer.

    `evicted` appears twice on purpose: once as the counter maintained at
    append time, and once as `evicted_derived`, recomputed from the oldest
    surviving sequence number. Two independent derivations of the same
    quantity that MUST agree is how an off-by-one in bounded retention becomes
    visible instead of becoming a quietly wrong denominator.

    ⚠ `instance` AND `window_generation` ARE NOT DECORATION. `seq` restarts at
    zero in a new process and at every `reset()`; without those two fields a
    reader comparing two snapshots cannot tell "less happened" from "this is a
    different process" or "somebody reset the window under me".
    """
    with _LOCK:
        rows = list(_RECORDS)
        counters = dict(_COUNTERS)
        capacity = _RECORDS.maxlen or 0
        window_at, window_t0, seq = _WINDOW_AT, _WINDOW_T0, _SEQ
        generation, enabled_now = _WINDOW_GEN, _ENABLED
    # ⚠ DERIVED FROM THE UNTRIMMED RING, BEFORE `limit` is applied. Computing
    # it afterwards would count rows this response merely declined to serve as
    # rows the ring had evicted — the two are not the same thing, and
    # conflating them is precisely the off-by-one the cross-check exists to
    # catch. With an empty ring the honest derivation is `_SEQ`: every record
    # ever appended is gone.
    derived = (rows[0]["seq"] - 1) if rows else seq
    trimmed = 0
    if limit is not None and limit >= 0 and len(rows) > limit:
        trimmed = len(rows) - limit
        rows = rows[-limit:] if limit else []
    return {
        "schema_version": SCHEMA_VERSION,
        "instance": instance(),
        "enabled": enabled_now,
        "capacity": capacity,
        "window_generation": generation,
        "window_started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                           time.gmtime(window_at)),
        "window_ms": round((time.perf_counter() - window_t0) * 1000.0, 3),
        "counters": counters,
        # The counter's own answer, and the same number recomputed from the
        # surviving rows. `served` is what THIS response carries after
        # `limit`; `evicted_derived` accounts for it so the two agree.
        "evicted_derived": derived,
        "served": len(rows),
        "truncated_by_limit": trimmed,
        "oldest_seq": rows[0]["seq"] if rows else None,
        "newest_seq": rows[-1]["seq"] if rows else None,
        "vocabulary": {"rw": list(classes.RW), "scope": list(classes.SCOPE),
                       "scope_src": list(classes.SCOPE_SRC),
                       "outcome": list(classes.OUTCOME),
                       "method": list(classes.METHOD),
                       "nonterminal_reason": list(NONTERMINAL_REASON)},
        "provenance": _provenance(rows),
        "limits": list(LIMITS),
        "records": rows,
    }
