"""Actual-PG: the read-model check every save runs before its COMMIT.

`workread.refresh` runs on every changed save, docket write or not. It reads
which read-model tables exist and their three state rows in TWO statements
(it was six). Nothing is cached across saves: a table that appears or
disappears while the engine runs is seen by the very next save."""
import unittest

import test_pgstore as f
import test_pg_work_read as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, workread, worklistmeta


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class SaveProbe(unittest.TestCase):
    setUp = fixture.Counts.setUp
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh
    item = fixture.Counts.item

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def summary(self, slug='one'):
        row = self.c.execute(f'SELECT payload FROM {self.s}.work_list_summary WHERE slug=%s',
                             (slug,)).fetchone()
        return row and row[0]

    def counted_refresh(self):
        seen = []
        original = self.c.execute

        def counting(query, *a, **k):
            seen.append(' '.join(str(query).split())[:80])
            return original(query, *a, **k)

        self.c.execute = counting
        try:
            with self.c.transaction():
                result = workread.refresh(self.c, self.oid)
        finally:
            del self.c.execute
        return result, seen

    def settled(self):
        self.add(self.item())
        self.refresh()
        self.assertTrue(worklistmeta.ready(self.c, self.oid))

    def test_an_unrelated_save_decides_in_two_statements(self):
        self.settled()
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        self.assertEqual(len(seen), 2, seen)

    def test_a_pending_list_row_is_rebuilt_on_an_otherwise_quiet_save(self):
        self.settled()
        self.c.execute(f"UPDATE {self.s}.work_list_summary SET payload='{{}}'")
        self.c.execute(f"INSERT INTO {self.s}.work_list_dirty VALUES('one')")
        result, _ = self.counted_refresh()
        self.assertTrue(result)
        self.assertEqual(self.summary()['slug'], 'one')
        self.assertIsNone(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_an_uninitialized_list_is_built_on_an_otherwise_quiet_save(self):
        self.settled()
        self.c.execute(f'UPDATE {self.s}.work_list_state SET initialized=false WHERE singleton')
        self.assertIsNone(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())
        result, _ = self.counted_refresh()
        self.assertTrue(result)
        self.assertTrue(self.c.execute(
            f'SELECT initialized FROM {self.s}.work_list_state WHERE singleton').fetchone()[0])
        self.assertTrue(worklistmeta.ready(self.c, self.oid))

    def test_an_invalid_index_stops_the_save_after_the_probe(self):
        self.settled()
        self.c.execute(f'UPDATE {self.s}.work_index_state SET valid=false WHERE singleton')
        self.c.execute(f"INSERT INTO {self.s}.work_list_dirty VALUES('one')")
        result, seen = self.counted_refresh()
        self.assertFalse(result)
        self.assertEqual(len(seen), 2, seen)       # no access or list work
        self.assertIsNotNone(self.c.execute(f'SELECT 1 FROM {self.s}.work_list_dirty').fetchone())

    def test_a_changed_item_is_still_projected(self):
        self.settled()
        self.add(dict(self.item(), status='blocked', blocked_reason='x'))
        result, seen = self.counted_refresh()
        self.assertTrue(result)
        self.assertGreater(len(seen), 2)
        self.assertEqual(self.summary()['status'], 'blocked')

    def test_a_table_that_appears_while_running_is_seen_by_the_next_save(self):
        self.settled()
        self.c.execute(f'ALTER TABLE {self.s}.work_list_state RENAME TO work_list_state_away')
        self.c.execute(f"INSERT INTO {self.s}.work_list_dirty VALUES('one')")
        self.c.execute(f"UPDATE {self.s}.work_list_summary SET payload='{{}}'")
        result, _ = self.counted_refresh()          # list model absent: untouched
        self.assertTrue(result)
        self.assertEqual(self.summary(), {})
        self.c.execute(f'ALTER TABLE {self.s}.work_list_state_away RENAME TO work_list_state')
        result, _ = self.counted_refresh()          # back: the next save uses it
        self.assertTrue(result)
        self.assertEqual(self.summary()['slug'], 'one')


if __name__ == '__main__':
    unittest.main()
