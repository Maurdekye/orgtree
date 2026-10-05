"""Explicit native rename intent and working save baselines (design decision 9)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Intent:
    document: Any
    # Each step names a persisted origin, not a newly hired namesake.
    steps: list[tuple[str, str, str]] = field(default_factory=list)
    destinations: dict[str, str] = field(default_factory=dict)

    def add(self, mapping: dict[str, str], baselines: dict[str, str]) -> None:
        current = {dest: origin for origin, dest in self.destinations.items()}
        for old, new in mapping.items():
            origin = current.get(old)
            if origin is None and old in baselines and old not in self.destinations:
                origin = old
            if origin is not None:
                self.steps.append((origin, old, new))
                self.destinations[origin] = new


def register(org: Any, mapping: dict[str, str]) -> Intent | None:
    """Only Org.rename calls this, after validation and before its mutations."""
    from .. import store
    if not store._orgdb_on():
        return None
    pending = getattr(org, '_native_rename_intent', None)
    if pending is None or pending.document is not org.d:
        pending = Intent(org.d)
        org._native_rename_intent = pending
    pending.add(mapping, getattr(org.d, '_snap_nodes', {}))
    return pending


def clear(org: Any) -> None:
    org.__dict__.pop('_native_rename_intent', None)


def finish(conn: Any) -> None:
    """Handoff tokens live only within one save body, never past a savepoint."""
    conn.tx.rename_checked.clear()
    conn.tx.rename_nodes.clear()


def move_owner(box: Any, old: str, new: str) -> None:
    """A native owner key follows the agent row; it is not a log replacement."""
    from .. import store
    if not isinstance(box, store.SectionMap):
        box[new] = box.pop(old)
        return
    value = box[old]                    # load before changing its virtual key
    dict.__delitem__(box, old)
    dict.__setitem__(box, new, value)
    box._order = [name for name in box._order if name != old] + [new]
    for attr in ('_present', '_added', '_dropped', '_replaced'):
        values = getattr(box, attr)
        if old in values:
            values.remove(old)
            values.add(new)
    for attr in ('_appends', '_mail_bounds'):
        values = getattr(box, attr)
        if old in values:
            values[new] = values.pop(old)
    # _snaps stays unchanged until successful adoption. The save re-keys a copy.


def owner_baselines(rows: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    return {mapping.get(owner, owner): value for owner, value in rows.items()}


def doc_baselines(rows: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    from .. import store
    out = {}
    for key, value in rows.items():
        sect, sep, owner = key.partition(store.SPLIT_SEP)
        moved = mapping.get(owner, owner) if sep and sect in store.SPLIT_SECTIONS else owner
        out[sect + sep + moved if sep else key] = value
    return out


def working(lazy: Any, mapping: dict[str, str], nodes: dict[str, str]) -> Any:
    """Shallow views of changed metadata, never edits to adopted baselines."""
    from .. import store
    result = store.LazyDoc.__new__(store.LazyDoc)
    result.__dict__.update(lazy.__dict__)
    for key, value in dict.items(lazy):
        dict.__setitem__(result, key, value)
    result._snap_doc = doc_baselines(lazy._snap_doc, mapping)
    result._snap_nodes = nodes
    result._deferred_doc = {key: doc_baselines(rows, mapping)
                            for key, rows in lazy._deferred_doc.items()}
    result._snap_logs = {sect: owner_baselines(rows, mapping)
                         if sect in store.DICT_LOGS and isinstance(rows, dict) else rows
                         for sect, rows in lazy._snap_logs.items()}
    for sect in store.DICT_LOGS:
        value = dict.get(lazy, sect)
        if isinstance(value, store.SectionMap):
            copy = store.SectionMap.__new__(store.SectionMap)
            copy.__dict__.update(value.__dict__)
            for owner, entries in dict.items(value):
                dict.__setitem__(copy, owner, entries)
            copy._snaps = owner_baselines(value._snaps, mapping)
            dict.__setitem__(result, sect, copy)
    return result


def prepass(conn: Any, d: Any, lazy: Any, intent: Intent, changes: Any) -> Any:
    """Lock and validate before any name UPDATE or small-section write."""
    from .. import store
    from .compat import rows as R
    if intent.document is not d:
        raise store.StaleWrite('rename intent belongs to another document')
    if not intent.steps:
        return lazy                 # only unsaved hires were renamed
    if lazy is None or lazy._receipt_rows:
        raise store.StaleWrite('native rename requires node and section baselines')
    from . import graph   # noqa: PLC0415
    lazy = graph.save_baselines(conn, d, lazy, changes)
    # Node reference columns decode joined names. Validate their old texts before
    # changing names, and carry their post-rename text as the working CAS token.
    # Org.rename already walks these nodes; every adopted baseline is compared once.
    conn.raw.execute('SELECT id FROM orgtree.agents WHERE name=ANY(%s) '
                     'AND NOT tombstone ORDER BY id FOR UPDATE',
                     (list(lazy._snap_nodes),)).fetchall()
    before = {name: text for name, text, _ in R.nodes(
        conn.raw, list(lazy._snap_nodes))}
    for name, expected in lazy._snap_nodes.items():
        if name not in before or not R.same(before[name], expected):
            raise store.StaleWrite(f"node {name!r} changed before rename; nothing was written")
    ids = dict(conn.raw.execute('SELECT name,id FROM orgtree.agents WHERE name=ANY(%s) '
                                'AND NOT tombstone ORDER BY id',
                                (list(intent.destinations),)).fetchall())
    if set(ids) != set(intent.destinations):
        raise store.StaleWrite('a renamed agent disappeared; nothing was written')
    names = R.Names(conn.raw)
    for target in sorted({new for _, _, new in intent.steps}):
        names.lock(target)           # every agent row above is locked first
    for origin, old, new in intent.steps:
        occupied = conn.raw.execute('SELECT id FROM orgtree.agents WHERE name=%s '
                                    'AND NOT tombstone', (new,)).fetchone()
        if occupied is not None and int(occupied[0]) != int(ids[origin]):
            # Includes a live target deleted only in this unsaved document.
            raise store.StaleWrite(f"rename target {new!r} is still taken; nothing was written")
        changed = conn.raw.execute('UPDATE orgtree.agents SET name=%s, row_version=row_version+1 '
                                   'WHERE id=%s AND name=%s AND NOT tombstone',
                                   (new, ids[origin], old))
        if changed.rowcount != 1:
            raise store.StaleWrite('rename source changed; nothing was written')
        if changes is not None:
            changes.node_deletes.append(old)
            changes.node_updates.append(new)
    mapping = intent.destinations
    after = {name: text for name, text, _ in R.nodes(
        conn.raw, [mapping.get(name, name) for name in lazy._snap_nodes])}
    if len(after) != len(before):
        raise store.StaleWrite('rename baseline handoff is incomplete; nothing was written')
    conn.tx.rename_checked.update(after)
    conn.tx.rename_nodes.update(mapping.values())
    return working(lazy, mapping, after)


def write_title_only(c: Any, name: str, text: str, expected: str) -> bool:
    """Keep every child row when the name/title is the only logical change."""
    from . import codec
    from .compat import rows as R
    from .mappers import agents as A
    old, new = json.loads(expected), json.loads(text)
    if not isinstance(old, dict) or not isinstance(new, dict):
        return False
    if not R.same(R.dumps({k: v for k, v in old.items() if k != 'title'}),
                  R.dumps({k: v for k, v in new.items() if k != 'title'})):
        return False
    row = c.execute('SELECT id,extra FROM orgtree.agents WHERE name=%s AND NOT tombstone',
                    (name,)).fetchone()
    if row is None:
        raise R.CompatError('validated renamed agent disappeared')
    spec = codec.Spec('agents', (A.HOT.field('title'),))
    out = {}
    codec.encode(spec, {k: new[k] for k in ('title',) if k in new}, {'id': row[0]}, out)
    encoded = out['agents'][0]
    extra = dict(row[1] or {})
    extra.pop('title', None)
    extra.update(codec.from_column('json', encoded['extra']) or {})
    c.execute('UPDATE orgtree.agents SET title=%s,extra=%s,row_version=row_version+1 '
              'WHERE id=%s', (encoded['title'], codec.to_column('json', extra) if extra else None,
                             row[0]))
    return True
