"""Narrow native graph plans, checked before any structural statement.

The SQL aggregate triggers run for every writer. This module gives native
writers an ordered plan; it never repairs a missing lock in the body. Paths
are current parent edges, not a descendant list or an all-node document.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from ..ledger import USER, LedgerError


@dataclass(frozen=True)
class LockPlan:
    names: frozenset[str]
    agent_ids: frozenset[int]
    stats_ids: frozenset[int]
    whole: bool = False


def _paths(raw: Any, names: list[str]) -> list[tuple[int, str, int | None]]:
    # UNION coalesces common suffixes and terminates even on a malformed cycle.
    # The body's cycle/permission rules and final assertion remain separate.
    return raw.execute(
        "WITH RECURSIVE path(id,name,parent_id) AS ("
        "SELECT id,name,parent_id FROM orgtree.agents WHERE name=ANY(%s) "
        "UNION SELECT a.id,a.name,a.parent_id FROM orgtree.agents a "
        "JOIN path p ON a.id=p.parent_id) SELECT id,name,parent_id FROM path ORDER BY id",
        (names,)).fetchall()


def plan_locks(raw: Any, tx: Any) -> LockPlan | None:
    """Unheld planning read; append agent paths before the sorted lock block."""
    if not tx.structural_roots:
        return None
    if tx.all_nodes:
        rows = raw.execute("SELECT id,name,parent_id FROM orgtree.agents ORDER BY id").fetchall()
    else:
        rows = _paths(raw, sorted(tx.structural_roots))
    names = frozenset(str(r[1]) for r in rows)
    ids = frozenset(int(r[0]) for r in rows)
    # Roots may be new agents; their names still need the normal advisory/body
    # declaration, while only existing rows can be locked in this tier.
    tx.share_nodes |= names - tx.lock_nodes
    return LockPlan(names, ids, ids, tx.all_nodes)


def stats_lock_clause(plan: LockPlan | None) -> str:
    if plan is None:
        return ""
    condition = "true" if plan.whole else (
        "agent_id IN (" + ",".join(str(i) for i in sorted(plan.stats_ids)) + ")"
        if plan.stats_ids else "false")
    return ("PERFORM agent_id FROM orgtree.agent_subtree_stats WHERE " + condition +
            " ORDER BY agent_id FOR UPDATE;")


def install_plan(raw: Any, tx: Any, plan: LockPlan | None) -> None:
    """After the whole lock block, validate coverage before yielding the body."""
    if plan is not None:
        current = _paths(raw, sorted(tx.structural_roots)) if not plan.whole else raw.execute(
            "SELECT id,name,parent_id FROM orgtree.agents ORDER BY id").fetchall()
        missing = {str(r[1]) for r in current if int(r[0]) not in plan.agent_ids}
        if missing:
            from ..pgdoor import Widen   # noqa: PLC0415
            raise Widen(share_nodes=missing, structural_roots=missing)
        found = {int(r[0]) for r in raw.execute(
            "SELECT agent_id FROM orgtree.agent_subtree_stats WHERE agent_id=ANY(%s)",
            (sorted(plan.stats_ids),)).fetchall()}
        if found != plan.stats_ids:
            raise LedgerError("native graph aggregate rows are missing; reconciliation is required")
    # PostgreSQL owns the marker, not an attribute on a pooled connection.
    # Rollback/savepoint rollback and a later checkout cannot inherit authority.
    value = {"agents": sorted(plan.agent_ids) if plan else [],
             "stats": sorted(plan.stats_ids) if plan else [],
             "updates": sorted(tx.lock_nodes), "whole": bool(plan and plan.whole)}
    raw.execute("SELECT set_config('orgtree.graph_plan',%s,true)", (json.dumps(value),))


def current_plan(raw: Any) -> dict[str, Any] | None:
    """None is a raw/conversion writer; native markers last one transaction."""
    value = raw.execute(
        "SELECT nullif(current_setting('orgtree.graph_plan',true),'')").fetchone()[0]
    return json.loads(value) if value is not None else None


def check_paths(raw: Any, roots: set[str], *, updates: set[str] | None = None) -> None:
    """Structural guard. A missing early-tier lock widens, never locks late."""
    plan = current_plan(raw)
    if plan is None:
        # Raw/conversion writers get unconditional SQL trigger maintenance.
        # They may deadlock/retry without a plan; never acquire native locks late.
        return
    needed = roots - {USER}
    rows = _paths(raw, sorted(needed))
    missing = {str(r[1]) for r in rows if int(r[0]) not in plan['agents']
               or int(r[0]) not in plan['stats']}
    missing_updates = (updates or set()) - set(plan['updates']) if not plan['whole'] else set()
    # New agents have no physical row yet. Their update advisory/name declaration
    # is still mandatory, even when every ancestor was already held.
    if missing or missing_updates:
        from ..pgdoor import Widen   # noqa: PLC0415
        raise Widen(nodes=missing_updates, structural_roots=needed | missing,
                    share_nodes=missing - (updates or set()))


def assert_final_cycles(raw: Any) -> None:
    """Same SQL kernel used after today's revision and B4a's deferred flush."""
    raw.execute("SELECT orgtree.graph_assert_final_cycles()")
