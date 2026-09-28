"""foreground-tree F1, server side: a ws metadata frame moves the runtime stamp
before it is sent (api stream -> _tree_cache_drop), so the selected tree never
answers a kept ETag with 304 once the frame's value is in its body. That is
what lets the renderer keep its ETag on those frames."""
import copy
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_cache, ledger, store, supervisor


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class MetadataFramePG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-patch-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Visible charter')
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.client = TestClient(TokenGate(api.app, 'fg-patch'))
        self.headers = {'X-Orgtree-Desktop-Token': 'fg-patch', 'Accept-Encoding': 'identity'}
        self.url = f'/api/orgs/{self.slug}/foreground-tree'
        self.forecast = {'verdict': 'warm', 'probe': 1}
        foreground_cache._cache.clear()
        self.addCleanup(foreground_cache._cache.clear)

    def get(self, etag=None):
        headers = dict(self.headers)
        if etag:
            headers['If-None-Match'] = etag
        with patch.object(supervisor, 'cache_forecast_public', side_effect=lambda org, nid: dict(self.forecast)):
            return self.client.get(self.url, headers=headers)

    def test_a_frame_value_never_hides_behind_a_304_on_the_kept_etag(self):
        first = self.get()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['nodes']['boss']['cache_forecast'], self.forecast)
        same = self.get(first.headers['etag'])
        self.assertEqual(same.status_code, 304)                 # nothing moved yet
        self.forecast = {'verdict': 'cold', 'probe': 2}
        api._tree_cache_drop(self.slug)                          # what stream() does before sending
        after = self.get(first.headers['etag'])
        self.assertEqual(after.status_code, 200, 'the kept ETag revalidated a pre-frame body')
        body = after.json()
        value = (body['nodes']['boss']['set'] if body['kind'] == 'delta' else body['nodes']['boss'])['cache_forecast']
        self.assertEqual(value, {'verdict': 'cold', 'probe': 2})


if __name__ == '__main__':
    unittest.main()
