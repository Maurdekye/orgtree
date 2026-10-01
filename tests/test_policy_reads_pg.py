"""Actual-PG coherent policy snapshots, authority and history bounds."""
import json
import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='policy-reads-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=root.name, ORGTREE_V2_TOKEN='test')
import test_mail_archive_bounds_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import load_app
load_app()
from orgtree import ledger, pgstore, policy_reads, store, supervisor as sup

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PolicyReads(unittest.TestCase):
    setUpClass = classmethod(fixture.MailArchiveBounds.setUpClass.__func__)
    setUp = fixture.MailArchiveBounds.setUp
    query = fixture.MailArchiveBounds.query

    def configure(self, state='live', frozen=False):
        org = store.load_org(self.slug)
        n = org.node('worker')
        n['state'] = state
        if frozen: n['frozen'] = {'limit': True}
        org.d['watchdogs'] = [dict(id='dog', owner='worker', kind='process', state='armed',
                                  name='dog', target='pid:123', interval_s=15)]
        store.save_org(org)
        return org

    def test_selected_owner_decisions_match_full_org_and_refresh_after_retirement(self):
        self.configure(frozen=True)
        full = store.load_org(self.slug)
        got = policy_reads.watchdog_org(self.slug)
        self.assertEqual(sup._wd_owner_lost(got, got.d['watchdogs'][0]),
                         sup._wd_owner_lost(full, full.d['watchdogs'][0]))
        self.assertIsNone(sup._wd_owner_lost(got, got.d['watchdogs'][0]))
        self.configure(state='archived')
        got = policy_reads.watchdog_org(self.slug)
        self.assertEqual(sup._wd_owner_lost(got, got.d['watchdogs'][0]), ledger.Org.WATCHDOG_ARCHIVE_PAUSE)

    def test_owner_scope_revocation_is_seen_without_cached_org(self):
        org = self.configure()
        org.node('worker')['scope']['tools']['bash'] = False
        store.save_org(org)
        with patch.object(store, 'cached_org', side_effect=AssertionError('full read')):
            got = policy_reads.watchdog_org(self.slug)
        dog = dict(got.d['watchdogs'][0], kind='command')
        reason = sup._wd_owner_lost(got, dog)
        self.assertIsNotNone(reason)
        self.assertIn('no longer holds bash', reason)

    def test_storage_fields_and_unknown_node_blob_fallback(self):
        org = self.configure()
        org.d.update(kiosk={'enabled': False, 'storage_limit_mb': 3}, storage_blocked={'at': 'x'})
        store.save_org(org)
        got = policy_reads.storage_org(self.slug)
        self.assertEqual(got.d['kiosk'], org.d['kiosk'])
        self.assertEqual(got.d['storage_blocked'], org.d['storage_blocked'])
        self.assertEqual(got.nodes, {})
        with store._POOL.acquire(self.slug) as conn:
            conn.execute("INSERT INTO doc(key,val) VALUES('nodes','{}')")
        with patch.object(store, 'cached_org', return_value=org) as fallback:
            self.assertIs(policy_reads.watchdog_org(self.slug), org)
        fallback.assert_called_once_with(self.slug)

    def test_runtime_role_can_read_settings_and_owner_scope(self):
        self.configure()
        real = pgstore.PgConn.execute
        roles = []
        def runtime(conn, sql, params=()):
            if sql.startswith('WITH settings'):
                real(conn, 'SET LOCAL ROLE orgtree_runtime')
                roles.append(True)
            return real(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', runtime):
            self.assertEqual(set(policy_reads.watchdog_org(self.slug).nodes), {'worker'})
            self.assertEqual(policy_reads.storage_org(self.slug).nodes, {})
        self.assertEqual(len(roles), 2)

    def test_file_roots_lineage_sandbox_and_bound_account_match_full_org(self):
        org = self.configure()
        org.d['workspace'] = root.name
        org.node('worker')['scope']['add_dirs'] = [{'path': root.name, 'mode': 'ro'}]
        org.node('worker')['account'] = 'missing:test-lane'
        store.save_org(org)
        full = store.load_org(self.slug)
        got = policy_reads.watchdog_org(self.slug)
        with patch.object(store, 'load_org', side_effect=AssertionError('full read')), \
                patch.object(store, 'load_runtime_org', side_effect=AssertionError('full read')), \
                patch.object(sup.sbx, 'on_disk', side_effect=AssertionError('disk full read')):
            self.assertEqual(sup.wd_file_roots(got, 'worker'), sup.wd_file_roots(full, 'worker'))
            self.assertEqual(sup.scratch_dir(self.slug, 'worker@2', policy_org=got),
                             sup.scratch_dir(self.slug, 'worker', policy_org=got))
            with self.assertRaisesRegex(RuntimeError, 'bound to no account'):
                sup.spawn_env(got, bind_node='worker')
        org.d['sandbox'] = {'enabled': True}
        store.save_org(org)
        got = policy_reads.watchdog_org(self.slug)
        dog = dict(got.d['watchdogs'][0], kind='file', target=root.name)
        self.assertIn('now runs sandboxed', sup._wd_owner_lost(got, dog))

    def test_owner_and_watchdog_use_one_statement_snapshot(self):
        self.configure()
        real = pgstore.PgConn.execute
        changed = []
        def interleave(conn, sql, params=()):
            result = real(conn, sql, params)
            if sql.startswith('WITH settings') and not changed:
                changed.append(True)
                # Independent writer after SELECT executes, before fetch/decode.
                with pgstore.connect(os.environ['ORGTREE_PG_URL']) as writer:
                    writer.execute(f"UPDATE org_{conn.org_id}.nodes SET val="
                                   "jsonb_set(val::jsonb,'{state}','\"archived\"')::text WHERE id='worker'")
                    writer.execute(f"UPDATE org_{conn.org_id}.doc SET val='[]' WHERE key='watchdogs'")
            return result
        with patch.object(pgstore.PgConn, 'execute', interleave):
            got = policy_reads.watchdog_org(self.slug)
        self.assertTrue(changed)
        self.assertEqual(got.nodes['worker']['state'], 'live')
        self.assertEqual(len(got.d['watchdogs']), 1)
        self.assertEqual(policy_reads.watchdog_org(self.slug).d['watchdogs'], [])

    def test_bounded_owners_and_statement_plan_at_real_fleet_shape(self):
        org = self.configure()
        seed = org.node('worker')
        with store._POOL.acquire(self.slug) as conn:
            for i in range(1183):
                raw = dict(seed, state='live' if i < 29 else 'archived', charter='history ' * 100)
                conn.execute('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)',
                             (f'old-{i:04}', i + 100, json.dumps(raw)))
            conn.execute('ANALYZE nodes')
        real = pgstore.PgConn.execute
        plans = []
        def observed(conn, sql, params=()):
            if sql.startswith('WITH settings'):
                plans.append(real(conn, 'EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, params).fetchone()[0])
            return real(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', observed), \
                patch.object(store, 'cached_org', side_effect=AssertionError('full Org read')):
            got = policy_reads.watchdog_org(self.slug)
            storage = policy_reads.storage_org(self.slug)
        self.assertEqual(set(got.nodes), {'worker'})
        self.assertEqual(storage.nodes, {})
        self.assertEqual(len(plans), 2)
        def walk(node):
            if node.get('Relation Name') == 'nodes':
                self.assertLessEqual(node['Actual Rows'], 1)
                self.assertIn('Index', node['Node Type'])
            for child in node.get('Plans', []): walk(child)
        for plan in plans: walk(plan[0]['Plan'])

        # Read-volume evidence, not an idle latency benchmark. The old warm
        # cache reads no node SQL but still walks all nodes for the summary.
        costs = []
        def volume(label, action):
            count = dict(label=label, rows=0, value_utf8_bytes=0, statements=0,
                         summary_nodes_visited=0)
            class Cursor:
                def __init__(self, cur): self.cur = cur
                def __getattr__(self, name): return getattr(self.cur, name)
                def record(self, row):
                    if row is not None:
                        count['rows'] += 1
                        count['value_utf8_bytes'] += sum(
                            len(str(value).encode('utf-8')) for value in row if value is not None)
                    return row
                def fetchone(self): return self.record(self.cur.fetchone())
                def fetchall(self): return [self.record(row) for row in self.cur.fetchall()]
                def __iter__(self):
                    for row in self.cur: yield self.record(row)
            def measured(conn, sql, params=()):
                count['statements'] += 1
                return Cursor(real(conn, sql, params))
            summary = store._summary_row
            def summary_count(slug, doc):
                count['summary_nodes_visited'] += len(doc['nodes'])
                return summary(slug, doc)
            with patch.object(pgstore.PgConn, 'execute', measured), \
                    patch.object(store, '_summary_row', summary_count):
                action()
            costs.append(count)
        def old_tick_reads():
            # Exactly the cached_list per-org summary and ensuing loop read.
            store._summary_row(self.slug, store.cached_org(self.slug).d)
            store.cached_org(self.slug)
        for loop, reader in [('watchdog', policy_reads.watchdog_org),
                             ('storage', policy_reads.storage_org)]:
            with store._doc_cache_lock: store._doc_cache.pop(self.slug, None)
            volume(loop + '-old-cold', old_tick_reads)
            volume(loop + '-old-warm', old_tick_reads)
            volume(loop + '-new', lambda: reader(self.slug))
        for row in costs:
            if row['label'].endswith('-new'):
                self.assertLess(row['rows'], 20)
                self.assertEqual(row['summary_nodes_visited'], 0)
            else:
                self.assertEqual(row['summary_nodes_visited'], 1184)
        output = os.environ.get('POLICY_READ_COST_OUTPUT')
        if output:
            Path(output).write_text(json.dumps(dict(live=30, archived=1154,
                metric='PgConn returned rows and UTF-8 scalar value bytes; excludes wire overhead, catalog and directory listing',
                costs=costs), indent=2), encoding='utf-8')


if __name__ == '__main__': unittest.main()
