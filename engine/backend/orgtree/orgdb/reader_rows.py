"""Exact rows for native readers, restricted to their selected records.

The caller owns the raw connection and its read-only repeatable-read snapshot.
No connection, cache, write or compatibility statement is used here. The codecs
are the converter's codecs, including their null, missing and misfit values.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from . import codec, mappers, sections
from .mappers import agents


def _rows(raw: Any, statement: str, params=()) -> list[dict]:
    from psycopg.rows import dict_row   # noqa: PLC0415
    with raw.cursor(row_factory=dict_row) as cursor:
        cursor.execute(statement, params)
        return list(cursor.fetchall())


def read_agents(raw: Any, names: Iterable[str], *, recent_turns_limit: int | None = None
                ) -> dict[str, dict]:
    """Selected non-tombstone agents, in persisted order, with exact bodies.

    None keeps every recent-turn list entry; a limit keeps only its newest
    positions, in their original order. Identity readers use the full body.
    """
    if recent_turns_limit is not None and recent_turns_limit < 0:
        raise ValueError('recent_turns_limit must be nonnegative')
    rows = _rows(raw, 'SELECT * FROM orgtree.agents WHERE NOT tombstone '
                 'AND name = ANY(%s) ORDER BY ord, id', (list(names),))
    if not rows:
        return {}
    ids = [row['id'] for row in rows]
    hot_layout, rt_layout = agents.AGENTS.layout(), agents.RUNTIME_T.layout()
    hot, runtime = {}, {}
    for target, layout, main in ((hot, hot_layout, 'agents'),
                                 (runtime, rt_layout, 'agent_runtime')):
        for table in layout:
            if table == main:
                continue
            if table == 'agent_recent_turns' and recent_turns_limit is not None:
                target[table] = _rows(raw,
                    'SELECT turn.* FROM unnest(%s::bigint[]) selected(agent_id) '
                    'CROSS JOIN LATERAL (SELECT * FROM orgtree.agent_recent_turns '
                    'WHERE agent_id = selected.agent_id ORDER BY pos DESC LIMIT %s) turn',
                    (ids, recent_turns_limit))
            else:
                target[table] = _rows(raw, f'SELECT * FROM orgtree.{table} '
                                     'WHERE agent_id = ANY(%s)', (ids,))
    texts = {row['agent_id']: row for row in _rows(raw,
        'SELECT * FROM orgtree.agent_texts WHERE agent_id = ANY(%s)', (ids,))}
    payloads = {row['agent_id']: row for row in _rows(raw,
        'SELECT * FROM orgtree.agent_runtime WHERE agent_id = ANY(%s)', (ids,))}
    referenced = {row[f'{ref}_id'] for row in rows for ref in agents.REFS
                  if row[f'{ref}_id'] is not None}
    name_by_id = {aid: name for aid, name in raw.execute(
        'SELECT id, name FROM orgtree.agents WHERE id = ANY(%s)', (list(referenced),)).fetchall()}
    lists = {row['tool_list_id'] for row in rows if row['tool_list_id'] is not None}
    tools: dict[int, list[tuple[int, str]]] = {}
    for lid, pos, tool in raw.execute('SELECT list_id, pos, tool FROM orgtree.tool_list_items '
                                      'WHERE list_id = ANY(%s)', (list(lists),)).fetchall():
        tools.setdefault(lid, []).append((pos, tool))
    ch_hot, ch_rt = codec.Children(hot, hot_layout), codec.Children(runtime, rt_layout)
    return {row['name']: agents.decode_node(row, ch_hot, ch_rt, texts[row['id']],
                                          payloads[row['id']], tools, name_by_id.__getitem__)
            for row in rows}


def read_sections(raw: Any, keys: Iterable[str], *, owners: Iterable[str] | None = None
                  ) -> dict[str, Any]:
    """Named sections only; selected owners of by-agent sections when supplied.

    Empty owner containers, nulls and unknown scalar keys remain distinct.
    Child tables are probed by the selected parent IDs, never decoded globally.
    """
    keys = list(dict.fromkeys(keys))
    if 'nodes' in keys:
        raise ValueError('use read_agents for selected nodes')
    present = _rows(raw, 'SELECT * FROM orgtree.org_sections WHERE key = ANY(%s) '
                    'ORDER BY ord', (keys,))
    active = {row['key'] for row in present if row['state'] == 'v'}
    rows: dict[str, list[dict]] = {'org_sections': present}
    rows['org_extra'] = _rows(raw, 'SELECT * FROM orgtree.org_extra WHERE key = ANY(%s)',
                              (keys,))
    picked = [sec for sec in mappers.sections() if active.intersection(sec.keys)]
    ctx = sections.Context()
    wanted_ids = None
    if owners is not None:
        wanted_ids = [aid for aid, name in raw.execute(
            'SELECT id, name FROM orgtree.agents WHERE name = ANY(%s) '
            'ORDER BY tombstone, id', (list(owners),)).fetchall()]
    for sec in picked:
        by_agent = isinstance(sec, (sections.ByAgentLists, sections.ByAgentRecords,
                                    sections.ByAgentMaps))
        if by_agent:
            sql = 'SELECT * FROM orgtree.org_section_owners WHERE section = ANY(%s)'
            params: list[Any] = [list(active.intersection(sec.keys))]
            if wanted_ids is not None:
                sql += ' AND agent_id = ANY(%s)'
                params.append(wanted_ids)
            owner_rows = _rows(raw, sql, params)
            rows.setdefault('org_section_owners', []).extend(owner_rows)
            ids = [row['agent_id'] for row in owner_rows]
            for aid, name in raw.execute('SELECT id, name FROM orgtree.agents '
                                          'WHERE id = ANY(%s)', (ids,)).fetchall():
                ctx.names[aid] = name
        for table in sec.tables:
            main = table.spec.table
            if by_agent:
                rows[main] = _rows(raw, f'SELECT * FROM orgtree.{main} '
                                   'WHERE agent_id = ANY(%s)', (ids,))
            else:
                rows[main] = _rows(raw, f'SELECT * FROM orgtree.{main}')
            parent_key = table.keys[0][0]
            parent_ids = [row[parent_key] for row in rows[main]]
            child_key = table.link.get(parent_key, parent_key)
            for child in table.layout():
                if child != main:
                    rows[child] = _rows(raw, f'SELECT * FROM orgtree.{child} '
                                        f'WHERE {codec.quote(child_key)} = ANY(%s)', (parent_ids,))
    return sections.decode_document(rows, picked, ctx)


def read_records(raw: Any, key: str, ids: Iterable[int]) -> list[dict]:
    """Selected record IDs from one record-list section, in caller order."""
    selected = list(ids)
    sec = next((sec for sec in mappers.sections() if key in sec.keys), None)
    if not isinstance(sec, sections.RecordList):
        raise ValueError(f'{key!r} is not a record-list section')
    if not selected:
        return []
    table = sec.t
    parents = _rows(raw, f'SELECT * FROM orgtree.{table.spec.table} '
                    'WHERE id = ANY(%s)', (selected,))
    layout = table.layout()
    children = {}
    for child in layout:
        if child != table.spec.table:
            children[child] = _rows(raw, f'SELECT * FROM orgtree.{child} '
                                    f'WHERE {codec.quote(table.link["id"])} = ANY(%s)',
                                    (selected,))
    decoded = {row['id']: codec.decode(table.spec, row, codec.Children(children, layout),
                                       (row['id'],)) for row in parents}
    return [decoded[record_id] for record_id in selected if record_id in decoded]
