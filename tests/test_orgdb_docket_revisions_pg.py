"""Docket-owned tables retain once-per-transaction flags after forced checks."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
from unittest.mock import patch

import test_orgdb_docket_pg as fixture
from test_orgdb_docket_events import item
from orgtree.orgdb import conn


def setUpModule():
    original = fixture.seed
    def seed():
        value = original()
        value['work_items'].append(item())
        return value
    with patch.object(fixture, 'seed', seed):
        fixture.setUpModule()


@unittest.skipUnless(fixture.ADMIN and fixture.RUNTIME, 'disposable PostgreSQL URLs required')
class ForcedChecks(unittest.TestCase):
    def probe(self, select, update, changed, discarded, counters):
        with conn.connect(fixture.ADMIN, fixture.DATABASE) as raw:
            key, original = raw.execute(select).fetchone()
            def revisions():
                return raw.execute('SELECT '+','.join(counters)+' FROM orgtree.org_revision').fetchone()
            before = revisions()
            with raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                raw.execute(update, (changed, key))
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                first = revisions()
                self.assertEqual(first, tuple(v+1 for v in before))
                with self.assertRaisesRegex(RuntimeError, 'discard change'), raw.transaction():
                    raw.execute(update, (discarded, key))
                    raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    raise RuntimeError('discard change')
                self.assertEqual(revisions(), first)
                raw.execute(update, (original, key))
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                self.assertEqual(revisions(), first)
            self.assertEqual(revisions(), first)

            # A forced flush that is rolled back must not suppress the next
            # transaction's flag on the same pooled connection.
            with self.assertRaisesRegex(RuntimeError, 'discard transaction'), raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                raw.execute(update, (changed, key))
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                raise RuntimeError('discard transaction')
            self.assertEqual(revisions(), first)
            with raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                raw.execute(update, (original, key))
            self.assertEqual(revisions(), tuple(v+1 for v in first))

    def test_question_links_redefer_and_count_once(self):
        self.probe('SELECT ask_id,item_slug FROM orgtree.docket_question_links ORDER BY ask_id LIMIT 1',
                   'UPDATE orgtree.docket_question_links SET item_slug=%s WHERE ask_id=%s',
                   'forced-question', 'discarded-question', ('docket_rev',))

    def test_events_redefer_both_flags_and_count_once(self):
        self.probe("SELECT id,status_change FROM orgtree.work_item_events WHERE source='history' ORDER BY id LIMIT 1",
                   'UPDATE orgtree.work_item_events SET status_change=%s WHERE id=%s',
                   True, False, ('docket_rev', 'view_rev'))


if __name__ == '__main__':
    unittest.main()
