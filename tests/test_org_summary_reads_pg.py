"""Actual-PG listing snapshot, funding, privacy and compatibility contracts."""
import json
import os
import unittest
from unittest.mock import patch

import test_org_summary_behavior_pg as behavior
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, org_listing, org_summary, pgstore, store

tearDownModule = behavior.tearDownModule


@unittest.skipUnless(behavior.fixture.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class SummaryReads(unittest.TestCase):
    setUpClass = behavior.SummaryBehavior.__dict__['setUpClass']
    setUp = behavior.SummaryBehavior.setUp
    query = behavior.SummaryBehavior.query
    setting = behavior.SummaryBehavior.setting
    seed = behavior.SummaryBehavior.seed
    row = behavior.SummaryBehavior.row

    def test_public_network_identity_shapes_preserve_legacy_parity(self):
        try:
            for identity in ('broken', 42, ['wrong'], True, '', 0, [], False, None, {}):
                with self.subTest(identity=identity):
                    self.setting('net_identity', identity)
                    if identity:
                        with patch.object(org_listing, '_native', return_value=False):
                            with self.assertRaises(AttributeError): self.row(public=True)
                        with self.assertRaises(AttributeError): self.row(public=True)
                    else:
                        with patch.object(org_listing, '_native', return_value=False):
                            expected = self.row(public=True)
                        self.assertEqual(self.row(public=True), expected)
        finally:
            self.setting('net_identity', None)

    def test_missing_org_and_disappeared_marker_are_omitted(self):
        self.assertEqual(org_summary.public_rows('no-such-summary-org'), [])
        marker = store._db_path(self.slug)
        saved = marker + '.held'
        os.replace(marker, saved)
        try:
            self.assertEqual(org_summary.public_rows(self.slug), [])
            self.assertFalse(any(row['slug'] == self.slug for row, _ in org_summary.admin_rows()))
        finally:
            os.replace(saved, marker)

    def test_supported_admin_and_public_outputs_match_legacy_except_approved_rounding(self):
        self.seed()
        with patch.object(org_listing, '_native', return_value=False):
            old_admin, old_public = self.row(), self.row(public=True)
        decimal_total = self.query('SELECT cost FROM foreground_meta WHERE singleton=1')[0][0]
        old_admin['cost_usd_total'] = round(float(decimal_total) + 1.25, 4)
        with patch.object(store, 'list_orgs', side_effect=AssertionError('full listing')), \
                patch.object(store, 'list_orgs_with_docs', side_effect=AssertionError('full docs')), \
                patch.object(store, '_load_lazy', side_effect=AssertionError('whole nodes')):
            self.assertEqual(self.row(), old_admin)
            self.assertEqual(self.row(public=True), old_public)
            self.assertEqual([r['slug'] for r in org_summary.public_rows(self.slug)], [self.slug])

    def test_native_updates_retirement_and_rehire_refresh_counts_and_holds(self):
        self.seed()
        for state, live in [('archived', 0), ('live', 1)]:
            node = store.load_org(self.slug).node('worker')
            node.update(state=state, grant=9, cost_usd=3.123456)
            self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'worker'))
            full = store.load_org(self.slug)
            actual = self.row()
            self.assertEqual(actual['nodes'], 3)
            self.assertEqual(actual['live'], live)
            self.assertEqual(actual['kiosk_cfg']['held'], full.audit()['top_level_holds'])
            self.assertEqual(actual['cost_usd_total'], full.cost_total())

    def test_metadata_funding_and_cost_share_one_committed_snapshot(self):
        import psycopg
        self.seed()
        old = self.row()
        execute = psycopg.Connection.execute
        switched = []
        with store._POOL.acquire(self.slug) as conn:
            schema = 'org_' + str(conn.org_id)
        def concurrent(conn, sql, params=None, **kw):
            cursor = execute(conn, sql, params, **kw)
            if 'FROM public.orgs o CROSS JOIN foreground_meta f' in str(sql) and not switched:
                switched.append(True)
                with pgstore.connect(os.environ['ORGTREE_PG_URL']) as other:
                    other.execute(f"UPDATE {schema}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"archived\"')::text WHERE id='worker'")
                    other.execute(f"UPDATE {schema}.doc SET val=%s WHERE key='name'", (json.dumps('Changed'),))
                    other.execute(f"UPDATE {schema}.doc SET val='100' WHERE key='deleted_cost_usd'")
            return cursor
        with patch.object(psycopg.Connection, 'execute', concurrent):
            # One org read, so unrelated fixtures cannot trigger the writer.
            row, ctx = org_summary._read(self.slug, False)
        self.assertEqual(len(switched), 1)
        self.assertEqual((row['name'], row['live'], ctx.cost_total(), org_summary.top_level_holds(ctx)),
                         (old['name'], old['live'], old['cost_usd_total'], old['kiosk_cfg']['held']))
        current = self.row()
        self.assertEqual((current['name'], current['live']), ('Changed', 0))
        self.assertGreater(current['cost_usd_total'], old['cost_usd_total'])

    def test_projection_is_not_persistable_and_storage_cache_keeps_its_contract(self):
        self.seed()
        _, ctx = org_summary._read(self.slug, False)
        with self.assertRaises(TypeError): store.save_org(ctx)
        full = store.load_org(self.slug)
        for key in ('slug', 'workspace', 'sandbox', 'disk', 'kiosk'):
            self.assertEqual(ctx.d.get(key), full.d.get(key))
        calls = []
        class InlineThread:
            def __init__(self, target, **kw): self.target = target
            def start(self): self.target()
        with patch.object(api.supervisor, '_ws_usage_cache', {self.slug: (0, 123)}), \
                patch.object(api.supervisor, '_ws_walk_inflight', set()), \
                patch.object(api.supervisor, 'workspace_usage_bytes', side_effect=lambda org: calls.append(org.d['slug'])), \
                patch.object(api.supervisor.threading, 'Thread', InlineThread):
            self.assertEqual(api.supervisor.workspace_usage_cached(ctx), 123)
        self.assertEqual(calls, [self.slug])

    def test_legacy_settings_use_per_org_fallback_and_bad_number_refuses(self):
        self.seed()
        migrations = self.query("SELECT val FROM doc WHERE key='_migrations'")[0][0]
        try:
            self.query("DELETE FROM doc WHERE key='_migrations'")
            load = store._load_lazy
            observed = []
            def watched(conn, slug, *args, **kw):
                observed.append(slug)
                return load(conn, slug, *args, **kw)
            with patch.object(store, '_load_lazy', watched):
                self.assertTrue(self.row()['kiosk'])
            self.assertIn(self.slug, observed)
            self.setting('deleted_cost_usd', 'not-a-number')
            with self.assertRaises(ValueError): self.row()
        finally:
            # Later admin listings enumerate all fixture organizations.
            self.setting('_migrations', json.loads(migrations))
            self.setting('deleted_cost_usd', 1.25)

    def test_archived_cost_shapes_use_exact_legacy_conversion_or_error(self):
        self.seed()
        node = store.load_org(self.slug).node('archived')
        try:
            for value in ('2.125', True, 'invalid', [1], {'bad': 1}):
                with self.subTest(value=value):
                    node['cost_usd'] = value
                    self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'archived'))
                    self.assertEqual(self.query('SELECT count(*) FROM nodes WHERE public.orgtree_summary_cost_exception(val)')[0][0], 1)
                    legacy = store.load_org(self.slug)
                    try:
                        expected = legacy.cost_total()
                    except (ValueError, TypeError) as error:
                        with self.assertRaises(type(error)): self.row()
                    else:
                        self.assertEqual(self.row()['cost_usd_total'], expected)
                    # Public output has no cost and needs no whole-node fallback.
                    with patch.object(store, '_load_lazy', side_effect=AssertionError('public full load')):
                        self.assertEqual(self.row(public=True)['nodes'], 3)
        finally:
            node['cost_usd'] = 0.00005
            self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'archived'))

    def test_zero_shapes_need_no_fallback_and_exception_index_tracks_writes(self):
        self.seed()
        node = store.load_org(self.slug).node('archived')
        for value in (None, False, '', [], {}, 0, 3.5):
            with self.subTest(value=value):
                node['cost_usd'] = value
                self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'archived'))
                self.assertEqual(self.query('SELECT count(*) FROM nodes WHERE public.orgtree_summary_cost_exception(val)')[0][0], 0)
                with patch.object(store, '_load_lazy', side_effect=AssertionError('unneeded fallback')):
                    self.assertEqual(self.row()['cost_usd_total'], round(0.3 + float(value or 0) + 1.25, 4))
        node['cost_usd'] = '4'
        self.query('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)', ('exception', 100, json.dumps(node)))
        self.assertEqual(self.query('SELECT count(*) FROM nodes WHERE public.orgtree_summary_cost_exception(val)')[0][0], 1)
        self.query("DELETE FROM nodes WHERE id='exception'")
        self.assertEqual(self.query('SELECT count(*) FROM nodes WHERE public.orgtree_summary_cost_exception(val)')[0][0], 0)

    def test_index_install_covers_existing_rows_and_new_schema_bootstrap(self):
        self.seed()
        # The fixture schema is created after migration, exercising bootstrap.
        self.assertEqual(len(self.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='nodes_summary_cost_exceptions'")), 1)
        node = store.load_org(self.slug).node('archived')
        node['cost_usd'] = '7'
        self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'archived'))
        with store._POOL.acquire(self.slug) as conn:
            oid = conn.org_id
        with pgstore.connect(os.environ['ORGTREE_PG_URL']) as admin:
            admin.execute(f'DROP INDEX org_{oid}.nodes_summary_cost_exceptions')
            admin.execute('SELECT public.orgtree_install_summary_cost_index(%s)', (oid,))
        self.assertEqual(self.query('SELECT count(*) FROM nodes WHERE public.orgtree_summary_cost_exception(val)')[0][0], 1)
        node['cost_usd'] = 0.00005
        self.query('UPDATE nodes SET val=? WHERE id=?', (json.dumps(node), 'archived'))


if __name__ == '__main__': unittest.main()
