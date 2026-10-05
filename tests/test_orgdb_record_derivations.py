"""Schema completeness and record capture boundary controls; no database."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from dataclasses import replace
from pathlib import Path
import re
import unittest

from orgtree.orgdb import record_derivations as D
from orgtree.orgdb import record_registry as R
from orgtree.orgdb import record_sql as S

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / 'engine/backend/orgtree/pg_migrations/org'


class Declarations(unittest.TestCase):
    def test_product_migration_is_exactly_the_declared_generator(self):
        self.assertEqual((MIGRATIONS/'0018_records.sql').read_text(encoding='utf-8'),S.migration_sql())

    def test_every_current_schema_table_is_accounted_for_and_missing_source_is_caught(self):
        texts = {p.name: p.read_text(encoding='utf-8') for p in MIGRATIONS.glob('*.sql')}
        self.assertEqual(D.completeness(texts), [])
        broken = dict(D.SOURCES)
        del broken['agents']
        self.assertEqual(D.completeness(texts, broken),
                         ['agents: missing record derivation or exclusion reason'])
        texts['9999_new.sql'] = 'CREATE TABLE orgtree.new_panel(id bigint);'
        self.assertEqual(D.completeness(texts),
                         ['new_panel: missing record derivation or exclusion reason'])

    def test_agent_dependencies_include_both_graph_sides_and_every_derived_header(self):
        names = D.SOURCES['agents'].names
        ids = {n.id for n in names}
        for column in ('id', 'parent_id', 'predecessor_id', 'successor_id'):
            self.assertIn(f'r.{column}::text', ids)
        for kind in ('pile:', 'chain:', 'lineage:', 'references:'):
            self.assertTrue(any(kind in n.id for n in names), kind)
        for header in ('cost', 'audit', 'foreground', 'org_inbox'):
            self.assertIn(D.Name("'org'", repr(header)), names)

    def test_dropped_docket_tables_are_not_installed_and_stale_capture_is_caught(self):
        texts = {p.name: p.read_text(encoding='utf-8') for p in MIGRATIONS.glob('*.sql')}
        for table in ('work_item_history','work_item_scope','work_item_evidence','work_item_dismissals'):
            self.assertNotIn(table,D.tables(texts))
            self.assertNotIn(table,D.SOURCES)
        stale = dict(D.SOURCES,work_item_history=D.Source(D.group('work_summary')))
        self.assertEqual(D.completeness(texts,stale),
                         ['work_item_history: capture declared for a missing or dropped table'])

    def test_capture_only_reads_transition_tables_and_uses_old_and_new(self):
        for table, source in D.SOURCES.items():
            if source.excluded:
                self.assertTrue(source.excluded.strip())
                continue
            with self.subTest(table=table):
                sql = D.capture_function(table, source)
                self.assertEqual(set(re.findall(r'\bFROM (\w+)', sql)),
                                 {'old_rows', 'new_rows'})
                self.assertNotRegex(sql, r'\b(?:JOIN|FROM) orgtree\.')
                self.assertNotIn('orgtree.org_revision', sql)
                self.assertIn('pg_current_xact_id()', sql)
                self.assertEqual(sql.count('ON CONFLICT DO NOTHING'), 3)
                update = sql.split("TG_OP = 'UPDATE' THEN")[1].split('ELSIF')[0]
                self.assertIn('FROM old_rows r', update)
                self.assertIn('FROM new_rows r', update)

    def test_settings_wildcard_and_named_children_are_declared(self):
        self.assertIn(D.Name("'agent'", "'*'"), D.SOURCES['org_settings'].names)
        self.assertIn(D.named('node'), D.SOURCES['documents'].names)
        self.assertIn(D.named('grantee'), D.SOURCES['audience_grants'].names)
        self.assertIn(D.scope('ask', 'r.asks_id'), D.SOURCES['ask_options'].names)

    def test_g_turn_children_capture_both_owner_keys_without_statement_reads(self):
        for table in ('agent_turn_cost_unknown_fields','agent_turn_model_usage_keys'):
            source = D.SOURCES[table]
            self.assertEqual(source.names, (D.scope('turn','r.turn_id'),))
            sql = D.capture_function(table,source)
            self.assertEqual(D.capture_violations(sql),[])
            update = sql.split("TG_OP = 'UPDATE' THEN")[1].split('ELSIF')[0]
            for relation in ('old_rows','new_rows'):
                self.assertIn(f'FROM {relation} r',update)
            self.assertIn('r.turn_id',update)
        self.assertNotIn('agent_recent_turns',D.SOURCES)
        for kind in ('agent', '~scope'):
            self.assertIn(kind,S.RESOLVE.split("LIKE 'turn:%' THEN")[1].split('ELSIF')[0])
        for scope in ('detail:', 'lineage:'):
            self.assertIn(scope,S.RESOLVE.split("LIKE 'turn:%' THEN")[1].split('ELSIF')[0])

    def test_g_docket_sources_and_o1_derived_stats_are_explicit(self):
        texts = {p.name: p.read_text(encoding='utf-8') for p in MIGRATIONS.glob('*.sql')}
        for table in ('work_item_review_seats','work_item_artifact_grants','work_item_delivery',
                      'agent_turn_cost_unknown_fields','agent_turn_model_usage_keys'):
            broken = dict(D.SOURCES)
            del broken[table]
            self.assertEqual(D.completeness(texts,broken),
                [f'{table}: missing record derivation or exclusion reason'])
        for table in ('work_item_review_seats','work_item_artifact_grants','work_item_delivery'):
            self.assertEqual(D.SOURCES[table].names,D.group('work_summary'))
        self.assertTrue(D.SOURCES['agent_subtree_stats'].excluded)
        self.assertNotIn('record_capture_agent_subtree_stats',S.migration_sql())

    def test_changed_field_guards_pair_only_transition_rows_and_preserve_both_sides(self):
        source = D.Source((D.scope('subtree','r.id',changed=('parent_id','extra')),))
        sql = D.capture_function('agents',source)
        self.assertEqual(D.capture_violations(sql),[])
        update = sql.split("TG_OP = 'UPDATE' THEN")[1].split('ELSIF')[0]
        for other in ('old_rows','new_rows'):
            self.assertIn(f'FROM {other} p WHERE p.id=r.id',update)
        self.assertIn("to_json(ROW(r.parent_id,r.extra))::text",update)
        self.assertIn("to_json(ROW(p.parent_id,p.extra))::text",update)
        self.assertNotIn('to_jsonb',sql)
        with self.assertRaises(ValueError):
            D.capture_function('documents',source)
        with self.assertRaises(ValueError):
            D.capture_function('agents',D.Source((D.scope('subtree','r.id',changed=('id;select',)),)))

    def test_a_source_cannot_silently_be_both_mapped_and_excluded(self):
        with self.assertRaises(ValueError):
            D.Source()
        with self.assertRaises(ValueError):
            D.Source((D.agent(),), 'excluded')

    def test_statement_time_read_lock_and_cross_transaction_faults_are_caught(self):
        sql = D.capture_sql()
        self.assertEqual(D.capture_violations(sql), [])
        broken = sql.replace('FROM new_rows r', 'FROM orgtree.agents r', 1)
        self.assertTrue(any('statement capture reads orgtree.agents' in v
                            for v in D.capture_violations(broken)))
        broken = sql.replace('FROM new_rows r WHERE', 'FROM new_rows r FOR UPDATE; SELECT 1 WHERE', 1)
        self.assertTrue(any('takes a row lock' in v for v in D.capture_violations(broken)))
        first = D.capture_function('agents', D.SOURCES['agents'])
        broken = first.replace('pg_current_xact_id()', "'42'::xid8")
        self.assertTrue(any('no own transaction key' in v for v in D.capture_violations(broken)))


class RevisionDoor(unittest.TestCase):
    def test_o1_final_cycle_kernel_follows_the_singleton_and_precedes_publication(self):
        flush = S.FLUSH.split('CREATE FUNCTION orgtree.record_defer')[0]
        self.assertEqual(flush.count('PERFORM orgtree.graph_assert_final_cycles();'),2)
        first = flush.index('PERFORM orgtree.graph_assert_final_cycles();')
        self.assertLess(flush.index('UPDATE orgtree.org_revision'),first)
        self.assertLess(first,flush.index('PERFORM orgtree.resolve_scopes();'))
        self.assertLess(first,flush.index('INSERT INTO orgtree.revisions'))
        self.assertLess(first,flush.index('PERFORM pg_notify'))
        self.assertEqual(flush.count("IF current_setting('orgtree.graph_pending',true)='1' THEN"),2)

    def test_capture_and_resolution_are_separated_by_the_revision_lock(self):
        sql = S.migration_sql()
        self.assertEqual(D.capture_violations(sql), [])
        flush = S.FLUSH.split('CREATE FUNCTION orgtree.record_defer')[0]
        self.assertLess(flush.index('UPDATE orgtree.org_revision'), flush.index('PERFORM orgtree.resolve_scopes'))
        self.assertLess(flush.index('PERFORM orgtree.resolve_scopes'), flush.index('INSERT INTO orgtree.revisions'))
        self.assertIn('AFTER INSERT ON orgtree.changes', flush)
        self.assertIn('DEFERRABLE INITIALLY DEFERRED', flush)
        self.assertIn('WHERE xid=pg_current_xact_id()', S.RESOLVE)
        self.assertIn('greatest(floor,rev+1)', S.FLUSH)

    def test_window_resolvers_are_generated_from_the_same_rank_declaration(self):
        window = D.Window('latest', 1, (D.Stream('documents', 'r.node', 'r.id::text', ('r.ord', 'r.id')),))
        sql = S.migration_sql(windows=(window,))
        self.assertIn("LIKE 'window:latest:%'", sql)
        self.assertIn('LIMIT 1 + named_count', sql)
        self.assertIn("'latest:' || (r.node)::text", sql)
        self.assertEqual(D.capture_violations(sql), [])


class WindowDeclarations(unittest.TestCase):
    def window(self):
        return D.Window('agent_history', 25, (
            D.Stream('notice_log', 'r.node', "'notice:' || r.id::text", ('r.ord', 'r.id')),
            D.Stream('events', 'r.ord', "'event:' || r.id::text", ('r.ord', 'r.id'))))

    def test_union_window_names_entries_and_scopes_in_the_one_map(self):
        window = self.window()
        extended = D.with_windows(D.SOURCES, (window,))
        for stream in window.streams:
            names = extended[stream.table].names
            self.assertIn(D.Name(f"'agent_history:' || ({stream.partition})::text", stream.id), names)
            self.assertIn(D.scope('window:agent_history', stream.partition), names)
            sql = D.capture_function(stream.table, extended[stream.table])
            self.assertNotIn(f'FROM orgtree.{stream.table}', sql)
            self.assertIn('pending_scopes', sql)
        self.assertTrue(D.SOURCES['notice_log'].excluded)  # input remains unchanged

    def test_resolver_reads_after_capture_with_bounded_union_and_correct_both_sides(self):
        sql = D.window_resolution(self.window())
        self.assertIn('FROM orgtree.notice_log', sql)
        self.assertIn('FROM orgtree.events', sql)
        self.assertEqual(sql.count('LIMIT 25 + named_count'), 2)
        self.assertIn('greatest(1,25-named_count+1) AND 25+named_count', sql)
        self.assertIn('ON CONFLICT DO NOTHING', sql)

    def test_invalid_or_duplicate_windows_are_rejected(self):
        with self.assertRaises(ValueError):
            replace(self.window(), size=0)
        with self.assertRaises(ValueError):
            D.with_windows(D.SOURCES, (self.window(), self.window()))
        with self.assertRaises(ValueError):
            D.with_windows(D.SOURCES, (D.Window('x', 1, (D.Stream('missing', 'r.id', 'r.id', ('r.id',)),)),))


class SnapshotInterface(unittest.TestCase):
    def test_extension_selection_and_batch_builder_keep_the_exact_snapshot(self):
        seen = []
        raw = object()
        snapshot = R.Snapshot(raw, 'test', {'rev': 8}, 123.0)
        registry = R.Registry()
        def members(context, selection):
            seen.append((context, selection.set))
            return frozenset(selection.agents)
        def bodies(context, ids):
            seen.append((context, ids))
            return {key: {'id': key} for key in ids}
        registry.register(R.Entity('agent', members, bodies))
        selected = registry.select(snapshot, R.Selection('sub:4', ('2', '8')))
        self.assertEqual(selected, {'agent': frozenset(('2', '8'))})
        self.assertEqual(registry.bodies(snapshot, 'agent', selected['agent']),
                         {'2': {'id': '2'}, '8': {'id': '8'}})
        self.assertTrue(all(context is snapshot and context.raw is raw for context, _ in seen))
        with self.assertRaises(ValueError):
            registry.register(R.Entity('agent', members, bodies))

    def test_window_partitions_union_and_unknown_kinds_refuse(self):
        registry = R.Registry()
        registry.register_window(R.WindowKind('history', lambda args: args,
            lambda context, args: 'history:4',
            lambda context, args: frozenset((args['id'],)),
            lambda context, ids: dict.fromkeys(ids, 'body')))
        context = R.Snapshot(object(), 'org', {}, 0)
        selection = R.Selection('sub:9', windows=({'kind': 'history', 'id': '1'},
                                                {'kind': 'history', 'id': '2'}))
        self.assertEqual(registry.select(context, selection), {'history:4': frozenset(('1', '2'))})
        self.assertEqual(registry.bodies(context, 'history:4', frozenset(('1',))), {'1': 'body'})
        with self.assertRaises(ValueError):
            registry.select(context, R.Selection(windows=({'kind': 'unknown'},)))


if __name__ == '__main__':
    unittest.main()
