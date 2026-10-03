"""The save's pending docket row cleanup precedes its revision-row lock."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest

import test_orgdb_docket_events_pg as events
from test_orgdb_docket_events import item
from orgtree.orgdb import conn
from orgtree.orgdb.compat import conn as compat_conn, rows


def setUpModule():
    events.setUpModule()


class TraceRaw:
    """Capture the real runtime SQL while forwarding every operation to PostgreSQL."""
    def __init__(self, raw):
        object.__setattr__(self, 'raw', raw)
        object.__setattr__(self, 'statements', [])

    def execute(self, query, *args, **kwargs):
        self.statements.append(' '.join(str(query).split()))
        return self.raw.execute(query, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def __setattr__(self, name, value):
        setattr(self.raw, name, value)


@unittest.skipUnless(events.fixture.ADMIN and events.fixture.RUNTIME,
                     'disposable PostgreSQL URLs required')
class CleanupOrder(unittest.TestCase):
    def test_pending_delete_and_event_cascade_precede_save_revision_lock(self):
        fixture = events.fixture
        raw = conn.connect(fixture.RUNTIME, fixture.DATABASE)
        view = compat_conn.OrgDbConn(raw, fixture.SLUG, fixture.OID, fixture.DATABASE)
        record = item()
        record['slug'] = 'cleanup-lock-order'
        key = 'work_items\x1f' + record['slug']
        try:
            view.execute('BEGIN IMMEDIATE')
            view.execute('INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) '
                         'DO UPDATE SET val=excluded.val', (key, rows.dumps(record)))
            rid = raw.execute('SELECT id FROM orgtree.work_items WHERE slug=%s',
                              (record['slug'],)).fetchone()[0]
            self.assertGreater(raw.execute('SELECT count(*) FROM orgtree.work_item_events '
                                           'WHERE item_id=%s', (rid,)).fetchone()[0], 0)
            view.execute('COMMIT')

            traced = TraceRaw(raw)
            view.raw = traced
            view.execute('BEGIN IMMEDIATE')
            view.execute('DELETE FROM doc WHERE key=?', (key,))
            view.on_save_commit(True, work_changed=True)
            view.execute('COMMIT')

            deletes = [i for i, sql in enumerate(traced.statements)
                       if sql.startswith('DELETE FROM orgtree.work_items ')]
            revisions = [i for i, sql in enumerate(traced.statements)
                         if sql.startswith('UPDATE orgtree.org_revision ')]
            self.assertEqual(len(deletes), 1, traced.statements)
            self.assertEqual(len(revisions), 1, traced.statements)
            self.assertLess(deletes[0], revisions[0], traced.statements)
            self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.work_items WHERE id=%s',
                                         (rid,)).fetchone()[0], 0)
            self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.work_item_events '
                                         'WHERE item_id=%s', (rid,)).fetchone()[0], 0)
        finally:
            view.raw = raw
            if view.in_transaction:
                view.execute('ROLLBACK')
            raw.execute('DELETE FROM orgtree.work_items WHERE slug=%s', (record['slug'],))
            raw.close()


if __name__ == '__main__':
    unittest.main()
