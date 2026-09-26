"""PG-3a's door declarations: the topology agent tools on pgdoor.

`pgdoor` (WS3a) is the one shared prologue for agent tools taken off
DOC_LOCK; each family declares its own tools from its own module (plan
decision 12). This module declares PG-3a's, using the lock plans and bodies
in `lifecycle_tx`:

    orgtree_move            one move (`_move_rows`), or a batch
                            (`_move_batch_rows`, replayed step by step)
    orgtree_swap            `_swap_rows`
    orgtree_self_subjugate  `_promote_rows` (the caller descends beneath its
                            target)
    orgtree_retire,         `_archive_rows`. The turn interrupt and wait
    orgtree_dissolve        (`supervisor.interrupt_before_archive`) already
                            runs in `agent_call` BEFORE the door, with no
                            lock held; its warnings arrive in `pre`.
    orgtree_retool          `retool_rows` — `api._retool_seat` (set_scope,
                            and an account rebind through the door's
                            `_account_selection`); live effort after commit
    orgtree_rehire          `rehire_rows` — the whole `api._rehire_seat`
                            composite (rehire, scope, audiences, docket
                            assignment, kickoff, placement). The pre-lock
                            rename's outcome arrives in `pre`.

Each spec is computed from the door's UNLOCKED snapshot, so it can be stale.
The body re-derives the plan on the LOCKED document (`lifecycle_tx._need`)
and, on a gap, raises `lifecycle_tx.Widen`; `_door_body` translates that to
`pgdoor.Widen`, and the door rolls back and re-runs holding the extra rows.
Nothing a refused attempt did survives.

The caller's own node row is FOR UPDATE whatever the tool declared (the
door's rule, `pgdoor.agent_spec`), so a caller that is only share-locked by
a plan is still correct, only more conservative.

`api` imports this module, which is what registers the tools. Whether a
declared tool actually runs on the door is `pgdoor.enabled()`: PostgreSQL,
or ORGTREE_PGDOOR=1.
"""
from __future__ import annotations

from typing import Any, Callable, cast

from . import lifecycle_tx as lt
from . import pgdoor
from .ledger import LedgerError


def parse_moves(batch: Any) -> list[tuple[str, str | None]]:
    """orgtree_move's `moves` argument, validated. Shared by the DOC_LOCK
    cycle and the door, so both refuse the same shapes with the same words."""
    # D-224 ③: several moves as one transaction; the ledger restores its own
    # doc on a mid-batch refusal.
    if not isinstance(batch, list):
        raise LedgerError("`moves` must be a list of {node, new_parent}")
    # …and so must every ELEMENT (redteam 2026-09-02): the list check alone
    # let `["abc"]`, `[5]`, `[True]` reach `.get` on a str/int/bool →
    # AttributeError → a 500 out of the gateway an agent is holding a tool
    # result open on. An LLM writes ["a","b"] for this shape readily; D-169's
    # rule is that a bad argument 422s with a reason.
    out: list[tuple[str, str | None]] = []
    for i, m in enumerate(cast("list[Any]", batch)):
        if not isinstance(m, dict):
            raise LedgerError(
                f"moves[{i}] must be an object {{node, new_parent}}, not "
                f"{type(cast('object', m)).__name__}")
        mm = cast("dict[str, Any]", m)
        if "new_parent" not in mm:
            # the schema marks it required, and its absence silently meant
            # THE TOP LEVEL — a promotion the caller never typed (and one
            # only the user may make). Say so instead of guessing.
            raise LedgerError(
                f"moves[{i}] has no `new_parent` — name the new superior, or "
                f'pass "" for the top level (user only)')
        out.append((str(mm.get("node") or ""), mm.get("new_parent") or None))
    return out


def _spec(op: str, rows: Callable[[Any, Any, dict[str, Any]],
                                  "tuple[set[str], set[str]]"]):
    """A pgdoor spec function: `op`'s sections from `lt.SPECS`, node rows
    from `rows(snapshot, call, args)`."""
    s = lt.SPECS[op]

    def spec(snap: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
        upd, share = rows(snap, call, a)
        return pgdoor.TxSpec(nodes=tuple(sorted(upd)),
                             sections=tuple(s.sections),
                             share_nodes=tuple(sorted(share - upd)),
                             share_sections=tuple(s.share_sections),
                             logs=tuple(s.logs))
    return spec


def _door_body(fn: Callable[[Any, Any, Any, pgdoor.AgentTx], Any]):
    """Adapt a lifecycle_tx body `(org, held_nodes, held_share, ...)` to the
    door, translating its Widen to the door's."""
    def body(tx: pgdoor.AgentTx) -> Any:
        try:
            return fn(tx.org, tx.spec.nodes, tx.spec.share_nodes, tx)
        except lt.Widen as w:
            raise pgdoor.Widen(nodes=tuple(w.nodes),
                               share_nodes=tuple(w.share_nodes),
                               sections=tuple(w.sections),
                               share_sections=tuple(w.share_sections),
                               logs=tuple(w.logs)) from None
    return body


# ---------------------------------------------------------------- move


def _move_args(a: dict[str, Any]) -> "list[tuple[str, str | None]] | None":
    batch = a.get("moves")
    return parse_moves(batch) if batch else None


def _move_rows(snap: Any, call: Any, a: dict[str, Any]
               ) -> "tuple[set[str], set[str]]":
    try:
        mv = _move_args(a)
    except LedgerError:
        return {call.node}, set()        # the body refuses; lock only the caller
    if mv is not None:
        return lt._move_batch_rows(snap, call.node, mv)
    return lt._move_rows(snap, call.node, str(a.get("node") or ""),
                         a.get("new_parent") or None)


def _move(org: Any, hn: Any, hs: Any, tx: pgdoor.AgentTx) -> Any:
    a, actor = tx.args, tx.node
    mv = _move_args(a)
    if mv is not None:
        return lt.move_batch_body(org, hn, hs, actor, mv)
    return lt.move_body(org, hn, hs, actor, str(a.get("node") or ""),
                        a.get("new_parent") or None)


# ---------------------------------------------------------------- swap


def _swap_rows(snap: Any, call: Any, a: dict[str, Any]
               ) -> "tuple[set[str], set[str]]":
    return lt._swap_rows(snap, call.node, str(a.get("a") or ""),
                         str(a.get("b") or ""))


def _swap(org: Any, hn: Any, hs: Any, tx: pgdoor.AgentTx) -> Any:
    return lt.swap_body(org, hn, hs, tx.node, str(tx.args.get("a") or ""),
                        str(tx.args.get("b") or ""))


# ---------------------------------------------------------------- self-subjugate


def _subjugate_rows(snap: Any, call: Any, a: dict[str, Any]
                    ) -> "tuple[set[str], set[str]]":
    return lt._promote_rows(snap, call.node, call.node,
                            str(a.get("target") or ""))


def _subjugate(org: Any, hn: Any, hs: Any, tx: pgdoor.AgentTx) -> Any:
    return lt.promote_body(org, hn, hs, tx.node, tx.node,
                           str(tx.args.get("target") or ""))


# ---------------------------------------------------------------- retire / dissolve


def _archive_rows(snap: Any, call: Any, a: dict[str, Any]
                  ) -> "tuple[set[str], set[str]]":
    return lt._archive_rows(snap, call.node, str(a.get("node") or ""))


def _archive(op_body: Callable[..., Any]):
    def run(org: Any, hn: Any, hs: Any, tx: pgdoor.AgentTx) -> Any:
        result = op_body(org, hn, hs, tx.node, str(tx.args.get("node") or ""))
        warns = tx.pre.get("archive_warnings")
        if warns:
            result.setdefault("warnings", []).extend(warns)
        return result
    return run


# ---------------------------------------------------------------- rehire
# `api._rehire_seat` is a composite: `Org.rehire`, then `_seat_finish` (the
# scope fields, audience grants, a docket assignment when `work_item` rides
# the call, the kickoff mail), then the placement (`move` / `insert_parent`)
# when `target` / `hire_type` put the seat somewhere else. Its rows are the
# union of each part's plan. The sections are PG-3b's hire sections (the
# seat half is the same code) plus rehire's own and the docket:
#   REHIRE_SECTIONS  lifecycle_tx.SPECS["rehire"] (fable_lock, notices,
#                    watchdogs) + mail, audiences, lifecycle + work_items;
#   REHIRE_SHARE     SPECS["rehire"]'s settings = PG-3b's HIRE_SETTINGS less
#                    fable_lock, which rehire WRITES (agreed with WS3a
#                    2026-09-26; their staffdoor test pins the equality);
#   REHIRE_LOGS      events, notice_log, mail_log.
# `orgtree_staff`'s rehire mode starts from `rehire_rows` (WS3a's staffdoor).

REHIRE_SECTIONS = tuple(sorted(set(lt.SPECS["rehire"].sections)
                               | {"mail", "audiences", "lifecycle", "work_items"}))
REHIRE_SHARE = tuple(lt.SPECS["rehire"].share_sections)
REHIRE_LOGS = tuple(sorted(set(lt.SPECS["rehire"].logs) | {"mail_log"}))
# added when `audiences` rides the call (Org.audience_grant's rows)
REHIRE_AUDIENCE_SECTIONS = ("audience_requests", "user_inbox")
REHIRE_AUDIENCE_LOGS = ("user_mail_log",)
# the scope fields `_seat_finish` applies on a rehire: api._SEAT_SCOPE_REHIRE
# (api cannot be imported here; tests/test_pg3a_door.py pins the equality)
_REHIRE_SCOPE = ("permission_mode", "effort", "team_charter", "prefer_reserve",
                 "account_fallback", "clear_account_fallback", "charter",
                 "org_visibility", "tools", "add_dirs")


def rehire_rows(org: Any, actor: str, a: dict[str, Any]) -> pgdoor.TxSpec:
    """Every row `api._rehire_seat(org, slug, actor, a, ...)` locks, computed
    on `org` (the snapshot, or the locked document when a body re-checks)."""
    nid = str(a.get("node") or "")
    upd, share = lt._rehire_rows(org, actor, nid)
    sections, ssecs = set(REHIRE_SECTIONS), set(REHIRE_SHARE)
    kw = {f: a.get(f) for f in _REHIRE_SCOPE if a.get(f) is not None}
    if kw:
        u, s2, sec, ssec, _logs = lt._scope_plan(org, actor, nid, kw, False)
        upd |= u
        share |= s2
        sections |= set(sec)
        ssecs |= set(ssec)
    logs = set(REHIRE_LOGS)
    if a.get("audiences"):
        # Org.audience_grant, per target: resolves an open request
        # (audience_requests) and, for the user's ear, writes the user inbox
        # and its log (review f3). Declared for every target form: the
        # resolution of a target is itself a decision on the locked doc.
        sections |= set(REHIRE_AUDIENCE_SECTIONS)
        logs |= set(REHIRE_AUDIENCE_LOGS)
    if a.get("account") is not None:
        # the generic door's account step (supervisor.assign_account, doc
        # held): its own declared rows, which a provider-crossing rebind
        # writes (moot asks, folded notices, the docket reconcile)
        from . import supervisor
        sections |= set(supervisor._ASSIGN_SECTIONS)
        ssecs |= set(supervisor._ASSIGN_SHARE)
        logs |= set(supervisor._ASSIGN_LOGS)
    dest = str(a.get("target") or "")
    htype = str(a.get("hire_type") or "subordinate")
    if dest or htype != "subordinate":
        dest = dest or actor
        u, s2 = lt._move_rows(org, actor, nid, dest)
        upd |= u
        share |= s2
        if htype == "superior":
            u, s2 = lt._insert_rows(org, actor, nid, dest)
            upd |= u
            share |= s2
        ssecs |= set(lt.SPECS["move"].share_sections)
    return pgdoor.TxSpec(nodes=tuple(sorted(upd)),
                         sections=tuple(sorted(sections)),
                         share_nodes=tuple(sorted(share - upd)),
                         share_sections=tuple(sorted(ssecs - sections)),
                         logs=tuple(sorted(logs)))


def _rehire_spec(snap: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    return rehire_rows(snap, call.node, a)


def _sweep_first(call: Any, a: dict[str, Any]) -> None:
    """Plan decision 13: a docket write's archive move runs in its OWN
    transaction first, and the call then runs with the move deferred — a
    rehire carrying `work_item` assigns a docket item."""
    from . import worktx
    worktx.sweep(str(call.org))


def rename_stands(e: LedgerError, renamed_to: "str | None") -> LedgerError:
    """A rehire refused AFTER its pre-lock rename committed (the rename
    cannot share the rehire's transaction): the refusal must say the rename
    stands and name the id to retry against, word for word as the DOC_LOCK
    cycle does. Applied ONCE, by api._agent_door's refusal handler, to any
    refusal of a door call whose pre carries `renamed_to` (the rehire body,
    the kiosk cap, the account binding alike) - so a family body must NOT
    wrap it again (orgtree_staff's rehire mode included)."""
    if not renamed_to:
        return e
    return LedgerError(
        f'{e}  ⚠ The RENAME already happened and cannot be undone '
        f'here: the node is still archived, now named '
        f'"{renamed_to}". Nothing else was applied and it was not '
        f'started — retry against "{renamed_to}", without `name`.')


def rehire_body(tx: pgdoor.AgentTx) -> Any:
    """`orgtree_rehire` on the door: exactly `api._rehire_seat` on the locked
    rows, after re-deriving them on the locked document (a gap widens before
    anything is written). The wake-ups ride `after.drive`."""
    from . import api     # api imports this module; resolve at call time
    a = tx.args
    need = tx.spec.covers(rehire_rows(tx.org, tx.node, a))
    if need.nodes or need.share_nodes:
        raise pgdoor.Widen(nodes=need.nodes, share_nodes=need.share_nodes)
    renamed_to = tx.pre.get("renamed_to")
    drive: list[str] = []
    tx.org._work_defer_archive = True
    try:
        result = api._rehire_seat(tx.org, tx.call.org, tx.node, a, drive,
                                  renamed_to,
                                  list(tx.pre.get("rename_warnings") or []))
    finally:
        tx.org._work_defer_archive = False
    tx.after.drive.extend(drive)
    return result


# ---------------------------------------------------------------- retool
# `api._retool_seat`: `Org.set_scope` on the target (rows = `_scope_plan`;
# an agent never raises the kiosk ceiling, so `may_raise` is False), and —
# when `account` rides the call — the door's generic `_account_selection`
# step, `supervisor.assign_account` in THIS transaction. A rebind that owes a
# session boundary splits the seat in place: the new bearer `nid@gen`, the
# mooted asks and the folded notices. The live-effort send runs after commit
# (decision 40 (4)).

RETOOL_FIELDS = ("add_dirs", "tools", "org_visibility", "permission_mode",
                 "charter", "team_charter", "effort", "prefer_reserve",
                 "account_fallback", "clear_account_fallback")


def retool_rows(org: Any, actor: str, a: dict[str, Any]) -> pgdoor.TxSpec:
    nid = str(a.get("node") or "")
    kw = {f: a.get(f) for f in RETOOL_FIELDS if a.get(f) is not None}
    upd, share, secs, ssecs, logs = lt._scope_plan(org, actor, nid, kw, False)
    secs, logs = set(secs), set(logs)
    ssecs = set(ssecs)
    if a.get("account") is not None and nid in org.nodes:
        # the generic door step's supervisor.assign_account (doc held): the
        # in-place split rows a provider crossing archives into, and its own
        # declared sections (a live seat's open asks, credit and scope
        # requests are mooted; notices folded; the docket reconciled)
        from . import supervisor
        u, s2 = lt._split_rows(org, actor, nid)
        upd |= u
        share |= s2
        secs |= set(supervisor._ASSIGN_SECTIONS)
        ssecs |= set(supervisor._ASSIGN_SHARE)
        logs |= set(supervisor._ASSIGN_LOGS)
    return pgdoor.TxSpec(nodes=tuple(sorted(upd)), sections=tuple(sorted(secs)),
                         share_nodes=tuple(sorted(share - upd)),
                         share_sections=tuple(sorted(set(ssecs) - secs)),
                         logs=tuple(sorted(logs, key=str)))


def _retool_spec(snap: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    return retool_rows(snap, call.node, a)


def retool_body(tx: pgdoor.AgentTx) -> Any:
    """`orgtree_retool` on the door: exactly `api._retool_seat` on the locked
    rows (a gap in the re-derived plan widens first)."""
    from . import api, supervisor
    need = tx.spec.covers(retool_rows(tx.org, tx.node, tx.args))
    if not need.empty():
        raise pgdoor.Widen(nodes=need.nodes, sections=need.sections,
                           share_nodes=need.share_nodes,
                           share_sections=need.share_sections, logs=need.logs)
    result, effort = api._retool_seat(tx.org, tx.call.org, tx.node, tx.args)
    if effort is not None:
        target, before = effort
        org = tx.org

        def effort_delivery(res: Any) -> None:
            # the level is committed now, so a running Claude turn may be
            # sent it (the cycle's `effort_live` tail)
            if isinstance(res, dict):
                res["effort_delivery"] = supervisor.send_live_effort(
                    org, target, previous=before)
        tx.after.then.append(effort_delivery)
    return result


pgdoor.declare("orgtree_move", _spec("move", _move_rows), _door_body(_move))
pgdoor.declare("orgtree_swap", _spec("swap_seats", _swap_rows),
               _door_body(_swap))
pgdoor.declare("orgtree_self_subjugate", _spec("move", _subjugate_rows),
               _door_body(_subjugate))
pgdoor.declare("orgtree_retire", _spec("retire", _archive_rows),
               _door_body(_archive(lt.retire_body)))
pgdoor.declare("orgtree_dissolve", _spec("dissolve", _archive_rows),
               _door_body(_archive(lt.dissolve_body)))
pgdoor.declare("orgtree_rehire", _rehire_spec, body=rehire_body,
               before=_sweep_first)
pgdoor.declare("orgtree_retool", _retool_spec, body=retool_body)
