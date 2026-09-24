"""P01 S3 legacy boundary contracts for orgtree_hire and orgtree_staff (the agent door).

Disposable SQLite only; the app's lifecycle is not started. The provider gate
(machine state: is the tier's CLI installed and signed in), turn delivery, the UI
spark and the tree broadcast are patched; the agent door, the seat helpers, the
ledger, the docket, save and reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (staffing.*) against
docs/state-system/staffing-boundary.json.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

# left for the OS to reclaim: hires create agent scratch folders under the data
# root that Windows may still hold open when the interpreter exits
_temp = tempfile.mkdtemp(prefix='p01-staffing-boundary-')
_data = Path(_temp) / 'data'
_home = Path(_temp) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, opreceipts, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

HI, ST = 'orgtree_hire', 'orgtree_staff'
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
CARD_ST = 'b77b25e891a35aac05166f56195b7a125fc7cb1017e50709c00ffd4dafd8d69c'
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'retained',
          'coverage', 'legacy_defects', 'scope'}
NAMES = {'staffing.hire', 'staffing.staff-create', 'staffing.staff-update'}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/staffing-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.staffing-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every staffing contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        for name in ('reads', 'conflicts', 'wire', 'instrumentation'):
            self.assertEqual(registry['facets']['staffing.' + name]['status'], 'unresolved', name)
        for name in ('authority', 'predicates', 'writes', 'receipt', 'effects'):
            self.assertEqual(registry['facets']['staffing.' + name]['status'], 'specified', name)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('staffing.staff-update'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_the_selector_names_the_staff_action(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        self.assertEqual(contracts.select(registry, CARD_ST, {'action': 'create'}), ['staffing.staff-create'])
        self.assertEqual(contracts.select(registry, CARD_ST, {'action': ' Update '}), ['staffing.staff-update'])
        # the tool INFERS an omitted action (update with a slug, else create); the
        # selector DSL cannot say that, which is why every selector case names it
        self.assertEqual(contracts.select(registry, CARD_ST, {'slug': 'x'}), [])


class StaffingBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-staffing-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 6, 'mid', **SCOPE)
        org.hire(ledger.USER, None, 'haiku', 5, 'top2', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 0, 'gone', **SCOPE)
        org.retire('top', 'gone')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN'] for n in ('top', 'mid', 'top2')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.enterContext(patch.object(api, 'provider_hire_gate', lambda *a, **k: None))
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    def agent(self, tool, args, actor, key=None, epoch=None):
        body = dict(org=self.slug, node=actor, tool=tool, args=args)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL, args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch))
        return self.client.post('/api/agent', json=body, headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def hire(self, actor, name, **extra):
        return lambda: self.agent(HI, {'name': name, 'tier': 'haiku', 'grant': 0, **SCOPE, **extra}, actor)

    def staff(self, actor, **args):
        return lambda: self.agent(ST, args, actor)

    def item(self, owner, status='open', title='Fixture item'):
        r = self.agent('orgtree_work', dict(action='create', title=title, objective='Problem. Fix.',
                                            owner=owner, status=status), 'top')
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()['created']

    def act(self, request):
        for spy in (self.drive, self.notify, self.hub):
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after

    def refused(self, request, detail, code=422):
        r, changed, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        self.drive.assert_not_called()
        self.notify.assert_not_called()

    def driven(self):
        """[(target, mail_ping, ping_reason)] of every post-save drive."""
        return [(c.args[1], c.kwargs.get('mail_ping'), c.kwargs.get('ping_reason')) for c in self.drive.call_args_list]

    @staticmethod
    def owner(state, slug):
        [w] = [w for w in state['work_items'] if w.get('slug') == slug]
        o = w.get('owner')
        return (o.get('node') if isinstance(o, dict) else o), w.get('status')

    # -- staffing.hire ---------------------------------------------------------
    def test_hire_writes_one_idle_seat_where_it_was_placed(self):
        spec = self.spec
        r, changed, after = self.act(self.hire('mid', 'w1'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), changed), (spec['results']['hire'], spec['sections']['hire_self']))
        self.assertEqual((r.json()['node'], r.json()['started']), ('w1', False))
        self.assertIn('IDLE', r.json()['next_step'])
        self.assertEqual((after['nodes']['w1']['parent'], after['nodes']['w1']['state']), ('mid', 'live'))
        self.assertEqual((self.driven(), self.notify.call_count, self.hub.call_count), ([], 0, 1))
        # a destination in the caller's subtree, under `target` and its older spelling
        for key, name in (('target', 'w2'), ('parent', 'w3')):
            r, changed, after = self.act(self.hire('top', name, **{key: 'mid'}))
            self.assertEqual((r.status_code, after['nodes'][name]['parent']), (200, 'mid'))
            self.assertEqual(changed, spec['sections']['hire_target'])
            told = [x for x in after['notices'].get('mid', []) if (x.get('ev') or {}).get('variant') == 'lifecycle.hired']
            self.assertTrue(told, 'the destination is told its new report')

    def test_a_kickoff_starts_the_seat_once(self):
        spec = self.spec
        r, changed, after = self.act(self.hire('mid', 'w1', kickoff='go'))
        self.assertEqual((sorted(r.json()), changed), (spec['results']['hire_kickoff'], spec['sections']['hire_kickoff']))
        self.assertEqual((r.json()['applied'], r.json()['started']), (['kickoff'], True))
        self.assertEqual(self.driven(), [('w1', True, None)])
        self.assertEqual([c.args[1:] for c in self.notify.call_args_list], [('mid', 'w1')])
        self.assertEqual([(m['from'], m['kind']) for m in after['mail']['w1']], [('mid', 'request')])

    def test_hire_refusals_write_nothing(self):
        bare = lambda actor, **a: lambda: self.agent(HI, dict(name='x', tier='haiku', grant=0, **a), actor)  # noqa: E731
        self.refused(bare('mid', charter='x'), 'has no defaults')
        self.refused(self.hire('top', 'x', target='top2'), 'is outside your subtree')
        self.refused(self.hire('top', 'x', target='mid', hire_type='superior'), 'it cannot also take yours')
        self.refused(bare('top', target='top', hire_type='superior', charter='x'), 'is a top-level agent')
        self.refused(self.hire('mid', 'x', grant=500), 'not enough free credits on the chain')
        self.refused(self.hire('mid', 'x', grant=-1), 'grant must be a non-negative integer')
        self.refused(self.hire('mid', 'x', grant=1.5), 'grant must be a non-negative integer')
        self.refused(self.hire('mid', 'x', tier='nope'), "unknown tier 'nope'")
        self.refused(self.hire('mid', 'x', audiences=['user']), 'you may open only ears within your own reach')
        self.refused(self.hire('mid', 'x', audiences=[['mid']]), 'each audiences entry must be text')
        self.refused(self.hire('mid', 'x', kickoff='go', kickoff_kind='notice'), "kickoff_kind 'notice' contradicts")

    def test_a_superior_insertion_takes_the_anchor_seat(self):
        spec = self.spec
        before = self.durable()
        r, _, after = self.act(lambda: self.agent(HI, dict(name='boss', tier='haiku', grant=0, target='mid',
                                                              hire_type='superior', charter='fixture'), 'top'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()), spec['results']['hire_superior'])
        self.assertEqual((r.json()['inserted_above'], r.json()['reports_to']), ('mid', 'top'))
        nodes = after['nodes']
        self.assertEqual((nodes['boss']['parent'], nodes['mid']['parent']), ('top', 'boss'))
        self.assertEqual((nodes['boss']['scope']['tools'], nodes['boss']['scope']['org_visibility']),
                         (nodes['mid']['scope']['tools'], nodes['mid']['scope']['org_visibility']))
        # the inserted seat is paid out of the anchor's own grant (recorded legacy
        # behaviour): budget-neutral above, one credit less for the anchor
        self.assertEqual((nodes['boss']['grant'], nodes['mid']['grant']), (6, 5))
        self.assertEqual(nodes['top']['grant'], before['nodes']['top']['grant'])

    def test_audiences_follow_the_audience_rules_and_can_start_the_seat(self):
        r, changed, after = self.act(self.hire('mid', 'w1', audiences=['mid']))
        self.assertEqual((r.status_code, r.json()['applied'], r.json()['started']), (200, ['audience:mid'], True))
        self.assertIn('audiences', changed)
        self.assertEqual(self.driven(), [('w1', True, None)])
        # recorded legacy behaviour: no kickoff was sent, yet the result names one
        self.assertIn('its first turn starts on your kickoff', r.json()['next_step'])
        r, _, _ = self.act(self.hire('top', 'w2', audiences=['user']))
        self.assertEqual((r.status_code, r.json()['applied']), (200, ['audience:user']))

    def test_a_work_item_hire_assigns_opens_and_starts(self):
        wid = self.item('top', status='backlogged')
        r, changed, after = self.act(self.hire('top', 'w1', work_item=wid))
        self.assertEqual((r.json()['assigned_item'], r.json()['started']), (wid, True))
        self.assertEqual(self.owner(after, wid), ('w1', 'open'))
        self.assertIn('work_items', changed)
        self.assertEqual(self.driven(), [('w1', True, None)])

    # -- staffing.staff-create / staffing.staff-update ---------------------------
    def test_staff_create_writes_seat_and_item_in_one_save(self):
        spec = self.spec
        r, changed, after = self.act(self.staff('top', title='Staffed', objective='Problem. Fix.', name='s1',
                                                tier='haiku', grant=0, **SCOPE))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), changed), (spec['results']['staff_create'], spec['sections']['staff']))
        self.assertEqual(self.owner(after, r.json()['created']), ('s1', 'open'))
        self.assertEqual((r.json()['assigned_to'], after['nodes']['s1']['parent']), ('s1', 'top'))
        self.assertEqual(self.driven(), [('s1', True, None)])
        self.assertEqual([c.args[1:] for c in self.notify.call_args_list], [('top', 's1')])
        # with a kickoff too: two request mails and two sparks, still ONE drive
        r, _, after = self.act(self.staff('top', action='create', title='Two', objective='P. F.', name='s2',
                                          tier='haiku', grant=0, kickoff='go', **SCOPE))
        self.assertEqual([(m['from'], m['kind']) for m in after['mail']['s2']], [('top', 'request')] * 2)
        self.assertEqual((self.notify.call_count, self.driven()), (2, [('s2', True, None)]))

    def test_staff_update_hands_an_existing_item_over(self):
        spec = self.spec
        wid = self.item('mid')
        r, changed, after = self.act(self.staff('top', action='update', slug=wid, name='s1', tier='haiku',
                                                grant=0, **SCOPE))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()), spec['results']['staff_update'])
        self.assertEqual((r.json()['updated'], self.owner(after, wid)[0]), (wid, 's1'))
        self.assertIn('work_items', changed)
        self.assertTrue(any(m['from'] == '@system' and m['kind'] == 'notice' for m in after['mail'].get('mid', [])),
                        'the previous owner is told')
        self.assertEqual(self.driven(), [('s1', True, None)])

    def test_staff_refusals_write_nothing(self):
        hire = dict(name='x', tier='haiku', grant=0, **SCOPE)
        self.refused(self.staff('top', action='delete', **hire), "orgtree_staff writes the docket with action 'create' or 'update'")
        self.refused(self.staff('top', action='update', **hire), "action 'update' needs `slug`")
        self.refused(self.staff('top', staff_mode='hire', node='gone', title='t', objective='o'), "staff_mode 'hire' does not take `node`")
        self.refused(self.staff('top', staff_mode='rehire', title='t', objective='o'), "staff_mode 'rehire' needs `node`")
        self.refused(self.staff('top', staff_mode='bogus', title='t', objective='o', **hire), 'staff_mode must be hire or rehire')
        # the seat is made first, then the item refuses: the seat goes with the unsaved document
        self.refused(self.staff('top', title='', objective='', **hire), 'a work item needs a title')

    def test_staff_rehire_mode_restores_the_archived_seat(self):
        spec = self.spec
        r, _, after = self.act(self.staff('top', node='gone', title='Back', objective='Problem. Fix.'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()), spec['results']['staff_rehire'])
        self.assertEqual((after['nodes']['gone']['state'], self.owner(after, r.json()['created'])[0]), ('live', 'gone'))
        self.assertEqual(self.driven(), [('gone', True, None)])
        # recorded legacy behaviour: rehire mode on an agent that is already live is
        # not refused — the rehire is a no-op and the item is still assigned
        r, _, after = self.act(self.staff('top', node='mid', title='Live', objective='Problem. Fix.'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('mid is already live — nothing to do', r.json()['warnings'])
        self.assertEqual(self.owner(after, r.json()['created'])[0], 'mid')

    def test_a_rehire_rename_survives_a_later_refusal(self):
        r, changed, after = self.act(self.staff('top', node='gone', name='back', title='', objective=''))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn('a work item needs a title', r.json()['detail'])
        self.assertIn('The RENAME already happened', r.json()['detail'])
        self.assertNotIn('gone', after['nodes'])
        self.assertEqual(after['nodes']['back']['state'], 'archived')
        self.assertIn('nodes', changed)
        self.drive.assert_not_called()

    # -- receipts ------------------------------------------------------------------
    def test_keyed_receipts_and_coverage(self):
        spec = self.spec
        epoch = self.agent(opreceipts.OP_EPOCH, {}, 'top').json()['epoch']
        for tool, args in ((HI, dict(name='k1', tier='haiku', grant=0, **SCOPE)),
                           (ST, dict(title='Keyed', objective='P. F.', name='k2', tier='haiku', grant=0, **SCOPE))):
            with self.subTest(tool=tool):
                key = opreceipts.mint_key()
                self.assertEqual(self.agent(tool, args, 'top', key=key, epoch=epoch).status_code, 200)
                after = self.durable()
                [row] = [x for x in after[opreceipts.SECTION] if x.get('key') == key]
                self.assertEqual(sorted(row['result']), spec['retained'][tool])
                self.drive.reset_mock()
                replay = self.agent(tool, args, 'top', key=key, epoch=epoch).json()
                self.assertTrue(replay['replayed'])
                self.assertEqual(self.durable(), after)
                self.drive.assert_not_called()
        cov = spec['coverage']
        self.assertEqual(opreceipts.coverage(HI, {}), cov['hire'])
        self.assertEqual(opreceipts.coverage(ST, {'title': 't'}), cov['staff'])
        self.assertEqual(opreceipts.coverage(ST, {'node': 'gone'}), cov['staff_rehire'])
        self.assertEqual(opreceipts.coverage(ST, {'node': 'gone', 'name': 'back'}), cov['staff_rehire_named'])


if __name__ == '__main__':
    unittest.main()
