"""App registry and org summary/notice copies, each from one database snapshot."""
from __future__ import annotations

from types import SimpleNamespace

from . import agents, codec, conn, names, reader_rows, registry

REGISTRY_FIELDS = ('org_id', 'slug', 'org_uuid', 'state', 'unavailable_step',
                   'state_reason', 'attempts', 'report_path')
SUMMARY_FIELDS = ('name', 'created', 'net_slug', 'nodes', 'live', 'cost_usd_total')


def registry_snapshot():
    with registry.session(conn.runtime_base(), names.app(),
                          application_name='orgtree-app-feed') as raw, raw.transaction():
        raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        uuid, incarnation, rev = raw.execute('SELECT i.app_uuid::text,i.incarnation::text,r.rev '
            'FROM orgtree.app_identity i CROSS JOIN orgtree.registry_revision r').fetchone()
        rows = raw.execute('SELECT org_id,slug,org_uuid::text,state,unavailable_step,'
            'state_reason,attempts,report_path FROM orgtree.orgs ORDER BY org_id').fetchall()
        return (dict(app_uuid=uuid, incarnation=incarnation, rev=rev),
                [dict(entity='registry_org', id=str(row[0]), body=dict(zip(REGISTRY_FIELDS, row)))
                 for row in rows])


def _complete_summary(raw, slug):
    """The existing complete org-list reader's float/order fallback, same snapshot."""
    from .mappers.settings import SETTINGS
    from psycopg.rows import dict_row
    with raw.cursor(row_factory=dict_row) as cur:
        row = cur.execute('SELECT name,created,created_text,net_identity,deleted_cost_usd,extra '
                          'FROM orgtree.org_settings').fetchone()
    fields = tuple(f for f in SETTINGS.fields
                   if f.key in ('name', 'created', 'net_identity', 'deleted_cost_usd'))
    settings = codec.decode(codec.Spec('org_settings', fields), row or {}, None, ())
    total, live = raw.execute("SELECT count(*),count(*) FILTER (WHERE state='live') "
                              'FROM orgtree.agents WHERE NOT tombstone').fetchone()
    costs = raw.execute("SELECT cost_usd,extra->'cost_usd' FROM orgtree.agents "
                         'WHERE NOT tombstone ORDER BY ord').fetchall()
    return dict(name=settings.get('name', slug), created=settings.get('created'),
        net_slug=(settings.get('net_identity') or {}).get('slug'), nodes=int(total), live=int(live),
        cost_usd_total=round(sum(float((extra if extra is not None else cost) or 0.0)
                                 for cost, extra in costs)
                            + float(settings.get('deleted_cost_usd') or 0.0), 4))


def _project(raw, spec, fields, where='true', order='ord,id'):
    """Only notification fields; no document body, attachments or docket history."""
    from psycopg.rows import dict_row
    selected = codec.Spec(spec.table, tuple(f for f in spec.fields if f.key in fields))
    columns = ','.join(codec.quote(col) for col, _ in codec.columns(selected))
    with raw.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(f'SELECT id,{columns},extra FROM orgtree.{spec.table} '
                           f'WHERE {where} ORDER BY {order}').fetchall()
    # These specs contain only scalars and flattened objects; lists (e.g.
    # question choices) are intentionally absent from the notice builder.
    return [codec.decode(selected, {**row, 'extra': {key: value for key, value in
        (row['extra'] or {}).items() if key in fields}}, None, ()) for row in rows]


def _notices(raw, slug):
    from .. import desktop_notifications as notices
    from .mappers import records, docket
    settings = reader_rows.read_sections(raw, ('slug', 'name', 'created'))
    settings['slug'] = slug
    settings['asks'] = _project(raw, records.ASKS,
        ('id', 'node', 'status', 'question', 'questions'), "status='open'")
    settings['user_inbox'] = _project(raw, records.USER_INBOX,
        ('id', 'from', 'urgent', 'urgent_reason', 'body', 'text', 'ev'))
    settings['documents'] = _project(raw, records.DOCUMENTS, ('id', 'node', 'title'))
    settings['work_items'] = _project(raw, docket.WORK_ITEM,
        ('slug', 'title', 'owner', 'manual_attention', 'notification_attention_epoch'),
        "list_key='active' AND docket_manual")
    asked = [a.get('node') for a in settings['asks'] if isinstance(a.get('node'), str)]
    frozen = [name for name, in raw.execute('SELECT name FROM orgtree.agents '
        "WHERE NOT tombstone AND is_frozen AND coalesce(state,'live')='live' ORDER BY ord,id")]
    # Only state/frozen/generation are consumed. Hot rows carry them all;
    # native codecs preserve historical misfits without loading transcripts.
    # read_agents is deliberately used for exact node semantics, bounded by
    # actionable asks and currently frozen agents, never archived population.
    nodes = reader_rows.read_agents(raw, set(asked + frozen), recent_turns_limit=0)
    settings['nodes'] = nodes
    return (notices._attention(SimpleNamespace(d=settings))[0]
            + notices._frozen_rows(slug, settings.get('created'), ((n, nodes[n]) for n in frozen)))


def org_snapshot(row):
    from .. import org_summary
    from ..foreground_context import CompatibilityRequired
    with agents.snapshot(row['slug']) as (raw, stamp):
        try:
            summary, totals = org_summary._read(row['slug'], raw=raw, stamp=stamp)
            body = {**summary, 'cost_usd_total': totals.cost_total()}
        except CompatibilityRequired:
            body = _complete_summary(raw, row['slug'])
        return dict(org_uuid=stamp['org_uuid'], incarnation=stamp['incarnation'],
            rev=stamp['org_revision'], body={key: body.get(key) for key in SUMMARY_FIELDS},
            notices=_notices(raw, row['slug']))


class AppConnection:
    """pgfeed adapter: reconnect and fixed-interval revision reads heal lost NOTIFY."""
    def __init__(self):
        self.raw = conn.connect(conn.runtime_base(), names.app(), application_name='orgtree-app-listen')
        self._identity = None

    def listen(self, channel):
        self.raw.execute('LISTEN app_rev')

    def revisions(self):
        uuid, incarnation, rev = self.raw.execute('SELECT i.app_uuid::text,i.incarnation::text,r.rev '
            'FROM orgtree.app_identity i CROSS JOIN orgtree.registry_revision r').fetchone()
        self._identity = (uuid, incarnation)
        return [('app', rev)]

    def identity(self, slug):
        return self._identity

    def notifications(self, timeout):
        for notice in self.raw.notifies(timeout=timeout, stop_after=1):
            yield 'app:' + notice.payload

    def close(self):
        self.raw.close()
