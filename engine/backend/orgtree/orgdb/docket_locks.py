"""Current docket-role foreign keys share the agent tier, before docket locks.

The plan is transaction-local PostgreSQL state, so a savepoint/full rollback
cannot leave a Python token claiming a lock that PostgreSQL released. These
locks protect physical references; they add no mutation or naming authority.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from . import current_refs

SETTING = 'orgtree.compat_docket_agents'
LINKS = {'work_item_holders': ('agent_id',),
         'work_item_review_seats': ('reviewer_agent_id', 'holder_agent_id', 'recheck_owner_agent_id'),
         'work_item_artifact_grants': ('agent_id',)}


def values(record: Mapping[str, Any]) -> Iterable[Any]:
    """The same seven current roles as encode_current; historical actors excluded."""
    yield record.get('owner')
    yield record.get('reviewer')
    holders = record.get('holders')
    if isinstance(holders, list):
        yield from holders
    seats = record.get('review_seats')
    if isinstance(seats, list):
        for seat in seats:
            if isinstance(seat, Mapping):
                yield current_refs.seat_reviewer(seat)
                yield seat.get('holder')
                yield seat.get('recheck_owner')
    artifacts = record.get('artifacts')
    if isinstance(artifacts, list):
        for artifact in artifacts:
            grants = artifact.get('grants') if isinstance(artifact, Mapping) else None
            if isinstance(grants, list):
                for grant in grants:
                    if isinstance(grant, Mapping):
                        yield grant.get('to')


def linked(c: Any, where: str, params: tuple[Any, ...]) -> set[int]:
    """Typed, scoped physical links, including retained/tombstone identities."""
    ids = {int(a) for row in c.execute(
        'SELECT owner_agent_id,reviewer_agent_id FROM orgtree.work_items w WHERE ' + where,
        params).fetchall() for a in row if a is not None}
    for table, columns in LINKS.items():
        ids.update(int(a) for row in c.execute(
            'SELECT ' + ','.join('r.' + col for col in columns) +
            f' FROM orgtree.{table} r JOIN orgtree.work_items w ON w.id=r.item_id WHERE ' + where,
            params).fetchall() for a in row if a is not None)
    return ids


def named(c: Any, names: Iterable[str]) -> set[int]:
    names = sorted(set(names))
    return {int(a) for a, in c.execute('SELECT id FROM orgtree.agents WHERE name=ANY(%s)',
                                       (names,)).fetchall()} if names else set()


def plan(c: Any) -> dict[str, Any] | None:
    text = c.execute('SELECT current_setting(%s,true)', (SETTING,)).fetchone()[0]
    return json.loads(text) if text else None


def install(c: Any, ids: Iterable[int], names: Iterable[str], *, source: str) -> None:
    c.execute('SELECT set_config(%s,%s,true)',
              (SETTING, json.dumps(dict(ids=sorted(set(ids)), names=sorted(set(names)), source=source))))


def _missing(c: Any, ids: Iterable[int] = (), names: Iterable[str] = ()) -> None:
    from .. import orgtx, store
    held = plan(c)
    missing = set(ids) - set(held['ids'] if held else ())
    # A same-save hire/tombstone is already owned by this transaction. The
    # immediate FK check cannot wait for another writer on that new row.
    if missing:
        missing -= {int(a) for a, in c.execute(
            'SELECT id FROM orgtree.agents WHERE id=ANY(%s) '
            'AND xmin::text=pg_current_xact_id_if_assigned()::text', (sorted(missing),)).fetchall()}
    absent = set(names) - set(held['names'] if held else ())
    if not missing and not absent:
        return
    requested = set(absent)
    if missing:
        requested.update(str(n) for n, in c.execute(
            'SELECT name FROM orgtree.agents WHERE id=ANY(%s)', (sorted(missing),)).fetchall())
    if held and held['source'] == 'org_tx':
        error = orgtx.UnlockedWrite('current docket role requires earlier agent locks: ' +
                                   ', '.join(f'node {name!r}' for name in sorted(requested)))
        error.rows = [('node', name) for name in sorted(requested)]
        raise error
    raise store.StaleWrite('current docket identity changed outside its early agent plan; '
                           'nothing was written; reload and retry')


def lock(c: Any, ids: Iterable[int], names: Iterable[str], *, updates: Iterable[int] = (),
         source: str = 'save') -> None:
    """One ordered tier; never called after a managed plan has been installed."""
    ids, names, updates = sorted(set(ids)), sorted(set(names)), set(updates)
    locked = []
    for aid, in c.execute('SELECT id FROM orgtree.agents WHERE id=ANY(%s) ORDER BY id', (ids,)).fetchall():
        if c.execute('SELECT id FROM orgtree.agents WHERE id=%s FOR ' +
                     ('UPDATE' if aid in updates else 'SHARE'), (aid,)).fetchone() is not None:
            locked.append(aid)
    from .compat.rows import Names
    for name in names:
        Names(c).lock(name)
    install(c, locked, names, source=source)


def prepare(c: Any, records: Iterable[Mapping[str, Any]] = (), *, slugs: Iterable[str] = (),
            archive_ids: Iterable[int] = (), list_key: str | None = None) -> None:
    """Standalone compat entry, or validation of a save/org_tx's complete plan."""
    # Shape validation remains at the original writer boundary. Unsupported
    # list entries cannot carry a current-agent FK and need no role locks.
    records = [record for record in records if isinstance(record, Mapping)]
    slugs = sorted(set(slugs) | {r['slug'] for r in records if isinstance(r.get('slug'), str)})
    archive_ids = sorted(set(archive_ids))
    ids = set()
    if slugs:
        ids |= linked(c, 'w.slug=ANY(%s)', (slugs,))
    if archive_ids:
        ids |= linked(c, 'w.archive_seq=ANY(%s)', (archive_ids,))
    if list_key is not None:
        ids |= linked(c, 'w.list_key=%s', (list_key,))
    names = {ref.name for r in records for value in values(r)
             if (ref := current_refs.reference(value)) is not None}
    ids |= named(c, names)
    held = plan(c)
    if held is None:
        lock(c, ids, names, source='compat')
    else:
        _missing(c, ids)


def resolver(c: Any):
    """Resolve continuity under the early plan, including identity-specific tombstones."""
    from .compat.rows import Names
    names = Names(c)
    held = plan(c)
    if held is None:
        raise RuntimeError('current docket writer omitted its early agent plan')

    def find(name):
        row = names.current_record(name)
        if row is not None:
            _missing(c, (int(row['id']),))
        return row

    def tombstone(ref):
        _missing(c, names=(ref.name,))
        aid = names.current_tombstone(ref)
        _missing(c, (aid,))
        return aid

    resolve = current_refs.Resolver(find, tombstone)

    def checked(value, previous, previous_id):
        if previous_id is not None:
            _missing(c, (previous_id,))
        return resolve(value, previous, previous_id)

    return checked


def transaction_scope(c: Any, entries: Iterable[tuple[str, str, bool]], *,
                      all_nodes: bool = False, whole: bool = False) -> tuple[set[int], set[str]]:
    """Read role links before the transaction's single combined agent tier."""
    from .. import orgtx
    from .compat import rows as R
    entries = list(entries)
    if not whole and not any((kind == 'section' and key.partition(R.SEP)[0] in
                             ('work_items', 'work_items_archive')) or
               (kind == 'log' and json.loads(key)[0] == 'work_items_archive')
               for kind, key, _ in entries):
        return set(), set()
    ids, names = set(), set()
    if all_nodes:
        names.update(str(n) for n, in c.execute(
            'SELECT name FROM orgtree.agents WHERE NOT tombstone').fetchall())
    if whole:
        ids |= linked(c, 'true', ())
    for kind, key, _ in entries:
        if kind == 'node' and key != orgtx._ALL_NODES_KEY:
            names.add(key)
        elif kind == 'section':
            sect, sep, slug = key.partition(R.SEP)
            if sect == 'work_items':
                ids |= linked(c, 'w.slug=%s', (slug,)) if sep else linked(c, "w.list_key='active'", ())
            elif sect == 'work_items_archive':
                ids |= linked(c, "w.list_key='archive'", ())
        elif kind == 'log' and json.loads(key)[0] == 'work_items_archive':
            ids |= linked(c, "w.list_key='archive'", ())
    # Declared names can become new current roles in the body. Retained rows
    # of those names need the same tier, even when no live agent exists.
    ids |= named(c, names)
    if ids:
        names.update(str(n) for n, in c.execute(
            'SELECT name FROM orgtree.agents WHERE id=ANY(%s)', (sorted(ids),)).fetchall())
    return ids, names


def save(c: Any, d: Any, lazy: Any, rename_intent: Any) -> None:
    """Plan only docket records the normal differ will write; no lazy materialization."""
    from .. import store
    records = []
    value = dict.get(d, 'work_items')
    if value is not None:
        snap = lazy._snap_doc if lazy is not None else {}
        for key, text in store._split_rows('work_items', value).items():
            if key == 'work_items' or isinstance(text, store._WorkRowRef):
                continue
            baseline = store._work_raw(snap.get(key))
            if text != baseline:
                records.append(json.loads(text))
    archive = dict.get(d, 'work_items_archive')
    if isinstance(archive, list):
        prior = dict(archive._rows) if isinstance(archive, store.AppendLog) else {}
        for pos, record in enumerate(archive):
            rid = archive._row_ids[pos] if isinstance(archive, store.AppendLog) else None
            if rid is None or archive.full_rewrite or store._dumps(record) != prior.get(rid):
                records.append(record)
    if lazy is not None:
        records.extend(lazy._pending.get('work_items_archive', ()))
    records = [record for record in records if isinstance(record, Mapping)]
    # Settings writers take their common fence before every agent row. A
    # normal save can change settings and roles together; pulling role locks
    # forward must not put them before that existing first tier.
    if records and plan(c.raw) is None:
        from .compat import rows as R
        m = R.model()
        snap = lazy._snap_doc if lazy is not None else {}
        for key, section in m.owner.items():
            if section is not m.settings:
                continue
            changed = (store._dumps(dict.get(d, key)) != snap.get(key)
                       if dict.__contains__(d, key) else key in snap and
                       not any(key in rows for rows in lazy._deferred_doc.values()))
            if changed:
                R.lock_doc_key(c.raw, R.SETTINGS_FENCE)
                break
    if not records:
        if plan(c.raw) is None:
            # Header reorders/deletes take item locks but write no role FK.
            # Seal this save's empty role plan now, so a later entry cannot
            # accidentally start an agent tier after those item locks.
            install(c.raw, (), (), source='save')
        return
    slugs = [r['slug'] for r in records if isinstance(r.get('slug'), str)]
    if plan(c.raw) is not None:
        prepare(c.raw, records, slugs=slugs)
        return
    roles = {ref.name for r in records for value in values(r)
             if (ref := current_refs.reference(value)) is not None}
    nodes = dict.get(d, 'nodes', {})
    node_names = set(dict.keys(nodes)) if isinstance(nodes, dict) else set()
    if lazy is not None:
        if isinstance(nodes, store.NodesMap) and not nodes._touched_all:
            node_names = nodes._changed()
        node_names |= set(lazy._snap_nodes) - set(dict.keys(nodes)) if isinstance(nodes, dict) else set(lazy._snap_nodes)
        if rename_intent is not None:
            node_names |= set(lazy._snap_nodes)
    names = roles | node_names
    ids = linked(c.raw, 'w.slug=ANY(%s)', (slugs,)) | named(c.raw, names)
    updates = {int(a) for a, in c.raw.execute(
        'SELECT id FROM orgtree.agents WHERE name=ANY(%s) AND NOT tombstone', (sorted(node_names),)).fetchall()}
    lock(c.raw, ids, names, updates=updates)
