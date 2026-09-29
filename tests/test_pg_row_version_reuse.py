"""Row-version reuse: org-wide rows a tool call re-reads are sent only when
they changed, and a changed row is never served stale.

N1000 #3 (2026-09-29): agent tool calls ran 65-73 statements and read about
1.1 MB each. Every lazy load (three per message) re-read the org's eager doc
rows, and every dict-log section load re-read an owner list with every owner
in it. `store._eager_doc_rows` and `store._meta_owners_raw` now pass the
version (`xmin:ctid`) they hold, and PostgreSQL returns the value only for a
row that is a different version. `_write_dict_log` reads the committed owner
list only when a save adds or drops an owner.

Actual PostgreSQL (disposable, via test_pgstore). What this proves:
  * an unchanged row is reused (counted) and equal to a fresh read;
  * STALE CHECKS: a row changed behind the store's back, WITHOUT an org
    revision bump (what the heal-epoch stamp does), is read fresh, both by
    the helpers and by a real org_tx load; two updates of one row inside one
    transaction (same xmin) are told apart; a rolled-back write is not kept;
    a deleted row is gone; two orgs never share values, even when their rows
    carry the same version (written in one transaction);
  * deferred doc keys are still listed without their value;
  * an append to an existing owner's log does not read the owner list, and a
    save that adds an owner still merges into the committed list (control).

Run:  python tools/run-python-verification.py tests/test_pg_row_version_reuse.py
"""
import json
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


def node(nid):
    return {'id': nid, 'name': nid, 'parent': None, 'children': []}


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class RowVersionReuse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True, LAZY_DOC_KEYS=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        self.slug = self.org('reuse')

    def org(self, prefix, v=0):
        org = store.create_org(prefix + '-' + uuid.uuid4().hex[:10])
        for nid in ('a', 'b', 'c'):
            org.d['nodes'][nid] = node(nid)
        org.d['settings_x'] = {'v': v}
        org.d['watchdogs'] = [{'id': 'w1'}]
        org.d['steered_log'] = {'a': [{'at': '2026-01-01T00:00:00Z', 'n': 1}],
                                'b': [{'at': '2026-01-01T00:00:00Z', 'n': 2}]}
        store.save_org(org)
        return org.d['slug']

    # -- helpers ----------------------------------------------------------
    def rows(self, slug=None):
        with store._POOL.acquire(slug or self.slug) as conn:
            return store._eager_doc_rows(conn)

    def owners(self, slug=None):
        with store._POOL.acquire(slug or self.slug) as conn:
            return store._owners_of(conn, 'steered_log', include_orphans=False)

    def write(self, sql, params, slug=None):
        """A write behind the store's back: no save, no revision bump."""
        with store._POOL.acquire(slug or self.slug) as conn:
            conn.execute(sql, params)

    def revision(self):
        with pgstore.connect() as raw:
            return raw.execute('SELECT revision FROM public.orgs WHERE slug=%s',
                               (self.slug,)).fetchone()[0]

    def stats(self):
        return dict(store.ROW_REUSE_STATS)

    # -- reuse ------------------------------------------------------------
    def test_unchanged_rows_are_reused_and_equal_a_fresh_read(self):
        first = self.rows()
        before = self.stats()
        second = self.rows()
        after = self.stats()
        self.assertEqual(second, first)
        served = [k for k, v in first.items() if v is not None]
        self.assertIn('settings_x', served)
        self.assertEqual(after['reused'] - before['reused'], len(served))
        self.assertEqual(after['read'], before['read'])
        with patch.object(store, 'STORE_BACKEND', 'sqlite'):
            self.assertIsNone(store._row_reuse_slot(object(), 'doc'))

    def test_deferred_keys_listed_without_value(self):
        self.rows()
        rows = self.rows()
        self.assertIn('watchdogs', rows)
        self.assertIsNone(rows['watchdogs'])

    def test_owner_list_reused_while_unchanged(self):
        self.assertEqual(self.owners(), ['a', 'b'])
        before = self.stats()
        self.assertEqual(self.owners(), ['a', 'b'])
        self.assertEqual(self.stats()['reused'] - before['reused'], 1)

    # -- stale checks -----------------------------------------------------
    def test_write_without_revision_bump_is_read_fresh(self):
        self.rows()
        rev = self.revision()
        self.write('UPDATE doc SET val=? WHERE key=?', (store._dumps({'v': 7}), 'settings_x'))
        self.assertEqual(self.revision(), rev, 'the write must not bump the revision')
        self.assertEqual(json.loads(self.rows()['settings_x']), {'v': 7})
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            self.assertEqual(tx.d['settings_x'], {'v': 7})

    def test_owner_list_write_without_revision_bump_is_read_fresh(self):
        self.owners()
        self.write('UPDATE meta SET val=? WHERE key=?', (json.dumps(['a', 'b', 'c']),
                                                        'owners:steered_log'))
        self.assertEqual(self.owners(), ['a', 'b', 'c'])
        # no owner-list row: the owners are those with rows (not the held c)
        self.write('DELETE FROM meta WHERE key=?', ('owners:steered_log',))
        self.assertEqual(self.owners(), ['a', 'b'])

    def test_two_updates_in_one_transaction_are_told_apart(self):
        self.rows()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            try:
                for v in (1, 2):
                    conn.execute('UPDATE doc SET val=? WHERE key=?',
                                 (json.dumps({'v': v}), 'settings_x'))
                    got = store._eager_doc_rows(conn)['settings_x']
                    self.assertEqual(json.loads(got), {'v': v})
            finally:
                conn.execute('ROLLBACK')
        # the rolled-back versions are not kept
        self.assertEqual(json.loads(self.rows()['settings_x']), {'v': 0})

    def test_a_reused_line_pointer_is_still_a_new_version(self):
        # pg-supervisor-a's review of landing 1 (R4): VACUUM frees a deleted
        # tuple's line pointer and the next insert of the key can land at the
        # SAME ctid. Only xmin tells that tuple apart from the held one.
        held = self.rows()['settings_x']
        with store._POOL.acquire(self.slug) as conn:
            conn.execute("SET statement_timeout = '20s'")
            try:
                ctid = lambda: conn.execute('SELECT ctid::text FROM doc WHERE key=?',
                                            ('settings_x',)).fetchone()[0]
                start = ctid()
                for i in range(1, 6):
                    conn.execute('DELETE FROM doc WHERE key=?', ('settings_x',))
                    conn.execute('VACUUM doc')
                    conn.execute('INSERT INTO doc(key,val) VALUES(?,?)',
                                 ('settings_x', store._dumps({'v': 100 + i})))
                    if ctid() == start:
                        break
                self.assertEqual(ctid(), start, 'control: the key came back at its old ctid')
            finally:
                conn.execute('RESET statement_timeout')
        got = self.rows()['settings_x']
        self.assertNotEqual(got, held)
        self.assertEqual(json.loads(got), {'v': 100 + i})

    def test_the_slot_names_the_server_database_and_org(self):
        # R2: a version is only unique within one cluster; another server or
        # database (a swapped or restored cluster, a test fixture) must never
        # share a slot, nor two orgs of one database
        class Raw:
            pass

        class Conn:
            def __init__(self, server, org_id):
                self.raw, self.org_id, self.server = Raw(), org_id, server

            def execute(self, sql, params=()):
                server = self.server

                class Cursor:
                    def fetchone(_):
                        return (server,)
                return Cursor()
        with patch.object(store, 'STORE_BACKEND', 'postgres'):
            slots = {store._row_reuse_slot(Conn(server, org), 'doc')
                     for server, org in (('t1 db', 1), ('t2 db', 1), ('t1 other', 1), ('t1 db', 2))}
        self.assertEqual(len(slots), 4, slots)

    def test_deleted_and_added_rows(self):
        self.rows()
        self.write('DELETE FROM doc WHERE key=?', ('settings_x',))
        self.assertNotIn('settings_x', self.rows())
        self.write('INSERT INTO doc(key,val) VALUES(?,?)', ('settings_x', json.dumps({'v': 5})))
        self.assertEqual(json.loads(self.rows()['settings_x']), {'v': 5})

    def test_orgs_never_share_values(self):
        other = self.org('reuse-other', v=9)
        for _ in range(2):
            self.assertEqual(json.loads(self.rows()['settings_x']), {'v': 0})
            self.assertEqual(json.loads(self.rows(other)['settings_x']), {'v': 9})

    def test_same_version_in_two_orgs_is_not_shared(self):
        # two identically built orgs, their rows rewritten in ONE transaction:
        # the new tuples carry the same xmin and (same layout) the same ctid,
        # so only the org in the reuse slot keeps their values apart
        other = self.org('reuse-twin')
        ids = {}
        with pgstore.connect() as raw:
            for slug in (self.slug, other):
                ids[slug] = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                        (slug,)).fetchone()[0]
        self.rows(); self.rows(other)
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            for slug, v in ((self.slug, 1), (other, 2)):
                raw.execute(f'UPDATE org_{ids[slug]}.doc SET val=%s WHERE key=%s',
                            (store._dumps({'v': v}), 'settings_x'))
            raw.execute('COMMIT')
            versions = {slug: raw.execute(
                f"SELECT xmin::text || ':' || ctid::text FROM org_{ids[slug]}.doc WHERE key=%s",
                ('settings_x',)).fetchone()[0] for slug in ids}
        self.assertEqual(versions[self.slug], versions[other], 'the twin rows must share a version')
        for _ in range(2):
            self.assertEqual(json.loads(self.rows()['settings_x']), {'v': 1})
            self.assertEqual(json.loads(self.rows(other)['settings_x']), {'v': 2})

    # -- owner list on write ------------------------------------------------
    def owner_reads(self, change):
        keys = []
        real = store._meta_get

        def spy(conn, key):
            keys.append(key)
            return real(conn, key)
        with patch.object(store, '_meta_get', spy):
            with orgtx.org_tx(self.slug, logs=['steered_log']) as tx:
                change(tx.d['steered_log'])
        return [k for k in keys if k == 'owners:steered_log']

    def test_append_to_existing_owner_does_not_read_owner_list(self):
        self.assertEqual(self.owner_reads(
            lambda log: log['a'].append({'at': '2026-01-02T00:00:00Z', 'n': 3})), [])
        self.assertEqual([e['n'] for e in store.load_org(self.slug).d['steered_log']['a']], [1, 3])

    def test_new_owner_still_merges_into_committed_list(self):
        self.write('UPDATE meta SET val=? WHERE key=?', (json.dumps(['a', 'b', 'z']),
                                                        'owners:steered_log'))
        self.assertEqual(self.owner_reads(
            lambda log: log.__setitem__('c', [{'at': '2026-01-02T00:00:00Z', 'n': 4}])),
            ['owners:steered_log'])
        self.assertEqual(self.owners(), ['a', 'b', 'z', 'c'])


if __name__ == '__main__':
    unittest.main()
