"""Actual read-only proposals use effective permissions and retain configuration."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

from copy import deepcopy
import unittest
from unittest.mock import patch

from orgtree import api, ledger, lifecycle_door, quickstaff, statepreview
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

    def test_actual_autopsy_and_replacement_inherit_effective_tools(self):
        self.org.d['tiers']['fable'] = 1  # small fixture budget, same funding rules
        self.org.node('parent')['parent'] = 'other'
        result = self.org._execute_auto_autopsy('leaf', 'fixture filter', 'haiku')
        for key in ('autopsy_id', 'rep_id'):
            node = self.org.node(result[key])
            self.assertFalse(node['scope']['tools']['edit'])
            self.assertEqual(node['scope']['tools']['mcp'], [])
            self.assertEqual(node['scope']['org_visibility'], 'self')
        self.assertEqual(self.org.node('leaf')['scope'], self.configured)

    def test_agent_superior_hire_uses_current_limits_then_preserves_seat_configuration(self):
        self.org.node('parent')['parent'] = 'other'
        configured = deepcopy(self.org.node('parent')['scope'])
        with patch.object(api, 'provider_hire_gate'):
            result = api._hire_seat(self.org, 'scope-proposals', 'other',
                                   dict(tier='haiku', name='lead', grant=0,
                                        target='parent', hire_type='superior'), [])
        self.assertEqual(result['inserted_above'], 'parent')
        self.assertEqual(self.org.node('parent')['parent'], 'lead')
        self.assertEqual(self.org.node('lead')['scope'], configured)
        self.assertFalse(self.org.capability_scope('lead')['tools']['edit'])
        self.assertEqual(self.org.capability_scope('parent')['org_visibility'], 'self')

    def test_operator_superior_hire_uses_current_limits_then_preserves_seat_configuration(self):
        self.org.node('parent')['parent'] = 'other'
        configured = deepcopy(self.org.node('parent')['scope'])
        with patch.object(api, 'provider_hire_gate'):
            result = api._op_hire(self.org, api.Op(op='hire', actor='other',
                                  tier='haiku', name='lead', grant=0,
                                  parent='other', above='parent'), None)
        self.assertEqual(result['inserted_above'], 'parent')
        self.assertEqual(self.org.node('parent')['parent'], 'lead')
        self.assertEqual(self.org.node('lead')['scope'], configured)
        self.assertFalse(self.org.capability_scope('lead')['tools']['edit'])

    def test_native_folder_revocation_plans_no_descendants(self):
        with patch.object(self.org, 'descendants',
                          side_effect=AssertionError('native scope plan walked descendants')):
            updates, shares = lifecycle_door.revoke_dir_rows(self.org, 'boss', 'parent')
        self.assertEqual(updates, {'parent'})
        self.assertEqual(shares, {'boss'})


if __name__ == '__main__':
    unittest.main()
