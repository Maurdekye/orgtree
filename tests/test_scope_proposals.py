"""Actual read-only proposals use effective permissions and retain configuration."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

from copy import deepcopy
import unittest
from unittest.mock import patch

from orgtree import ledger, quickstaff, statepreview
from orgtree.orgdb import native_move


class ScopeProposals(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create('scope-proposals')
        self.org.hire(ledger.USER, None, 'haiku', 20, 'boss')
        self.org.hire(ledger.USER, None, 'haiku', 20, 'other')
        self.org.hire(ledger.USER, 'boss', 'haiku', 5, 'parent')
        self.org.hire(ledger.USER, 'parent', 'haiku', 0, 'leaf')
        for name in ('boss', 'parent', 'leaf'):
            self.org.node(name)['scope'].update(permission_mode='bypassPermissions',
                                                org_visibility='full')
        self.org.node('other')['scope'].update(permission_mode='plan', org_visibility='self')
        self.org.node('other')['scope']['tools'] = {
            'bash': False, 'edit': False, 'web': False, 'subagents': False, 'mcp': []}
        self.configured = deepcopy(self.org.node('leaf')['scope'])
        self.enterContext(patch.object(native_move, 'enabled', return_value=True))

    def test_actual_inspection_limits_visible_nodes_by_current_chain(self):
        before = statepreview.inspect_state(self.org, 'leaf')
        self.assertEqual(before['visibility'], 'full')
        self.org.node('parent')['parent'] = 'other'
        current = statepreview.inspect_state(self.org, 'leaf')
        self.assertEqual(current['visibility'], 'self')
        self.assertEqual([row['id'] for row in current['nodes']], ['leaf'])
        self.assertEqual(current['nodes'][0]['scope']['permission_mode'], 'plan')
        self.assertFalse(current['nodes'][0]['scope']['tools']['edit'])
        with self.assertRaisesRegex(ledger.LedgerError, 'outside your visible scope'):
            statepreview.inspect_state(self.org, 'leaf', ['boss'])
        self.org.node('parent')['parent'] = 'boss'
        self.assertEqual(statepreview.inspect_state(self.org, 'leaf')['visibility'], 'full')
        self.assertEqual(self.org.node('leaf')['scope'], self.configured)

    def test_actual_staff_proposal_uses_owner_current_capabilities(self):
        item = {'title': 'Fixture staffing', 'slug': 'fixture-staffing'}
        ctx = {'mode': 'under_assignee', 'owner': {'node': 'leaf'}}
        before = quickstaff.staff_args(self.org, item, ctx, 'haiku')
        self.org.node('parent')['parent'] = 'other'
        current = quickstaff.staff_args(self.org, item, ctx, 'haiku')
        self.assertTrue(before['tools']['edit'])
        self.assertFalse(current['tools']['edit'])
        self.assertEqual(current['permission_mode'], 'plan')
        self.assertEqual(current['org_visibility'], 'self')
        self.assertEqual(current['target'], 'leaf')
        self.org.node('parent')['parent'] = 'boss'
        self.assertEqual(quickstaff.staff_args(self.org, item, ctx, 'haiku'), before)
        self.assertEqual(self.org.node('leaf')['scope'], self.configured)


if __name__ == '__main__':
    unittest.main()
