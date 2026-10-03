"""Native small readers and exact selected-row decoding on disposable PG."""
import copy
import json
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_orgdb_compat_pg as fixture
from orgtree import (desktop_notifications as notices, policy_candidates as candidates,
                     policy_context, policy_reads, settingstx, store, supervisor, tree_ui)
from orgtree.ledger import USER
from orgtree.orgdb import reader_rows, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class SmallReaders(unittest.TestCase):
    def setUp(self):
        switch = fixture.storage(True)
        switch.__enter__()
        self.addCleanup(switch.__exit__, None, None, None)
        self.slug = 'small-' + self._testMethodName.removeprefix('test_').replace('_', '-')
        self.org = store.create_org(self.slug)
        self.org.d['nodes']['dev'] = fixture.node('dev', None)
        store.save_org(self.org)
        self.org = store.load_org(self.slug)
        notices._cache.clear()

    def read(self, body):
        with registry.connection(self.slug) as raw:
            with raw.transaction():
                raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                return body(raw)

    def save(self):
        store.save_org(self.org)

    def test_selected_agent_decoder_preserves_refs_misfits_and_recent_turn_limit(self):
        self.org.node('dev')['parent'] = 'missing-parent'
        self.org.node('dev')['predecessor'] = 'missing-previous'
        self.org.node('dev')['future_scalar'] = [None, {'x': 1}]
        self.org.node('dev')['turns'] = [{'n': i, 'at': fixture.AT} for i in range(12)]
        self.org.d['nodes']['other'] = fixture.node('other', None)
        self.save()
        expected = copy.deepcopy(self.org.node('dev'))
        full = self.read(lambda raw: reader_rows.read_agents(raw, ['dev', 'missing-parent']))
        self.assertEqual(list(full), ['dev'])
        self.assertEqual(full['dev'], expected)
        tail = self.read(lambda raw: reader_rows.read_agents(raw, ['dev'], recent_turns_limit=8))
        self.assertEqual(tail['dev']['turns'], expected['turns'][-8:])
        empty = self.read(lambda raw: reader_rows.read_agents(raw, ['dev'], recent_turns_limit=0))
        self.assertEqual(empty['dev']['turns'], [])
        self.assertEqual(self.read(lambda raw: reader_rows.read_agents(raw, [], recent_turns_limit=0)), {})

    def test_sections_preserve_scalar_null_custom_and_selected_owner_shapes(self):
        self.org.d['default_effort'] = None
        self.org.d['custom_identity'] = {'zero': 0, 'flag': False}
        self.org.d['audiences'] = [{'grantee': 'dev', 'grantor': USER, 'reason': 'kept'}]
        self.org.d['nodes']['other'] = fixture.node('other', None)
        self.org.d['mail'] = {'dev': [{'id': 'wanted', 'body': 'dev'}],
                              'other': [{'id': 'other', 'body': 'unrelated'}]}
        self.org.d['delivering'] = {'dev': []}
        self.save()
        keys = ('default_effort', 'custom_identity', 'audiences', 'mail', 'delivering', 'missing')
        got = self.read(lambda raw: reader_rows.read_sections(raw, keys, owners=['dev']))
        self.assertEqual(got['default_effort'], None)
        self.assertEqual(got['custom_identity'], self.org.d['custom_identity'])
        self.assertEqual(got['audiences'], self.org.d['audiences'])
        self.assertEqual(got['mail'], {'dev': self.org.d['mail']['dev']})
        self.assertEqual(got['delivering'], {'dev': []})
        self.assertNotIn('missing', got)

    def test_record_window_decodes_only_selected_ids_in_requested_order(self):
        self.org.d['documents'] = [dict(id='one', node='dev', title='first', body='A'),
                                   dict(id='two', node='dev', title='second', body='B')]
        self.save()
        ids = self.read(lambda raw: [row[0] for row in raw.execute(
            'SELECT id FROM orgtree.documents ORDER BY ord').fetchall()])
        got = self.read(lambda raw: reader_rows.read_records(raw, 'documents', ids[::-1]))
        self.assertEqual(got, self.org.d['documents'][::-1])
        self.assertEqual(self.read(lambda raw: reader_rows.read_records(raw, 'documents', [])), [])

    def test_policy_graph_exact_candidates_closure_and_no_unrelated_retired_body(self):
        self.org.d['nodes']['parent'] = dict(fixture.node('parent', None), state='archived')
        self.org.d['nodes']['previous'] = dict(fixture.node('previous', None), state='archived')
        self.org.d['nodes']['frozen'] = dict(fixture.node('frozen', None), state='archived', frozen=[1])
        self.org.d['nodes']['unused'] = dict(fixture.node('unused', None), state='archived')
        self.org.node('dev').update(parent='parent', predecessor='previous')
        self.save()
        graph = candidates.read(self.slug)
        self.assertEqual(set(graph.candidates), {'dev', 'frozen'})
        self.assertEqual(set(graph.nodes), {'dev', 'frozen', 'parent', 'previous'})
        self.assertEqual(graph.nodes['dev']['parent'], 'parent')
        self.assertFalse(graph.private)
        self.org.node('parent')['parent'] = 'dev'
        self.save()
        self.assertEqual(set(candidates.read(self.slug).nodes), set(graph.nodes))

    def test_policy_graph_and_settings_share_read_only_repeatable_snapshot(self):
        self.org.d['killswitch'] = False
        self.save()

        def project(conn, graph):
            # Commit a different process's write after this graph's snapshot.
            with registry.connection(self.slug) as writer:
                writer.execute("UPDATE orgtree.agents SET state='archived' WHERE name='dev'")
                writer.execute("UPDATE orgtree.org_settings SET killswitch='true'::json")
            self.assertEqual(graph.nodes['dev']['state'], 'live')
            self.assertFalse(candidates.settings(conn)['killswitch'])
            self.assertEqual(conn.raw.execute('SHOW transaction_read_only').fetchone()[0], 'on')
            self.assertEqual(conn.raw.execute('SHOW transaction_isolation').fetchone()[0], 'repeatable read')
            return graph

        self.assertEqual(candidates.read(self.slug, project).candidates, ('dev',))
        self.assertEqual(candidates.read(self.slug).candidates, ())

    def test_policy_graph_plan_does_not_scan_large_retired_backlog(self):
        with registry.connection(self.slug) as raw:
            raw.execute("INSERT INTO orgtree.agents(name,ord,state,tombstone) "
                        "SELECT 'old-'||i,i+100,'archived',false FROM generate_series(1,2000) i")
        identity = registry.lookup(self.slug)
        with fixture.dbconn.connect(fixture.ADMIN, identity[1]) as raw:
            raw.execute('ANALYZE orgtree.agents')
        plan = self.read(lambda raw: raw.execute('EXPLAIN (ANALYZE, FORMAT JSON) '
                                                 + candidates.NATIVE_GRAPH).fetchone()[0])
        seen = []

        def walk(node):
            if node.get('Relation Name') == 'agents':
                seen.append(node)
                self.assertIn('Index', node['Node Type'], json.dumps(plan))
                self.assertLessEqual(node['Actual Rows'], 1, json.dumps(plan))
                self.assertEqual(node.get('Rows Removed by Filter', 0), 0, json.dumps(plan))
            for child in node.get('Plans', []):
                walk(child)

        walk(plan[0]['Plan'])
        self.assertTrue(seen)
        self.assertEqual(candidates.read(self.slug).candidates, ('dev',))

    def test_policy_context_reads_settings_audiences_and_only_selected_mail(self):
        self.org.d['nodes']['old'] = dict(fixture.node('old', None), state='archived')
        self.org.d['audiences'] = [{'grantee': 'dev', 'grantor': USER}]
        self.org.d['mail'] = {'dev': [dict(id='mail', body='hello')],
                              'old': [dict(id='cold', body='history')]}
        self.save()
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole-org fallback')):
            projected = policy_context.read(self.slug)
        self.assertIsInstance(projected, policy_context.PolicyContext)
        self.assertEqual(set(projected.nodes), {'dev'})
        self.assertEqual(projected.d['audiences'], self.org.d['audiences'])
        self.assertEqual(projected.d['mail'], {'dev': self.org.d['mail']['dev']})
        self.assertEqual(projected.model_for('dev'), self.org.model_for('dev'))

    def test_policy_docket_uses_agreed_snapshot_callable_in_same_transaction(self):
        observed = []
        summary = fixture.item('policy-task', 'Policy task')

        class Snapshot:
            def __init__(self, raw, org_id, *, viewer, now_ts):
                observed.append((viewer, org_id, raw.execute('SHOW transaction_read_only').fetchone()[0]))

            def foreground(self, *, include_backlogged):
                self.include_backlogged = include_backlogged
                return [SimpleNamespace(summary=summary, questions=[], physical_archive=False)]

        with patch.dict(sys.modules, {'orgtree.orgdb.docket': SimpleNamespace(Snapshot=Snapshot)}), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole-org fallback')):
            got = policy_context.read(self.slug, docket=True)
        self.assertEqual(got._work_rows, [summary])
        self.assertEqual(observed, [(USER, registry.lookup(self.slug)[0], 'on')])

    def test_watchdog_owner_scope_and_retirement_refresh_without_other_agents(self):
        self.org.d['watchdogs'] = [dict(id='dog', owner='dev', name='dog', kind='command',
                                      target='echo check', interval_s=15, state='armed')]
        self.org.d['nodes']['unrelated'] = dict(fixture.node('unrelated', None), state='archived')
        self.org.node('dev')['scope']['tools'] = {'bash': False, 'mcp': []}
        self.save()
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole-org fallback')):
            got = policy_reads.watchdog_org(self.slug)
        self.assertEqual(set(got.nodes), {'dev'})
        self.assertIn('no longer holds bash', supervisor._wd_owner_lost(got, got.d['watchdogs'][0]))
        self.org.node('dev')['state'] = 'archived'
        self.save()
        got = policy_reads.watchdog_org(self.slug)
        self.assertEqual(got.nodes['dev']['state'], 'archived')
        self.assertIsNotNone(supervisor._wd_owner_lost(got, got.d['watchdogs'][0]))

    def test_completed_stamp_skips_whole_org_heal_invalid_stamp_keeps_it(self):
        self.org.d['_migrations']['pm_plan_stamp_heal'] = {'at': 'not-an-iso-time', 'healed': []}
        self.save()
        with patch.object(settingstx, 'whole_org_tx', side_effect=AssertionError('completed heal')):
            self.assertIsNone(settingstx.heal_plan_stamps(self.slug))
        self.org.d['_migrations']['pm_plan_stamp_heal'] = {'at': 1, 'healed': []}
        self.save()
        self.assertFalse(settingstx._plan_stamp_heal_completed(self.slug))
        with patch.object(settingstx, 'whole_org_tx', return_value=['locked']) as locked:
            self.assertEqual(settingstx.heal_plan_stamps(self.slug), ['locked'])
        locked.assert_called_once()

    def test_notification_native_probe_and_frozen_reader_avoid_legacy_pool(self):
        self.org.node('dev')['frozen'] = {'at': fixture.AT, 'limit': True}
        self.save()
        with patch.object(fixture.pgstore.PgConn, 'execute', side_effect=AssertionError('legacy pool')):
            stamp = notices._probe(self.slug)
            found = notices._frozen_direct(self.slug, self.org.d.get('created'))
        self.assertEqual(stamp[0], tree_ui._committed(self.slug)[1])
        self.assertEqual([(row['kind'], row['agent']) for row in found], [('agent-frozen', 'dev')])

    def test_notification_cache_warm_poll_does_not_reload_whole_org(self):
        self.org.node('dev')['frozen'] = {'at': fixture.AT, 'limit': True}
        self.save()
        with patch.object(notices, '_CACHE_ON', True), patch.object(notices, '_RUNTIME_VIEWS', True):
            first = notices._all_rows()
            with patch.object(store, 'load_runtime_org', side_effect=AssertionError('warm full read')):
                second = notices._all_rows()
        self.assertEqual(first, second)
        self.assertTrue(any(row['org'] == self.slug for row in second))

    def test_tree_revision_uses_native_registry_connection_and_committed_counter(self):
        with patch.object(store, '_bounded_read', side_effect=AssertionError('legacy reader')):
            before = tree_ui._committed(self.slug)
            self.org.node('dev')['title'] = 'Changed'
            self.save()
            after = tree_ui._committed(self.slug)
        self.assertEqual(before[0], registry.lookup(self.slug)[0])
        self.assertEqual(after, (before[0], before[1] + 1))


if __name__ == '__main__':
    unittest.main()
