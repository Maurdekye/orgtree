"""One exact turn payload, with independent log and recent-list membership.

Conversion merges only equal reconstructed records. The two positions preserve
the original lists, including pre-log turns and conflicting number/time pairs.
Recent positions may have gaps; callers observe their order, never their value.
"""
from __future__ import annotations

import json
import difflib
from dataclasses import replace
from typing import Any, Mapping

from . import codec
from .codec import Field as F, Rows, Spec
from .sections import ByAgentLists

USAGE = Spec('', (
    F('asked', 'text', nullable=True), F('matched', 'bool', nullable=True),
    F('keys', 'list', item='text', table='agent_turn_model_usage_keys'),
))
SPEC = Spec('agent_turns', (
    F('n', 'int'), F('at', 'ts'), F('cost', 'float'), F('ms', 'int', nullable=True),
    F('toks', 'int'), F('denials', 'int'), F('approvals', 'int'), F('ran_as', 'text'),
    F('killed', 'bool'), F('estimated', 'bool'), F('cost_complete', 'bool'),
    F('cost_source', 'text'),
    F('cost_unknown_fields', 'list', item='text', table='agent_turn_cost_unknown_fields'),
    F('route', 'json'), F('reported', 'json'),
    F('model_usage_key', 'turn_usage', spec=USAGE),
))
_OLD = ByAgentLists('turn_log', SPEC).t
TABLE = replace(_OLD,
    keys=_OLD.keys + (('recent_pos', 'bigint'),), link={'id': 'turn_id'},
    record_columns=tuple('idx integer' if c == 'idx integer NOT NULL' else c
                         for c in _OLD.record_columns) + (
        'recent_pos bigint', 'row_version bigint NOT NULL DEFAULT 0',
        'CHECK (idx IS NOT NULL OR recent_pos IS NOT NULL)',
        'CHECK (recent_pos >= 0)',
    ), indexes=_OLD.indexes + (
        'CREATE UNIQUE INDEX agent_turns_recent_position ON orgtree.agent_turns '
        '(agent_id,recent_pos) WHERE recent_pos IS NOT NULL',
        'CREATE INDEX agent_turns_recent_tail ON orgtree.agent_turns '
        '(agent_id,recent_pos DESC,id) WHERE recent_pos IS NOT NULL',
        'CREATE INDEX agent_turns_log_tail ON orgtree.agent_turns '
        '(agent_id,idx DESC,id) WHERE idx IS NOT NULL',
        'CREATE INDEX agent_turns_log_number ON orgtree.agent_turns '
        '(agent_id,n,idx DESC,id) WHERE idx IS NOT NULL',
    ))


def exact(record: Any) -> str:
    """Type-preserving equality, independent of object key order.

Unlike Python or jsonb equality, 1, 1.0 and true are distinct; so are signed
zero and unknown fields. Escaped NUL and surrogates remain safe JSON text.
"""
    try:
        return json.dumps(record, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise codec.ShapeError('turn record is not finite JSON') from exc


def payload(row: Mapping[str, Any], children: codec.Children) -> dict[str, Any]:
    return codec.decode(SPEC, row, children, (row['id'],))


def recent_values(rows: Mapping[str, list[Mapping[str, Any]]]) -> dict[int, list[dict]]:
    children = codec.Children(rows, TABLE.layout())
    selected: dict[int, list[Mapping[str, Any]]] = {}
    for row in rows.get(SPEC.table, []):
        if row.get('recent_pos') is not None:
            selected.setdefault(row['agent_id'], []).append(row)
    return {aid: [payload(r, children) for r in sorted(group, key=lambda r: r['recent_pos'])]
            for aid, group in selected.items()}


def match(recent: list[dict], logged: list[tuple[int, dict]]) -> list[int | None]:
    """One-to-one ordered matches, preferring the latest equal log occurrences.

The caller supplies logged rows in source order. An exact representation is
the lookup key itself, not a digest; every selected record is compared again.
"""
    candidates: dict[str, list[int]] = {}
    for position, (_, record) in enumerate(logged):
        candidates.setdefault(exact(record), []).append(position)
    result: list[int | None] = [None] * len(recent)
    ceiling = len(logged)
    for position in range(len(recent) - 1, -1, -1):
        key = exact(recent[position])
        choices = candidates.get(key, [])
        while choices and choices[-1] >= ceiling:
            choices.pop()
        if choices:
            picked = choices.pop()
            if exact(logged[picked][1]) != key:
                raise codec.ShapeError('turn membership equality changed')
            result[position] = logged[picked][0]
            ceiling = picked
    return result


def merge_recent(recent: Mapping[int, list[dict]], out: Rows) -> None:
    """Conversion finish: keep log IDs, then mint unmatched list-only payloads."""
    rows = out.setdefault(SPEC.table, [])
    children = codec.Children(out, TABLE.layout())
    logged: dict[int, list[dict]] = {}
    for row in rows:
        row.setdefault('recent_pos', None)
        if row.get('idx') is not None:
            logged.setdefault(row['agent_id'], []).append(row)
    next_id = max((row['id'] for row in rows), default=0)
    by_id = {row['id']: row for row in rows}
    for aid, records in recent.items():
        group = sorted(logged.get(aid, []), key=lambda r: r['idx'])
        matches = match(records, [(r['id'], payload(r, children)) for r in group])
        for position, (record, rid) in enumerate(zip(records, matches)):
            if rid is not None:
                by_id[rid]['recent_pos'] = position
            else:
                next_id += 1
                codec.encode(SPEC, record,
                    {'id': next_id, 'agent_id': aid, 'idx': None, 'recent_pos': position},
                    out, link=TABLE.link)


def recent_plan(old: list[tuple[Mapping[str, Any], dict]], records: list[dict],
                candidates: list[tuple[Mapping[str, Any], dict]] = ()) -> list[tuple[int | None, int]]:
    """Selected payload ID and position for each new recent occurrence.

Keep unchanged subsequences and their gapped positions. An ordinary ring append
therefore retains every surviving membership. A rewrite with insufficient gaps
allocates new positions above the previous maximum, clearing changed keys first.
"""
    selected: list[int | None] = [None] * len(records)
    positions: list[int | None] = [None] * len(records)
    old_keys = [exact(record) for _, record in old]
    keys = [exact(record) for record in records]
    for block in difflib.SequenceMatcher(a=old_keys, b=keys, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            row = old[block.a + offset][0]
            selected[block.b + offset] = row['id']
            positions[block.b + offset] = row['recent_pos']
    used = {rid for rid in selected if rid is not None}
    logged = sorted(candidates, key=lambda pair: pair[0]['idx'])
    log_order = {row['id']: row['idx'] for row, _ in old + logged if row['idx'] is not None}
    chosen = match(records, [(r['id'], record) for r, record in logged])
    for i, rid in enumerate(chosen):
        if selected[i] is None and rid is not None and rid not in used:
            left = max((log_order[value] for value in selected[:i] if value in log_order), default=-1)
            right = min((log_order[value] for value in selected[i + 1:] if value in log_order),
                        default=float('inf'))
            if not left < log_order[rid] < right:
                continue
            selected[i] = rid
            used.add(rid)
    maximum = max((row['recent_pos'] for row, _ in old), default=-1)
    left = -1
    start = 0
    for i in range(len(records) + 1):
        right = positions[i] if i < len(records) else max(maximum, left) + len(records) + 1
        if right is None:
            continue
        count = i - start
        if right - left <= count:
            return [(rid, maximum + 1 + index) for index, rid in enumerate(selected)]
        for index in range(start, i):
            positions[index] = left + 1 + index - start
        if i < len(records):
            left = right
            start = i + 1
    return [(rid, int(position)) for rid, position in zip(selected, positions)]


def _dict_rows(raw: Any, statement: str, params=()) -> list[dict]:
    from psycopg.rows import dict_row
    with raw.cursor(row_factory=dict_row) as cursor:
        cursor.execute(statement, params)
        return list(cursor.fetchall())


def read_recent(raw: Any, ids: list[int], *, limit: int | None = None) -> dict[int, list[dict]]:
    """Only selected agents' recent members and those members' metadata children."""
    if not ids:
        return {}
    if limit is not None and limit < 0:
        raise ValueError('recent-turn limit must be nonnegative')
    if limit is None:
        selected = _dict_rows(raw, 'SELECT * FROM orgtree.agent_turns WHERE agent_id=ANY(%s) '
                             'AND recent_pos IS NOT NULL ORDER BY agent_id,recent_pos', (ids,))
    else:
        selected = _dict_rows(raw,
            'SELECT turn.* FROM unnest(%s::bigint[]) selected(agent_id) '
            'CROSS JOIN LATERAL (SELECT * FROM orgtree.agent_turns '
            'WHERE agent_id=selected.agent_id AND recent_pos IS NOT NULL '
            'ORDER BY recent_pos DESC,id DESC LIMIT %s) turn', (ids, limit))
    rows = {SPEC.table: selected}
    turn_ids = [row['id'] for row in selected]
    if turn_ids:
        for child in TABLE.layout():
            if child != SPEC.table:
                rows[child] = _dict_rows(raw, f'SELECT * FROM orgtree.{child} '
                                        'WHERE turn_id=ANY(%s)', (turn_ids,))
    return recent_values(rows)


def lock_agents(raw: Any, ids: list[int]) -> None:
    """Take the agent tier before membership rows or their child rows."""
    if ids:
        raw.execute('SELECT id FROM orgtree.agents WHERE id=ANY(%s) ORDER BY id FOR UPDATE',
                    (sorted(set(ids)),)).fetchall()


def lock_log_ids(raw: Any, ids: list[int]) -> None:
    agents = [row[0] for row in raw.execute(
        'SELECT DISTINCT agent_id FROM orgtree.agent_turns WHERE id=ANY(%s) '
        'AND idx IS NOT NULL', (ids,)).fetchall()]
    lock_agents(raw, agents)


def _old_recent(raw: Any, aid: int):
    from .compat import rows as R
    rows, children = R.fetch(raw, TABLE, 'agent_id=%s AND recent_pos IS NOT NULL',
                             (aid,), order='recent_pos', lock=True)
    return [(row, payload(row, children)) for row in rows]


def _log_candidates(raw: Any, aid: int, records: list[dict]):
    """Bounded tail plus bounded indexed number probes; no cold JSON predicates."""
    from .compat import rows as R
    cap = max(8, len(records))
    selected = {int(row[0]) for row in raw.execute(
        'SELECT id FROM orgtree.agent_turns WHERE agent_id=%s AND idx IS NOT NULL '
        'ORDER BY idx DESC,id DESC LIMIT %s', (aid, cap)).fetchall()}
    numbers = sorted({rec['n'] for rec in records if codec.fits('int', rec.get('n'))})
    if numbers:
        selected.update(int(row[0]) for row in raw.execute(
            'SELECT turn.id FROM unnest(%s::bigint[]) selected(n) CROSS JOIN LATERAL '
            '(SELECT id FROM orgtree.agent_turns WHERE agent_id=%s AND n=selected.n '
            'AND idx IS NOT NULL ORDER BY idx DESC,id DESC LIMIT %s) turn',
            (numbers, aid, cap)).fetchall())
    rows, children = R.fetch(raw, TABLE, 'id=ANY(%s)', (sorted(selected),), order='idx')
    return [(row, payload(row, children)) for row in rows]


def reconcile_recent(raw: Any, aid: int, records: list[dict]) -> None:
    """Change one selected node's recent membership, leaving its log untouched."""
    from .compat import rows as R
    # node_put already owns this row; repeated acquisition also makes the helper
    # safe for a caller that writes a ring without a full node replacement.
    lock_agents(raw, [aid])
    old = _old_recent(raw, aid)
    if exact([record for _, record in old]) == exact(records):
        return
    plan = recent_plan(old, records, _log_candidates(raw, aid, records) if records else [])
    target = {rid: position for rid, position in plan if rid is not None}
    changed = [row['id'] for row, _ in old if target.get(row['id']) != row['recent_pos']]
    if changed:
        # Release affected unique keys before any replacement. Rows with no
        # surviving membership are removed; a log member only loses recent_pos.
        raw.execute('DELETE FROM orgtree.agent_turns WHERE id=ANY(%s) AND idx IS NULL',
                    (changed,))
        raw.execute('UPDATE orgtree.agent_turns SET recent_pos=NULL,row_version=row_version+1 '
                    'WHERE id=ANY(%s) AND idx IS NOT NULL', (changed,))
    old_positions = {row['id']: row['recent_pos'] for row, _ in old}
    for record, (rid, position) in zip(records, plan):
        if rid is None:
            rid = R.new_ids(raw, SPEC.table, 1)[0]
            encoded: Rows = {}
            codec.encode(SPEC, record, {'id': rid, 'agent_id': aid, 'idx': None,
                                      'recent_pos': position}, encoded, link=TABLE.link)
            R.store_encoded(raw, TABLE, encoded, ids=[rid])
        elif old_positions.get(rid) != position:
            # An old list-only row selected at another position must survive the
            # clearing phase. Its payload is reinserted under the same identity.
            prior = next(((row, value) for row, value in old if row['id'] == rid), None)
            if prior is not None and prior[0]['idx'] is None:
                encoded = {}
                codec.encode(SPEC, prior[1], {'id': rid, 'agent_id': aid, 'idx': None,
                                             'recent_pos': position}, encoded, link=TABLE.link)
                R.store_encoded(raw, TABLE, encoded, ids=[rid])
            else:
                raw.execute('UPDATE orgtree.agent_turns SET recent_pos=%s,row_version=row_version+1 '
                            'WHERE id=%s', (position, rid))


def clear_recent(raw: Any, aid: int) -> None:
    reconcile_recent(raw, aid, [])


def attach_log(raw: Any, aid: int, rid: int, idx: int, record: dict) -> None:
    """Insert an allocated log ID, consolidating a proven list-only match."""
    from .compat import rows as R
    lock_agents(raw, [aid])
    old = _old_recent(raw, aid)
    last_shared = max((row['recent_pos'] for row, _ in old if row['idx'] is not None), default=-1)
    equal = [(row, value) for row, value in old if row['idx'] is None
             and row['recent_pos'] > last_shared and exact(value) == exact(record)]
    prior = equal[0][0] if equal else None
    position = prior['recent_pos'] if prior is not None else None
    if prior is not None:
        raw.execute('DELETE FROM orgtree.agent_turns WHERE id=%s AND idx IS NULL', (prior['id'],))
    out: Rows = {}
    codec.encode(SPEC, record, {'id': rid, 'agent_id': aid, 'idx': idx,
                              'recent_pos': position}, out, link=TABLE.link)
    R.store_encoded(raw, TABLE, out, ids=[rid])


def rewrite_log(raw: Any, row: Mapping[str, Any], before: dict, record: dict) -> None:
    """Keep the log identity; fork a differing recent occurrence before editing."""
    from .compat import rows as R
    lock_agents(raw, [row['agent_id']])
    position = row['recent_pos']
    if position is not None and exact(before) != exact(record):
        raw.execute('UPDATE orgtree.agent_turns SET recent_pos=NULL,row_version=row_version+1 '
                    'WHERE id=%s', (row['id'],))
        fork_id = R.new_ids(raw, SPEC.table, 1)[0]
        out: Rows = {}
        codec.encode(SPEC, before, {'id': fork_id, 'agent_id': row['agent_id'], 'idx': None,
                                   'recent_pos': position}, out, link=TABLE.link)
        R.store_encoded(raw, TABLE, out, ids=[fork_id])
        position = None
    raw.execute('DELETE FROM orgtree.agent_turns WHERE id=%s', (row['id'],))
    out = {}
    codec.encode(SPEC, record, {'id': row['id'], 'agent_id': row['agent_id'], 'idx': row['idx'],
                              'recent_pos': position}, out, link=TABLE.link)
    R.store_encoded(raw, TABLE, out, ids=[row['id']])


def remove_log(raw: Any, ids: list[int]) -> int:
    """Remove log membership, retaining any independently selected recent data."""
    lock_log_ids(raw, ids)
    changed = int(raw.execute('UPDATE orgtree.agent_turns SET idx=NULL,row_version=row_version+1 '
                             'WHERE id=ANY(%s) AND idx IS NOT NULL AND recent_pos IS NOT NULL',
                             (ids,)).rowcount)
    changed += int(raw.execute('DELETE FROM orgtree.agent_turns WHERE id=ANY(%s) '
                              'AND idx IS NOT NULL AND recent_pos IS NULL', (ids,)).rowcount)
    return changed


class Log(ByAgentLists):
    """A normal by-agent log whose table also carries node recent membership."""
    def __init__(self, legacy: Spec) -> None:
        super().__init__('turn_log', SPEC)
        self.t = TABLE
        self.tables = (TABLE,)
        self.migration_tables = (ByAgentLists('turn_log', legacy).t,)

    def decode(self, rows, ctx, present, doc) -> None:
        selected = dict(rows)
        selected[SPEC.table] = [r for r in rows.get(SPEC.table, []) if r.get('idx') is not None]
        super().decode(selected, ctx, present, doc)
