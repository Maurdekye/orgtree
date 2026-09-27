"""Committed foreground caches must not inherit whole-history or stale-feed reads."""
import gzip
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from orgtree import foreground_cache as cache, foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PG not configured: NOT RUN')
class ForegroundCache(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fc-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 0, 'boss', charter='Visible text. ' * 500)
        org.hire(ledger.USER, 'boss', 'luna', 0, 'retired')
        org.nodes['retired']['state'] = 'archived'
        store.save_org(org)
        self.runtime = 1
        self.builds = 0

    def build(self, raw, graph, public=False):
        self.builds += 1
        self.assertEqual(raw.execute('SHOW transaction_isolation').fetchone()[0], 'repeatable read')
        name = json.loads(raw.execute("SELECT val FROM doc WHERE key='name'").fetchone()[0])
        # Minimal field producer isolates cache invariants from context tests.
        return {'format': 'orgtree.foreground-tree/v1', 'kind': 'snapshot',
            'catalog_revision': f"{graph['stamp']['org_id']}:{graph['stamp']['catalog_revision']}",
            'header': {'name': name}, 'roots': ['boss'], 'org_rev': 0, 'sync_rev': 0,
            'nodes': {nid: {'id': nid, 'children': [], 'charter': row['node'].get('charter'),
                           'last_status': row['node'].get('last_status'),
                           'public': public, **({} if public else {'secret': 'private'})}
                      for nid, row in graph['rows'].items()}, 'missing_requested': graph['missing']}

    def read(self, tag='', *, public=False, include=(), compressed=False):
        return cache.read(self.slug, public, tag, include=include, compressed=compressed,
            runtime=lambda: self.runtime, sync_revision=lambda: 0,
            build=lambda raw, graph: self.build(raw, graph, public))

    def status(self, value):
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'summary': value}
        org.nodes['boss']['working_activity_at'] = value
        store.save_org(org)

    def direct(self, sql, params=()):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.raw.execute(sql, params)
            conn.execute('COMMIT')

    def test_status_reads_only_changed_node_and_never_whole_org_or_foreground(self):
        tag, _, _ = self.read()
        self.status('new')
        rows = []
        original = fg._rows
        def observed(raw, ids):
            rows.append(set(ids))
            return original(raw, ids)
        with patch.object(fg, '_rows', side_effect=observed), \
             patch.object(fg, 'select_foreground', side_effect=AssertionError('all active rows rebuilt')), \
             patch.object(store, 'cached_org', side_effect=AssertionError('whole Org loaded')):
            changed, body, _ = self.read(tag)
        self.assertNotEqual(changed, tag)
        self.assertEqual(rows, [{'boss'}])
        response = json.loads(body)
        self.assertEqual(response['kind'], 'delta')
        self.assertEqual(response['nodes'], {'boss': {'set': {'last_status': {'summary': 'new'}}, 'unset': []}})
        self.assertEqual(self.builds, 1)

    def test_direct_header_write_is_seen_without_save_hook_or_public_revision(self):
        tag, _, _ = self.read()
        previous = fg.read_foreground(self.slug)['stamp']['org_revision']
        self.direct("UPDATE doc SET val=%s WHERE key='name'", ('"changed directly"',))
        new, body, _ = self.read(tag)
        self.assertEqual(fg.read_foreground(self.slug)['stamp']['org_revision'], previous)
        self.assertNotEqual(new, tag)
        self.assertEqual(json.loads(body)['header']['set']['name'], 'changed directly')
        self.assertEqual(self.builds, 2)

    def test_unreported_node_change_cannot_hide_behind_a_local_status_save(self):
        tag, _, _ = self.read()
        self.direct("UPDATE nodes SET val=(val::jsonb || %s::jsonb)::text WHERE id='boss'",
                    ('{"charter":"changed by another process"}',))
        self.status('local')
        _, body, _ = self.read(tag)
        self.assertEqual(self.builds, 2)
        response = json.loads(body)
        if response['kind'] == 'delta':
            self.assertEqual(response['nodes']['boss']['set']['charter'], 'changed by another process')
        else:
            self.assertEqual(response['nodes']['boss']['charter'], 'changed by another process')

    def test_same_snapshot_hit_reads_no_node_bodies_and_unknown_base_is_full(self):
        tag, original, _ = self.read()
        with patch.object(fg, '_rows', side_effect=AssertionError('node read on hit')):
            same, body, _ = self.read(tag)
            unknown, full, _ = self.read('W/"foreground-unknown"')
        self.assertEqual(same, tag)
        self.assertEqual(unknown, tag)
        self.assertIsNone(body)
        self.assertEqual(full, original)
        self.assertEqual(json.loads(full)['kind'], 'snapshot')
        self.assertEqual(self.builds, 1)

    def test_public_and_include_partitions_never_share_private_or_missing_rows(self):
        private, _, _ = self.read()
        public, body, _ = self.read(private, public=True)
        self.assertNotEqual(public, private)
        self.assertNotIn('secret', json.loads(body)['nodes']['boss'])
        included, body, _ = self.read(private, include=['retired'])
        self.assertNotEqual(included, private)
        self.assertEqual(set(json.loads(body)['nodes']), {'boss', 'retired'})
        plain, body, _ = self.read(private)
        self.assertEqual(plain, private)
        self.assertIsNone(body)

    def test_runtime_and_nonstatus_changes_rebuild_without_forcing_full_wire(self):
        tag, _, _ = self.read()
        self.runtime += 1
        same, body, _ = self.read(tag)
        self.assertEqual(same, tag)
        self.assertIsNone(body)
        self.direct("UPDATE nodes SET val=(val::jsonb || %s::jsonb)::text WHERE id='boss'",
                    ('{"not_displayed": true}',))
        same, body, _ = self.read(tag)
        self.assertEqual(same, tag)
        self.assertIsNone(body)
        self.assertEqual(self.builds, 3)

    def test_compressed_wire_and_bounded_include_cache(self):
        tag, body, _ = self.read(compressed=True)
        self.assertEqual(json.loads(gzip.decompress(body))['kind'], 'snapshot')
        with patch.object(cache, 'MAX_ENTRIES', 2):
            for i in range(5):
                self.read(include=['missing-' + str(i)])
            self.assertLessEqual(len(cache._cache), 2)
        _, _, _ = self.read(tag)
        self.assertGreaterEqual(self.builds, 7)

    def test_external_commit_during_build_keeps_old_snapshot_then_refreshes(self):
        original = self.build
        changed = []
        def interleave(raw, graph, public=False):
            if not changed:
                changed.append(True)
                self.direct("UPDATE doc SET val=%s WHERE key='name'", ('"newer snapshot"',))
            return original(raw, graph, public)
        with patch.object(self, 'build', side_effect=interleave):
            tag, body, _ = self.read()
        self.assertNotEqual(json.loads(body)['header']['name'], 'newer snapshot')
        changed_tag, body, _ = self.read(tag)
        self.assertNotEqual(changed_tag, tag)
        self.assertEqual(json.loads(body)['header']['set']['name'], 'newer snapshot')


if __name__ == '__main__':
    unittest.main()
