"""Shared inbox/event records, using the endpoint codecs in one snapshot.

Window limits and SQL order keys are declared here once. The same declarations
feed statement capture, post-revision boundary resolution and baseline selection.
Registration is explicit so a deployment never enables readers before capture.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from typing import Mapping

from . import codec
from .compat import rows as R
from .mappers import records as specs
from .record_derivations import Name, Source, Stream, Window, group
from .record_registry import Entity, Registry, Selection, Snapshot


@dataclass(frozen=True)
class Panel:
    section: str
    entity: str
    window: Window | None = None


# List logs are ordered by immutable row ID in the existing endpoint. Pending
# mail has no cap: it is a state set, not a large finite history window.
PANELS = (
    Panel('user_inbox', 'user_inbox'),
    Panel('user_mail_log', 'user_mail_log:shared', Window('user_mail_log', 50, (
        Stream('user_mail_log', "'shared'", 'r.id::text', ('r.id',)),))),
    Panel('user_outbox', 'user_outbox:shared', Window('user_outbox', 50, (
        Stream('user_outbox', "'shared'", 'r.id::text', ('r.id',)),))),
    Panel('events', 'event:shared', Window('event', 300, (
        Stream('events', "'shared'", 'r.id::text', ('r.id',)),))),
)
WINDOWS = tuple(panel.window for panel in PANELS if panel.window is not None)
PREPARE = '\n'.join(
    f'CREATE INDEX {panel.section}_record_window ON orgtree.{panel.section} (id DESC NULLS LAST);'
    for panel in PANELS if panel.window is not None)
TABLES = {section.key: section.t for section in specs.sections()
          if section.key in {panel.section for panel in PANELS}}


def dependencies(base: Mapping[str, Source]) -> dict[str, Source]:
    """Add direct/child dependencies without changing the frozen core map."""
    result = dict(base)

    def add(table, *names):
        result[table] = Source((*result[table].names, *names))

    add('user_inbox', Name("'user_inbox'", 'r.id::text'))
    add('events', *group('events_count'))
    for table, parent, entity in (
        ('user_inbox_attachments', 'user_inbox_id', 'user_inbox'),
        ('user_mail_log_attachments', 'user_mail_log_id', 'user_mail_log:shared'),
        ('user_outbox_attachments', 'user_outbox_id', 'user_outbox:shared'),
        ('user_outbox_attachments_missing', 'user_outbox_id', 'user_outbox:shared'),
        ('event_warnings', 'events_id', 'event:shared'),
    ):
        add(table, Name(repr(entity), f'r.{parent}::text'))
    return result


def members(panel: Panel, state: Snapshot, selection: Selection) -> frozenset[str]:
    if selection.set != 'shared':
        return frozenset()
    if panel.window is None:
        rows = state.raw.execute(f'SELECT id::text FROM orgtree.{panel.section} ORDER BY id')
    else:
        stream, = panel.window.streams
        order = ','.join(f'{key} DESC NULLS LAST' for key in stream.order)
        rows = state.raw.execute(
            f'SELECT ({stream.id})::text FROM orgtree.{stream.table} r '
            f'WHERE ({stream.partition})::text=%s AND ({stream.predicate}) '
            f'ORDER BY {order}, ({stream.id})::text COLLATE "C" LIMIT %s',
            ('shared', panel.window.size))
    return frozenset(str(row[0]) for row in rows)


def bodies(panel: Panel, state: Snapshot, ids: frozenset[str]) -> dict:
    if not ids:
        return {}
    table = TABLES[panel.section]
    rows, children = R.fetch(state.raw, table, 'id=ANY(%s::bigint[])', (sorted(ids),))
    result = {}
    # Same codec and wire/reference producers as /inbox and /events. No new
    # transaction, roster load, mutable global or endpoint call is involved.
    for row in rows:
        value = codec.decode(table.spec, row, children, (row['id'],))
        if panel.section != 'events':
            from ..api import _mail_refs, _sent_refs
            value = (_sent_refs(state.slug, [value]) if panel.section == 'user_outbox'
                     else _mail_refs(state.slug, 'user', [value]))[0]
        result[str(row['id'])] = value
    return result


def events_count(state: Snapshot) -> dict:
    return {'events_count': state.raw.execute(
        'SELECT events_count FROM orgtree.org_revision WHERE singleton').fetchone()[0]}


def register(registry: Registry) -> Registry:
    for panel in PANELS:
        registry.register(Entity(panel.entity, partial(members, panel), partial(bodies, panel)))
    # Extend the existing org entity without widening the tree header's strict
    # field grouping: events_count is a panel group, not an old tree field.
    original = registry.entities.get('org')

    def org_members(state, selection):
        inherited = original.members(state, selection) if original else frozenset()
        return inherited | (frozenset(('events_count',)) if selection.set == 'shared' else frozenset())

    def org_bodies(state, ids):
        existing = ids - {'events_count'}
        result = dict(original.bodies(state, existing)) if original and existing else {}
        if 'events_count' in ids:
            result['events_count'] = events_count(state)
        return result

    registry.entities['org'] = Entity('org', org_members, org_bodies)
    return registry
