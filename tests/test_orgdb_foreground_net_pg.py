"""Native foreground hub status equals the full tree in the same org.

Use the guarded runner and P03 heavy lock; the twins own disposable databases.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import json
import statistics
import time
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree import api, foreground_api, foreground_context, foreground_store, net


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class ForegroundNet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            org.d['net_identity'] = {'slug': 'self-abcdef', 'secret': 'fixture-private-secret'}
            org.d['net_hubs'] = [
                {'id': 'a', 'address': 'https://fixture-a.invalid', 'enabled': True},
                {'id': 'b', 'address': 'https://fixture-b.invalid', 'enabled': False},
            ]
            org.d['net_state'] = {'a': {'address': 'https://fixture-a.invalid',
                                      'registered_at': fixture.AT}}
            org.d['net_spool'] = {
                'a': [{'id': 'plain', 'body': 'private message'},
                      {'id': 'first', 'tries': 2, 'last_err': 'earlier'},
                      {'id': 'latest', 'tries': 7, 'last_err': 'x' * 240},
                      {'id': 'tie', 'tries': 7, 'last_err': 'later in list'}],
                'b': [{'id': 'other', 'tries': 1, 'last_err': 'offline'}],
            }
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('foreground net', seed)

    def context(self, *, retained=False):
        slug = self.twin.copy
        project = (lambda raw, graph: foreground_api._page_context(raw, slug, graph)
                   if retained else foreground_context.build(raw, slug, graph))
        return foreground_store.read_foreground(slug, project=project)

    def annotate(self, org):
        request = SimpleNamespace(state=SimpleNamespace())
        rosters = {address: [{'slug': 'self-abcdef'}, {'slug': 'remote'}]
                   for address in ('https://fixture-a.invalid', 'https://fixture-b.invalid')}
        with ExitStack() as stack:
            stack.enter_context(patch.object(api.registry, 'list_accounts', return_value=[]))
            stack.enter_context(patch.object(api.registry, 'resolve_alias', return_value=None))
            stack.enter_context(patch('orgtree.registry_migration.observe_ambient', return_value={}))
            stack.enter_context(patch.object(fixture.store, 'local_net_slugs', return_value=set()))
            stack.enter_context(patch.dict(net._rosters, rosters, clear=True))
            stack.enter_context(patch.dict(net._status, {}, clear=True))
            stack.enter_context(patch.dict(net._hub_names, {}, clear=True))
            return api._annotate_org_view(org, org.tree_header([]), request)['net']

    def test_hub_status_matches_full_tree_without_private_payloads(self):
        with fixture.storage(True):
            expected = self.annotate(fixture.store.load_org(self.twin.copy))
            actual = self.annotate(self.context())
        self.assertEqual(actual, expected)
        self.assertEqual(actual['slug'], 'self-abcdef')
        a, b = actual['hubs']
        self.assertEqual((a['queued'], a['stuck'], a['stuck_err']), (4, 3, 'x' * 200))
        self.assertEqual((b['queued'], b['stuck'], b['stuck_err']), (1, 1, 'offline'))
        self.assertEqual([r['slug'] for r in a['roster']], ['remote'])
        wire = json.dumps(actual)
        self.assertNotIn('fixture-private-secret', wire)
        self.assertNotIn('private message', wire)

    def test_retained_inputs_refresh_after_spool_and_identity_write(self):
        with fixture.storage(True):
            before = self.annotate(self.context(retained=True))
            with fixture.orgtx.org_tx(self.twin.copy, sections=['net_identity', 'net_spool']) as tx:
                tx.d['net_identity']['slug'] = 'replacement-123456'
                tx.d['net_spool']['a'] = [{'id': 'new', 'tries': 1, 'last_err': 'retry'}]
            try:
                actual = self.annotate(self.context(retained=True))
                expected = self.annotate(fixture.store.load_org(self.twin.copy))
                self.assertEqual(actual, expected)
                self.assertNotEqual(actual, before)
                self.assertEqual(actual['slug'], 'replacement-123456')
                self.assertEqual(actual['hubs'][0]['queued'], 1)
            finally:
                with fixture.orgtx.org_tx(self.twin.copy, sections=['net_identity', 'net_spool']) as tx:
                    tx.d['net_identity']['slug'] = 'self-abcdef'
                    tx.d['net_spool']['a'] = [
                        {'id': 'plain', 'body': 'private message'},
                        {'id': 'first', 'tries': 2, 'last_err': 'earlier'},
                        {'id': 'latest', 'tries': 7, 'last_err': 'x' * 240},
                        {'id': 'tie', 'tries': 7, 'last_err': 'later in list'}]

    def test_large_spool_context_cost(self):
        with fixture.storage(True):
            original = fixture.store.load_org(self.twin.copy).d['net_spool']
            with fixture.orgtx.org_tx(self.twin.copy, sections=['net_spool']) as tx:
                tx.d['net_spool'] = {'a': [{'id': str(i), 'body': 'q' * 4096}
                                          for i in range(5000)]}
            try:
                def sample():
                    self.context()
                    samples = []
                    for _ in range(9):
                        start = time.perf_counter()
                        self.context()
                        samples.append((time.perf_counter() - start) * 1000)
                    return statistics.median(samples)
                # Compare the current selector with the old one on identical data.
                old = tuple(k for k in foreground_context.SETTINGS
                            if k not in ('net_identity', 'net_spool'))
                with patch.object(foreground_context, 'SETTINGS', old):
                    baseline = sample()
                current = sample()
                print(json.dumps({'fixture': '5000 queued messages, 4096 body bytes each',
                                  'boundary': 'warm native foreground read plus context build',
                                  'runs': 9, 'old_median_ms': baseline,
                                  'current_median_ms': current,
                                  'added_ms': current - baseline}))
                actual = self.annotate(self.context())
                self.assertEqual(actual['hubs'][0]['queued'], 5000)
                self.assertNotIn('stuck', actual['hubs'][0])
            finally:
                with fixture.orgtx.org_tx(self.twin.copy, sections=['net_spool']) as tx:
                    tx.d['net_spool'] = original


if __name__ == '__main__':
    unittest.main()
