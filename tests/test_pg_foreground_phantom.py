"""Adopted from review-astra's probe (review finding f5, c2e1e04): can the node-write-count proof be fooled?

A multi-org org_tx publishes the earlier org's change set (tree_changes journal)
BEFORE the one real COMMIT. If a later org's save then fails, everything rolls
back but the journal keeps a phantom node write. A direct SQL write to a
DIFFERENT node (another process's row write: node_revision +1, no journal entry)
then makes node_revision delta == journal write count, so the proof passes and
the directly-written node is reused stale."""
import copy
import json
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_cache, ledger, orgtx, pgstore, store, tree_changes


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class PhantomJournal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def make(self, name):
        org = store.create_org(name + '-' + self._testMethodName[-20:])
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Boss charter')
        org.hire(ledger.USER, 'boss', 'luna', 0, 'peer', charter='Peer charter')
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        return org.d['slug']

    def setUp(self):
        self.a = self.make('pja')        # created first: lower org_id, saved first
        self.b = self.make('pjb')
        self.client = TestClient(TokenGate(api.app, 'pj'))
        self.headers = {'X-Orgtree-Desktop-Token': 'pj', 'Accept-Encoding': 'identity'}
        foreground_cache._cache.clear()
        self.addCleanup(foreground_cache._cache.clear)

    def get(self, slug, etag=None):
        h = dict(self.headers)
        if etag:
            h['If-None-Match'] = etag
        with patch.object(api, '_tree_runtime_stamp', side_effect=lambda s: ('fixed',)):
            r = self.client.get(f'/api/orgs/{slug}/foreground-tree', headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def whole(self, slug):
        r = self.get(slug)
        return r.json()['nodes']

    def test_failed_multi_org_tx_plus_direct_write_is_not_hidden(self):
        self.get(self.a)                                 # cache org A
        real = store._write_doc

        def fail_b(conn, d, lazy, *args, **kwargs):
            if d.get('slug') == self.b:
                raise RuntimeError('probe: second org save fails after the first published')
            return real(conn, d, lazy, *args, **kwargs)
        with patch.object(store, '_write_doc', fail_b):
            with self.assertRaises(Exception):
                with orgtx.org_tx_multi({self.a: dict(nodes=['boss']), self.b: dict(nodes=['boss'])}) as t:
                    t[self.a].org.d['nodes']['boss']['charter'] = 'rolled back'
                    t[self.b].org.d['nodes']['boss']['charter'] = 'rolled back'
        self.assertEqual(store.load_org(self.a).d['nodes']['boss']['charter'], 'Boss charter',
                         'setup: the multi-org tx did not roll back')
        with pgstore.connect() as c:                     # another process's direct row write
            oid = c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (self.a,)).fetchone()[0]
            c.execute(f"UPDATE org_{oid}.nodes SET val=(val::jsonb || %s::jsonb)::text WHERE id='peer'",
                      ('{"charter":"written directly"}',))
            c.commit()
        served = self.get(self.a).json()
        nodes = served.get('nodes', {})
        peer = nodes.get('peer', {})
        peer = peer.get('set', peer) if isinstance(peer, dict) else peer
        foreground_cache._cache.clear()
        fresh = self.whole(self.a)
        print('SERVED kind', served.get('kind'), 'peer', json.dumps(peer)[:200])
        print('FRESH peer charter', fresh['peer'].get('charter'))
        self.assertEqual(fresh['peer'].get('charter'), 'written directly', 'setup: direct write not visible')
        cached_whole = self.get(self.a).json()           # rebuilt after clear: sanity only
        del cached_whole
        # the real assertion: what the cache served after the direct write
        self.assertEqual(peer.get('charter'), 'written directly',
                         'direct node write hidden behind a phantom journal entry')

    def test_control_direct_write_alone_is_seen(self):
        self.get(self.a)
        with pgstore.connect() as c:
            oid = c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (self.a,)).fetchone()[0]
            c.execute(f"UPDATE org_{oid}.nodes SET val=(val::jsonb || %s::jsonb)::text WHERE id='peer'",
                      ('{"charter":"written directly"}',))
            c.commit()
        peer = self.get(self.a).json()['nodes']['peer']
        print('CONTROL peer charter', peer.get('charter'))
        self.assertEqual(peer.get('charter'), 'written directly')

    def test_a_failed_multi_org_tx_leaves_the_journal_unknown(self):
        seq = store.org_seq(self.a)
        real = store._write_doc

        def fail_b(conn, d, lazy, *args, **kwargs):
            if d.get('slug') == self.b:
                raise RuntimeError('second org save fails after the first published')
            return real(conn, d, lazy, *args, **kwargs)
        with patch.object(store, '_write_doc', fail_b):
            with self.assertRaises(Exception):
                with orgtx.org_tx_multi({self.a: dict(nodes=['boss']), self.b: dict(nodes=['boss'])}) as t:
                    t[self.a].org.d['nodes']['boss']['charter'] = 'rolled back'
                    t[self.b].org.d['nodes']['boss']['charter'] = 'rolled back'
        self.assertGreater(store.org_seq(self.a), seq, 'setup: org A published nothing')
        self.assertIsNone(tree_changes.since_detail(store.DATA_ROOT, self.a, seq, store.org_seq(self.a)),
                          'a rolled-back change set is still journaled as known')

if __name__ == '__main__':
    unittest.main()
