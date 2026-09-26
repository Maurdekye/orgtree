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


pgdoor.declare("orgtree_move", _spec("move", _move_rows), _door_body(_move))
pgdoor.declare("orgtree_swap", _spec("swap_seats", _swap_rows),
               _door_body(_swap))
pgdoor.declare("orgtree_self_subjugate", _spec("move", _subjugate_rows),
               _door_body(_subjugate))
pgdoor.declare("orgtree_retire", _spec("retire", _archive_rows),
               _door_body(_archive(lt.retire_body)))
pgdoor.declare("orgtree_dissolve", _spec("dissolve", _archive_rows),
               _door_body(_archive(lt.dissolve_body)))
