"""Stateless snapshot and catch-up reads shared by HTTP and socket runners.

Body builders and membership readers receive the SAME explicit read-only
snapshot. The client supplies declarations, never its previous member IDs.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
from typing import Any, Iterator, Mapping

from .record_registry import Registry, Selection, Snapshot

BOUND = 2000
MAX_AGENTS = 128
MAX_GENERATION = 2**53-1
PAGE_RECORDS = 128
PAGE_BYTES = 512*1024


@dataclass(frozen=True)
class Cursor:
    org_uuid: str
    incarnation: str
    rev: int

    def __post_init__(self):
        if (not isinstance(self.org_uuid,str) or not self.org_uuid
                or not isinstance(self.incarnation,str) or not self.incarnation
                or type(self.rev) is not int or not 0 <= self.rev <= MAX_GENERATION):
            raise ValueError('invalid record cursor')

    def wire(self) -> dict:
        return dict(org_uuid=self.org_uuid,incarnation=self.incarnation,rev=self.rev)


def cursor(snapshot: Snapshot) -> Cursor:
    stamp = snapshot.stamp
    return Cursor(stamp['org_uuid'],stamp['incarnation'],stamp['org_revision'])


@contextmanager
def snapshot(slug: str) -> Iterator[Snapshot]:
    """Own exactly one snapshot, including floor and the display clock."""
    from . import agents, enabled
    if not enabled():
        raise NotImplementedError('records require org database storage')
    with agents.snapshot(slug) as (raw,stamp):
        floor, now = raw.execute('SELECT floor,extract(epoch FROM clock_timestamp()) '
                                 'FROM orgtree.org_revision').fetchone()
        yield Snapshot(raw,slug,{**stamp,'floor':floor},float(now))


def subscriptions(arguments: Any) -> tuple[Selection, ...]:
    """Validate a socket/HTTP subscription declaration before any SQL."""
    if not isinstance(arguments,list) or len(arguments)>MAX_AGENTS:
        raise ValueError('subscriptions must be a bounded list')
    selections, generations = [], set()
    for args in arguments:
        if not isinstance(args,dict) or set(args)-{'sub','agents','windows'}:
            raise ValueError('invalid subscription declaration')
        generation = args.get('sub')
        if (type(generation) is not int or not 0 <= generation <= MAX_GENERATION
                or generation in generations):
            raise ValueError('invalid subscription generation')
        names, windows = args.get('agents',[]), args.get('windows',[])
        if (not isinstance(names,list) or len(names)>MAX_AGENTS
                or any(not isinstance(n,str) or not n.isascii() or not n.isdigit()
                       or not 0 < int(n) < 2**63 or str(int(n)) != n for n in names)):
            raise ValueError('agents must contain positive database IDs')
        if (not isinstance(windows,list) or len(windows)>MAX_AGENTS
                or any(not isinstance(w,dict) for w in windows)):
            raise ValueError('invalid record windows')
        generations.add(generation)
        selections.append(Selection('sub:'+str(generation),tuple(dict.fromkeys(names)),tuple(windows)))
    return tuple(selections)


def _members(registry: Registry, state: Snapshot, selections: tuple[Selection, ...]) -> dict:
    if len({selection.set for selection in selections}) != len(selections):
        raise ValueError('duplicate record set')
    return {selection.set:registry.select(state,selection) for selection in selections}


def _build(registry: Registry, state: Snapshot, wanted: Mapping[str, set[str]]) -> dict:
    """One batch per entity across overlapping sets. Missing bodies are errors."""
    built = {}
    for entity,ids in sorted(wanted.items()):
        if not ids:
            continue
        rows = registry.bodies(state,entity,frozenset(ids))
        if set(rows) != ids:
            raise RuntimeError('record membership/body snapshot disagrees: '+entity)
        built[entity] = rows
    return built


def records(registry: Registry, state: Snapshot,
            selections: tuple[Selection, ...] = (Selection(),)) -> list[dict]:
    members = _members(registry,state,selections)
    wanted: dict[str,set[str]] = {}
    for entities in members.values():
        for entity,ids in entities.items():
            wanted.setdefault(entity,set()).update(ids)
    built = _build(registry,state,wanted)
    return [dict(entity=entity,id=key,body=built[entity][key],set=set_name)
            for set_name,entities in sorted(members.items())
            for entity,ids in sorted(entities.items()) for key in sorted(ids)]


def baseline(registry: Registry, state: Snapshot) -> dict:
    return dict(type='record_snapshot',cursor=cursor(state).wire(),records=records(registry,state))


def subscribed(registry: Registry, state: Snapshot, selection: Selection) -> dict:
    if not selection.set.startswith('sub:'):
        raise ValueError('subscription needs a generation')
    generation = int(selection.set.partition(':')[2])
    return dict(type='record_subscribed',sub=generation,**cursor(state).wire(),
                records=records(registry,state,(selection,)))


def subscribed_pages(registry: Registry, state: Snapshot, selection: Selection,
                     *, page_records: int = PAGE_RECORDS,
                     page_bytes: int = PAGE_BYTES) -> tuple[dict, ...]:
    """One same-snapshot set, ordered pages, including an empty final page.

    Initial membership is not the catch-up bound: archived_all may be large.
    The receiver publishes only when the last page's cursor is still current.
    """
    if (type(page_records) is not int or page_records < 1
            or type(page_bytes) is not int or page_bytes < 64):
        raise ValueError('invalid subscription page size')
    return subscription_pages(subscribed(registry,state,selection),
                              page_records=page_records, page_bytes=page_bytes)


def subscription_pages(answer: dict, *, page_records: int = PAGE_RECORDS,
                       page_bytes: int = PAGE_BYTES) -> tuple[dict, ...]:
    answer = dict(answer)
    rows = answer.pop('records')
    pages,chunk = [],[]
    def encoded_size(value):
        return len(json.dumps(value,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('utf-8'))
    def header_size():
        return encoded_size({**answer,'records':[],'page':len(pages),'final':False})
    size = header_size()
    for row in rows:
        entry_size = encoded_size(row)
        if chunk and (len(chunk) >= page_records or size+1+entry_size > page_bytes):
            pages.append({**answer,'records':chunk,'page':len(pages),'final':False})
            chunk,size = [],header_size()
        size += entry_size + bool(chunk)
        chunk.append(row)
    # A single oversize record is indivisible; the queue's individual-frame
    # policy still applies. Large sets of ordinary records fit byte-sized pages.
    pages.append({**answer,'records':chunk,'page':len(pages),'final':True})
    return tuple(pages)


def catchup(registry: Registry, state: Snapshot, after: Cursor, *,
            selections: tuple[Selection, ...] = (Selection(),), bound: int = BOUND) -> dict:
    """State at R decides upsert/tombstone, including displaced memberships."""
    if type(bound) is not int or bound<1:
        raise ValueError('invalid record bound')
    current = cursor(state)
    if ((after.org_uuid,after.incarnation) != (current.org_uuid,current.incarnation)
            or after.rev < state.stamp['floor'] or after.rev > current.rev):
        return {'type':'record_reset'}
    frame = dict(type='record_changes',org_uuid=current.org_uuid,incarnation=current.incarnation,
                 **{'from':after.rev,'to':current.rev},upserts=[],tombstones=[])
    if after.rev == current.rev:
        return frame
    # The revision PK restricts the interval, then the changes PK restricts
    # each xid. Read-side scopes stay internal; no history bodies are read.
    scope_filter = " OR (c.entity='~scope' AND split_part(c.entity_id,':',1)=ANY(%s))" if registry.scopes else ''
    parameters = (after.rev,current.rev,*((sorted(registry.scopes),) if registry.scopes else ()),bound+1)
    changed = state.raw.execute('SELECT DISTINCT c.entity,c.entity_id '
        'FROM orgtree.revisions r JOIN orgtree.changes c USING(xid) '
        "WHERE r.rev>%s AND r.rev<=%s AND (c.entity<>'~scope'"+scope_filter+') '
        'ORDER BY c.entity,c.entity_id LIMIT %s',parameters).fetchall()
    if len(changed)>bound or any(entity=='reset' for entity,key in changed):
        return {'type':'record_reset'}
    members = _members(registry,state,selections)
    touched = set()
    scopes: dict[str,set[str]] = {}
    for entity,key in changed:
        if entity == '~scope':
            kind,_,root = key.partition(':')
            if kind in registry.scopes:
                scopes.setdefault(kind,set()).add(root)
        elif key == '*':
            for entities in members.values():
                touched.update((entity,n) for n in entities.get(entity,()))
        else:
            touched.add((entity,key))
    replacements = set()
    for kind,roots in scopes.items():
        result = registry.scopes[kind](state,frozenset(roots),members)
        touched.update(result.touched)
        if result.replacements-set(members) or 'shared' in result.replacements:
            raise RuntimeError('read-side scope names an invalid replacement set')
        replacements.update(result.replacements)
    # Count distinct bodies, including every replacement member. A large
    # catch-up resets; unlike initial paged subscriptions it is one bounded frame.
    expanded = touched | {(entity,key) for name in replacements
        for entity,ids in members[name].items() for key in ids}
    if len(expanded)>bound:
        return {'type':'record_reset'}
    wanted: dict[str,set[str]] = {}
    entries = []
    for set_name,entities in sorted(members.items()):
        if set_name in replacements:
            for entity,ids in entities.items():
                wanted.setdefault(entity,set()).update(ids)
            continue
        for entity,key in sorted(touched):
            if entity not in entities:
                continue
            if key not in entities[entity]:
                frame['tombstones'].append(dict(entity=entity,id=key,set=set_name))
            else:
                wanted.setdefault(entity,set()).add(key)
                entries.append((set_name,entity,key))
    built = _build(registry,state,wanted)
    frame['upserts'] = [dict(entity=entity,id=key,body=built[entity][key],set=set_name)
                        for set_name,entity,key in entries]
    if replacements:
        frame['replacements'] = [dict(set=name,records=[
            dict(entity=entity,id=key,body=built[entity][key],set=name)
            for entity,ids in sorted(members[name].items()) for key in sorted(ids)])
            for name in sorted(replacements)]
    return frame
