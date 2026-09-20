"""Durable operator halt; distinct from the transient interrupt signal.

User invariant (docs/v2-user-decisions.md, 12 September 2026):
"A turn cannot run while its agent is halted."

DOC_LOCK orders admission, delivery and the durable halt request. Workers
register before releasing it and unregister after all turn cleanup. A halt
first closes admission as `halting`, kills provider processes, then publishes
`halted` only when those workers and their processes have settled. Never wait
for a worker while holding DOC_LOCK: its finally block needs the same lock.

The ORG KILLSWITCH (user redesign 2026-09-13) is the second durable halt
state: one persistent org-level latch, `org.d["killswitch"]`, that makes
EVERY agent in the org non-runnable without touching any per-agent `halt`
record. Every gate below asks `blocked()` — the unified non-runnable
predicate — instead of the per-agent flag alone, which is what lets the
latch inherit all of halt's admission coverage (send door, workers,
deliveries, spawn slots) without a second gate system. Clearing either
state only restores eligibility: nothing is restarted, resumed or requeued
until a separate event legitimately starts work (docket rev 4).
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from functools import wraps
import threading
import time
import uuid
from typing import Any

from . import store
from .ledger import LedgerError, USER, now


class Cancelled(RuntimeError):
    """Halt closed admission; this is cancellation, not provider failure."""


# Kept separately from disposable provider/runtime state. A model switch or
# forget_state must not erase evidence of a worker that still owns cleanup.
_workers: dict[tuple[str, str], int] = {}
_worker_states: dict[tuple[str, str], list[dict]] = {}
_halt_states: dict[tuple[str, str], list[dict]] = {}
_halters: dict[tuple[str, str], int] = {}
_changed = threading.Condition(store.DOC_LOCK)
SETTLE_TIMEOUT = 20.0  # leave room inside the agent tool transport's 30s timeout

# ---------------------------------------------------- the durable settler
# ⚠ WHY THIS EXISTS. `_halt` used to publish `halted` ONLY from inside its own
# bounded loop. Miss the 20s window and the loop was gone, and nothing
# anywhere re-evaluated settlement again except `recover()`, which runs at
# backend startup. So a node that settled 21 seconds after the request stayed
# durably `halting` until the next restart — measured on the live org
# 2026-09-20, five agents still `halting` 27 minutes after an 11-way halt,
# with every later stop/interrupt/retire failing on top of it (docket
# fix-agents-stuck-halting-and-non-json-stop-error).
#
# So a halt that does not finish in the foreground hands off to a NAMED,
# QUERYABLE operation that keeps killing and keeps checking until it settles.
# The caller gets that operation's id back instead of an ambiguous "still
# halting" with nobody behind it.
_settlers: dict[tuple[str, str], dict[str, Any]] = {}
SETTLER_POLL = 0.25       # first re-check interval after the foreground gave up
SETTLER_POLL_MAX = 5.0    # …backing off to this, so a long settle is not a spin


# ------------------------------------------------- the three gate predicates
# `blocked` is asked by EVERY agent tool call, before the verb runs, and it
# used to answer by parsing the whole document. On the live org that is 50-75
# ms of a call that has already paid the same cost once for authentication
# (measured 2026-09-18, toolcalls/out/load-sites-orgtree.json), and
# `send_message` asks it a second time through `guarded`.
#
# These three READ and never write, so they take `cached_org` — the shared,
# `org_seq`-guarded snapshot the streaming path has used since `aba2439`. A
# save bumps the seq and drops the entry, so a halt or a killswitch latched by
# one call is seen by the very next one: this is not a TTL cache and there is
# no window in which it can answer from before a write.
#
# ⚠ READ-ONLY BY CONTRACT (store.cached_org): the returned Org is shared with
# every other reader in the process. Never mutate it, never save it, and never
# hand it to a caller that will. Everything below this block still loads its
# own copy under the lock, because everything below this block writes.
def _node(slug: str, nid: str):
    try:
        return store.cached_org(slug).nodes.get(nid)
    except LedgerError:
        return None


def requested(slug: str, nid: str) -> bool:
    # lock-free like `blocked` below, for the same incident-measured reason
    n = _node(slug, nid)
    return bool(n and n.get("halt"))


def org_killswitch(slug: str) -> dict[str, Any] | None:
    """The org-level emergency latch record ({at, by}), or None."""
    # lock-free like `blocked` below, for the same incident-measured reason
    try:
        return store.cached_org(slug).d.get("killswitch") or None
    except LedgerError:
        return None


def blocked(slug: str, nid: str) -> str | None:
    """The unified non-runnable cause: 'halt' when the agent itself carries
    the durable halt, 'killswitch' when its org's latch holds. One predicate,
    asked by every gate in this module, so the org latch covers exactly the
    wake/admission surface the per-agent halt already covers — a gate that
    consulted `requested` alone would be a path the latch does not close."""
    # ⚠ NO DOC_LOCK, deliberately (state-access rearchitecture, incident
    # 2026-09-19: a user message send stalled for minutes). The snapshot is
    # seq-gated and torn-proof without a caller's lock, and every mutating
    # door re-checks halt/killswitch under ITS OWN lock on the resident
    # document — this predicate is a pre-gate, and the lock it used to take
    # never extended to the action anyway. What the lock DID do under swarm
    # load was convoy: a snapshot rebuild that fell back to a full parse ran
    # inside it and stalled every write for tens of seconds.
    try:
        org = store.cached_org(slug)
    except LedgerError:
        return None
    n = org.nodes.get(nid)
    if n is not None and n.get("halt"):
        return "halt"
    if org.d.get("killswitch"):
        return "killswitch"
    return None


def _states(slug: str, nid: str, st) -> list[dict]:
    """Under DOC_LOCK: account/model resets may have replaced runtime state."""
    from . import supervisor as sup
    unique = {}
    for s in [st, sup.state(slug, nid), *_worker_states.get((slug, nid), []),
              *_halt_states.get((slug, nid), [])]:
        unique[id(s)] = s
    return list(unique.values())


def check(slug: str, nid: str) -> None:
    cause = blocked(slug, nid)
    if cause == "halt":
        raise Cancelled("agent is halted — explicit unhalt is required")
    if cause == "killswitch":
        raise Cancelled("the org killswitch is latched — explicit release "
                        "is required")


@contextmanager
def slot(slug: str, nid: str, semaphore):
    """A canceled owner must not wait for another agent's slot or spawn lock."""
    while True:
        check(slug, nid)
        if semaphore.acquire(timeout=.1):
            try:
                check(slug, nid)
                yield
            finally:
                semaphore.release()
            return


def retain(org, nid: str, carriers) -> bool:
    """Under DOC_LOCK: keep complete carriers, with stable identity, once.

    Mail pointers still point to the durable mailbox. Journaled carriers keep
    their tokens so neither shutdown nor a turn's cleanup can rebox the same
    mail alongside its already composed carrier.
    """
    n = org.node(nid)
    held = n.setdefault("halt_queue", [])
    ids = {c.get("_halt_id") for c in held}
    changed = False
    for value in carriers:
        c = value if isinstance(value, dict) else {"text": str(value)}
        ident = c.setdefault("_halt_id", uuid.uuid4().hex)
        if ident not in ids:
            held.append(copy.deepcopy(c))
            ids.add(ident)
            changed = True
    return changed


def held_tokens(org, nid: str) -> set[str]:
    n = org.nodes.get(nid) or {}
    return {t for c in n.get("halt_queue") or [] for t in c.get("toks") or []}


def link_freeze_replay(slug: str, nid: str, frozen) -> None:
    """Under DOC_LOCK: identify a freeze's copy of still-unconfirmed input.

    Confirmed input has no pending carrier. If halt races the freeze before
    confirmation, both mechanisms must retain ONE input, with its original
    command/mail metadata, rather than reconstruct two unrelated texts.
    """
    from . import supervisor as sup
    st = sup.state(slug, nid)
    with sup._state_lock:
        pending = st.get("halt_pending_carrier")
        if pending is not None and frozen.get("resume_texts"):
            ident = pending.setdefault("_halt_id", uuid.uuid4().hex)
            frozen.setdefault("halt_sources", {})[str(len(frozen["resume_texts"]) - 1)] = ident


def restore_frozen_sources(org, nid: str, carriers, sources) -> None:
    """Under DOC_LOCK: merge freeze replay with any matching halt owner."""
    held = {c.get("_halt_id"): c for c in org.node(nid).get("halt_queue") or []}
    for i, c in enumerate(carriers):
        ident = sources.get(str(i))
        if not ident:
            continue
        if ident in held:
            # The retained carrier owns unconfirmed tokens and the original
            # input; the freeze's truncated prose must not duplicate it.
            c.clear()
            c.update(copy.deepcopy(held[ident]))
        else:
            c["_halt_id"] = ident


def _capture(org, nid: str, st, *, force: bool = False) -> None:
    from . import supervisor as sup
    with sup._state_lock:
        queued = list(st.get("queue") or []) + list(st.get("steer") or [])
        queued.extend(st.get("halt_steering_carriers") or [])
        queued.extend(st.get("halt_aux_carriers") or [])
        for entry in st.get("steer_limbo") or []:
            queued.extend(entry.get("carriers") or [])
        pending = st.get("halt_pending_carrier")
        if pending is not None:
            queued.insert(0, pending)
    changed = retain(org, nid, queued)
    # Durable first. A failed save leaves every runtime carrier in place.
    if changed or force:
        store.save_org(org)
    captured = {id(c) for c in queued}
    with sup._state_lock:
        st["queue"] = [c for c in st.get("queue") or [] if id(c) not in captured]
        st["steer"] = [c for c in st.get("steer") or [] if id(c) not in captured]


def delivery(empty):
    """Serialize a short mailbox/receipt transaction with halt admission."""
    def decorate(fn):
        @wraps(fn)
        def guarded(slug, nid, *args, **kwargs):
            with store.DOC_LOCK:
                if blocked(slug, nid):
                    return empty()
                return fn(slug, nid, *args, **kwargs)
        return guarded
    return decorate


def admission(fn):
    """The send door is atomic with halt, including steer envelope drains."""
    @wraps(fn)
    def guarded(slug, nid, text, *args, **kwargs):
        options = dict(zip(("command", "wake", "mail_ping", "idle_only", "view",
                            "sender", "ping_reason", "segments", "_inventory"),
                           args))
        options.update(kwargs)
        with store.DOC_LOCK:
            n = _node(slug, nid)
            cause = blocked(slug, nid) if n else None
            if n and cause:
                # Commands have no mailbox. Retain them verbatim, as well as
                # raw restart/replay nudges; passive notices never create work.
                if options.get("wake", True) and not options.get("idle_only"):
                    org = store.load_org(slug)
                    c = {"text": text, "view": options.get("view") or ""}
                    # a replay's frozen composition is retained WITH it: an
                    # unhalt that handed back the text and dropped the segments
                    # would put the raw envelope back on the desk, which is the
                    # defect this field exists to close (2026-09-16)
                    if options.get("segments"):
                        c["segs"] = options["segments"]
                    if options.get("command"):
                        c.update(cmd=True, view=text)
                    if options.get("mail_ping"):
                        c["ping"] = True
                        c["ping_reason"] = options.get("ping_reason")
                    retain(org, nid, [c])
                    store.save_org(org)
                    n = org.node(nid)
                halt_rec = n.get("halt")
                return {"accepted": not options.get("idle_only", False),
                        "queued": len(n.get("halt_queue") or []),
                        # a bare org latch has no per-node phases to settle:
                        # the agent is effectively halted the moment the
                        # latch commits, so the flags say so plainly
                        "halted": (halt_rec["phase"] == "halted"
                                   if halt_rec else True),
                        "halting": (halt_rec["phase"] == "halting"
                                    if halt_rec else False),
                        "deferred": "halted" if halt_rec else "killswitch"}
            return fn(slug, nid, text, *args, **kwargs)
    return guarded


def worker(fn):
    """Register the whole turn owner, including slot waits and finalizers."""
    @wraps(fn)
    def guarded(slug, nid, *args, **kwargs):
        from . import supervisor as sup
        key = (slug, nid)
        st = sup.state(slug, nid)
        with store.DOC_LOCK:
            n = _node(slug, nid)
            if n and blocked(slug, nid):
                org = store.load_org(slug)
                kept = (retain(org, nid, [args[0]])
                        if args and fn.__name__ in ("_run_turn", "_run_one_turn") else False)
                _capture(org, nid, st, force=kept)
                with sup._state_lock:
                    if not _workers.get(key):
                        st["busy"] = st["waiting"] = False
                _changed.notify_all()
                return None
            _workers[key] = _workers.get(key, 0) + 1
            _worker_states.setdefault(key, []).append(st)
            if fn.__name__ in ("_run_turn", "_run_one_turn") and args:
                c = args[0] if isinstance(args[0], dict) else {"text": str(args[0])}
                with sup._state_lock:
                    old = st.get("halt_pending_carrier")
                    if old and old.get("text") == c.get("text") and not isinstance(args[0], dict):
                        c = old
                    st["halt_pending_carrier"] = c
                    st["halt_carrier_id"] = c.get("_halt_id")
        try:
            return fn(slug, nid, *args, **kwargs)
        finally:
            with store.DOC_LOCK:
                gated = False
                try:
                    n = _node(slug, nid)
                    gated = bool(n and blocked(slug, nid))
                    if gated:
                        _capture(store.load_org(slug), nid, st)
                finally:
                    owners = _worker_states.get(key, [])
                    for i, owner in enumerate(owners):
                        if owner is st:
                            owners.pop(i)
                            break
                    if not owners:
                        _worker_states.pop(key, None)
                    count = _workers.get(key, 1) - 1
                    if count:
                        _workers[key] = count
                    else:
                        _workers.pop(key, None)
                        st.pop("halt_pending_carrier", None)
                        if gated:
                            runtimes = _states(slug, nid, st)
                            with sup._state_lock:
                                for runtime in runtimes:
                                    runtime["busy"] = runtime["waiting"] = False
                    _changed.notify_all()
    return guarded


def callback(slug: str, nid: str):
    """Count provider pumps/callbacks through cleanup without retaining arguments."""
    def decorate(fn):
        @worker
        def run(_slug, _nid, *args, **kwargs):
            return fn(*args, **kwargs)

        @wraps(fn)
        def guarded(*args, **kwargs):
            return run(slug, nid, *args, **kwargs)
        return guarded
    return decorate


def confirmed(org, nid: str, toks, carriers=()) -> None:
    """Under DOC_LOCK: spend held mail only with the provider receipt transaction."""
    from . import supervisor as sup
    tokens = set(toks)
    ids = {c.get("_halt_id") for c in carriers if isinstance(c, dict)} - {None}

    def keep(c):
        return not (c.get("_halt_id") in ids or tokens.intersection(c.get("toks") or []))

    n = org.node(nid)
    if n.get("halt_queue"):
        n["halt_queue"] = [c for c in n["halt_queue"] if keep(c)]
    st = sup.state(org.d["slug"], nid)
    with sup._state_lock:
        st["halt_steering_carriers"] = [c for c in st.get("halt_steering_carriers") or []
                                        if keep(c)]
        st["halt_aux_carriers"] = [c for c in st.get("halt_aux_carriers") or [] if keep(c)]


@delivery(lambda: None)
def complete_auxiliary(slug: str, nid: str, carrier) -> None:
    org = store.load_org(slug)
    confirmed(org, nid, [], [carrier])
    store.save_org(org)


def consumed(slug: str, nid: str) -> None:
    """Initial provider acknowledgement also spends a retained raw carrier."""
    from . import supervisor as sup
    with store.DOC_LOCK:
        n = _node(slug, nid)
        if not n or n.get("halt"):
            return
        st = sup.state(slug, nid)
        with sup._state_lock:
            c = st.pop("halt_pending_carrier", None)
            ident = (c or {}).get("_halt_id") or st.pop("halt_carrier_id", None)
            st.pop("halt_carrier_id", None)
        if ident and n.get("halt_queue"):
            org = store.load_org(slug)
            confirmed(org, nid, [], [{"_halt_id": ident}])
            store.save_org(org)


def _cut(slug: str, nid: str, st, *, halting: bool = True) -> None:
    with store.DOC_LOCK:
        owners = _states(slug, nid, st)
    for runtime in owners:
        _cut_state(slug, nid, runtime, halting=halting)


def cut_for_archive(slug: str, nid: str) -> None:
    """The abrupt cross-lane teardown, WITHOUT the halt flags — for a node
    whose turn is about to lose its owner to an archive.

    `supervisor.interrupt_before_archive` calls this for a node whose turn did
    not settle inside the interrupt timeout. Retire/dissolve do not otherwise
    touch process state (the measured gap `warmpool._keeper_pass` names), and
    the graceful `interrupt_turn` verb deliberately leaves the process alive,
    so without this the CLI's only remaining end condition after the archive
    commits is its own turn's `finally` — bounded only by `TURN_TIMEOUT`, four
    hours, during which it keeps making tool calls under a seat that no longer
    exists. That is the stranded-CLI symptom.

    ⚠ `halting=False` IS THE WHOLE POINT, not a detail. `st["halt_requested"]`
    is keyed to `(slug, nid)` in `supervisor._state` and is cleared only by
    unhalt; set here it would survive the archive and suppress every turn of a
    LATER agent rehired under the same id. The per-turn flags (`interrupted`,
    the admission and deploy-hold cancel tokens) are set as usual — they die
    with the turn they belong to."""
    from . import supervisor as sup
    _cut(slug, nid, sup.state(slug, nid), halting=False)


def _cut_state(slug: str, nid: str, st, *, halting: bool = True) -> None:
    from . import supervisor as sup, warmpool
    with sup._state_lock:
        if halting:
            st["halt_requested"] = True
        st["interrupted"] = True
        st["admission_cancel_token"] = st.get("admission_wait_token")
        st["deploy_hold_cancel"] = st.get("deploy_hold_token")
        ev = st.get("mcp_tool_event")
        proc = st.get("proc")
        codex = st.get("codex_turn")
        agy = st.get("antigravity_turn")
        compact = st.get("halt_compact_proc")
        remote = st.get("halt_remote_proc")
        compact_client = st.get("halt_compact_client")
        auxiliary = list(st.get("halt_aux_procs") or [])
        cache = st.get("cache_keepalive")
        if cache:
            cache["cancel"].set()
            auxiliary.append(cache.get("proc"))
    if isinstance(ev, threading.Event):
        ev.set()
    # Abrupt process-tree termination, not the graceful interrupt verb.
    for p in (proc, compact, remote, *auxiliary):
        if p is not None:
            sup._wd_kill_tree(p)
    # ⚠ A REPEAT CUT ON AN ALREADY-DEAD PROCESS MUST BE CHEAP. `_cut` runs on
    # every settle poll, and each teardown here costs a `taskkill` spawn plus
    # bounded waits. Unguarded, five simultaneous halts re-paid all of it
    # twice a second, which is why a halt that should have returned in 20 s
    # had not returned in 60 (coordinator measurement, 2026-09-20).
    # `_wd_kill_tree` above already early-returns on a dead handle;
    # and `AppServerClient.close` now does its own liveness check before the
    # OS work. Nothing alive is ever skipped: the guard is a liveness test,
    # not a "we tried once" memo.
    #
    # ⚠ `warmpool.halt_kill` IS NOT GUARDED, and that is deliberate — a first
    # attempt at this wrapped it in `if not warmpool.halt_settled(...)` and
    # broke `test_a_warm_process_removed_from_pool_still_blocks_halt_until_
    # reaped`. Its teardown bookkeeping (`_end_teardown`, which is what drops
    # a reaped process out of `warmpool._terminating`) only runs INSIDE that
    # call, so skipping it on the settled pass leaks the entry forever. It is
    # already cheap on a settled node: `kill_node` returns at once with no
    # pool entry, `_wd_kill_tree` early-returns on a dead handle, and
    # `_reap`'s `wait()` on an already-exited process returns immediately.
    if codex is not None:
        codex.client.close()
    if agy is not None:
        agy.close()
    if compact_client is not None:
        compact_client.close()
    sup._cancel_working_cache(slug, nid)
    warmpool.halt_kill(slug, nid)


def _settled(slug: str, nid: str, st) -> bool:
    from . import supervisor as sup, warmpool
    if _workers.get((slug, nid)):
        return False
    if not warmpool.halt_settled(slug, nid):
        return False
    return all(_state_settled(runtime) for runtime in _states(slug, nid, st))


def _handles(st) -> list[tuple[str, Any]]:
    """Every process handle this runtime state owns, each with the lane it
    belongs to. MUST be called with `supervisor._state_lock` held.

    These are the agent CLI and provider processes — the ones the user's halt
    ruling is about. `halt.halt` does not report `halted` until every one of
    them has been confirmed gone by `poll()`, not merely asked to die."""
    handles: list[tuple[str, Any]] = [
        ("cli", st.get("proc")),
        ("compact", st.get("halt_compact_proc")),
        ("remote_control", st.get("halt_remote_proc")),
    ]
    handles.extend(("cli_fork", p) for p in st.get("halt_aux_procs") or [])
    compact_client = st.get("halt_compact_client")
    if compact_client is not None:
        handles.append(("compact_app_server", compact_client.proc))
    codex = st.get("codex_turn")
    if codex is not None:
        handles.append(("codex_app_server", codex.client.proc))
    agy = st.get("antigravity_turn")
    if agy is not None:
        handles.append(("antigravity", agy.proc))
    return [(kind, p) for kind, p in handles if p is not None]


def _state_settled(st) -> bool:
    from . import supervisor as sup
    with sup._state_lock:
        if st.get("busy") or st.get("proc_control") or st.get("cache_keepalive"):
            return False
        return all(p.poll() is not None for _kind, p in _handles(st))


def surviving(slug: str, nid: str, st=None) -> list[dict[str, Any]]:
    """The agent CLI/provider processes still alive after a cut pass, by pid.

    This is the explicit tracking the halt ruling asks for. A halt that has
    not completed says exactly WHICH process is keeping it open rather than
    reporting an unqualified "still settling", so the condition is actionable
    instead of ambiguous."""
    from . import supervisor as sup
    if st is None:
        st = sup.state(slug, nid)
    alive: list[dict[str, Any]] = []
    with store.DOC_LOCK:
        runtimes = _states(slug, nid, st)
    for runtime in runtimes:
        with sup._state_lock:
            handles = _handles(runtime)
        for kind, p in handles:
            if p.poll() is None:
                alive.append({"kind": kind, "pid": getattr(p, "pid", None)})
    return alive


def blocking(slug: str, nid: str, st=None) -> list[str]:
    """Plain sentences naming everything that is not settled yet. Empty means
    settled. Written for a person reading an API response, not a log."""
    from . import supervisor as sup, warmpool
    if st is None:
        st = sup.state(slug, nid)
    reasons: list[str] = []
    with store.DOC_LOCK:
        count = _workers.get((slug, nid)) or 0
        runtimes = _states(slug, nid, st)
    if count:
        reasons.append(f"{count} turn worker(s) have not finished cleanup")
    if not warmpool.halt_settled(slug, nid):
        reasons.append("a warm-pool process for this agent is still alive")
    for runtime in runtimes:
        with sup._state_lock:
            if runtime.get("busy"):
                reasons.append("the turn is still marked busy")
            if runtime.get("proc_control"):
                reasons.append("a process-control operation is in progress")
            if runtime.get("cache_keepalive"):
                reasons.append("a cache keepalive process is still running")
    for rec in surviving(slug, nid, st):
        reasons.append(f"the {rec['kind']} process (pid {rec['pid']}) "
                       f"is still running")
    # de-duplicate while keeping the order a reader sees them in
    return list(dict.fromkeys(reasons))


def halt(slug: str, nid: str, actor: str = USER, *, timeout=None) -> dict[str, Any]:
    key = (slug, nid)
    with store.DOC_LOCK:
        _halters[key] = _halters.get(key, 0) + 1
    try:
        return _halt(slug, nid, actor, timeout=timeout)
    finally:
        with store.DOC_LOCK:
            count = _halters[key] - 1
            if count:
                _halters[key] = count
            else:
                _halters.pop(key, None)
            _changed.notify_all()


def _halt(slug: str, nid: str, actor: str, *, timeout=None) -> dict[str, Any]:
    from . import supervisor as sup
    st = sup.state(slug, nid)
    with store.DOC_LOCK:
        org = store.load_org(slug)
        org._require_authority(actor, nid)
        n = org.node(nid)
        if n.get("remote_controlled"):
            remote = sup._remote_procs.get((slug, nid))
            if remote is not None:
                st["halt_remote_proc"] = remote
            elif not _workers.get((slug, nid)):
                raise LedgerError("remote-control process ownership is unavailable; release remote control first")
        if not n.get("halt"):
            n["halt"] = {"phase": "halting", "requested_at": now(), "by": actor}
            org._log("halt", actor, {"node": nid, "phase": "halting"}, [])
        sup.maildrain.suspend(org, nid)
        owners = _states(slug, nid, st)
        _halt_states[(slug, nid)] = owners
        with sup._state_lock:
            for runtime in owners:
                runtime["halt_requested"] = True
        try:
            for runtime in owners:
                _capture(org, nid, runtime, force=True)
        except Exception:
            if not requested(slug, nid):
                with sup._state_lock:
                    for runtime in owners:
                        runtime.pop("halt_requested", None)
                _halt_states.pop((slug, nid), None)
            raise
    sup.notify(slug, nid, "halting")
    deadline = time.monotonic() + (SETTLE_TIMEOUT if timeout is None else timeout)
    # ⚠ THE SETTLE POLL MUST NOT CYCLE THE DOCUMENT LOCK (beta.1 wave finding,
    # 2026-09-19: four parallel halts of busy agents took 66.6 s wall — every
    # 50 ms poll re-joined the FIFO admission queue behind agent writes, twice
    # per iteration counting the Condition re-acquire, and added its own queue
    # pressure). `_settled` reads only supervisor runtime state, so the poll
    # runs lock-free; the lock is taken to CAPTURE arriving carriers (only
    # when a lock-free peek says any exist — durability for mid-settle
    # arrivals is preserved) and ONCE at the end to commit phase=halted. The
    # commit re-checks `_settled` under the lock: a worker registering between
    # the lock-free check and the acquisition returns us to the poll instead
    # of committing a halt that is not settled. `_cut` still re-kills straggler
    # process trees, throttled to ~500 ms — its own brief lock use is the
    # registry snapshot, not a load-capable hold.
    last_cut = -1.0
    while True:
        now_m = time.monotonic()
        if now_m - last_cut >= 0.5:
            _cut(slug, nid, st)
            last_cut = now_m
        if _pending_carriers(slug, nid, st):
            with store.DOC_LOCK:
                org = store.load_org(slug)
                _capture(org, nid, st)
        if _settled(slug, nid, st):
            with store.DOC_LOCK:
                org = store.load_org(slug)
                _capture(org, nid, st)
                if _settled(slug, nid, st):
                    result = _publish_halted(org, nid)
                    break
            # ⚠ NO `continue` HERE, AND ITS ABSENCE IS THE FIX. The lock-free
            # check said settled and the re-check under the lock disagreed —
            # a worker registered in between. `ed54b13` sent that arm straight
            # back to the top of the loop, which is ABOVE both the deadline
            # test and the sleep, so a node whose worker count flickers (a
            # provider event stream re-entering `halt.callback`, which is
            # ordinary traffic) spins this loop hot and the call stops
            # honouring its own timeout entirely. Measured: 274,000 round
            # trips in six seconds against a 0.3 s deadline. That is the
            # coordinator's 2026-09-20 observation that later halts "did not
            # return within 60s". Before `ed54b13` the settled check only ever
            # ran under the lock, so the two answers could not disagree and
            # every iteration reached the deadline. Falling through costs one
            # 50 ms sleep and keeps the call bounded by the deadline it was
            # given.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            # ⚠ NEVER RETURN AN AMBIGUOUS "still halting" WITH NOBODY BEHIND
            # IT. Before this handoff the foreground loop was the only thing
            # that could ever publish `halted`, so missing this deadline left
            # the node durably `halting` until the backend restarted —
            # measured on the live org 2026-09-20, five agents still halting
            # 27 minutes later. The operation below owns the rest of the
            # transition, names what is keeping it open, and is queryable.
            op = _start_settler(slug, nid)
            return {"node": nid, "halted": False, "settled": False,
                    "halting": True, "operation": op,
                    "surviving_processes": op.get("surviving") or [],
                    "blocking": op.get("blocking") or [],
                    "status": "admission is blocked and the provider processes "
                    "have been killed; halt has not completed yet — operation "
                    + str(op.get("operation_id"))
                    + " is finishing it asynchronously"}
        time.sleep(min(.05, remaining))
    sup.notify(slug, nid, "halted")
    return result


def _publish_halted(org, nid: str) -> dict[str, Any]:
    """Under DOC_LOCK, with settlement ALREADY PROVEN by `_settled`: commit
    the durable `halted` phase and save.

    Only ever called behind `_settled`, which is what makes this the point at
    which the user's halt semantic is satisfied — admission closed, every
    agent CLI/provider process confirmed gone by `poll()` rather than merely
    asked to die, and the turn's own cleanup finished — and not one moment
    earlier. Two call sites now share it: the foreground loop and the
    background settler, so they cannot drift into publishing different
    things."""
    n = org.node(nid)
    n["halt"]["phase"] = "halted"
    n["halt"].setdefault("at", now())
    n["halt"].pop("settling", None)
    n.pop("remote_controlled", None)
    if n.get("inflight"):
        n["halt"]["interrupted_turn"] = n.pop("inflight")
    store.save_org(org)
    return {"node": nid, "halted": True, "settled": True,
            "queued": len(n.get("halt_queue") or []),
            "status": "halted; no turn can run until explicit unhalt"}


def operation(slug: str, nid: str) -> dict[str, Any] | None:
    """The live settle operation for this node, or None. Refreshed on read,
    so a caller polling it sees what is blocking NOW rather than the list
    that was true when the operation started."""
    with store.DOC_LOCK:
        op = _settlers.get((slug, nid))
        if op is None:
            return None
        snapshot = dict(op)
    snapshot["blocking"] = blocking(slug, nid)
    snapshot["surviving"] = surviving(slug, nid)
    return snapshot


def _start_settler(slug: str, nid: str) -> dict[str, Any]:
    """Hand the unfinished transition to a named background operation.

    IDEMPOTENT: a second halt — or a retire, or the desktop's stop button
    pressed again — against a node already settling JOINS the operation that
    is running instead of starting a second one. That is what lets repeat
    lifecycle calls be answered structurally rather than racing."""
    key = (slug, nid)
    with store.DOC_LOCK:
        existing = _settlers.get(key)
        if existing is not None and existing.get("state") == "settling":
            op, fresh = existing, False
        else:
            op = {"operation_id": "halt-" + uuid.uuid4().hex[:12],
                  "operation": "halt", "node": nid, "state": "settling",
                  "requested_at": now(), "polls": 0}
            _settlers[key] = op
            fresh = True
        snapshot = dict(op)
    snapshot["blocking"] = blocking(slug, nid)
    snapshot["surviving"] = surviving(slug, nid)
    # Durable, so the operation is visible to anything reading the org doc
    # rather than only to a caller holding this process's return value.
    with store.DOC_LOCK:
        org = store.load_org(slug)
        n = org.nodes.get(nid)
        if n is not None and n.get("halt"):
            n["halt"]["settling"] = {"operation_id": snapshot["operation_id"],
                                     "since": op["requested_at"],
                                     "blocking": snapshot["blocking"]}
            store.save_org(org)
    if fresh:
        threading.Thread(target=_settle_loop, args=(slug, nid, op),
                         name=f"halt-settle-{slug}-{nid}", daemon=True).start()
    return snapshot


def _settle_loop(slug: str, nid: str, op: dict[str, Any]) -> None:
    """Keep cutting and keep checking until the node is genuinely settled.

    Every pass re-runs the SAME `_cut` the foreground loop runs, because a
    process can still be spawning or re-parenting between passes and "it was
    dead once" is not the guarantee halt owes. The loop ends only by
    publishing `halted`, by the halt being released (unhalt, or the node
    going away), or by a newer operation replacing this one."""
    from . import supervisor as sup
    st = sup.state(slug, nid)
    delay = SETTLER_POLL
    while True:
        with store.DOC_LOCK:
            if _settlers.get((slug, nid)) is not op:
                return                      # superseded by a newer operation
            n = _node(slug, nid)
            if n is None or not n.get("halt"):
                op["state"] = "released"
                _settlers.pop((slug, nid), None)
                return
        try:
            _cut(slug, nid, st)
        except Exception as e:              # noqa: BLE001
            # A kill that fails is recorded and RETRIED. It must never end
            # the operation: ending it is exactly how the node got stuck.
            op["last_error"] = f"{type(e).__name__}: {e}"
        published = None
        if _settled(slug, nid, st):
            with store.DOC_LOCK:
                org = store.load_org(slug)
                n = org.nodes.get(nid)
                if n is not None and n.get("halt"):
                    _capture(org, nid, st)
                    if _settled(slug, nid, st):
                        published = _publish_halted(org, nid)
                        op["state"] = "halted"
                        op["completed_at"] = now()
                        if _settlers.get((slug, nid)) is op:
                            _settlers.pop((slug, nid), None)
        elif _pending_carriers(slug, nid, st):
            with store.DOC_LOCK:
                _capture(store.load_org(slug), nid, st)
        op["polls"] = int(op.get("polls") or 0) + 1
        if published is not None:
            sup.notify(slug, nid, "halted")
            return
        time.sleep(delay)
        delay = min(SETTLER_POLL_MAX, delay * 1.5)


def _pending_carriers(slug: str, nid: str, st) -> bool:
    """Lock-free peek at exactly the runtime fields `_capture(org, nid, st)`
    would sweep from this `st`, so the settle poll only pays a document-lock
    pass when there is actually something to make durable."""
    from . import supervisor as sup
    with sup._state_lock:
        if (st.get("queue") or st.get("steer")
                or st.get("halt_steering_carriers")
                or st.get("halt_aux_carriers")
                or st.get("halt_pending_carrier") is not None):
            return True
        for entry in st.get("steer_limbo") or []:
            if entry.get("carriers"):
                return True
    return False


def recover(org) -> bool:
    """Startup has reaped the old process tree; a halt still owns its seat."""
    from . import supervisor as sup
    changed = False
    slug = org.d["slug"]
    for nid, n in org.nodes.items():
        if not n.get("halt"):
            continue
        st = sup.state(slug, nid)
        st["halt_requested"] = True
        if _settled(slug, nid, st):
            n["halt"]["phase"] = "halted"
            n["halt"].setdefault("at", now())
            # the settle operation that was recorded before the restart has
            # no thread behind it any more, and this IS its completion
            n["halt"].pop("settling", None)
            if n.get("inflight"):
                n["halt"]["interrupted_turn"] = n.pop("inflight")
            changed = True
    return changed


def unhalt(slug: str, nid: str, actor: str = USER) -> dict[str, Any]:
    from . import supervisor as sup, warmpool
    with store.DOC_LOCK:
        org = store.load_org(slug)
        org._require_authority(actor, nid)
        n = org.node(nid)
        if not n.get("halt"):
            return {"node": nid, "unhalted": False, "status": "agent is not halted"}
        st = sup.state(slug, nid)
        if _halters.get((slug, nid)) or not _settled(slug, nid, st):
            raise LedgerError("halt is still settling — wait for the active turn to end")
        n.pop("halt")
        runtimes = _states(slug, nid, st)
        with sup._state_lock:
            for runtime in runtimes:
                runtime.pop("halt_requested", None)
                runtime.pop("interrupted", None)
                runtime.pop("admission_cancel_token", None)
        _halt_states.pop((slug, nid), None)
        org._log("unhalt", actor, {"node": nid}, [])
        store.save_org(org)
        sup.scan_steer_records(slug, nid)
        # Docket rev 4 (user rule 2026-09-13): clearing a halt only restores
        # eligibility — it must not start, resume or requeue a turn. Retained
        # carriers are MERGED back into the runtime queue so the next
        # legitimately started turn delivers them; mail waits in the mailbox
        # it never left. `resume_pending` (which starts turns) remains for
        # startup recovery of NORMAL agents only.
        result = merge_pending(slug, nid)
    sup.notify(slug, nid, "unhalted")
    warmpool.poke()
    return {"node": nid, "unhalted": True, "delivery": result}


def merge_pending(slug: str, nid: str) -> dict[str, Any]:
    """Merge durable halt_queue carriers into the runtime queue and START
    NOTHING (docket rev 4: clearing halt or the org killswitch restores
    eligibility only). The durable copies stay until a provider receipt
    spends them (`confirmed`), so a restart before the next legitimate turn
    loses nothing. Mail needs no merge — it waits in the mailbox and the
    next turn's envelope drains it; this preserves retained COMMANDS and
    raw nudges, which have no mailbox."""
    from . import supervisor as sup
    with store.DOC_LOCK:
        org = store.load_org(slug)
        n = org.node(nid)
        if n.get("halt") or org.d.get("killswitch") or n.get("state") != "live" \
                or n.get("frozen") or n.get("limit_locked"):
            return {"deferred": True, "merged": 0}
        st = sup.state(slug, nid)
        with sup._state_lock:
            queued = {c.get("_halt_id") for c in st.get("queue") or []
                      if isinstance(c, dict)}
            fresh = [copy.deepcopy(c) for c in n.get("halt_queue") or []
                     if c.get("_halt_id") not in queued]
            st["queue"].extend(fresh)
    return {"merged": len(fresh), "started": False}


def resume_pending(slug: str, nid: str) -> dict[str, Any]:
    """Restore durable carriers after a restart without a second owner.

    ⚠ This one STARTS a turn when there is work, so it belongs to startup
    recovery of NORMAL agents only — unhalt and killswitch release call
    `merge_pending` instead (docket rev 4: clearing never starts work), and
    the latch guard here keeps restart recovery from driving a latched org."""
    from . import supervisor as sup
    with store.DOC_LOCK:
        org = store.load_org(slug)
        n = org.node(nid)
        if n.get("halt") or org.d.get("killswitch") or n.get("state") != "live" \
                or n.get("frozen") or n.get("limit_locked"):
            return {"deferred": True}
        st = sup.state(slug, nid)
        first = None
        with sup._state_lock:
            if st.get("busy") or st.get("proc_control"):
                return {"queued": True}
            queued = {c.get("_halt_id") for c in st.get("queue") or [] if isinstance(c, dict)}
            st["queue"].extend(copy.deepcopy(c) for c in n.get("halt_queue") or []
                               if c.get("_halt_id") not in queued)
            if st["queue"]:
                first = st["queue"].pop(0)
                st["busy"] = True
        if first is not None:
            threading.Thread(target=sup._run_turn, args=(slug, nid, first), daemon=True).start()
            return {"started": True}
        if org.waking_mail(nid):
            return sup.send_message(slug, nid, "(orgtree) Handle your pending mail.", mail_ping=True)
        return {"idle": True}


def restore_carriers(org, nid: str, current) -> None:
    """Under DOC_LOCK: a provider resume may follow unhalt's remaining hold."""
    from . import supervisor as sup
    st = sup.state(org.d["slug"], nid)
    with sup._state_lock:
        ids = {c.get("_halt_id") for c in st.get("queue") or [] if isinstance(c, dict)}
        if isinstance(current, dict):
            ids.add(current.get("_halt_id"))
        st["queue"].extend(copy.deepcopy(c) for c in org.node(nid).get("halt_queue") or []
                           if c.get("_halt_id") not in ids)
        st["halt_pending_carrier"] = (current if isinstance(current, dict)
                                      else {"text": current})
        st["halt_carrier_id"] = st["halt_pending_carrier"].get("_halt_id")


def killswitch_latch(slug: str, actor: str = USER) -> dict[str, Any]:
    """⏹ latch the persistent org-level killswitch state, then stop every
    current turn (user redesign 2026-09-13 — the button used to be
    `interrupt_all`, a turn boundary agents sailed straight back over).

    ORDER IS LOAD-BEARING, same rule as `interrupt_all`'s watchdog pause:
    the latch and the dog pause commit in ONE save BEFORE any agent is
    interrupted. Once that save lands, every gate in this module answers
    'killswitch', so no queue pump, retry or fresh mail can start a turn
    between the per-agent interrupts that follow — the org transition and
    the sweep read as one coordinated operation.

    Watchdogs: still paused, and release does NOT resume them — the
    2026-09-04 ruling ("nothing un-pauses them") predates the latch and
    stays; the latch closes admission, but a firing dog would still pile
    mail into boxes while the org stands still."""
    from . import supervisor as sup
    sup._wd_bump_stop_epoch(slug)
    with store.DOC_LOCK:
        org = store.load_org(slug)
        already = bool(org.d.get("killswitch"))
        if not already:
            org.d["killswitch"] = {"at": now(), "by": actor}
            org._log("killswitch", actor, {"latched": True}, [])
        paused = org.watchdogs_pause_all(org.WATCHDOG_KILLSWITCH_PAUSE)
        for nid in org.nodes:
            sup.maildrain.suspend(org, nid)
        store.save_org(org)
    sweep = sup.interrupt_all(slug)
    return {"latched": True, "already_latched": already,
            "interrupted": sweep["interrupted"], "watchdogs_paused": paused}


def killswitch_release(slug: str, actor: str = USER) -> dict[str, Any]:
    """Clear ONLY the org-level latch. Individual halts were never touched
    and so survive exactly as they stand; nothing is restarted, resumed or
    requeued — retained carriers are merged for the next legitimate turn
    and watchdogs stay paused (per-dog manual resume is the only exit)."""
    with store.DOC_LOCK:
        org = store.load_org(slug)
        rec = org.d.get("killswitch")
        if not rec:
            return {"released": False, "status": "the killswitch is not latched"}
        org.d.pop("killswitch")
        org._log("killswitch_release", actor,
                 {"latched_at": rec.get("at"), "latched_by": rec.get("by")}, [])
        store.save_org(org)
        merged = [nid for nid, n in org.nodes.items()
                  if n["state"] == "live" and not n.get("halt")
                  and n.get("halt_queue")
                  and merge_pending(slug, nid).get("merged")]
    return {"released": True, "merged": merged}
