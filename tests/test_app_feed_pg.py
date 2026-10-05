"""App commit ordering and same-snapshot summaries/notices on disposable PG."""
import import_provenance  # noqa: F401  own checkout before importing orgtree

from contextlib import contextmanager
import asyncio
import json
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

    def test_all_notice_categories_match_original_including_exclusions(self):
        from orgtree import desktop_notifications
        from orgtree.orgdb import app_reads
        org = fixture.store.load_org(self.other.copy)
        org.d['asks'] = [
            dict(id='batch', node='dev', status='open', questions=[dict(question='First tab?')]),
            dict(id='closed', node='dev', status='answered', question='Hidden'),
            dict(id='retired', node='ops', status='open', question='Hidden retired')]
        org.d['nodes']['dev']['frozen'] = dict(at=fixture.AT, reason='usage')
        org.d['nodes']['ops']['state'] = 'retired'
        org.d['nodes']['ops']['frozen'] = dict(at=fixture.AT, reason='historical')
        org.d['user_inbox'] = [
            dict(id='routine', body='Ordinary', **{'from': 'dev'}),
            dict(id='urgent', urgent=True, urgent_reason='Act now', **{'from': 'dev'}),
            dict(id='terminal', urgent=True, body='Stopped',
                 ev=dict(variant='runtime.turn_failed_terminal'), **{'from': 'dev'})]
        item = fixture.item('manual', 'Manual attention')
        item.update(manual_attention=dict(reason='Check this', set_rev=7),
                    notification_attention_epoch=3, notification_attention_active=True)
        org.d['work_items'] = [item, fixture.item('ordinary', 'No attention')]
        org.d['documents'] = [dict(id='doc', node='dev', title='Report', body='Not in notice')]
        fixture.store.save_org(org)
        row = next(r for r in fixture.registry.rows() if r['org_id'] == self.other_id)
        actual = app_reads.org_snapshot(row)['notices']
        loaded = fixture.store.load_org(self.other.copy)
        expected = desktop_notifications._attention(loaded)[0] + desktop_notifications._frozen(loaded)
        self.assertEqual(actual, expected)
        self.assertEqual({n['kind'] for n in actual}, {'question', 'routine', 'urgent-mail',
            'terminal-failure', 'work-attention', 'document', 'agent-frozen'})
        self.assertEqual(len(actual), 7)
        self.assertEqual(next(n['body'] for n in actual if n['kind'] == 'question'), 'First tab?')

    def test_lost_app_notification_converges_without_later_commit(self):
        asyncio.run(self._listener_recovery(app=True, killed=False))

    def test_killed_app_listener_converges_without_later_commit(self):
        asyncio.run(self._listener_recovery(app=True, killed=True))

    def test_lost_org_notification_converges_without_registry_write(self):
        asyncio.run(self._listener_recovery(app=False, killed=False))

    def test_killed_org_listener_converges_without_registry_write(self):
        asyncio.run(self._listener_recovery(app=False, killed=True))

    def test_missing_notice_resolver_is_caught_by_parity_control(self):
        from orgtree.orgdb import app_reads
        with patch.object(app_reads, '_notices', return_value=[]):
            with self.assertRaises(AssertionError):
                self.test_all_notice_categories_match_original_including_exclusions()
        # Restoring the resolver must restore the same original assertion.
        self.test_all_notice_categories_match_original_including_exclusions()

    def test_disabled_safety_read_is_caught_by_lost_notification_control(self):
        from orgtree import pgfeed
        original = pgfeed.RevisionFeed._read_all
        def no_poll(feed, connection, source):
            if source == 'catchup':
                return original(feed, connection, source)
        with patch.object(pgfeed.RevisionFeed, '_read_all', no_poll):
            with self.assertRaises(TimeoutError):
                asyncio.run(self._listener_recovery(app=True, killed=False, deadline=.4))
        asyncio.run(self._listener_recovery(app=True, killed=False))

    def test_revision_lock_is_acquired_only_at_commit_and_hold_is_measured(self):
        # A temporary AFTER trigger observes the actual revision-row update.
        # Client receipt is later than lock release, so this is an upper bound.
        with self.app() as raw:
            raw.execute('CREATE TEMP TABLE app_hold_probe(at timestamptz)')
            raw.execute('CREATE FUNCTION pg_temp.app_hold_probe() RETURNS trigger LANGUAGE plpgsql '
                        'AS $$ BEGIN INSERT INTO app_hold_probe VALUES (clock_timestamp()); '
                        'RETURN NULL; END $$')
            raw.execute('CREATE TRIGGER app_hold_probe AFTER UPDATE ON orgtree.registry_revision '
                        'FOR EACH ROW EXECUTE FUNCTION pg_temp.app_hold_probe()')
            try:
                measures = []
                for _ in range(5):
                    raw.execute('BEGIN')
                    raw.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s',
                                (self.first_id,))
                    self.assertEqual(raw.execute('SELECT count(*) FROM app_hold_probe').fetchone()[0], 0)
                    raw.execute('COMMIT')
                    elapsed = raw.execute('SELECT extract(epoch FROM clock_timestamp()-at)*1000 '
                                          'FROM app_hold_probe').fetchone()[0]
                    measures.append(float(elapsed))
                    raw.execute('TRUNCATE app_hold_probe')
                self.assertEqual(len(measures), 5)
                print('registry_revision_hold_upper_bound_ms=' + json.dumps(measures))
            finally:
                raw.execute('ROLLBACK')
                raw.execute('DROP TRIGGER app_hold_probe ON orgtree.registry_revision')

    async def _listener_recovery(self, *, app, killed, deadline=8):
        from orgtree import pgfeed
        from orgtree.orgdb import app_reads
        from orgtree.orgdb.app_host import AppHost
        from orgtree.orgdb.record_runtime import HostClock
        loop = asyncio.get_running_loop()
        errors, connections, dropped = [], [], []
        listening, release = threading.Event(), threading.Event()
        async def read_registry():
            return await asyncio.to_thread(app_reads.registry_snapshot)
        async def read_org(row):
            return await asyncio.to_thread(app_reads.org_snapshot, row)
        host = AppHost(read_registry, read_org, errors.append, clock=HostClock(), interval=.01)
        await host.ready()
        await host.idle()
        queue = await host.connect()
        await queue.take()  # initial full copy
        factory = app_reads.AppConnection if app else pgfeed.orgdb_conn
        class GatedConnection:
            def __init__(self):
                self.inner = factory()
                self.first = not connections
                connections.append(self.inner)
            def __getattr__(self, key):
                return getattr(self.inner, key)
            def notifications(self, timeout):
                if self.first:
                    self.first = False
                    listening.set()  # LISTEN and initial revision read both completed
                    if not release.wait(8):
                        raise TimeoutError('test did not release listener barrier')
                for payload in self.inner.notifications(timeout):
                    # Deliberately lose real notifications, not their source commits.
                    dropped.append(payload)
                    if killed:
                        yield payload
        def observed(slug, rev, gap):
            if app:
                loop.call_soon_threadsafe(host.refresh.wake)
            else:
                loop.call_soon_threadsafe(host.observed, slug, rev, gap)
        feed = pgfeed.RevisionFeed(GatedConnection, observed, poll_s=.05, retry_s=.02)
        feed.start()
        try:
            self.assertTrue(await asyncio.to_thread(listening.wait, 8))
            with self.app() as raw:
                registry_before = self.revision(raw)
                if killed:
                    inner = connections[0]
                    session = inner.raw if app else inner.c[self.twin.copy][1]
                    self.assertTrue(raw.execute('SELECT pg_terminate_backend(%s)',
                                                (session.info.backend_pid,)).fetchone()[0])
                if app:
                    raw.execute('UPDATE orgtree.orgs SET attempts=attempts+1 WHERE org_id=%s',
                                (self.first_id,))
            if app:
                target = app_reads.registry_snapshot()[0]['rev']
            else:
                org = fixture.store.load_org(self.twin.copy)
                org.d['name'] = 'recovered ' + str(time.monotonic_ns())
                org.d['nodes']['dev']['cost_usd'] += 1
                fixture.store.save_org(org)
                row = next(r for r in fixture.registry.rows() if r['org_id'] == self.first_id)
                target = app_reads.org_snapshot(row)['rev']
            # No writes after this barrier. Only catch-up can recover the last state.
            release.set()
            async def delivered():
                while True:
                    frame = json.loads(await queue.take())
                    if app and frame['type'] == 'registry_snapshot' and frame['cursor']['rev'] == target:
                        return frame
                    if (not app and frame['type'] == 'org_summary'
                            and frame['org_id'] == self.first_id and frame['rev'] == target):
                        return frame
            frame = await asyncio.wait_for(delivered(), deadline)
            if app:
                cursor, records = app_reads.registry_snapshot()
                self.assertEqual((frame['cursor'], frame['records']), (cursor, records))
                self.assertEqual(cursor['rev'], registry_before + 1)
            else:
                self.assertEqual(frame['body'], app_reads.org_snapshot(row)['body'])
                with self.app() as raw:
                    self.assertEqual(self.revision(raw), registry_before)
            if killed:
                inner = connections[0]
                self.assertTrue(feed.stats.reconnects if app else inner.errors)
            else:
                self.assertTrue(dropped, 'control must actually lose a delivered PG notification')
            self.assertFalse(errors)
        finally:
            release.set()
            await asyncio.to_thread(feed.stop, 2)
            self.assertFalse(feed._thread.is_alive())
            await host.close()

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
