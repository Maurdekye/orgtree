"""workread.counts_raw reuses a clean answer per docket revision, never a stale one.

N1000 engprof run 2 (2026-09-28): counts_raw was 28% of
/api/orgs/{slug}/foreground-tree/children, the largest engine-CPU route. The
cache (workread._counts_cache) keys on work_read_state.revision, which the
orgtree_work_access_dirty trigger bumps on every docket-relevant write, and
expires an entry just before the next archive deadline.

Every docket change kind that moves a count gets its own test: the cache is
primed, the change is written and refreshed, and the next answer must equal
the canonical Org oracle (test_pg_work_read.Counts.oracle) AND differ from the
primed one. A spy on workread._counts_compute proves the cache actually served
the unchanged cases, so a cache that never hits cannot pass either.

Run:  python tools/run-python-verification.py tests/test_pg_work_counts_cache.py
"""
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as wr
from orgtree import pgstore, workrows, workread
from orgtree.ledger import USER


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class CountsCache(unittest.TestCase):
    setUpClass = wr.Counts.setUpClass
    tearDown = wr.Counts.tearDown
    item = wr.Counts.item
    add = wr.Counts.add
    refresh = wr.Counts.refresh
    oracle = wr.Counts.oracle
    node = wr.Counts.node

    def setUp(self):
        wr.Counts.setUp(self)
        workread._counts_cache.clear()
        self.computed = 0
        real = workread._counts_compute

        def spy(*args, **kwargs):
            self.computed += 1
            return real(*args, **kwargs)
        p = patch.object(workread, '_counts_compute', spy)
        p.start()
        self.addCleanup(p.stop)

    def counts(self, viewer=USER):
        with pgstore.connect() as c, c.transaction():
            c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            return workread.counts_raw(c, self.oid, viewer=viewer, now_ts=self.now)

    def primed(self, viewer=USER):
        """Answer twice; the second must come from the cache and agree."""
        first = self.counts(viewer)
        computed = self.computed
        self.assertEqual(self.counts(viewer), first)
        self.assertEqual(self.computed, computed, 'unchanged docket was recomputed: no cache hit')
        self.assertEqual(first, self.oracle(viewer))
        return first

    def changed(self, before, viewer=USER):
        after = self.counts(viewer)
        self.assertEqual(after, self.oracle(viewer))
        self.assertNotEqual(after, before, 'the change did not move the counts; the test proves nothing')
        return after

    def test_unchanged_docket_is_served_from_cache(self):
        self.add(self.item()); self.refresh()
        self.primed()
        self.assertEqual(self.computed, 1)

    def test_create_invalidates(self):
        self.add(self.item()); self.refresh()
        before = self.primed()
        self.add(self.item('two')); self.refresh()
        self.assertEqual(self.changed(before)['active'], 2)

    def test_status_change_invalidates(self):
        self.add(self.item()); self.refresh()
        before = self.primed()
        self.add(dict(self.item(), status='backlogged')); self.refresh()
        self.assertEqual(self.changed(before), dict(active=0, attention=0, archived=0, backlogged=1))

    def test_archive_invalidates(self):
        item = self.item(); self.add(item); self.refresh()
        before = self.primed()
        with self.c.transaction():
            self.add(dict(item, status='done'), True)
            self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s', (workrows.PREFIX + 'one',))
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'", (workrows.header([]),))
            self.assertTrue(workread.refresh(self.c, self.oid))
        self.assertEqual(self.changed(before), dict(active=0, attention=0, archived=1, backlogged=0))

    def test_reassign_invalidates_each_viewer(self):
        self.add(self.item()); self.refresh()
        old_owner, new_owner = self.primed('a'), self.primed('c')
        self.assertEqual((old_owner['active'], new_owner['active']), (1, 0))
        self.add(dict(self.item(), owner={'node': 'c', 'generation': 0})); self.refresh()
        self.assertEqual(self.changed(old_owner, 'a')['active'], 0)
        self.assertEqual(self.changed(new_owner, 'c')['active'], 1)

    def test_delete_invalidates(self):
        self.add(self.item()); self.add(self.item('two')); self.refresh()
        before = self.primed()
        with self.c.transaction():
            self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s', (workrows.PREFIX + 'two',))
            self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'", (workrows.header(['one']),))
            self.assertTrue(workread.refresh(self.c, self.oid))
        self.assertEqual(self.changed(before)['active'], 1)

    def test_question_invalidates(self):
        self.add(self.item()); self.refresh()
        before = self.primed()
        asks = [dict(id='ask1', node='a', status='open', questions=[dict(work_item='one', question='why?')])]
        self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val',
                       ('asks', json.dumps(asks)))
        self.refresh()
        self.assertEqual(self.changed(before)['attention'], 1)

    def test_reparent_invalidates(self):
        self.node('a', 'b'); self.add(self.item()); self.refresh()
        before = self.primed('b')
        self.node('a', 'c'); self.refresh()
        self.assertEqual(self.changed(before, 'b')['active'], 0)

    def test_dirty_docket_is_refused_not_served(self):
        self.add(self.item()); self.refresh()
        self.primed()
        self.add(self.item('two'))
        self.assertIsNone(self.counts())
        self.refresh()
        self.assertEqual(self.counts()['active'], 2)

    def test_entry_expires_before_the_next_archive_deadline(self):
        # a done item archives once its docket update is strictly older than the hour
        stamp = datetime.fromtimestamp(self.now - 3600 + 10, tz=timezone.utc).isoformat()
        self.add(dict(self.item(), status='done', docket_at=stamp)); self.refresh()
        before = self.primed()
        self.assertEqual(before['archived'], 0)
        self.now += 5                      # inside the entry's life: served
        computed = self.computed
        self.assertEqual(self.counts(), self.oracle())
        self.assertEqual(self.computed, computed)
        self.now += 4.5                    # inside the safety margin: recomputed
        self.assertEqual(self.counts(), self.oracle())
        self.assertEqual(self.computed, computed + 1)
        self.now += 1                      # past the deadline: archived
        self.assertEqual(self.changed(before)['archived'], 1)

    def test_earlier_clock_is_not_served_a_later_answer(self):
        stamp = datetime.fromtimestamp(self.now - 3600 - 5, tz=timezone.utc).isoformat()
        self.add(dict(self.item(), status='done', docket_at=stamp)); self.refresh()
        later = self.primed()
        self.assertEqual(later['archived'], 1)
        self.now -= 10
        self.assertEqual(self.changed(later)['archived'], 0)

    def test_key_names_the_database(self):
        self.add(self.item()); self.refresh()
        self.primed()
        (key,) = list(workread._counts_cache)
        database = self.c.execute('SELECT current_database()').fetchone()[0]
        self.assertEqual((key[0], key[2], key[3]), (database, self.oid, USER))


if __name__ == '__main__':
    unittest.main()
