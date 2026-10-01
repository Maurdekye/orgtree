"""orgtree_status, orgtree_send_notice and the reservation tools plan their
locks without the whole-org cached snapshot.

door-tools-status-reservation-and-send-notice-pl: these tools used to pay
`store.cached_org` (every docket body) just to plan which rows to lock. The
reservation specs read only arguments (needs_snapshot=False); status and
send_notice read node rows only, so they take the runtime snapshot
(runtime_snapshot=True), as orgtree_message already does. The oracle for each
plan is the same spec computed on the full coherent org.
"""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, ledger, pgdoor, store, supervisor

os.environ['ORGTREE_PGDOOR'] = '1'
REQUEST = SimpleNamespace(state=SimpleNamespace())
FREE = ('orgtree_reservation', 'orgtree_resource_reservation')
RUNTIME = ('orgtree_status', 'orgtree_send_notice')


def tearDownModule():
    f.tearDownModule()


class Declared(unittest.TestCase):
    def test_modes(self):
        for name in FREE:
            self.assertIn(name, pgdoor.SNAPSHOT_FREE, name)
            self.assertNotIn(name, pgdoor.RUNTIME_SNAPSHOTS, name)
        for name in RUNTIME:
            self.assertIn(name, pgdoor.RUNTIME_SNAPSHOTS, name)
            self.assertNotIn(name, pgdoor.SNAPSHOT_FREE, name)


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class OnPg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()
        cls.slug = f._fresh_org('doorsnap')
        org = store.load_org(cls.slug)
        for nid in ('a', 'b', 'c'):
            org.d['nodes'].pop(nid)
        org.d.pop('killswitch', None)
        org.hire(ledger.USER, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'w', add_dirs=[],
                 tools={'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []},
                 org_visibility='full', charter='c')
        org.work_create('boss', 'a ticket', 'the problem')
        store.save_org(org)

    def plan(self, name, node, args):
        body = SimpleNamespace(org=self.slug, node=node)
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole-org snapshot')):
            got = pgdoor._resolve(name, self.slug, body, dict(args))
        want = pgdoor.LOCKS[name](store.load_org(self.slug), body, dict(args))
        return got, want

    def test_plans_equal_the_full_snapshot_plan(self):
        cases = (('orgtree_status', 'w', {'status': 'working'}),
                 ('orgtree_status', 'w', {'status': 'done'}),
                 ('orgtree_status', 'w', {'status': 'blocked'}),
                 ('orgtree_status', 'boss', {'status': 'done'}),
                 ('orgtree_send_notice', 'w', {'to': 'boss', 'body': 'x'}),
                 ('orgtree_send_notice', 'boss', {'to': 'w', 'body': 'x'}),
                 ('orgtree_reservation', 'w', {'action': 'list'}),
                 ('orgtree_reservation', 'w', {'action': 'release', 'successor': 'boss'}),
                 ('orgtree_resource_reservation', 'w', {'action': 'list'}))
        for name, node, args in cases:
            with self.subTest(name=name, node=node, args=args):
                got, want = self.plan(name, node, args)
                self.assertEqual(got, want)
        # the done status really plans the parent's mailbox (not a vacuous equality)
        got, _ = self.plan('orgtree_status', 'w', {'status': 'done'})
        self.assertNotEqual(got, self.plan('orgtree_status', 'w', {'status': 'working'})[0])

    def test_reservation_spec_never_reads_a_snapshot(self):
        body = SimpleNamespace(org=self.slug, node='w')
        with patch.object(store, 'cached_org', side_effect=AssertionError('cached')), \
                patch.object(store, 'load_runtime_org', side_effect=AssertionError('runtime')):
            for name in FREE:
                pgdoor._resolve(name, self.slug, body, {'action': 'list'})

    def test_calls_run_without_cached_org(self):
        with patch.object(supervisor, 'send_message', lambda *a, **k: {}), \
                patch.object(api, 'hub_changed', lambda *a, **k: None), \
                patch.object(supervisor.halt, 'blocked', lambda *a, **k: None), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole-org snapshot')):
            out = api.agent_call(api.AgentCall(org=self.slug, node='w', tool='orgtree_send_notice',
                                               args={'to': 'boss', 'body': 'fyi-probe'}), REQUEST)
            self.assertTrue(out.get('delivered') or out.get('deferred'), out)
            out = api.agent_call(api.AgentCall(org=self.slug, node='w', tool='orgtree_status',
                                               args={'status': 'working', 'summary': 'busy'}), REQUEST)
            self.assertIn('recorded', out)
            out = api.agent_call(api.AgentCall(org=self.slug, node='w', tool='orgtree_reservation',
                                               args={'action': 'list'}), REQUEST)
            self.assertIn('reservations', out)
        org = store.load_org(self.slug)
        self.assertEqual(org.nodes['w'].get('last_status', {}).get('summary'), 'busy')


if __name__ == '__main__':
    unittest.main()
