"""App commit ordering and same-snapshot summaries/notices on disposable PG."""
import import_provenance  # noqa: F401  own checkout before importing orgtree

from contextlib import contextmanager
import threading
import time
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class AppDatabase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('app feed')
        cls.other = fixture.Twins('app feed second')
        cls.first_id = fixture.registry.lookup(cls.twin.copy)[0]
        cls.other_id = fixture.registry.lookup(cls.other.copy)[0]

    def setUp(self):
        self.enterContext(fixture.storage(True))

    @contextmanager
    def app(self):
        with fixture.dbconn.connect(fixture.ADMIN, fixture.names.app()) as raw:
            raw.execute("SET statement_timeout='10s'")
            yield raw

    def revision(self, raw):
        return raw.execute('SELECT rev FROM orgtree.registry_revision').fetchone()[0]

    def test_one_revision_for_multiple_rows_statements_and_change_back(self):
        with self.app() as raw:
            before = self.revision(raw)
            raw.execute('BEGIN')
            for amount in (1, -1):
                raw.execute('UPDATE orgtree.orgs SET attempts=attempts+%s WHERE org_id=ANY(%s)',
                            (amount, [self.first_id, self.other_id]))
                self.assertEqual(self.revision(raw), before, 'source statements must not lock revision')
            raw.execute('COMMIT')
            self.assertEqual(self.revision(raw), before + 1)

    def test_rollback_savepoint_and_failed_transaction_leave_no_revision(self):
        with self.app() as raw:
            before = self.revision(raw)
            raw.execute('BEGIN')
            raw.execute('SAVEPOINT undone')
            raw.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s', (self.first_id,))
            raw.execute('SET CONSTRAINTS orgtree.registry_flush IMMEDIATE')
            self.assertEqual(self.revision(raw), before + 1)
            raw.execute('ROLLBACK TO undone')
            raw.execute('COMMIT')
            self.assertEqual(self.revision(raw), before)
            raw.execute('BEGIN')
            raw.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s', (self.first_id,))
            raw.execute('ROLLBACK')
            self.assertEqual(self.revision(raw), before)

    def test_source_rows_do_not_wait_on_revision_and_commit_order_matches_revision(self):
        attempted, committed = threading.Event(), threading.Event()
        failures = []
        with self.app() as first, self.app() as observer:
            before = self.revision(observer)
            first.execute('BEGIN')
            first.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s', (self.first_id,))
            first.execute('SELECT rev FROM orgtree.registry_revision FOR UPDATE')
            def second_writer():
                try:
                    with self.app() as second:
                        second.execute('BEGIN')
                        second.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s',
                                       (self.other_id,))
                        attempted.set()
                        second.execute('COMMIT')
                        committed.set()
                except BaseException as exc:
                    failures.append(exc)
                    attempted.set()
            thread = threading.Thread(target=second_writer)
            thread.start()
            try:
                self.assertTrue(attempted.wait(5), 'second source update blocked on revision too early')
                self.assertFalse(failures)
                self.assertFalse(committed.is_set(), 'commit passed a held singleton')
                self.assertEqual(self.revision(observer), before)
                first.execute('COMMIT')
                self.assertTrue(committed.wait(5))
            finally:
                first.execute('ROLLBACK')
                thread.join(12)
            self.assertFalse(thread.is_alive())
            self.assertFalse(failures)
            self.assertEqual(self.revision(observer), before + 2)

    def test_registry_snapshot_fields_and_revision_are_one_repeatable_read(self):
        from orgtree.orgdb import app_reads
        cursor, records = app_reads.registry_snapshot()
        self.assertTrue(cursor['app_uuid'] and cursor['incarnation'])
        self.assertIsInstance(cursor['rev'], int)
        self.assertEqual({r['body']['org_id'] for r in records}, {r['org_id'] for r in fixture.registry.rows()})
        self.assertTrue(all(set(r['body']) == set(app_reads.REGISTRY_FIELDS) for r in records))
        self.assertTrue(all(r['id'] == str(r['body']['org_id']) for r in records))

    def test_summary_and_notices_match_original_builders(self):
        from orgtree import desktop_notifications, org_summary
        from orgtree.orgdb import app_reads
        row = next(r for r in fixture.registry.rows() if r['org_id'] == self.first_id)
        actual = app_reads.org_snapshot(row)
        summary, totals = org_summary._read(row['slug'])
        self.assertEqual(actual['body'], {**{k: summary[k] for k in app_reads.SUMMARY_FIELDS
                                            if k != 'cost_usd_total'}, 'cost_usd_total': totals.cost_total()})
        org = fixture.store.load_org(row['slug'])
        expected = desktop_notifications._attention(org)[0] + desktop_notifications._frozen(org)
        self.assertEqual(actual['notices'], expected)

    def test_summary_and_notices_do_not_observe_commit_between_their_reads(self):
        from orgtree.orgdb import app_reads
        row = next(r for r in fixture.registry.rows() if r['org_id'] == self.first_id)
        original = app_reads._notices
        baseline = app_reads.org_snapshot(row)
        def committed_between(raw, slug):
            org = fixture.store.load_org(slug)
            org.d['name'] = 'after summary snapshot'
            org.d.setdefault('user_inbox', []).append(dict(id='late-mail', body='late', **{'from': 'dev'}))
            fixture.store.save_org(org)
            return original(raw, slug)
        with patch.object(app_reads, '_notices', side_effect=committed_between):
            held = app_reads.org_snapshot(row)
        self.assertEqual(held, baseline)
        fresh = app_reads.org_snapshot(row)
        self.assertNotEqual(fresh['rev'], held['rev'])
        self.assertEqual(fresh['body']['name'], 'after summary snapshot')
        self.assertGreater(len(fresh['notices']), len(held['notices']))

    def test_existing_row_notification_and_new_commit_notification_both_remain(self):
        with self.app() as listener, self.app() as writer:
            listener.execute('LISTEN app_orgs')
            listener.execute('LISTEN app_rev')
            before = self.revision(writer)
            with writer.transaction():
                writer.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s',
                               (self.first_id,))
                writer.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s',
                               (self.other_id,))
            received = list(listener.notifies(timeout=2, stop_after=3))
            self.assertEqual([(n.channel, n.payload) for n in received if n.channel == 'app_rev'],
                             [('app_rev', str(before + 1))])
            self.assertEqual(len([n for n in received if n.channel == 'app_orgs']), 2)


if __name__ == '__main__':
    unittest.main()
