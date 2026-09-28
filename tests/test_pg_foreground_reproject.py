"""A runtime-only refresh repeats the projection from the kept context, and its
bytes equal a fresh full build (foreground-tree-at-n1000 F3b-1)."""
import copy
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
from engine.launch import TokenGate
from orgtree import api, foreground_cache, foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReprojectPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-reproject-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Visible charter')
        for nid in ('old', 'leaf', 'peer'):
            org.hire(ledger.USER, 'boss', 'luna', 0, nid)
        org.nodes['old']['state'] = 'archived'
        org.nodes['leaf']['parent'] = 'old'
        org.work_create(ledger.USER, 'Current visible work', objective='Keep the counts exact.', owner='boss')
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.client = TestClient(TokenGate(api.app, 'fg-reproject'))
        self.headers = {'X-Orgtree-Desktop-Token': 'fg-reproject', 'Accept-Encoding': 'identity'}
        self.url = f'/api/orgs/{self.slug}/foreground-tree'
        self.runtime = ['first']
        foreground_cache._cache.clear()
        self.addCleanup(foreground_cache._cache.clear)

    def get(self, etag=None):
        headers = dict(self.headers)
        if etag:
            headers['If-None-Match'] = etag
        with patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: tuple(self.runtime)):
            return self.client.get(self.url, headers=headers)

    def fresh(self):
        """The whole current version, built from scratch."""
        foreground_cache._cache.clear()
        response = self.get()
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def cached(self):
        """The whole current version as the cache holds it, with no storage read."""
        with patch.object(fg, 'select_foreground', side_effect=AssertionError('rebuilt')):
            response = self.get()
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def test_runtime_only_refresh_reads_no_storage_and_equals_a_full_build(self):
        first = self.get()
        self.assertEqual(first.status_code, 200, first.text)
        self.runtime = ['second']
        with patch.object(fg, 'select_foreground', side_effect=AssertionError('storage re-read')), \
             patch.object(fg, '_rows', side_effect=AssertionError('node rows re-read')):
            again = self.get(first.headers['etag'])
        self.assertIn(again.status_code, (200, 304), again.text)
        kept = self.cached()
        self.assertEqual(kept.content, self.fresh().content)

    def test_status_then_runtime_change_equals_a_full_build(self):
        first = self.get()
        org = store.load_org(self.slug)
        org.nodes['peer']['last_status'] = {'status': 'working', 'summary': 'kept in step'}
        store.save_org(org)
        self.runtime = ['second']
        with patch.object(fg, 'select_foreground', side_effect=AssertionError('storage re-read')):
            changed = self.get(first.headers['etag'])
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()['nodes']['peer']['set']['last_status']['summary'], 'kept in step')
        kept = self.cached()
        self.assertEqual(kept.json()['nodes']['peer']['last_status']['summary'], 'kept in step')
        self.assertEqual(kept.content, self.fresh().content)

    # F3b-2: a committed node change re-reads only that node.
    def rows_read(self):
        seen = []
        original = fg._rows

        def spy(raw, ids):
            seen.append(set(ids))
            return original(raw, ids)
        return seen, patch.object(fg, '_rows', side_effect=spy)

    def direct(self, sql, params=()):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.raw.execute(sql, params)
            conn.execute('COMMIT')

    def test_a_nonstatus_node_change_rereads_only_that_node_and_equals_a_full_build(self):
        first = self.get()
        org = store.load_org(self.slug)
        org.nodes['peer']['charter'] = 'Changed through the ordinary save'
        org.work_create(ledger.USER, 'Another item', objective='Counts move too.', owner='peer')
        store.save_org(org)
        seen, spy = self.rows_read()
        with spy, patch.object(fg, 'select_foreground', side_effect=AssertionError('storage re-read')):
            changed = self.get(first.headers['etag'])
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(seen, [{'peer'}])
        self.assertEqual(self.cached().content, self.fresh().content)
        self.assertEqual(self.cached().json()['nodes']['peer']['charter'], 'Changed through the ordinary save')

    def test_the_same_node_saved_twice_between_reads_stays_incremental(self):
        first = self.get()
        for text in ('once', 'twice'):
            org = store.load_org(self.slug)
            org.nodes['peer']['charter'] = text
            store.save_org(org)
        with patch.object(fg, 'select_foreground', side_effect=AssertionError('storage re-read')):
            changed = self.get(first.headers['etag'])
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.cached().json()['nodes']['peer']['charter'], 'twice')
        self.assertEqual(self.cached().content, self.fresh().content)

    def test_a_direct_node_write_beside_a_local_save_is_never_reused_stale(self):
        first = self.get()
        self.direct("UPDATE nodes SET val=(val::jsonb || %s::jsonb)::text WHERE id='peer'",
                    ('{"charter":"written by another process"}',))
        org = store.load_org(self.slug)
        org.nodes['boss']['charter'] = 'local save'
        store.save_org(org)
        changed = self.get(first.headers['etag'])
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.cached().json()['nodes']['peer']['charter'], 'written by another process')
        self.assertEqual(self.cached().content, self.fresh().content)

    def test_a_settings_change_renormalizes_reused_nodes(self):
        # A node whose scope lacks permission_mode takes the org default during
        # normalization; a kept, normalized copy must not keep the old default.
        self.direct("UPDATE nodes SET val=jsonb_set(val::jsonb,'{scope}',(val::jsonb->'scope')-'permission_mode')::text "
                    "WHERE id='peer'")
        first = self.get()
        # Only the setting moves (no Python save: a load/save would re-heal the
        # node row itself and hide the reused copy).
        self.direct("INSERT INTO doc(key,val) VALUES('permission_mode',%s) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
                    ('"plan"',))
        with patch.object(fg, 'select_foreground', side_effect=AssertionError('storage re-read')):
            changed = self.get(first.headers['etag'])
        self.assertEqual(changed.status_code, 200, changed.text)
        kept = self.cached()                              # before fresh() clears the cache
        fresh = self.fresh()
        self.assertIn('"permission_mode":"plan"', json.dumps(fresh.json()['nodes']['peer'], separators=(',', ':')))
        self.assertEqual(kept.content, fresh.content)


if __name__ == '__main__':
    unittest.main()
