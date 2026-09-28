"""Pin local discovery/transport/privacy behavior before changing its reader."""
import json
import unittest
from unittest.mock import patch

import test_policy_candidates_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class DiscoveryBehavior(unittest.TestCase):
    setUpClass = fixture.CandidateReads.__dict__['setUpClass']
    setUp = fixture.CandidateReads.setUp
    query = fixture.CandidateReads.query

    def setting(self, key, value):
        self.query('INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val',
                   (key, json.dumps(value)))

    def listing(self, peers=()):
        with patch.object(api.net, 'remote_peers', return_value=list(peers)):
            return api._list_orgs_payload(api.AgentCall(org=self.slug, node='worker',
                                                      tool='orgtree_list_orgs', args={}))

    def resolve(self, name=None, peers=()):
        with patch.object(api.net, 'remote_peers', return_value=list(peers)):
            return api._external_candidates(self.slug if name is None else name)

    def test_public_metadata_and_transport_merge_preserve_exact_output(self):
        self.setting('name', 'Display name')
        self.setting('net_identity', {'slug': 'local.peer', 'secret': 'MUST-NOT-LEAK'})
        peer = {'slug': '@net:local.peer', 'online': True, 'last_seen': 'now'}
        rows = self.listing([peer])['orgs']
        self.assertEqual(next(r for r in rows if r['slug'] == self.slug),
                         {'slug': self.slug, 'name': 'Display name', 'you': True,
                          'transports': ['org', 'net']})
        self.assertEqual(rows[-1], dict(peer, transports=['org', 'net']))
        self.assertNotIn('MUST-NOT-LEAK', json.dumps(rows))
        self.assertEqual(self.resolve(peers=[{'slug': '@net:' + self.slug + '.remote'}]),
                         {'org': [self.slug], 'net': [self.slug + '.remote']})

    def test_even_empty_or_disabled_kiosks_are_hidden_from_both_entry_points(self):
        for kiosk in ({}, {'enabled': False, 'token': 'PRIVATE-TOKEN'},
                      {'enabled': True, 'token': 'PRIVATE-TOKEN'}):
            with self.subTest(kiosk=kiosk):
                self.setting('kiosk', kiosk)
                self.assertFalse(any(r['slug'] == self.slug for r in self.listing()['orgs']))
                self.assertEqual(self.resolve(), {'org': [], 'net': []})
                self.assertNotIn('PRIVATE-TOKEN', json.dumps(self.listing()))

    def test_current_metadata_changes_are_visible_without_snapshot_cache(self):
        self.setting('name', 'Before')
        self.listing()
        self.setting('name', 'After')
        rows = self.listing()['orgs']
        self.assertEqual(next(r for r in rows if r['slug'] == self.slug)['name'], 'After')
        self.setting('kiosk', {})
        self.assertEqual(self.resolve(), {'org': [], 'net': []})
        self.setting('kiosk', None)
        self.assertEqual(self.resolve(), {'org': [self.slug], 'net': []})

    def test_unknown_or_invalid_local_name_still_resolves_remote_peers(self):
        for name in ('unknown-org', '../invalid'):
            with self.subTest(name=name):
                self.assertEqual(self.resolve(name, [{'slug': '@net:' + name}]),
                                 {'org': [], 'net': [name]})


if __name__ == '__main__': unittest.main()
