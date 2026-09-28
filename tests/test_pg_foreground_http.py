"""Real PG routes with the real context and committed docket-count reader."""
import base64
import copy
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_cache, foreground_store as fg, ledger, orgtx, pgfeed, store, tree_changes


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ForegroundRoutePG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-http-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Visible charter')
        for nid in ('old', 'hidden', 'leaf'):
            org.hire(ledger.USER, 'boss', 'luna', 0, nid)
        org.nodes['old']['state'] = 'archived'
        org.nodes['hidden']['state'] = 'archived'
        org.nodes['leaf']['parent'] = 'old'
        org.work_create(ledger.USER, 'Current visible work', objective='Keep the counts exact.', owner='boss')
        org = ledger.Org(copy.deepcopy(org.d))
        store.save_org(org)
        self.client = TestClient(TokenGate(api.app, 'foreground-pg'))
        self.headers = {'X-Orgtree-Desktop-Token': 'foreground-pg', 'Accept-Encoding': 'identity'}
        self.url = f'/api/orgs/{self.slug}'

    def get(self, suffix='/foreground-tree', **headers):
        return self.client.get(self.url + suffix, headers={**self.headers, **headers})

    def test_real_header_and_selected_cards_match_legacy_without_whole_org_read(self):
        expected = self.get('')
        self.assertEqual(expected.status_code, 200, expected.text)
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org loaded by foreground route')):
            actual = self.get()
        self.assertEqual(actual.status_code, 200, actual.text)
        full, bounded = expected.json(), actual.json()
        self.assertEqual(set(bounded['nodes']), {'boss', 'old', 'leaf'})
        self.assertEqual(bounded['nodes']['boss']['hidden_retired_children'], 1)
        self.assertEqual(bounded['nodes']['old']['children'], ['leaf'])
        for key, value in full.items():
            if key not in ('roots', 'sync_rev', 'org_rev'):
                self.assertEqual(bounded['header'][key], value, key)
        stack = list(full['roots'])
        while stack:
            row = stack.pop()
            stack.extend(row['children'])
            if row['id'] not in bounded['nodes']:
                continue
            for key, value in row.items():
                if key not in ('children', 'lineage', 'detail_rev'):
                    self.assertEqual(bounded['nodes'][row['id']][key], value, (row['id'], key))

    def test_real_status_delta_uses_only_changed_node_and_direct_commit_refreshes_header(self):
        with patch.object(api, '_tree_runtime_stamp', return_value=('fixed',)):
            first = self.get()
            self.assertEqual(first.status_code, 200, first.text)
            org = store.load_org(self.slug)
            org.nodes['boss']['last_status'] = {'status': 'working', 'summary': 'new'}
            store.save_org(org)
            with patch.object(fg, 'select_foreground', side_effect=AssertionError('full projection rebuilt')):
                changed = self.get(**{'If-None-Match': first.headers['etag']})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()['kind'], 'delta')
            self.assertEqual(changed.json()['nodes']['boss']['set']['last_status']['summary'], 'new')
            same = self.get(**{'If-None-Match': changed.headers['etag']})
            self.assertEqual(same.status_code, 304)
            with store._POOL.acquire(self.slug) as conn:
                conn.execute('BEGIN IMMEDIATE')
                conn.raw.execute("UPDATE doc SET val=%s WHERE key='name'", ('"externally renamed"',))
                conn.execute('COMMIT')
            renamed = self.get(**{'If-None-Match': changed.headers['etag']})
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertEqual(renamed.json()['header']['set']['name'], 'externally renamed')

    def test_hidden_lookup_pages_include_and_public_scrub(self):
        found = self.get('/foreground-tree/lookup/hidden')
        self.assertEqual(found.status_code, 200, found.text)
        self.assertEqual(found.json()['path'], ['boss', 'hidden'])
        self.assertFalse(found.json()['nodes']['hidden']['detail'])
        page = self.get('/foreground-tree/children?parent=boss&limit=1')
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(len(page.json()['matches']), 1)
        self.assertIsNotNone(page.json()['next_cursor'])
        search = self.get('/foreground-tree/search?q=hidden')
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()['matches'], ['hidden'])
        shown = self.get('/foreground-tree?include=hidden')
        self.assertEqual(set(shown.json()['nodes']), {'boss', 'old', 'hidden', 'leaf'})
        self.assertEqual(shown.json()['nodes']['boss']['hidden_retired_children'], 0)
        missing = self.get('/foreground-tree/lookup/absent')
        self.assertFalse(missing.json()['found'])
        org = store.load_org(self.slug)
        org.nodes['boss']['session_id'] = 'private-session'
        store.save_org(org)
        public = TestClient(api.PublicGateway(api.app))
        with patch.object(api, '_kiosk_token_map', return_value={'testtoken': self.slug}):
            response = public.get('/k/testtoken' + self.url + '/foreground-tree',
                                  headers={'Accept-Encoding': 'identity'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn('session_id', response.json()['nodes']['boss'])

    def test_native_row_transaction_status_keeps_changed_node_read_bound(self):
        # TestClient omits lifespan. Install the same post-commit listener as
        # startup without starting provider/feed workers.
        listener = lambda c: pgfeed.note_local(c.slug, c.revision)
        with patch.object(api, '_tree_runtime_stamp', return_value=('fixed',)), \
             patch.object(orgtx, 'commit_listeners', [*orgtx.commit_listeners, listener]):
            first = self.get()
            self.assertEqual(first.status_code, 200, first.text)
            before = fg.read_foreground(self.slug)['stamp']
            seq = store.org_seq(self.slug)
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                tx.d['nodes']['boss']['last_status'] = {'status': 'working', 'summary': 'row transaction'}
            after = fg.read_foreground(self.slug)['stamp']
            journal = tree_changes.since(store.DATA_ROOT, self.slug, seq, store.org_seq(self.slug))
            builds = []
            original = fg.select_foreground
            def observed(*args):
                builds.append(1)
                return original(*args)
            with patch.object(fg, 'select_foreground', side_effect=observed):
                changed = self.get(**{'If-None-Match': first.headers['etag']})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()['nodes']['boss']['set']['last_status']['summary'], 'row transaction')
            self.assertEqual(builds, [], {'before': before, 'after': after, 'journal': journal})

    def test_last_retired_child_preserves_legacy_front_and_catalog_revalidation(self):
        expected = self.get('').json()['roots'][0]['children']
        expected = [row['id'] for row in expected if row['state'] == 'archived'][-1]
        path = '/foreground-tree/children?parent=boss&edge=last&limit=1'
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org loaded')):
            first = self.get(path)
        self.assertEqual(first.status_code, 200, first.text)
        payload = first.json()
        self.assertEqual(payload['kind'], 'page')
        self.assertEqual(payload['matches'], [expected])
        self.assertEqual(set(payload['nodes']), {'boss', expected})
        self.assertIsNone(payload['next_cursor'])
        self.assertEqual(first.headers['x-orgtree-catalog-rev'], payload['catalog_revision'])
        self.assertEqual(self.get(path, **{'If-None-Match': first.headers['etag']}).status_code, 304)
        org = store.load_org(self.slug)
        org.nodes['old']['ui_order'] = 1000
        store.save_org(org)
        changed = self.get(path, **{'If-None-Match': first.headers['etag']})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()['matches'], ['old'])
        self.assertNotEqual(changed.json()['catalog_revision'], payload['catalog_revision'])
        empty = self.get('/foreground-tree/children?parent=leaf&edge=last&limit=1')
        self.assertEqual(empty.status_code, 200, empty.text)
        self.assertEqual(empty.json()['matches'], [])
        self.assertEqual(empty.json()['nodes'], {})
        for query in ('edge=first&limit=1', 'edge=last', 'edge=last&limit=2',
                      'edge=last&limit=1&cursor=', 'edge=last&limit=1&cursor=old'):
            with self.subTest(query=query):
                response = self.get('/foreground-tree/children?parent=boss&' + query)
                self.assertEqual(response.status_code, 400, response.text)

    def test_retired_page_cursor_rejects_malformed_order_fields_as_http400(self):
        self.client = TestClient(TokenGate(api.app, 'foreground-pg'), raise_server_exceptions=False)
        first = self.get('/foreground-tree/children?parent=boss&limit=1')
        self.assertEqual(first.status_code, 200, first.text)
        cursor = first.json()['next_cursor']
        self.assertIsNotNone(cursor)
        original = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
        invalid_fields = {
            0: ['not-a-number', 'NaN', 'Infinity', '-Infinity', '1e131072', '1e-16384',
                True, None, [], {}],
            1: [None, 4, [], 'bad\x00created', '\ud800'],
            2: ['1', 1.5, True, None, 2**63, -(2**63)-1],
            3: [None, 4, {}, 'bad\x00id', '\ud800'],
        }
        for field, values in invalid_fields.items():
            for value in values:
                with self.subTest(field=field, value=repr(value)):
                    forged = copy.deepcopy(original)
                    forged[5][field] = value
                    encoded = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip('=')
                    response = self.get('/foreground-tree/children?parent=boss&limit=1&cursor=' + encoded)
                    self.assertEqual(response.status_code, 400, response.text)
        # Rejecting a cursor must leave the read connection usable, and a real
        # server-issued ordering key must still fetch the next distinct child.
        valid = self.get('/foreground-tree/children?parent=boss&limit=1&cursor=' + cursor)
        self.assertEqual(valid.status_code, 200, valid.text)
        self.assertEqual(len(valid.json()['matches']), 1)
        self.assertTrue(set(first.json()['matches']).isdisjoint(valid.json()['matches']))


if __name__ == '__main__':
    unittest.main()
