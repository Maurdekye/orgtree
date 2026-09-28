"""The completed startup heal must not load or lock historical node rows."""
import json
import threading
import unittest
from unittest.mock import patch

import test_mail_archive_bounds_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, pgstore, settingstx, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class StartupHealGuard(unittest.TestCase):
    setUpClass = classmethod(fixture.MailArchiveBounds.setUpClass.__func__)
    setUp = fixture.MailArchiveBounds.setUp
    query = fixture.MailArchiveBounds.query

    def legacy(self):
        return settingstx.whole_org_tx(self.slug, lambda tx: tx.org.heal_plan_stamps(),
            sections=settingstx.HEAL_SECTIONS, logs=settingstx.SETTINGS_LOGS)

    def prepare(self):
        org = store.load_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'old')
        org.nodes['old']['state'] = 'archived'
        for node in org.nodes.values():
            node['scope']['permission_mode'] = 'plan'
        org.d['permission_mode'] = 'plan'
        org.d.setdefault('_migrations', {}).pop('pm_plan_stamp_heal', None)
        store.save_org(org)

    def test_missing_marker_heals_live_and_archive_once_preserves_later_plan(self):
        self.prepare()
        self.assertEqual(sorted(settingstx.heal_plan_stamps(self.slug)),
                         ['<org default>', 'old', 'worker'])
        org = store.load_org(self.slug)
        self.assertEqual(org.nodes['old']['scope']['permission_mode'], 'acceptEdits')
        org.nodes['worker']['scope']['permission_mode'] = 'plan'  # deliberate later setting
        store.save_org(org)
        self.assertIsNone(settingstx.heal_plan_stamps(self.slug))
        self.assertEqual(store.load_org(self.slug).nodes['worker']['scope']['permission_mode'], 'plan')

    def test_completed_marker_reads_constant_rows_without_org_or_node_locks(self):
        self.legacy()
        original = pgstore.PgConn.execute
        measurements = []
        for count in (20, 200):
            self.query("INSERT INTO nodes(id,ord,val) SELECT 'history-'||x,1000+x,? FROM generate_series(1,?) x "
                       'ON CONFLICT(id) DO NOTHING', ('{"state":"archived"}', count))
            rows = []
            def measured(conn, sql, params=()):
                result = original(conn, sql, params)
                rows.append((sql, len(result._rows), sum(len(str(v).encode()) for r in result._rows for v in r)))
                return result
            with patch.object(pgstore.PgConn, 'execute', measured), \
                 patch.object(settingstx, 'whole_org_tx', side_effect=AssertionError('all-node locks')), \
                 patch.object(store, '_load_lazy', side_effect=AssertionError('full Org load')):
                self.assertIsNone(settingstx.heal_plan_stamps(self.slug))
            self.assertFalse(any('FROM nodes' in sql or 'FOR UPDATE' in sql for sql, _, _ in rows))
            self.assertTrue(any("key='_migrations'" in sql for sql, _, _ in rows))
            measurements.append([(sql, n, b) for sql, n, b in rows])
        self.assertEqual(measurements[0], measurements[1])

    def test_incompatible_markers_keep_exact_legacy_result_or_error(self):
        original = settingstx.whole_org_tx
        for value in (None, False, [], 'bad', {'pm_plan_stamp_heal': None},
                      {'pm_plan_stamp_heal': {}}, {'pm_plan_stamp_heal': {'at': 2, 'healed': []}},
                      {'pm_plan_stamp_heal': {'at': 'then', 'healed': 'bad'}}):
            with self.subTest(value=value):
                self.query("INSERT INTO doc(key,val) VALUES('_migrations',?) "
                           'ON CONFLICT(key) DO UPDATE SET val=excluded.val', (json.dumps(value),))
                def outcome(fn):
                    try: return ('result', fn())
                    except Exception as error: return ('error', type(error).__name__)
                expected = outcome(self.legacy)
                with patch.object(settingstx, 'whole_org_tx', wraps=original) as fallback:
                    self.assertEqual(outcome(lambda: settingstx.heal_plan_stamps(self.slug)), expected)
                    self.assertEqual(fallback.call_count, 1)

    def test_legacy_blob_and_non_pg_keep_original_transaction(self):
        self.legacy()
        with patch.object(settingstx, 'whole_org_tx', return_value=['fallback']) as fallback:
            with patch.object(store, 'STORE_BACKEND', 'json'):
                self.assertEqual(settingstx.heal_plan_stamps(self.slug), ['fallback'])
            with patch.object(store.os.path, 'exists', return_value=False):
                self.assertEqual(settingstx.heal_plan_stamps(self.slug), ['fallback'])
            self.query("INSERT INTO doc(key,val) VALUES('nodes','{}')")
            self.assertEqual(settingstx.heal_plan_stamps(self.slug), ['fallback'])
            self.assertEqual(fallback.call_count, 3)

    def test_two_absent_reads_recheck_inside_transaction(self):
        self.prepare()
        barrier = threading.Barrier(2)
        original = settingstx._plan_stamp_heal_completed
        outcomes = []
        def absent(slug):
            result = original(slug)
            self.assertFalse(result)
            barrier.wait(timeout=10)
            return result
        def run():
            try: outcomes.append(settingstx.heal_plan_stamps(self.slug))
            except BaseException as error: outcomes.append(error)
        with patch.object(settingstx, '_plan_stamp_heal_completed', absent):
            threads = [threading.Thread(target=run) for _ in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(15)
            self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(outcomes.count(None), 1, outcomes)
        self.assertEqual(sorted(next(o for o in outcomes if o is not None)),
                         ['<org default>', 'old', 'worker'])

    def test_save_failure_rolls_back_heal_and_marker_together(self):
        self.prepare()
        before = {table: self.query('SELECT * FROM '+table+' ORDER BY 1')
                  for table in ('nodes','doc','log_l')}
        original = store._write_doc
        entered = []
        def fail_after_save(*args, **kwargs):
            original(*args, **kwargs)
            entered.append(True)
            raise RuntimeError('after save before commit')
        with patch.object(store, '_write_doc', fail_after_save):
            with self.assertRaisesRegex(RuntimeError, 'after save before commit'):
                settingstx.heal_plan_stamps(self.slug)
        self.assertEqual(entered, [True])
        self.assertFalse(settingstx._plan_stamp_heal_completed(self.slug))
        for table, rows in before.items():
            self.assertEqual(self.query('SELECT * FROM '+table+' ORDER BY 1'), rows, table)
        self.assertEqual(sorted(settingstx.heal_plan_stamps(self.slug)),
                         ['<org default>', 'old', 'worker'])


if __name__ == '__main__':
    unittest.main()
