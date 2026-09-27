"""HTTP authority, reset and compatibility boundaries of the opt-in tree.

Storage/context equivalence are exercised in their actual-PG modules. These
controls isolate the transport from those dependencies, with no server lifespan
or provider process.
"""
import gzip
import json
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401,E402
from engine.launch import TokenGate
from fastapi.testclient import TestClient
from orgtree import api, foreground_api as routes, foreground_store as fg, foreground_view as view, store
from orgtree.ledger import LedgerError
app = TokenGate(api.app, 'foreground-test')


class ForegroundHTTP(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.headers = {'X-Orgtree-Desktop-Token': 'foreground-test', 'Accept-Encoding': 'identity'}
        self.url = '/api/orgs/example/foreground-tree'
        self.backend = patch.object(store, 'STORE_BACKEND', 'postgres')
        self.backend.start()
        self.addCleanup(self.backend.stop)

    def get(self, path='', **headers):
        return self.client.get(self.url + path, headers={**self.headers, **headers})

    def payload(self, kind='lookup'):
        return {'format': view.FORMAT, 'kind': kind, 'catalog_revision': '9:4',
                'org_rev': 21, 'sync_rev': 13, 'nodes': {}, 'found': False, 'path': []}

    def test_operator_token_precedes_any_storage(self):
        with patch.object(routes.foreground_cache, 'read', side_effect=AssertionError('unauthorized storage')):
            self.assertEqual(self.client.get(self.url).status_code, 401)

    def test_snapshot_gzip_and_unchanged_watermarks(self):
        payload = {'format': view.FORMAT, 'kind': 'snapshot', 'nodes': {}, 'roots': []}
        wire = gzip.compress(json.dumps(payload).encode())
        marks = {'X-Orgtree-Org-Rev': '21', 'X-Orgtree-Sync-Rev': '13'}
        with patch.object(routes.foreground_cache, 'read', return_value=('W/"foreground-one"', wire, marks)) as read:
            response = self.get('?include=old&include=other', **{'Accept-Encoding': 'gzip'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), payload)
        self.assertEqual(response.headers['content-encoding'], 'gzip')
        self.assertEqual(read.call_args.kwargs['include'], ['old', 'other'])
        self.assertTrue(read.call_args.kwargs['compressed'])
        self.assertFalse(read.call_args.args[1])
        with patch.object(routes.foreground_cache, 'read', return_value=('W/"foreground-one"', None, marks)):
            unchanged = self.get(**{'If-None-Match': 'W/"foreground-one"'})
        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(unchanged.content, b'')
        self.assertEqual(unchanged.headers['x-orgtree-sync-rev'], '13')
        self.assertIn('private', unchanged.headers['cache-control'])

    def test_public_gateway_scopes_org_and_selects_public_partition(self):
        public = TestClient(api.PublicGateway(api.app))
        with patch.object(api, '_kiosk_token_map', return_value={'validtoken': 'example'}), \
             patch.object(routes.foreground_cache, 'read', return_value=('W/"foreground-public"', b'{}', {})) as read:
            response = public.get('/k/validtoken' + self.url, headers={'Accept-Encoding': 'identity'})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(read.call_args.args[1])
            read.reset_mock()
            wrong = public.get('/k/validtoken/api/orgs/secret/foreground-tree')
            self.assertEqual(wrong.status_code, 404)
            read.assert_not_called()
            self.assertEqual(public.get('/k/badtoken' + self.url).status_code, 404)

    def test_backend_or_context_incompatibility_is_not_an_empty_tree(self):
        with patch.object(store, 'STORE_BACKEND', 'sqlite'), \
             patch.object(routes.foreground_cache, 'read', side_effect=AssertionError('fallback loaded history')):
            response = self.get()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['kind'], 'compatibility')
        self.assertNotIn('nodes', response.json())
        self.assertEqual(response.json()['legacy_url'], '/api/orgs/example')
        with patch.object(routes.foreground_cache, 'read', side_effect=routes._Unavailable):
            self.assertEqual(self.get().json(), response.json())

    def test_page_inputs_and_exact_lookup_keep_separate_contracts(self):
        page = self.payload('page')
        page.update(matches=['old'], next_cursor='next')
        with patch.object(fg, 'read_retired_children', return_value=page) as read:
            response = self.get('/children?parent=boss&limit=10&cursor=before')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(read.call_args.args, ('example', 'boss'))
        self.assertEqual(read.call_args.kwargs['limit'], 10)
        self.assertEqual(read.call_args.kwargs['cursor'], 'before')
        self.assertTrue(callable(read.call_args.kwargs['project']))
        with patch.object(fg, 'search', return_value=page) as read:
            response = self.get('/search?q=retired&state=archived&limit=8')
        self.assertEqual(response.json()['matches'], ['old'])
        self.assertEqual(read.call_args.args, ('example', 'retired'))
        self.assertEqual(read.call_args.kwargs['state'], 'archived')
        with patch.object(fg, 'read_exact', return_value=self.payload()) as read:
            missing = self.get('/lookup/gone')
        self.assertEqual(read.call_args.args, ('example', 'gone'))
        self.assertEqual(missing.status_code, 200)
        self.assertFalse(missing.json()['found'])

    def test_page_304_uses_current_watermarks_but_not_a_newer_catalog(self):
        with patch.object(fg, 'read_exact', return_value=self.payload()):
            first = self.get('/lookup/gone')
        newer = self.payload()
        newer.update(org_rev=22, sync_rev=14)
        with patch.object(fg, 'read_exact', return_value=newer):
            hit = self.get('/lookup/gone', **{'If-None-Match': first.headers['etag']})
        self.assertEqual(hit.status_code, 304)
        self.assertEqual(hit.headers['x-orgtree-org-rev'], '22')
        newer['catalog_revision'] = '9:5'
        with patch.object(fg, 'read_exact', return_value=newer):
            changed = self.get('/lookup/gone', **{'If-None-Match': first.headers['etag']})
        self.assertEqual(changed.status_code, 200)

    def test_cursor_reset_contains_the_actual_snapshot_catalog(self):
        stamp = {'org_id': 9, 'catalog_revision': 5}
        previous = {'org_id': 9, 'catalog_revision': 4}
        cursor = fg._cursor(previous, 'children', 'boss', [0, '', 1, 'old'])
        def expired(*args, **kwargs):
            fg._after(kwargs['cursor'], stamp, 'children', 'boss')
        with patch.object(fg, 'read_retired_children', side_effect=expired):
            result = self.get('/children?parent=boss&cursor=' + cursor)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json(), {'format': view.FORMAT, 'kind': 'reset',
                                       'reason': 'catalog_changed', 'catalog_revision': '9:5'})
        # The same cursor against a recreated org is a reset as well.
        stamp['org_id'] = 10
        with self.assertRaises(fg.CursorReset):
            fg._after(cursor, stamp, 'children', 'boss')

    def test_bad_inputs_are_400_and_corrupt_graph_is_not_missing(self):
        self.assertEqual(self.get('/children?limit=nope').status_code, 400)
        with patch.object(fg, 'read_retired_children', side_effect=lambda *a, **k: fg._limit(k['limit'])):
            self.assertEqual(self.get('/children?limit=101').status_code, 400)
        with patch.object(fg, 'read_exact', side_effect=fg.OrgNotFound('org absent')):
            self.assertEqual(self.get('/lookup/missing').status_code, 404)
        with patch.object(fg, 'read_exact', side_effect=LedgerError('foreground ancestor cycle')):
            self.assertEqual(self.get('/lookup/missing').status_code, 503)


if __name__ == '__main__':
    unittest.main()
