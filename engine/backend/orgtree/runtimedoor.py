"""S6 (fence-off plan): the runtime agent tools on the row-transaction door.

`orgtree_interrupt`, `orgtree_unstick`, `orgtree_restart_wake`, the
self-restart family (`orgtree_self_relaunch`, `orgtree_self_restart` and its
deprecated alias `orgtree_self_update`) and the primed-restart family
(`orgtree_prime_relaunch`, `orgtree_prime_restart`) used to run inside
`agent_call`'s resident DOC_LOCK cycle. Declared here, they run on the door
(`pgdoor`) instead when it is enabled: ONE `org_tx` with the door's prologue
(the caller's node row held, halt and killswitch checked on the locked rows,
the receipt filed last), then the door's generic post-commit tail.

Each body does ONLY the document half — the authority checks and the gate's
event-log entry — on the locked rows. Everything outside the document
(signalling a live turn, spawning the deploy, writing the primed-restart or
restart-wake sidecar file, the unstick resume mail) is an `after.then` step:
it runs once, after the commit, never on a rolled-back or re-run attempt, and
a failure is disclosed in `result["warnings"]` rather than raised (plan
decision 27, F2). Under DOC_LOCK those effects ran INSIDE the lock and were
not undone when the save failed (`opreceipts` classed them UNROLLED); here
they follow the commit (TX_POST).

ROWS. The door always holds the caller's node row FOR UPDATE and the
killswitch FOR SHARE. On top of that:

  * an authority check over a target ("the caller is an ancestor of it")
    reads the target's parent chain up to the caller, so that chain is held
    FOR SHARE (`rcdoor.chain`, planned on the unlocked snapshot). The body
    re-walks it on the locked rows and widens if the tree moved in between;
  * `unstick` writes the target's row, its own notices row, `fable_lock`
    (cleared when this was its last holder) and the `events`/`notice_log`
    lines. It does NOT take every other node FOR SHARE (`api.unstick_rows`
    does, for continue_on): the "is anyone else still limit-locked?" read is
    ordered by `fable_lock` itself, because the ONLY writer of
    `limit_locked` (`Org.fable_limit_hit`) writes `fable_lock` in the same
    step, and this transaction holds that row FOR UPDATE;
  * the restart gates read `audiences` and `kiosk` and log to `events` — the
    same rows the forced self-restart path (`api._forced_self_restart`)
    already takes.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import pgdoor, rcdoor, restart_wake, supervisor

INTERRUPT = "orgtree_interrupt"
UNSTICK = "orgtree_unstick"
RESTART_WAKE = "orgtree_restart_wake"
SELF_RELAUNCH = "orgtree_self_relaunch"
SELF_RESTART = "orgtree_self_restart"
SELF_UPDATE = "orgtree_self_update"          # the deprecated alias
PRIME_RELAUNCH = "orgtree_prime_relaunch"
PRIME_RESTART = "orgtree_prime_restart"
TOOLS: tuple[str, ...] = (INTERRUPT, UNSTICK, RESTART_WAKE, SELF_RELAUNCH,
                          SELF_RESTART, SELF_UPDATE, PRIME_RELAUNCH,
                          PRIME_RESTART)

#: the rows a restart gate reads (authority: live, kiosk, parent, a user
#: audience) and the event it logs — as `api._forced_self_restart` takes them
_GATE = pgdoor.TxSpec(share_sections=("audiences", "kiosk"), logs=("events",))

UNSTICK_DEFAULT_TEXT = ("(orgtree) Your superior manually UNSTUCK you. Handle "
                        "any mail above and continue.")

#: `refuse(status, message)` raises the HTTP error api would have raised for
#: a refusal that is not a 422 (a LedgerError is mapped to 422 by the door).
Refuse = Callable[[int, str], Any]


# ------------------------------------------------------------------ helpers

def _target(a: dict[str, Any], key: str = "node",
            default: str = "") -> str:
    return str(a.get(key) or default)


def _chain_spec(snapshot: Any, target: str, actor: str) -> pgdoor.TxSpec:
    return pgdoor.TxSpec(share_nodes=rcdoor.chain(snapshot, target, actor))


def _hold_chain(t: pgdoor.AgentTx, target: str) -> None:
    """The authority chain from `target` up to the caller, walked on the
    LOCKED document, must be held: a move between the plan and the locks
    widens the transaction instead of deciding on an unlocked row."""
    held = set(t.spec.nodes) | set(t.spec.share_nodes)
    missing = [n for n in rcdoor.chain(t.org, target, t.node)
               if n not in held]
    if missing:
        raise pgdoor.Widen(share_nodes=missing)


def _merge(result: dict[str, Any], fn: Callable[[], Any]) -> None:
    """Run a post-commit effect and fold its dict into the tool result."""
    out = fn()
    if isinstance(out, dict):
        result.update(out)


# ---------------------------------------------------------------- interrupt

def interrupt_spec(snapshot: Any, call: Any, a: dict[str, Any]
                   ) -> pgdoor.TxSpec:
    return _chain_spec(snapshot, _target(a), call.node)


def interrupt_body(t: pgdoor.AgentTx) -> dict[str, Any]:
    target = _target(t.args)
    t.org.node(target)            # 422s a bogus target before it acts
    _hold_chain(t, target)
    t.org._require_authority(t.node, target)
    slug = str(t.call.org)
    result: dict[str, Any] = {}

    def interrupt(res: dict[str, Any]) -> None:
        # signals a live process: never inside the transaction
        _merge(res, lambda: supervisor.interrupt_turn(slug, target))
    t.after.then.append(interrupt)
    return result


# ------------------------------------------------------------------ unstick

def unstick_spec(snapshot: Any, call: Any, a: dict[str, Any]
                 ) -> pgdoor.TxSpec:
    target = _target(a)
    return pgdoor.TxSpec(
        nodes=(target,) if target else (),
        sections=("fable_lock",) + ((("notices", target),) if target else ()),
        share_nodes=rcdoor.chain(snapshot, target, call.node),
        share_sections=("spend_frozen",),
        logs=("events", "notice_log"))


def unstick_body(t: pgdoor.AgentTx) -> dict[str, Any]:
    target = _target(t.args)
    t.org.node(target)
    if target not in t.spec.nodes:
        raise pgdoor.Widen(nodes=[target], sections=[("notices", target)])
    _hold_chain(t, target)
    t.org._require_authority(t.node, target)
    result = t.org.unstick(t.node, target)
    if result.get("released"):
        slug, actor = str(t.call.org), t.node
        texts = [str(x) for x in result.get("resume_texts") or []] \
            or [UNSTICK_DEFAULT_TEXT]
        views = [str(x) for x in result.get("resume_views") or []]

        def resume(_res: Any) -> None:
            for i, text in enumerate(texts):
                supervisor.send_message(
                    slug, target, text, sender=actor,
                    view=views[i] if i < len(views) else text)
            supervisor.notify(slug, target, "turn_started")
        t.after.then.append(resume)
    return result


# ------------------------------------------------------------ restart wake

def restart_wake_spec(snapshot: Any, call: Any, a: dict[str, Any]
                      ) -> pgdoor.TxSpec:
    target = _target(a, "target", call.node)
    if target == call.node:
        return pgdoor.TxSpec()
    return _chain_spec(snapshot, target, call.node)


def restart_wake_body(refuse: Refuse
                      ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        a = t.args
        act = str(a.get("action") or "arm")
        if act not in ("arm", "cancel", "status"):
            refuse(422, "action must be arm|cancel|status")
        target = _target(a, "target", t.node)
        t.org._require_live(t.node)
        if target != t.node:
            t.org.node(target)
            _hold_chain(t, target)
            if not t.org.is_ancestor(t.node, target):
                refuse(403,
                       f"you can only manage restart wake for yourself or "
                       f"your subordinates ({target!r} is not your "
                       f"subordinate)")
            t.org._require_live(target)
        reason = a.get("reason")
        if act == "arm":
            if a.get("mode") and a.get("mode") != "one_shot":
                refuse(422, "only one-shot restart wakes are supported "
                            "(re-arm after waking if needed)")
            if reason is not None:
                reason = str(reason)[:200]
        slug, actor = str(t.call.org), t.node

        def sidecar(res: dict[str, Any]) -> None:
            # the machine-wide restart-wakes file, not the org document
            if act == "status":
                _merge(res, lambda: restart_wake.status_restart_wake(
                    slug, target))
            elif act == "cancel":
                _merge(res, lambda: restart_wake.cancel_restart_wake(
                    slug, target))
            else:
                _merge(res, lambda: restart_wake.arm_restart_wake(
                    slug, target, actor, reason=reason))
        t.after.then.append(sidecar)
        return {}
    return run


# ------------------------------------------------------------ self restart

def self_restart_body(desktop_managed: Callable[[], bool]
                      ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    """`orgtree_self_relaunch` / `orgtree_self_restart` / the
    `orgtree_self_update` alias, WITHOUT `force` (api routes a forced call to
    `_forced_self_restart` before either path). The gate refuses and logs
    `self_restart` on the locked rows; the detached launch follows the
    commit. As under DOC_LOCK, the gate's event commits even when the launch
    then refuses (a busy machine): the event records the decision."""
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        tool = str(t.call.tool)
        t.org.self_restart_gate(t.node)
        slug, actor = str(t.call.org), t.node
        if tool == SELF_RELAUNCH:
            target, kw = "org", {}
        else:
            target = str(t.args.get("target") or "org")
            kw = ({"action": "update"}
                  if tool == SELF_UPDATE and desktop_managed() else {})

        def launch(res: dict[str, Any]) -> None:
            _merge(res, lambda: supervisor.launch_self_restart(
                slug, actor, target, **kw))
        t.after.then.append(launch)
        return {}
    return run


# ----------------------------------------------------------- primed restart

def prime_spec(_snapshot: Any, _call: Any, a: dict[str, Any]
               ) -> pgdoor.TxSpec:
    if str(a.get("action") or "arm") == "status":
        return pgdoor.TxSpec()          # a read: no authority act, no log
    return _GATE


def _prime_status(tool: str) -> dict[str, Any]:
    pr = supervisor.primed_restart()
    if tool == PRIME_RELAUNCH:
        status = (
            "relaunch in progress..."
            if pr and pr.get("state") == "executing" else
            f"a relaunch is primed by {pr.get('by_org')}/"
            f"{pr.get('by_node')} (armed {pr.get('at')}) — "
            "it fires after the engine is idle and the "
            "operating system has been idle for at least 60 "
            "seconds"
            if pr else
            "no relaunch is primed on this machine")
    else:
        status = (
            "restart in progress..."
            if pr and pr.get("state") == "executing" else
            f"a restart is primed by {pr.get('by_org')}/"
            f"{pr.get('by_node')} (target="
            f"{pr.get('target')!r}, armed {pr.get('at')}) — "
            "it fires when this machine goes quiet"
            # FR-32: a deadline you cannot SEE is a forced
            # deploy nobody knows is scheduled
            + (f", and if it has not by {pr.get('deadline')} "
               f"({pr.get('deadline_minutes')} min from "
               f"arming) it ESCALATES — stopping whoever is "
               f"working and deploying anyway"
               if pr.get("deadline_ts") else
               " — no deadline, so it waits however long "
               "that takes")
            if pr else
            "no restart is primed on this machine")
    return {"primed": pr, "status": status}


def prime_body(refuse: Refuse,
               opt_int: Callable[[dict[str, Any], str], int | None]
               ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    """`orgtree_prime_relaunch` (no target, no deadline: the native consumer
    waits for an idle engine AND an idle OS) and `orgtree_prime_restart`
    (FR-27/FR-32: a target and an optional deadline). arm/cancel take the
    restart authority and log on the locked rows; the primed-restart sidecar
    file is written after the commit. status is a read."""
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        tool = str(t.call.tool)
        a = t.args
        act = str(a.get("action") or "arm")
        if act not in ("arm", "cancel", "status"):
            refuse(422, "action must be arm|cancel|status")
        if act == "status":
            # read-only: no authority act, so no gate and no event; a
            # retired node is still not answered
            t.org._require_live(t.node)
            return _prime_status(tool)
        slug, actor = str(t.call.org), t.node
        if act == "cancel":
            t.org.prime_restart_gate(actor, "cancel")

            def cancel(res: dict[str, Any]) -> None:
                _merge(res, lambda: supervisor.cancel_prime_restart(
                    slug, actor))
            t.after.then.append(cancel)
            return {}
        if tool == PRIME_RELAUNCH:
            target, reason, deadline = "org", a.get("reason"), None
        else:
            target = str(a.get("target") or "org")
            reason = a.get("reason")
            # FR-32: absent stays absent all the way down
            deadline = opt_int(a, "deadline_minutes")
        t.org.prime_restart_gate(actor, "arm", target=target, reason=reason,
                                 deadline_minutes=deadline)

        def arm(res: dict[str, Any]) -> None:
            _merge(res, lambda: supervisor.arm_prime_restart(
                slug, actor, target, reason, deadline_minutes=deadline))
        t.after.then.append(arm)
        return {}
    return run


# ------------------------------------------------------------- declaration

def declare(refuse: Refuse, desktop_managed: Callable[[], bool],
            opt_int: Callable[[dict[str, Any], str], int | None]) -> None:
    """Register the runtime tools on the door (api calls this once at
    import). The callables are api's, passed in because this module must not
    import api (api imports it)."""
    pgdoor.declare(INTERRUPT, interrupt_spec, body=interrupt_body)
    pgdoor.declare(UNSTICK, unstick_spec, body=unstick_body)
    pgdoor.declare(RESTART_WAKE, restart_wake_spec,
                   body=restart_wake_body(refuse))
    srb = self_restart_body(desktop_managed)
    for name in (SELF_RELAUNCH, SELF_RESTART, SELF_UPDATE):
        pgdoor.declare(name, _GATE, body=srb)
    pb = prime_body(refuse, opt_int)
    for name in (PRIME_RELAUNCH, PRIME_RESTART):
        pgdoor.declare(name, prime_spec, body=pb)

