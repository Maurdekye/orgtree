"""Mailbox delivery stages share the ordered runtime clock, never record bodies."""
import import_provenance  # noqa: F401
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from orgtree.orgdb.record_mail_runtime import MailboxOverlays


class MailRuntime(unittest.TestCase):
    def test_socket_unsubscribe_keeps_overlap_and_late_worker_cannot_restore_inputs(self):
        from orgtree import record_api
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        from orgtree.orgdb.record_registry import Selection
        host = OrgHost('org',self.fail)
        source = dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])
        inputs = RuntimeInputs(Cursor('uuid','inc',5),
            {'1':dict(id='agent',state='archived',ask=None,tier='unknown')},
            {'1':SimpleNamespace()}, {}, held=frozenset({'1'}),
            mail={'1':source},mail_held=frozenset({'1'}))
        selected = Selection('sub:1',('1',),({'kind':'agent_mail','agent':'1'},))
        for token in ('one','two'):
            host.runner.clients[token] = SimpleNamespace(selections={1:selected},pending=set())
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            host._adopt(inputs)
            record_api.socket_message(host,'one','{"type":"unsubscribe","sub":1}')
            self.assertIn('1',host.overlay._mail)
            host.leave('two')
            self.assertEqual(host.overlay._mail,{})
            changed = host._adopt(inputs)  # the already-running snapshot finishes
            host._published(SimpleNamespace(answers={},runtime=changed))
            self.assertEqual(host.overlay._mail,{})
            self.assertEqual(host.overlay.full()['agents']['1']['mail_stages'],{})

    def test_host_adopts_mail_only_after_cursor_fence_and_clears_on_unsubscribe(self):
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        body = dict(id='agent',state='archived',ask=None,tier='unknown')
        context = SimpleNamespace()
        host = OrgHost('org',self.fail)
        source = dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            changed = host._adopt(RuntimeInputs(Cursor('uuid','inc',5),{'1':body},{'1':context},{},
                held=frozenset({'1'}),mail={'1':source},mail_held=frozenset({'1'})))
            self.assertEqual(changed['1']['mail_stages'],{'batch':'queued'})
            stale = RuntimeInputs(Cursor('uuid','inc',4),{},{},{},held=frozenset({'1'}),
                                  mail={},mail_held=frozenset())
            self.assertEqual(host._adopt(stale),{})
            self.assertIn('1',host.overlay._mail)
            cleared = host._adopt(RuntimeInputs(Cursor('uuid','inc',5),{},{},{},
                held=frozenset({'1'}),mail={},mail_held=frozenset()))
            self.assertEqual(cleared['1']['mail_stages'],{})
            self.assertEqual(host.overlay._mail,{})

    def test_stage_transition_uses_retained_inputs_and_increases_sequence(self):
        source = dict(slug='org',name='agent',leased=True,batches=[{'tok':'batch'}])
        body = dict(id='agent',state='archived',ask=None,tier='unknown')
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}) as stages:
            overlay = MailboxOverlays('uuid','inc')
            overlay.adopt_mail({'1':source})
            overlay.adopt({'1':body},{'1':SimpleNamespace()})
            initial = overlay.full()['agents']['1']
            self.assertEqual(initial['mail_stages'],{'batch':'queued'})
            stages.assert_called_with('org','agent',[{'tok':'batch'}],leased=True)
            source['batches'].clear()
            stages.return_value = {'batch':'steer'}
            changed = overlay.transition(['agent'])['1']
            self.assertGreater(changed['seq'],initial['seq'])
            self.assertEqual(changed['epoch'],initial['epoch'])
            self.assertEqual(changed['mail_stages'],{'batch':'steer'})
            stages.assert_called_with('org','agent',[{'tok':'batch'}],leased=True)
            self.assertNotIn('mail_stages',body)

    def test_unsubscribe_drops_retained_batches_and_sends_empty_stage_map(self):
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            overlay = MailboxOverlays('uuid','inc')
            overlay.adopt_mail({'1':dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])})
            overlay.adopt({'1':dict(id='agent',state='archived',ask=None,tier='unknown')},{'1':SimpleNamespace()})
            changed = overlay.adopt_mail({},removed=('1',))
            self.assertEqual(changed['1']['mail_stages'],{})
            self.assertEqual(overlay._mail,{})


if __name__ == '__main__':
    unittest.main()
