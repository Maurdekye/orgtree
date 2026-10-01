"""Conditional tree representation, bounded bases, and lossless HTTP encoding."""
import copy
import gzip
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='tree-ui-')
Path(_root.name, 'data').mkdir()
os.environ.update(ORGTREE_DATA=str(Path(_root.name, 'data')), HOME=_root.name,
                  USERPROFILE=_root.name, ORGTREE_STORE='sqlite', ORGTREE_V2_TOKEN='operator')
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import api, ledger, store, tree_ui, pgfeed  # noqa: E402


class TreeCache(unittest.TestCase):
    def setUp(self):
        tree_ui._cache.clear()
        self.tree = {'slug':'cache', 'sync_rev':1, 'roots':[{'id':'boss', 'charter':'whole charter'*100,
                     'last_status':None, 'children':[]}]}
        self.input = 0
        self.calls = 0

    def build(self):
        self.calls += 1
        return copy.deepcopy(self.tree)

    def read(self, since='', public=False, compressed=False):
        return tree_ui.read('cache', public, since, stamp=lambda:str(self.input), build=self.build,
                            compressed=compressed)

    def test_unchanged_content_304_after_unrelated_stamp_and_new_watermark(self):
        tag, body, _ = self.read()
        self.input += 1
        self.tree['sync_rev'] = 2
        same, body, headers = self.read(tag)
        self.assertEqual(same, tag)
        self.assertIsNone(body)
        self.assertEqual(headers['X-Orgtree-Sync-Rev'], '2')
        self.assertEqual(self.calls, 2)
        self.read(tag)
        self.assertEqual(self.calls, 2)

    def test_exact_base_patch_and_evicted_base_full_fallback(self):
        first, _, _ = self.read()
        self.input += 1
        self.tree['roots'][0]['last_status'] = {'summary':'one'}
        tag, body, _ = self.read(first)
        wire = json.loads(body)
        self.assertEqual(wire['nodes']['boss']['set'], {'last_status':{'summary':'one'}})
        self.assertNotEqual(tag, first)
        for i in range(tree_ui.MAX_VERSIONS):
            self.input += 1
            self.tree['roots'][0]['last_status'] = {'summary':str(i+2)}
            self.read()
        _, body, _ = self.read(first)
        self.assertEqual(json.loads(body)['tree'], self.tree)

    def test_public_and_private_partition_and_compression_are_lossless(self):
        _, plain, _ = self.read()
        _, zipped, _ = self.read(compressed=True)
        self.assertEqual(gzip.decompress(zipped), plain)
        self.assertLess(len(zipped), len(plain)/2)
        self.tree['roots'][0]['charter'] = 'scrubbed public'
        _, public, _ = self.read(public=True)
        self.assertEqual(json.loads(public)['tree']['roots'][0]['charter'], 'scrubbed public')
        _, private, _ = self.read()
        self.assertEqual(private, plain)

    def test_stamp_captured_before_build_cannot_pin_old_view_to_new_save(self):
        original = self.build
        def racing():
            old = original()
            self.input += 1
            self.tree['roots'][0]['title'] = 'new committed'
            return old
        with patch.object(self, 'build', side_effect=racing):
            tag, _, _ = self.read()
        _, body, _ = self.read(tag)
        self.assertIsNotNone(body, 'raced stamp must not revalidate the old view')
        self.assertEqual(json.loads(body)['nodes']['boss']['set']['title'], 'new committed')

    def test_cache_budget_and_expiry_release_bases(self):
        with patch.object(tree_ui, 'MAX_BYTES', 1):
            self.read()
            self.assertFalse(tree_ui._cache)
        self.read()
        with patch.object(tree_ui, 'IDLE_S', -1):
            tree_ui._sweep()
            self.assertFalse(tree_ui._cache)

    def test_gzip_negotiation_respects_disabled_quality(self):
        self.assertTrue(tree_ui.accepts_gzip('br, gzip'))
        self.assertFalse(tree_ui.accepts_gzip('gzip;q=0, *;q=1'))
        self.assertFalse(tree_ui.accepts_gzip('notgzip'))


class CommittedProof(unittest.TestCase):
    def test_foreign_revision_followed_by_local_cannot_hide_the_gap(self):
        slug = 'proof-' + os.urandom(3).hex()
        pgfeed.note_local(slug, 3)
        self.assertFalse(pgfeed.snapshot_changes_published(None, slug, 1, 3))
        pgfeed.note_local(slug, 2)
        self.assertTrue(pgfeed.snapshot_changes_published(None, slug, 1, 3))

    def test_received_revision_is_not_trusted_before_callback_finishes(self):
        entered, release = threading.Event(), threading.Event()
        def callback(*args):
            entered.set()
            release.wait(3)
        feed = pgfeed.RevisionFeed(lambda:None, callback)
        feed.observe('x', 1, source='catchup')
        thread = threading.Thread(target=lambda:feed.observe('x', 2, source='notify'))
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(feed.last_seen('x'), 2)
            self.assertFalse(pgfeed.snapshot_changes_published(feed, 'x', 1, 2))
        finally:
            release.set()
            thread.join()
        self.assertTrue(pgfeed.snapshot_changes_published(feed, 'x', 1, 2))
        # The initial feed baseline cannot validate snapshots older than it.
        self.assertFalse(pgfeed.snapshot_changes_published(feed, 'x', 0, 2))


class TreeHTTP(unittest.TestCase):
    def setUp(self):
        self.slug = 'tree-' + os.urandom(3).hex()
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'boss', charter='Visible charter\nLong detail')
        store.save_org(org)
        self.client = TestClient(app)
        self.url = f'/api/orgs/{self.slug}'

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def test_full_http_preserves_legacy_fields_and_status_delta_reconciles(self):
        headers = {'X-Orgtree-Desktop-Token':'operator', 'Accept-Encoding':'gzip'}
        # Stable annotation fixture lets this assert the WHOLE projection,
        # including all future fields, independently of clock/provider refresh.
        expected = api._org_view(self.slug, type('R', (), {'state':type('S', (), {})(),
                                  'headers':{}, 'url':type('U', (), {'path':self.url})()})(), None)
        with patch.object(api, '_org_view', return_value=expected):
            first = self.client.get(self.url+'?view=delta', headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.headers['content-encoding'], 'gzip')
        self.assertEqual(first.json()['tree'], expected)
        new = copy.deepcopy(expected)
        new['roots'][0]['last_status'] = {'summary':'now working'}
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = new['roots'][0]['last_status']
        store.save_org(org)
        with patch.object(api, '_org_view', return_value=new):
            second = self.client.get(self.url+'?view=delta', headers={**headers,'If-None-Match':first.headers['etag']})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()['nodes']['boss']['set'], {'last_status':{'summary':'now working'}})


if __name__ == '__main__':
    unittest.main()
