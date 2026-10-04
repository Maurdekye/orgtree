"""Actual audience use pauses current-chain grants and never deletes them."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

from copy import deepcopy
import os
import tempfile
import unittest
from unittest.mock import patch

_old_data = os.environ.get('ORGTREE_DATA')
_data = tempfile.TemporaryDirectory(prefix='orgtree-audience-scope-')
os.environ['ORGTREE_DATA'] = _data.name

from orgtree import ledger, scope_chain  # noqa: E402
from orgtree.orgdb import native_move  # noqa: E402


def tearDownModule():
    _data.cleanup()
    if _old_data is None:
        os.environ.pop('ORGTREE_DATA', None)
    else:
        os.environ['ORGTREE_DATA'] = _old_data


class AudienceAvailability(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create('audience-controls')
        self.org.hire(ledger.USER, None, 'luna', 20, 'wide')
        self.org.hire(ledger.USER, None, 'luna', 20, 'other')
        self.org.hire(ledger.USER, 'wide', 'luna', 5, 'parent')
        self.org.hire(ledger.USER, 'parent', 'luna', 0, 'child')
        self.org.d['org_inbox_multi_holder'] = True
        self.native = patch.object(native_move, 'enabled', return_value=True)
        self.native.start()
        self.addCleanup(self.native.stop)

    def grant(self, grantor='wide', **extra):
        record = dict(grantee='child', grantor=grantor, granted_at='fixed',
                      reason='configured', unknown={'keep': [1, 2]}, **extra)
        self.org.d['audiences'].append(record)
        return record

    def test_actual_has_and_display_pause_then_restore_without_editing_grant(self):
        record = self.grant()
        before = deepcopy(record)
        self.assertTrue(self.org._has_audience('child', 'wide'))
        self.org.node('parent')['parent'] = 'other'
        self.assertFalse(self.org._has_audience('child', 'wide'))
        self.assertEqual(self.org.audience_summary('child'),
                         {'audiences_held': [], 'audiences_paused': ['wide']})
        self.assertFalse(self.org.audience_records()[0]['available'])
        self.assertEqual(record, before)
        self.org.node('parent')['parent'] = 'wide'
        self.assertTrue(self.org._has_audience('child', 'wide'))
        self.assertEqual(record, before)

    def test_delegated_lateral_channel_uses_delegator_not_grantor_ancestry(self):
        self.grant('other', delegated_by='wide')
        self.assertTrue(self.org._has_audience('child', 'other'))
        self.org.node('parent')['parent'] = 'other'
        self.assertFalse(self.org._has_audience('child', 'other'))
        self.org.node('parent')['parent'] = 'wide'
        self.assertTrue(self.org._has_audience('child', 'other'))

    def test_user_and_unanchored_extern_exceptions_remain_exact(self):
        self.grant(ledger.USER, delegated_by='gone')
        self.grant(ledger.EXTERN)
        self.org.node('parent')['parent'] = 'other'
        self.assertTrue(self.org._has_audience('child', ledger.USER))
        self.assertTrue(self.org._has_audience('child', ledger.EXTERN))
        self.assertEqual(self.org.extern_holders(), ['child'])

    def test_extern_null_anchor_is_not_mistaken_for_absent_anchor(self):
        self.grant(ledger.EXTERN, delegated_by=None)
        self.assertFalse(self.org._has_audience('child', ledger.EXTERN))
        self.assertEqual(self.org.extern_holders(), [])

    def test_extern_holders_filter_paused_before_single_holder_selection(self):
        self.grant(ledger.EXTERN, delegated_by='wide')
        self.org.d['audiences'].append(dict(grantee='other', grantor=ledger.EXTERN,
                                           delegated_by='wide'))
        self.org.d['org_inbox_multi_holder'] = False
        self.assertEqual(self.org.extern_holders(), ['child'])
        self.org.node('parent')['parent'] = 'other'
        self.assertEqual(self.org.extern_holders(), [])

    def test_explicit_revoke_is_permanent_even_after_chain_restoration(self):
        self.grant()
        self.org.node('parent')['parent'] = 'other'
        self.org.audience_revoke(ledger.USER, 'child', 'wide')
        self.org.node('parent')['parent'] = 'wide'
        self.assertFalse(self.org._has_audience('child', 'wide'))
        self.assertEqual(self.org.d['audiences'], [])

    def test_explicit_grant_renews_paused_pair_preserving_unknown_payload_and_order(self):
        record = self.grant('wide', delegated_by='other')
        self.assertFalse(self.org._has_audience('child', 'wide'))
        self.org.audience_grant('wide', 'child')
        self.assertEqual(len(self.org.d['audiences']), 1)
        self.assertIs(self.org.d['audiences'][0], record)
        self.assertEqual(record['unknown'], {'keep': [1, 2]})
        self.assertNotIn('delegated_by', record)
        self.assertTrue(self.org._has_audience('child', 'wide'))

    def test_native_sweep_does_not_even_read_the_audience_list(self):
        self.org.d = {'nodes': {}}
        self.assertEqual(self.org._sweep_audiences(), [])

    def test_authority_checks_actual_transaction_path_before_cached_ancestor(self):
        self.grant()
        raw = object()
        with patch.object(native_move, 'connection', return_value=raw), \
                patch.object(native_move.graph, 'check_scope_paths',
                             side_effect=scope_chain.ScopeError('unheld current path')) as guard:
            with self.assertRaisesRegex(scope_chain.ScopeError, 'unheld'):
                self.org._has_audience('child', 'wide')
        guard.assert_called_once_with(raw, {'child', 'wide'})

    def test_authority_uses_fresh_locked_physical_parents_not_loaded_cached_path(self):
        self.grant()
        raw = object()
        parents = {'child': 'parent', 'parent': 'other', 'other': None, 'wide': None}
        with patch.object(native_move, 'connection', return_value=raw), \
                patch.object(native_move.graph, 'check_scope_paths', return_value=parents):
            self.assertFalse(self.org._has_audience('child', 'wide'))
        self.assertEqual(self.org.node('parent')['parent'], 'wide')

    def test_corrupt_chain_refuses_instead_of_authorizing_from_partial_cycle(self):
        self.grant()
        self.org.node('wide')['parent'] = 'child'
        with self.assertRaisesRegex(scope_chain.ScopeError, 'cyclic'):
            self.org._has_audience('child', 'wide')

    def test_legacy_grant_use_display_and_destructive_sweep_stay_unchanged(self):
        self.grant()
        self.org.node('parent')['parent'] = 'other'
        with patch.object(native_move, 'enabled', return_value=False):
            self.assertTrue(self.org._has_audience('child', 'wide'))
            self.assertEqual(self.org.audience_summary('child'), {'audiences_held': ['wide']})
            self.assertIs(self.org.audience_records(), self.org.d['audiences'])
            self.assertEqual(self.org._sweep_audiences(), [('child', 'wide')])
            self.assertEqual(self.org.d['audiences'], [])


if __name__ == '__main__':
    unittest.main()
