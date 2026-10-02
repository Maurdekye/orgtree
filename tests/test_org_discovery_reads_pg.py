"""Actual-PG discovery reads: bounded data, coherence and legacy fallback."""
import json
import os
import unittest
from unittest.mock import patch

import test_org_discovery_behavior_pg as behavior
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, org_listing, pgstore, store

tearDownModule = behavior.tearDownModule


@unittest.skipUnless(behavior.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class DiscoveryReads(unittest.TestCase):
    setUpClass = behavior.DiscoveryBehavior.__dict__['setUpClass']
    setUp = behavior.DiscoveryBehavior.setUp
    query = behavior.DiscoveryBehavior.query
    setting = behavior.DiscoveryBehavior.setting
    listing = behavior.DiscoveryBehavior.listing
    resolve = behavior.DiscoveryBehavior.resolve

    def test_both_entry_points_avoid_full_org_and_return_only_public_metadata(self):
        self.setting('net_identity', {'slug': 'public.peer', 'secret': 'NETWORK-SECRET'})
        with patch.object(store, 'list_orgs', side_effect=AssertionError('full listing')), \
                patch.object(store, 'load_org', side_effect=AssertionError('full load')), \
                patch.object(store, 'cached_org', side_effect=AssertionError('full cache')):
            row = org_listing._metadata(self.slug)
            self.assertEqual(set(row), {'slug', 'name', 'net_slug'})
            self.assertEqual(row['net_slug'], 'public.peer')
            self.assertNotIn('SECRET', json.dumps(row))
            self.assertEqual(self.resolve(), {'org': [self.slug], 'net': []})
            self.assertTrue(any(r['slug'] == self.slug for r in self.listing()['orgs']))

    def test_settings_are_one_snapshot_and_next_read_observes_the_change(self):
        self.setting('name', 'Before')
        self.setting('net_identity', {'slug': 'before.peer'})
        execute = pgstore.PgConn.execute
        observed = []
        def concurrent(conn, sql, params=()):
            cur = execute(conn, sql, params)
            if sql.startswith('SELECT key,CASE key'):
                observed.append(sql)
                with pgstore.connect(os.environ['ORGTREE_PG_URL']) as raw:
                    raw.execute(f'UPDATE org_{conn.org_id}.doc SET val=%s WHERE key=%s',
                                (json.dumps('After'), 'name'))
            return cur
        with patch.object(pgstore.PgConn, 'execute', concurrent):
            row = org_listing._metadata(self.slug)
        self.assertEqual(len(observed), 1)
        self.assertEqual((row['name'], row['net_slug']), ('Before', 'before.peer'))
        self.assertEqual(next(r for r in self.listing()['orgs'] if r['slug'] == self.slug)['name'],
                         'After')

    def test_missing_marker_and_deleted_org_are_not_discovered(self):
        marker = store._db_path(self.slug)
        saved = marker + '.held'
        os.replace(marker, saved)
        try:
            self.assertEqual(self.resolve(), {'org': [], 'net': []})
            self.assertFalse(any(r['slug'] == self.slug for r in self.listing()['orgs']))
        finally:
            os.replace(saved, marker)

    def test_legacy_backend_and_pending_json_keep_legacy_listing(self):
        rows = [{'slug': 'visible', 'name': 'Name', 'net_slug': None,
                 'admin_secret': 'NOT-PUBLIC'}]
        for backend in ('sqlite', 'json'):
            with self.subTest(backend=backend), patch.object(store, 'STORE_BACKEND', backend), \
                    patch.object(store, 'list_orgs', return_value=rows) as old:
                self.assertEqual(org_listing.discovery_rows(),
                                 [{'slug': 'visible', 'name': 'Name', 'net_slug': None}])
                old.assert_called_once()
        with patch.object(org_listing.os, 'listdir', return_value=['pending.json']), \
                patch.object(store, 'list_orgs', return_value=rows) as old:
            self.assertEqual(len(org_listing.discovery_rows()), 1)
            old.assert_called_once()


if __name__ == '__main__': unittest.main()
