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
    scope_roots: frozenset[str] = frozenset()


@dataclass(frozen=True)
class SubtreeStats:
    agent_id: int
    parent_id: int | None
    descendants: int
    height: int
    org_children_count: int
    row_version: int


def subtree_stats(raw: Any, name: str) -> SubtreeStats:
    """One indexed header/cache read, never a descendant-scan fallback."""
    row = raw.execute(
        "SELECT a.id,a.parent_id,s.parent_agent_id,s.descendants,s.height,"
        "s.org_children_count,a.row_version FROM orgtree.agents a "
        "LEFT JOIN orgtree.agent_subtree_stats s ON s.agent_id=a.id "
        "WHERE a.name=%s AND NOT a.tombstone", (name,)).fetchone()
    if row is None:
        raise LedgerError(f"no such agent: {name!r}")
    if row[3] is None or row[1] != row[2] or min(row[3:6]) < 0:
        raise LedgerError("native graph aggregate is missing or corrupt; reconciliation is required")
    return SubtreeStats(int(row[0]), row[1], int(row[3]), int(row[4]), int(row[5]), int(row[6]))


def verify_stats(raw: Any) -> list[tuple[int, str]]:
    """Explicit slow, read-only reference check for reconciliation diagnostics."""
    return [(int(agent_id), str(issue)) for agent_id, issue in raw.execute(
        "SELECT agent_id,issue FROM orgtree.graph_verify_stats() ORDER BY agent_id").fetchall()]


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
    """Plan current authority paths; only structural paths need stats locks."""
    roots = tx.lock_nodes | tx.share_nodes | tx.structural_roots
    if not roots and not tx.all_nodes:
        return None
    if tx.all_nodes:
        rows = raw.execute("SELECT id,name,parent_id FROM orgtree.agents ORDER BY id").fetchall()
    else:
        rows = _paths(raw, sorted(roots))
    names = frozenset(str(r[1]) for r in rows)
    ids = frozenset(int(r[0]) for r in rows)
    # Roots may be new agents; their names still need the normal advisory/body
    # declaration, while only existing rows can be locked in this tier.
    tx.share_nodes |= names - tx.lock_nodes
    stats = (ids if tx.all_nodes else frozenset(int(r[0]) for r in
             _paths(raw, sorted(tx.structural_roots)))) if tx.structural_roots else frozenset()
    return LockPlan(names, ids, stats, tx.all_nodes, frozenset(roots))


def stats_lock_clause(plan: LockPlan | None) -> str:
    if plan is None or not plan.stats_ids:
        return ""
    condition = "true" if plan.whole else (
        "agent_id IN (" + ",".join(str(i) for i in sorted(plan.stats_ids)) + ")"
        if plan.stats_ids else "false")
    return ("PERFORM agent_id FROM orgtree.agent_subtree_stats WHERE " + condition +
            " ORDER BY agent_id FOR UPDATE;")


def install_plan(raw: Any, tx: Any, plan: LockPlan | None) -> None:
    """After the whole lock block, validate coverage before yielding the body."""
    if plan is not None:
        current = _paths(raw, sorted(plan.scope_roots)) if not plan.whole else raw.execute(
            "SELECT id,name,parent_id FROM orgtree.agents ORDER BY id").fetchall()
        missing = {str(r[1]) for r in current if int(r[0]) not in plan.agent_ids}
        if missing:
            if not tx.structural_roots:
                from ..orgtx import SerializationFailure   # noqa: PLC0415
                # Before the body: rebuild the plan on retry, never lock late.
                raise SerializationFailure('scope chain changed while acquiring its locks')
            from ..pgdoor import Widen   # noqa: PLC0415
            raise Widen(share_nodes=missing, structural_roots=missing)
        current_stats = (_paths(raw, sorted(tx.structural_roots))
                         if tx.structural_roots and not plan.whole else current
                         if tx.structural_roots else [])
        missing_stats = {str(r[1]) for r in current_stats if int(r[0]) not in plan.stats_ids}
        if missing_stats:
            from ..pgdoor import Widen   # noqa: PLC0415
            raise Widen(share_nodes=missing_stats, structural_roots=missing_stats)
        found = {int(r[0]) for r in raw.execute(
            "SELECT agent_id FROM orgtree.agent_subtree_stats WHERE agent_id=ANY(%s)",
            (sorted(plan.stats_ids),)).fetchall()} if plan.stats_ids else set()
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


def check_scope_paths(raw: Any, roots: set[str]) -> None:
    """An authoritative scope read uses held agents, never a cached permission."""
    plan = current_plan(raw)
    if plan is None:
        raise LedgerError('scope authority requires its current planned org transaction')
    rows = _paths(raw, sorted(roots - {USER}))
    missing = {str(r[1]) for r in rows if int(r[0]) not in plan['agents']}
    if missing:
        from ..pgdoor import Widen   # noqa: PLC0415
        raise Widen(share_nodes=missing)


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


@dataclass(frozen=True)
class ScalarPatch:
    """A loaded header token and only the fields this operation changes."""
    agent_id: int
    name: str
    row_version: int
    values: dict[str, Any]


def _field_image(value: Any, *, reference: int | None = None) -> dict[str, Any]:
    from . import codec   # noqa: PLC0415
    if reference is not None:
        return {'ref': reference}
    return {} if value is codec.MISSING else {'value': value}


def _header_images(row: tuple[Any, ...]) -> dict[str, dict[str, Any]]:
    from . import codec   # noqa: PLC0415
    from .compat.rows import scalar_field   # noqa: PLC0415
    _, _, _, parent_id, parent, parent_null, grant, extra = row
    parent_value = None if parent_null else scalar_field(parent, extra, 'parent')
    grant_value = scalar_field(codec.from_column('num', grant) if grant is not None else None,
                               extra, 'grant')
    return {'parent': _field_image(parent_value, reference=parent_id),
            'grant': _field_image(grant_value)}


def _scalar_records(raw: Any) -> dict[str, Any]:
    value = raw.execute("SELECT nullif(current_setting('orgtree.graph_patches',true),'')").fetchone()[0]
    return json.loads(value) if value is not None else {}


def apply_scalars(raw: Any, patches: list[ScalarPatch]) -> dict[int, int]:
    """One version-fenced UPDATE FROM batch, with rollback-owned save handoff.

    No child row or unrelated header column is rewritten. A partial CAS rolls
    back this entire batch, even if a caller catches the refusal. PostgreSQL
    owns the handoff: savepoint rollback and connection reuse cannot retain it.
    """
    from . import codec   # noqa: PLC0415
    from .. import store   # noqa: PLC0415
    if not patches:
        return {}
    if len({p.agent_id for p in patches}) != len(patches):
        raise LedgerError('duplicate native scalar patch')
    for p in patches:
        if not p.values or set(p.values) - {'parent', 'grant'}:
            raise LedgerError('native scalar patches change parent or grant only')
        if 'parent' in p.values and p.values['parent'] is not None \
                and not codec.fits('text', p.values['parent']):
            raise LedgerError('native scalar parent must name an agent or the top level')
        if 'grant' in p.values and not codec.fits('num', p.values['grant']):
            raise LedgerError('native scalar grant must be an exact finite number')
    plan = current_plan(raw)
    if plan is None or not plan.stats_ids:
        raise LedgerError('native scalar patches require a planned org transaction')
    updates = {p.name for p in patches}
    missing = updates - set(plan['updates']) if not plan['whole'] else set()
    if missing:
        from ..pgdoor import Widen   # noqa: PLC0415
        raise Widen(nodes=missing)
    roots = {p.name for p in patches if 'parent' in p.values}
    roots |= {p.values['parent'] for p in patches if p.values.get('parent') is not None}
    if roots:
        check_paths(raw, roots, updates=updates)
    ids = [p.agent_id for p in patches]
    rows = raw.execute('SELECT id,name,row_version,parent_id,parent,parent_null,credit_grant,extra '
                       'FROM orgtree.agents WHERE id=ANY(%s) AND NOT tombstone', (ids,)).fetchall()
    before = {int(r[0]): r for r in rows}
    if set(before) != set(ids) or any(before[p.agent_id][1:3] != (p.name, p.row_version)
                                     for p in patches):
        raise store.StaleWrite('native scalar header changed; nothing was written')
    parents = {str(p.values['parent']) for p in patches if p.values.get('parent') is not None}
    parent_ids = dict(raw.execute('SELECT name,id FROM orgtree.agents WHERE name=ANY(%s) '
                                 'AND NOT tombstone', (sorted(parents),)).fetchall()) if parents else {}
    if set(parent_ids) != parents:
        raise store.StaleWrite('native scalar parent disappeared; nothing was written')
    records = _scalar_records(raw)
    extras, changed_extra = [], []
    for p in patches:
        old_extra = before[p.agent_id][7]
        extra = dict(old_extra or {})
        changed = any(key in extra for key in p.values)
        for key in p.values:
            extra.pop(key, None)
        extras.append(codec.to_column('json', extra) if extra else None)
        changed_extra.append(changed)
    raw.execute('SAVEPOINT graph_scalar_batch')
    try:
        result = raw.execute(
            'WITH patch AS (SELECT * FROM unnest(%s::bigint[],%s::text[],%s::bigint[],'
            '%s::boolean[],%s::bigint[],%s::boolean[],%s::numeric[],%s::boolean[],%s::json[]) '
            'AS p(id,name,version,set_parent,parent_id,set_grant,new_grant,set_extra,extra)) '
            'UPDATE orgtree.agents a SET parent_id=CASE WHEN p.set_parent THEN p.parent_id ELSE a.parent_id END,'
            'parent=CASE WHEN p.set_parent THEN NULL ELSE a.parent END,'
            'parent_null=CASE WHEN p.set_parent THEN CASE WHEN p.parent_id IS NULL THEN true END '
            'ELSE a.parent_null END,'
            'credit_grant=CASE WHEN p.set_grant THEN p.new_grant ELSE a.credit_grant END,'
            'extra=CASE WHEN p.set_extra THEN p.extra ELSE a.extra END,row_version=a.row_version+1 '
            'FROM patch p WHERE a.id=p.id AND a.name=p.name AND a.row_version=p.version AND NOT a.tombstone '
            'RETURNING a.id,a.row_version',
            (ids, [p.name for p in patches], [p.row_version for p in patches],
             ['parent' in p.values for p in patches],
             [parent_ids.get(p.values.get('parent')) for p in patches],
             ['grant' in p.values for p in patches],
             [codec.to_column('num', p.values['grant']) if 'grant' in p.values else None for p in patches],
             changed_extra, extras)).fetchall()
        versions = {int(i): int(v) for i, v in result}
        if set(versions) != set(ids):
            raise store.StaleWrite('native scalar CAS lost a row; batch rolled back')
        for p in patches:
            entry = records.setdefault(str(p.agent_id), {'before': {}, 'after': {}})
            images = _header_images(before[p.agent_id])
            for key, value in p.values.items():
                prior = entry['before'].setdefault(key, [])
                if images[key] not in prior:
                    prior.append(images[key])
                entry['after'][key] = (_field_image(value, reference=parent_ids.get(value))
                                       if key == 'parent' else _field_image(value))
            entry['version'] = versions[p.agent_id]
        raw.execute("SELECT set_config('orgtree.graph_patches',%s,true)", (json.dumps(records),))
        raw.execute('RELEASE SAVEPOINT graph_scalar_batch')
        return versions
    except BaseException:
        raw.execute('ROLLBACK TO SAVEPOINT graph_scalar_batch')
        raw.execute('RELEASE SAVEPOINT graph_scalar_batch')
        raise


def _image_value(image: dict[str, Any], names: dict[int, str]) -> Any:
    from . import codec   # noqa: PLC0415
    if 'ref' in image:
        if image['ref'] not in names:
            raise LedgerError('native scalar reference disappeared before save')
        return names[image['ref']]
    return image.get('value', codec.MISSING)


def save_baselines(conn: Any, d: Any, lazy: Any, changes: Any) -> Any:
    """Working baselines for headers already written in this transaction.

    The original LazyDoc and all its maps remain untouched until the normal
    successful adoption. This is also the rename prepass's read-only input.
    A second call accepts its own post-patch baseline instead of applying twice.
    """
    from .. import store   # noqa: PLC0415
    from . import codec   # noqa: PLC0415
    from .compat.rows import same   # noqa: PLC0415
    records = _scalar_records(conn.raw)
    if not records:
        return lazy
    if lazy is None or lazy._receipt_rows:
        raise store.StaleWrite('native scalar save requires node baselines')
    wanted = {int(i) for i in records}
    images = [image for record in records.values() for values in record['before'].values()
              for image in values] + [image for record in records.values()
                                     for image in record['after'].values()]
    wanted |= {image['ref'] for image in images if 'ref' in image}
    names = {int(i): str(name) for i, name in conn.raw.execute(
        'SELECT id,name FROM orgtree.agents WHERE id=ANY(%s)', (sorted(wanted),)).fetchall()}
    baselines = dict(lazy._snap_nodes)
    for identity, record in records.items():
        name = names.get(int(identity))
        text = baselines.get(name)
        if text is None:
            raise store.StaleWrite('native scalar save lost its loaded node baseline')
        baseline = json.loads(text)
        for key, after in record['after'].items():
            new = _image_value(after, names)
            actual = baseline.get(key, codec.MISSING)
            candidates = [_image_value(image, names) for image in record['before'][key]] + [new]
            if not any(actual is candidate if actual is codec.MISSING or candidate is codec.MISSING
                       else same(json.dumps(actual), json.dumps(candidate)) for candidate in candidates):
                raise store.StaleWrite('native scalar save baseline does not match its header token')
            baseline[key] = new
        baselines[name] = store._dumps(baseline)
        if changes is not None and name not in changes.node_updates:
            changes.node_updates.append(name)
    working = store.LazyDoc.__new__(store.LazyDoc)
    working.__dict__.update(lazy.__dict__)
    for key, value in dict.items(lazy):
        dict.__setitem__(working, key, value)
    working._snap_nodes = baselines
    return working


def guard_node_put(raw: Any, name: str, value: Any) -> None:
    """Before lookup/encoding/header writes: cover only actual graph changes."""
    from . import codec   # noqa: PLC0415
    if not isinstance(value, dict) or not codec.fits('text', name) or current_plan(raw) is None:
        return                 # normal shape checks or the unconditional raw SQL triggers
    row = raw.execute('SELECT a.tombstone,p.name,orgtree.graph_child_counted(a) FROM orgtree.agents a '
                      'LEFT JOIN orgtree.agents p ON p.id=a.parent_id '
                      'WHERE a.name=%s ORDER BY a.tombstone,a.id LIMIT 1', (name,)).fetchone()
    parent = value.get('parent')
    new_parent = parent if isinstance(parent, str) and codec.fits('text', parent) else None
    counted = not (value.get('state') == 'archived' and bool(value.get('successor')))
    if row is not None:
        hidden, old_parent, old_counted = row
        if not hidden and old_parent == new_parent and old_counted == counted:
            return
    check_paths(raw, {name} | ({new_parent} if new_parent is not None else set()), updates={name})


def guard_node_delete(raw: Any, name: str) -> None:
    """A tombstone changes branch visibility; never take path locks late."""
    if current_plan(raw) is not None:
        check_paths(raw, {name}, updates={name})
