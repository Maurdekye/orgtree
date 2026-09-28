"""A docket write that commits in the middle of a load never fails the load.

work-items-header-row-mismatch-valueerror-under: in N1000 attempt 5, three
tool calls failed with `ValueError: work-items header/row count or identity
mismatch` from store._load_work_refs. Inside org_tx the connection is READ
COMMITTED and every statement takes its own snapshot; a transaction that does
not lock the docket (a message, a node update) does not hold back a concurrent
create, archive or update. The header came from the load's doc read and the
item listing from a later statement, so a create committed between them made
the two disagree. Likewise an update committed between the listing and the
body fetch raised StaleWrite.

Each test commits the docket change from a SECOND connection at the exact
point between two of the load's statements (deterministic, no timing), then
checks that the load succeeds, shows the NEWER docket whole (never the old
header with the new rows, never a body under the wrong version), and that the
re-read path actually ran (WORK_RACE_STATS). Actual PostgreSQL via
test_pgstore.

Run:  python tools/run-python-verification.py tests/test_work_refs_snapshot_pg.py
"""
import hashlib
import json
import os
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, store, workrows
from test_work_item_rows import items


def tearDownModule():
    f.tearDownModule()


def _is_listing(sql):
    # the load's version listing, alone (not the header+listing re-read)
    return 'starts_with(key' in sql and 'xmin::text' in sql and 'SELECT (SELECT' not in sql


def _is_body_fetch(sql):
    return 'key = ANY' in sql and 'xmin::text' in sql


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class WorkRefsSnapshot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        # a distinct org per test (several test names end the same way)
        self.slug = f._fresh_org('wsnap-' + hashlib.sha1(self._testMethodName.encode()).hexdigest()[:12])
        org = store.load_org(self.slug)
        org.d['work_items'] = items()
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']):      # heal epoch, warm cache
            pass
        with store._POOL.acquire(self.slug) as conn:
            self.org_id = conn.org_id
        self.stats = dict(getattr(store, 'WORK_RACE_STATS', {}))   # absent at base

    def raced(self, what):
        return getattr(store, 'WORK_RACE_STATS', {}).get(what, 0) - self.stats.get(what, 0)

    # -- the second connection: commits at once, outside every org_tx ------
    def other(self, action):
        import psycopg
        table = f'org_{self.org_id}.doc'
        with psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True) as c:
            with c.transaction():
                ids = workrows.ids_from_header(c.execute(
                    f'SELECT val FROM {table} WHERE key=%s', (workrows.SECTION,)).fetchone()[0])
                action(c, table, ids)

    def create(self, slug):
        def act(c, table, ids):
            item = {'slug': slug, 'notification_attention_active': False,
                    'nested': {'values': []}, 'rev': 1}
            c.execute(f'INSERT INTO {table}(key, val) VALUES (%s, %s)',
                      (workrows.PREFIX + slug, workrows.dumps(item)))
            c.execute(f'UPDATE {table} SET val=%s WHERE key=%s',
                      (workrows.header(ids + [slug]), workrows.SECTION))
        self.other(act)

    def archive(self, slug):
        def act(c, table, ids):
            c.execute(f'DELETE FROM {table} WHERE key=%s', (workrows.PREFIX + slug,))
            c.execute(f'UPDATE {table} SET val=%s WHERE key=%s',
                      (workrows.header([i for i in ids if i != slug]), workrows.SECTION))
        self.other(act)

    def update(self, slug, rev):
        def act(c, table, ids):
            key = workrows.PREFIX + slug
            value = json.loads(c.execute(f'SELECT val FROM {table} WHERE key=%s', (key,)).fetchone()[0])
            value['rev'] = rev
            c.execute(f'UPDATE {table} SET val=%s WHERE key=%s', (workrows.dumps(value), key))
        self.other(act)

    def before(self, match, *actions):
        """Run each action, in turn, just BEFORE the next statement `match`
        accepts; returns (patcher, fired list)."""
        original = pgstore.PgConn.execute
        pending = list(actions)
        fired = []

        def execute(c, sql, params=()):
            if pending and match(sql):
                pending.pop(0)()
                fired.append(sql)
            return original(c, sql, params)
        return patch.object(pgstore.PgConn, 'execute', execute), fired

    def loaded(self):
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            return [dict(w) for w in tx.d['work_items']]

    # -- the N1000 failure ------------------------------------------------
    def test_a_create_between_header_and_listing_loads_the_new_docket(self):
        p, fired = self.before(_is_listing, lambda: self.create('three'))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 1, 'control: the create committed mid-load')
        self.assertEqual([w['slug'] for w in got], ['one', 'two', 'three'])
        self.assertEqual(self.raced('relisted'), 1, 'the disagreement was re-read')

    def test_an_archive_between_header_and_listing_loads_the_new_docket(self):
        p, fired = self.before(_is_listing, lambda: self.archive('two'))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 1)
        self.assertEqual([w['slug'] for w in got], ['one'])
        self.assertEqual(self.raced('relisted'), 1)

    def test_a_create_in_a_message_door_call_does_not_fail_it(self):
        # the failing shape: store._load_sqlite_org(lazy_work=True) inside a
        # transaction that does not lock the docket
        p, fired = self.before(_is_listing, lambda: self.create('three'))
        with p, orgtx.org_tx(self.slug, nodes=['b'], sections=[('mail', 'b')]) as tx:
            slugs = [w['slug'] for w in tx.d['work_items']]
        self.assertEqual(len(fired), 1)
        self.assertEqual(slugs, ['one', 'two', 'three'])

    # -- an update before the body fetch ------------------------------------
    def test_an_update_before_the_body_fetch_loads_the_new_version(self):
        store._WORK_ITEM_META.clear()
        p, fired = self.before(_is_body_fetch, lambda: self.update('one', 17))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 1)
        self.assertEqual({w['slug']: w['rev'] for w in got}, {'one': 17, 'two': 1})
        self.assertEqual(self.raced('relisted'), 1)
        # never cached under the listing's (old) version: a later warm load
        # hits the cache for the row version it actually holds
        self.assertEqual({w['slug']: w['rev'] for w in self.loaded()}, {'one': 17, 'two': 1})

    def test_churn_on_every_fetch_falls_back_to_one_whole_read(self):
        store._WORK_ITEM_META.clear()
        p, fired = self.before(_is_body_fetch, lambda: self.update('one', 21),
                               lambda: self.update('one', 22), lambda: self.update('one', 23))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 2, 'both body fetches raced; the whole read has none')
        self.assertEqual({w['slug']: w['rev'] for w in got}, {'one': 22, 'two': 1})
        self.assertEqual(self.raced('whole'), 1)

    # -- a discarded attempt's rows are dropped (pg-workitems' review, P1/P2) --
    @staticmethod
    def forget(slug):
        """Evict one item from the warm metadata cache (its body is fetched)."""
        key = workrows.PREFIX + slug
        for ident in [i for i in store._WORK_ITEM_META if i[-4] == key]:
            del store._WORK_ITEM_META[ident]

    def test_step2_drops_a_ref_bound_before_the_race(self):
        # one, two warm (bound as refs at once); three uncached. Before the
        # body fetch: archive two, update three. The stale ref to two must
        # not survive into the re-read.
        self.create('three')
        self.forget('three')
        p, fired = self.before(_is_body_fetch,
                               lambda: (self.archive('two'), self.update('three', 5)))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 1)
        self.assertEqual({w['slug']: w['rev'] for w in got}, {'one': 1, 'three': 5})
        self.assertEqual(self.raced('relisted'), 1)

    def test_the_whole_read_drops_a_ref_bound_in_step2(self):
        self.forget('one')                          # two stays warm
        p, fired = self.before(_is_body_fetch, lambda: self.update('one', 31),
                               lambda: (self.archive('two'), self.update('one', 32)))
        with p:
            got = self.loaded()
        self.assertEqual(len(fired), 2)
        self.assertEqual({w['slug']: w['rev'] for w in got}, {'one': 32})
        self.assertEqual(self.raced('whole'), 1)

    # -- not a race: one statement still disagrees ----------------------------
    def test_a_missing_item_row_still_raises(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('DELETE FROM doc WHERE key=?', (workrows.PREFIX + 'two',))
        with self.assertRaises(ValueError):
            store._load_sqlite_org(self.slug, lazy_work=True)
        self.assertEqual(self.raced('relisted'), 1, 'it was re-read once before raising')


if __name__ == '__main__':
    unittest.main()
