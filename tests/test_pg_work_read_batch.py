"""Actual-PG: a docket save writes its read-model rows in batches.

The ancestor chain is read in one statement, an item's dependency rows are
rewritten in one statement, the processed dirty markers go with the state
update, and after access work the list model is read once under the lock the
save already holds. The rows written are the same as the row-by-row code wrote:
reconcile(), which rebuilds everything from raw data, must agree."""
import json
import unittest

import test_pgstore as f
import test_pg_work_read as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, workread


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class BatchedSave(unittest.TestCase):
    setUp = fixture.Counts.setUp
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh
    item = fixture.Counts.item
    node = fixture.Counts.node
    counts = fixture.Counts.counts
    oracle = fixture.Counts.oracle

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def counted_refresh(self):
        seen = []
        original = self.c.execute

        def counting(query, *a, **k):
            seen.append(' '.join(str(query).split()))
            return original(query, *a, **k)

        self.c.execute = counting
        try:
            with self.c.transaction():
                result = workread.refresh(self.c, self.oid)
        finally:
            del self.c.execute
        return result, seen

    def deps(self, slug='one'):
        return {r[0] for r in self.c.execute(
            f'SELECT node_id FROM {self.s}.work_read_dependency WHERE slug=%s', (slug,))}

    def dirty(self):
        return {r[0] for r in self.c.execute(f'SELECT slug FROM {self.s}.work_read_dirty')}

    def reconciled(self):
        with self.c.transaction():
            return workread.reconcile(self.c, self.oid)

    def chain(self, *ids):
        for child, parent in zip(ids, ids[1:] + (None,)):
            self.node(child, parent)

    def test_a_deep_owner_chain_is_read_in_one_statement(self):
        self.chain('a', 'b', 'c', 'd', 'e')
        self.add(self.item())
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        parent_reads = [q for q in seen if "->'parent'" in q]
        self.assertEqual(len(parent_reads), 1, parent_reads)
        self.assertEqual(self.deps(), {'a', 'b', 'c', 'd', 'e'})
        for viewer in ('a', 'c', 'e', 'stranger'):
            with self.subTest(viewer=viewer):
                self.assertEqual(self.counts(viewer), self.oracle(viewer))
        self.assertTrue(self.reconciled())

    def test_a_parent_cycle_ends_and_matches_the_row_by_row_answer(self):
        self.node('a', 'b')
        self.node('b', 'a')
        self.add(self.item())
        self.refresh()
        self.assertEqual(self.deps(), {'a', 'b'})
        self.assertEqual(self.counts('b'), self.oracle('b'))

    def test_a_malformed_parent_still_refuses_the_counts(self):
        self.node('a', 'b')
        self.c.execute(f"UPDATE {self.s}.nodes SET val=%s WHERE id='a'",
                       (json.dumps(dict(id='a', name='a', parent=7, children=[])),))
        self.add(self.item())
        with self.assertLogs('orgtree.workread', level='ERROR'):
            with self.c.transaction():
                self.assertFalse(workread.refresh(self.c, self.oid))
        self.assertIsNone(self.counts())

    def test_a_changed_dependency_set_keeps_drops_and_adds_rows_in_one_statement(self):
        self.chain('a', 'b', 'top')
        self.node('c', 'b')
        self.add(self.item())
        self.refresh()
        self.assertEqual(self.deps(), {'a', 'b', 'top'})
        self.add(dict(self.item(), owner={'node': 'c', 'generation': 0}))
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        writes = [q for q in seen if 'work_read_dependency' in q]
        self.assertEqual(len(writes), 1, writes)
        self.assertEqual(self.deps(), {'c', 'b', 'top'})
        self.assertEqual(self.counts('a'), self.oracle('a'))
        self.assertEqual(self.counts('c'), self.oracle('c'))
        self.assertTrue(self.reconciled())

    def test_a_removed_item_drops_its_rows(self):
        self.chain('a', 'b')
        self.add(self.item())
        self.refresh()
        self.c.execute(f'DELETE FROM {self.s}.doc WHERE key=%s', (fixture.workrows.PREFIX + 'one',))
        self.c.execute(f"UPDATE {self.s}.doc SET val=%s WHERE key='work_items'", (fixture.workrows.header([]),))
        self.refresh()
        self.assertEqual(self.deps(), set())
        self.assertEqual(self.dirty(), set())
        self.assertTrue(self.reconciled())

    def test_every_processed_dirty_marker_is_cleared_with_the_state_update(self):
        self.chain('a', 'b')
        for slug in ('one', 'two', 'three'):
            self.add(self.item(slug))
        self.assertEqual(self.dirty(), {'one', 'two', 'three'})
        self.refresh()
        self.assertEqual(self.dirty(), set())
        self.assertFalse(self.c.execute(
            f'SELECT questions_dirty FROM {self.s}.work_read_state WHERE singleton').fetchone()[0])
        self.assertTrue(self.reconciled())

    def test_a_failed_item_leaves_every_dirty_marker_in_place(self):
        self.add(self.item('aa'))
        self.add(dict(self.item('zz'), participants=[1]))
        with self.assertLogs('orgtree.workread', level='ERROR'):
            with self.c.transaction():
                self.assertFalse(workread.refresh(self.c, self.oid))
        self.assertEqual(self.dirty(), {'aa', 'zz'})
        self.assertIsNone(self.counts())
        self.add(dict(self.item('zz'), participants=['m']))
        self.c.execute(f'UPDATE {self.s}.work_read_state SET ready=true WHERE singleton')
        self.refresh()
        self.assertEqual(self.dirty(), set())
        self.assertEqual(self.counts(), self.oracle())

    def test_after_access_work_the_list_is_read_once_under_the_held_lock(self):
        self.add(self.item())
        self.refresh()
        self.add(dict(self.item(), status='blocked', blocked_reason='x'))
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        locks = [q for q in seen if 'work_read_state WHERE singleton FOR UPDATE' in q]
        self.assertEqual(len(locks), 1, locks)
        self.assertEqual([q for q in seen if q.startswith('SELECT to_regclass(%s)') and q.count('to_regclass') == 1], [])
        list_state = [q for q in seen if 'FROM ' + self.s + '.work_list_state' in q]
        self.assertEqual(len(list_state), 1, list_state)
        summary = self.c.execute(f"SELECT payload FROM {self.s}.work_list_summary WHERE slug='one'").fetchone()[0]
        self.assertEqual(summary['status'], 'blocked')
        self.assertIsNone(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_after_access_work_an_uninitialized_list_is_built(self):
        self.add(self.item())
        self.refresh()
        self.c.execute(f'UPDATE {self.s}.work_list_state SET initialized=false WHERE singleton')
        self.add(dict(self.item(), status='blocked', blocked_reason='x'))
        result, _ = self.counted_refresh()
        self.assertTrue(result)
        self.assertEqual(self.c.execute(
            f'SELECT initialized,ready FROM {self.s}.work_list_state WHERE singleton').fetchone(), (True, True))

    def test_a_changed_item_save_statement_count(self):
        self.chain('a', 'b')
        self.add(self.item())
        self.refresh()
        self.add(dict(self.item(), status='blocked', blocked_reason='x'))
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        self.assertEqual(len(seen), COUNT, seen)


# Measured: 20 (the row-by-row code ran 28 for the same save).
COUNT = 20


if __name__ == '__main__':
    unittest.main()
