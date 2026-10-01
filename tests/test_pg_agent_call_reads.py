"""Actual-PG: the reads an agent write call makes before its transaction.

agent_call authenticates the caller and then runs the halt/killswitch
pre-gate. Both need the caller's node row; they share ONE runtime read, and
the pre-gate still refuses a halted caller or a latched org with 409."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, ledger, orgtx, store, supervisor

T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
REQUEST = SimpleNamespace(state=SimpleNamespace())
_N = [0]


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class AgentCallReads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        _N[0] += 1
        org = store.create_org(f'acr{_N[0]}')
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 20, 'boss', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(api, 'mail_notify', lambda *a, **k: None),
                  patch.object(api, 'hub_changed', lambda *a, **k: None)]
        for x in self.p:
            x.start()
        self.addCleanup(lambda: [x.stop() for x in self.p])

    def status(self):
        return api.agent_call(api.AgentCall(org=self.slug, node='worker', tool='orgtree_status',
                                            args={'status': 'working', 'summary': 's'}), REQUEST)

    def test_identity_and_halt_pregate_share_one_runtime_read(self):
        self.status()                                      # warm
        reads = []
        original = store.read_runtime_node

        def counting(*a, **k):
            reads.append(a[:2])
            return original(*a, **k)

        with patch.object(store, 'read_runtime_node', counting):
            self.assertNotIn('error', self.status())
        self.assertEqual(reads, [(self.slug, 'worker')])
        self.assertEqual(store.load_org(self.slug).node('worker')['last_status']['summary'], 's')

    def test_a_message_reads_the_org_once_before_its_transaction(self):
        # the before-step's runtime read also plans the message's rows
        send = lambda n: api.agent_call(api.AgentCall(  # noqa: E731
            org=self.slug, node='worker', tool='orgtree_message',
            args={'to': 'boss', 'body': f'hello {n}'}), REQUEST)
        send(0)                                            # warm
        loads = []
        original = store.load_runtime_org

        def counting(slug, *a, **k):
            loads.append(slug)
            return original(slug, *a, **k)

        with patch.object(store, 'load_runtime_org', counting):
            self.assertNotIn('error', send(1))
        self.assertEqual(loads, [self.slug])
        inbox = store.load_org(self.slug).d.get('mail', {}).get('boss') or []
        self.assertIn('hello 1', [m.get('body') for m in inbox])

    def test_a_halted_caller_is_refused_by_the_pregate(self):
        self.status()
        with orgtx.org_tx(self.slug, nodes=['worker']) as tx:
            tx.org.node('worker')['halt'] = True
        with self.assertRaises(api.HTTPException) as caught:
            self.status()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('halted', str(caught.exception.detail))

    def test_a_latched_killswitch_is_refused_by_the_pregate(self):
        self.status()
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d['killswitch'] = {'by': 'user'}
        with self.assertRaises(api.HTTPException) as caught:
            self.status()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('killswitch', str(caught.exception.detail))


if __name__ == '__main__':
    unittest.main()
