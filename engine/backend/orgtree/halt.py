"""Durable operator halt; distinct from the transient interrupt signal.

User invariant (docs/v2-user-decisions.md, 12 September 2026):
"A turn cannot run while its agent is halted."

DOC_LOCK orders admission, delivery and the durable halt request. Workers
register before releasing it and unregister after all turn cleanup. A halt
first closes admission as `halting`, kills provider processes, then publishes
`halted` only when those workers and their processes have settled. Never wait
for a worker while holding DOC_LOCK: its finally block needs the same lock.
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


def _node(slug: str, nid: str):
    try:
        return store.load_org(slug).nodes.get(nid)
    except LedgerError:
        return None


def requested(slug: str, nid: str) -> bool:
    with store.DOC_LOCK:
        n = _node(slug, nid)
        return bool(n and n.get("halt"))


def _states(slug: str, nid: str, st) -> list[dict]:
    """Under DOC_LOCK: account/model resets may have replaced runtime state."""
    from . import supervisor as sup
    unique = {}
    for s in [st, sup.state(slug, nid), *_worker_states.get((slug, nid), []),
              *_halt_states.get((slug, nid), [])]:
        unique[id(s)] = s
    return list(unique.values())


def check(slug: str, nid: str) -> None:
    if requested(slug, nid):
        raise Cancelled("agent is halted — explicit unhalt is required")


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
                if requested(slug, nid):
                    return empty()
                return fn(slug, nid, *args, **kwargs)
        return guarded
    return decorate


def admission(fn):
    """The send door is atomic with halt, including steer envelope drains."""
    @wraps(fn)
    def guarded(slug, nid, text, *args, **kwargs):
        options = dict(zip(("command", "wake", "mail_ping", "idle_only", "view",
                            "sender", "ping_reason", "_inventory"), args))
        options.update(kwargs)
        with store.DOC_LOCK:
            n = _node(slug, nid)
            if n and n.get("halt"):
                # Commands have no mailbox. Retain them verbatim, as well as
                # raw restart/replay nudges; passive notices never create work.
                if options.get("wake", True) and not options.get("idle_only"):
                    org = store.load_org(slug)
                    c = {"text": text, "view": options.get("view") or ""}
                    if options.get("command"):
                        c.update(cmd=True, view=text)
                    if options.get("mail_ping"):
                        c["ping"] = True
                        c["ping_reason"] = options.get("ping_reason")
                    retain(org, nid, [c])
                    store.save_org(org)
                    n = org.node(nid)
                return {"accepted": not options.get("idle_only", False),
                        "queued": len(n.get("halt_queue") or []),
                        "halted": n["halt"]["phase"] == "halted",
                        "halting": n["halt"]["phase"] == "halting",
                        "deferred": "halted"}
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
            if n and n.get("halt"):
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
                n = None
                try:
                    n = _node(slug, nid)
                    if n and n.get("halt"):
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
                        if n and n.get("halt"):
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


def _cut(slug: str, nid: str, st) -> None:
    with store.DOC_LOCK:
        owners = _states(slug, nid, st)
    for runtime in owners:
        _cut_state(slug, nid, runtime)


def _cut_state(slug: str, nid: str, st) -> None:
    from . import supervisor as sup, warmpool
    with sup._state_lock:
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


def _state_settled(st) -> bool:
    from . import supervisor as sup
    with sup._state_lock:
        if st.get("busy") or st.get("proc_control") or st.get("cache_keepalive"):
            return False
        handles = [st.get("proc"), st.get("halt_compact_proc"), st.get("halt_remote_proc")]
        handles.extend(st.get("halt_aux_procs") or [])
        compact_client = st.get("halt_compact_client")
        if compact_client is not None:
            handles.append(compact_client.proc)
        codex = st.get("codex_turn")
        if codex is not None:
            handles.append(codex.client.proc)
        agy = st.get("antigravity_turn")
        if agy is not None:
            handles.append(agy.proc)
        return all(p is None or p.poll() is not None for p in handles)


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
    while True:
        _cut(slug, nid, st)
        with store.DOC_LOCK:
            org = store.load_org(slug)
            n = org.node(nid)
            _capture(org, nid, st)
            if _settled(slug, nid, st):
                n["halt"]["phase"] = "halted"
                n["halt"].setdefault("at", now())
                n.pop("remote_controlled", None)
                if n.get("inflight"):
                    n["halt"]["interrupted_turn"] = n.pop("inflight")
                store.save_org(org)
                result = {"node": nid, "halted": True, "settled": True,
                          "queued": len(n.get("halt_queue") or []),
                          "status": "halted; no turn can run until explicit unhalt"}
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"node": nid, "halted": False, "settled": False,
                        "halting": True, "status": "admission is blocked; the active "
                        "turn is still settling — halt has not completed"}
            _changed.wait(min(.05, remaining))
    sup.notify(slug, nid, "halted")
    return result


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
        result = resume_pending(slug, nid)
    sup.notify(slug, nid, "unhalted")
    warmpool.poke()
    return {"node": nid, "unhalted": True, "delivery": result}


def resume_pending(slug: str, nid: str) -> dict[str, Any]:
    """Restore durable carriers after unhalt/restart without a second owner."""
    from . import supervisor as sup
    with store.DOC_LOCK:
        org = store.load_org(slug)
        n = org.node(nid)
        if n.get("halt") or n.get("state") != "live" or n.get("frozen") or n.get("limit_locked"):
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
