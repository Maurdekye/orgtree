"""File-panel invalidations occur after successful delivery, never on refusal."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from orgtree import api

class FileEvents(unittest.TestCase):
    def test_only_successful_file_or_presentations_notify(self):
        with patch.object(api.supervisor, 'notify') as notify:
            for tool, result in [('orgtree_send_file', {'sent': {'path': 'outbox/x'}}),
                                 ('orgtree_present', {'presented': 'd'}),
                                 ('orgtree_submit_report', {'presentation': {'id': 'd'}})]:
                api._file_panel_notice('org', 'agent', tool, result)
            self.assertEqual(notify.call_count, 3)
            self.assertEqual(notify.call_args.args, ('org', 'agent', 'file_presented'))
            for tool, result in [('orgtree_message', {'sent': True}),
                                 ('orgtree_present', {}), ('orgtree_submit_report', {'presentation': None})]:
                api._file_panel_notice('org', 'agent', tool, result)
            self.assertEqual(notify.call_count, 3)

    def test_delivery_notifies_after_scope_success_and_never_after_refusal(self):
        org = SimpleNamespace(d={'slug': 'org'})
        order = []
        result = {'sent': {'path': 'outbox/file'}}
        with patch('orgtree.scope_actions.run', side_effect=lambda *a: order.append('delivered') or result), \
                patch.object(api.supervisor, 'notify', side_effect=lambda *a: order.append('notified')):
            self.assertIs(api._agent_send_file(org, 'agent', {}, notify_panel=True), result)
        self.assertEqual(order, ['delivered', 'notified'])
        with patch('orgtree.scope_actions.run', side_effect=ValueError('refused')), \
                patch.object(api.supervisor, 'notify') as notify:
            with self.assertRaises(ValueError):
                api._agent_send_file(org, 'agent', {}, notify_panel=True)
            notify.assert_not_called()

    def test_notify_failure_keeps_successful_delivery_and_discloses_warning(self):
        result = {'sent': {'path': 'outbox/file'}}
        with patch.object(api.supervisor, 'notify', side_effect=RuntimeError('offline')):
            api._file_panel_notice('org', 'agent', 'orgtree_send_file', result)
        self.assertIn('sent', result)
        self.assertTrue(result.get('warnings'))
if __name__ == '__main__':
    unittest.main()
