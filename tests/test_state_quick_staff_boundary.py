"""P01 S3 legacy boundary contracts for the operator staffing chooser: staffing-options and quick staff.

Disposable SQLite only; the app's lifecycle is not started. Provider discovery, the
provider gate, account reasons, advertised efforts and turn delivery are machine state
and are patched to a fixed offer (the snapshot is recomputed on every read); the
desktop token gate, the routes, quickstaff, the ledger, the docket, save and reload are
real. Each test pins a fact stated in docs/state-system/operation-contracts.json
(quick-staff.*) against docs/state-system/quick-staff-boundary.json.
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
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

# left for the OS to reclaim: seats create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-quick-staff-boundary-')
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
from orgtree import agentauth, api, appsettings, ledger, quickstaff, staffcache, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'ping',
          'legacy_defects', 'scope'}
NAMES = {'quick-staff.options', 'quick-staff.options-refresh', 'quick-staff.preview', 'quick-staff.select'}
OFFER = {'providers': [{'id': 'claude', 'hire_enabled': True, 'tiers': [{'tier': 'haiku', 'seat': 1}]},
                       {'id': 'openai', 'hire_enabled': True, 'tiers': [{'tier': 'luna', 'seat': .2}]}]}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/quick-staff-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.quick-staff-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every quick-staff contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        for name in ('reads', 'conflicts', 'wire', 'instrumentation'):
            self.assertEqual(registry['facets']['quick-staff.' + name]['status'], 'unresolved', name)
        # both callers of _staff_call are contracted now, so its create branch maps back
        # to the one contract that takes it (quick staff always sends action update)
        rows = {r['id'][:8]: r for r in registry['dispatch']}
        self.assertEqual(rows['f2c32b21']['contracts'], ['staffing.staff-create'])
        self.assertIn('quick-staff.select', rows['41f82592']['contracts'])

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('quick-staff.select'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class QuickStaffBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-quick-staff-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.d['tiers'] = {'haiku': 1, 'luna': .2}
        org.hire(ledger.USER, None, 'haiku', 4, 'mgr', add_dirs=[], tools=NO_TOOLS, org_visibility='self', charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.agent_token = agentauth.child_env(self.slug, 'mgr')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.enterContext(patch.object(api, 'provider_hire_gate', lambda *a, **k: None))
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message',
                                                    return_value={'accepted': True, 'queued': 0}))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.enterContext(patch.object(quickstaff, 'account_reason', return_value=None))
        self.enterContext(patch.object(quickstaff, 'supported_efforts', return_value=['low', 'high']))
        self.enterContext(patch.object(api, '_providers_payload', return_value=copy.deepcopy(OFFER)))
        self.enterContext(patch.object(staffcache, 'read', side_effect=lambda **kw: staffcache._compute()))
        self.warm = self.enterContext(patch.object(staffcache, 'warm'))
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        self.mode('request')
        appsettings.set_quick_staff_request_accounts(False)

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)

    @staticmethod
    def mode(value):
        appsettings.set_quick_staff_behavior(value)

    def ticket(self, title, notes=False):
        with store.write_org(self.slug) as org:
            extra = dict(done_so_far=['Described it.'], working_on_next=['Do it.']) if notes else {}
            wid = org.work_create('mgr', title, 'Problem. Fix.', status='backlogged', owner='mgr', **extra)['slug']
            store.save_org(org)
        return wid

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    @staticmethod
    def item(state, wid):
        [w] = [w for w in state['work_items'] if w['slug'] == wid]
        return w

    def path(self, wid):
        return f'/api/orgs/{self.slug}/work-items/{wid}/quick-staff'

    def call(self, method, path, body=None, headers=OP):
        return lambda: self.client.request(method, path, json=body, headers=headers)

    def act(self, request):
        for spy in (self.drive, self.notify, self.hub, self.warm):
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after

    def refused(self, request, detail, code=422):
        r, changed, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual((changed, self.hub.call_count), ([], 0))
        self.drive.assert_not_called()

    def selection(self, wid, **extra):
        p = self.client.get(self.path(wid), headers=OP).json()
        return {**{k: p[k] for k in ('mode', 'configured_mode', 'owner')}, 'request_id': str(uuid.uuid4()), **extra}

    def driven(self):
        return [(c.args[1], c.kwargs.get('mail_ping'), c.kwargs.get('ping_reason')) for c in self.drive.call_args_list]

    # -- staffing-options ----------------------------------------------------------
    def test_options_read_and_refresh_write_nothing(self):
        spec = self.spec
        r, changed, _ = self.act(self.call('GET', f'/api/orgs/{self.slug}/staffing-options'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), changed, self.hub.call_count), (spec['results']['options'], [], 0))
        # the org's tiers the (patched-off) provider gate and the account boards admit: all of them here
        self.assertEqual({t['tier'] for t in r.json()['tiers']}, set(self.durable()['tiers']))
        self.assertEqual(r.json()['errors'], [])
        generation = staffcache.state()['generation']
        r, changed, _ = self.act(self.call('POST', f'/api/orgs/{self.slug}/staffing-options/refresh'))
        self.assertEqual((sorted(r.json()), changed, self.hub.call_count), (spec['results']['refresh'], [], 0))
        self.assertEqual(r.json()['generation'], generation + 1)
        self.warm.assert_called_once_with('manual retry')
        self.refused(self.call('GET', f'/api/orgs/{self.slug}/staffing-options',
                               headers={'X-Orgtree-Agent-Token': self.agent_token}),
                     'agent credential is invalid or expired', code=401)

    # -- quick-staff.preview ----------------------------------------------------------
    def test_preview_follows_the_mode_and_needs_a_backlogged_ticket(self):
        spec = self.spec
        wid = self.ticket('Repair the widget')
        for mode in ('request', 'under_assignee', 'top_level'):
            with self.subTest(mode=mode):
                self.mode(mode)
                r, changed, _ = self.act(self.call('GET', self.path(wid)))
                self.assertEqual((r.status_code, sorted(r.json()), changed), (200, spec['results']['preview'], []))
                self.assertEqual((r.json()['mode'], r.json()['configured_mode'], r.json()['owner']['node']), (mode, mode, 'mgr'))
                # request mode offers the provider document's models; the immediate modes every org tier a trial hire admits
                want = ['haiku', 'luna'] if mode == 'request' else None
                got = [m['tier'] for m in r.json()['models']]
                self.assertEqual(got, want) if want else self.assertEqual(set(got), set(self.durable()['tiers']))
        with store.write_org(self.slug) as org:
            org.work_update('mgr', wid, ['x'], ['y'], status='open')
            store.save_org(org)
        self.refused(self.call('GET', self.path(wid)), 'Quick staff is available only for backlogged tickets')

    # -- quick-staff.select --------------------------------------------------------------
    def test_request_commit_opens_mails_and_replays(self):
        spec = self.spec
        wid = self.ticket('Repair the widget')
        body = self.selection(wid, tier='haiku', effort='high')
        r, changed, after = self.act(self.call('POST', self.path(wid), body))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), changed), (spec['results']['request'], spec['sections']['request']))
        w = self.item(after, wid)
        self.assertEqual((w['status'], w['owner']['node'], w['working_on_next']), ('open', 'mgr', ['Staff the ticket.']))
        self.assertEqual(sorted(w['quick_staff_receipts']), [body['request_id']])
        [mail] = after['mail']['mgr']
        self.assertEqual((mail['from'], mail['kind']), ('@user', 'request'))
        self.assertIn('Suggested model: haiku.', json.dumps(after['mail']['mgr']))
        self.assertIn('Suggested effort: high.', json.dumps(after['mail']['mgr']))
        self.assertEqual(self.driven(), [('mgr', True, spec['ping']['ping_reason'])])
        self.assertEqual(([c.args[1:] for c in self.notify.call_args_list], self.hub.call_count), ([('@user', 'mgr')], 1))
        # the same request id and selection replays; a different selection under it is refused
        r, changed, _ = self.act(self.call('POST', self.path(wid), body))
        self.assertEqual((r.json()['replayed'], changed, self.drive.call_count, self.hub.call_count), (True, [], 0, 0))
        self.refused(self.call('POST', self.path(wid), {**body, 'tier': 'luna'}),
                     'That staffing request id already belongs to a different selection.')

    def test_commit_refusals_write_nothing(self):
        wid = self.ticket('Repair the widget')
        body = self.selection(wid)
        self.refused(self.call('POST', self.path(wid), {**body, 'mode': 'top_level'}), 'The staffing behavior or assignee changed')
        self.refused(self.call('POST', self.path(wid), {**body, 'effort': 'high'}), 'Select a model before choosing an effort.')
        self.refused(self.call('POST', self.path(wid), {**body, 'tier': 'haiku', 'account': 'claude/primary'}),
                     'Request staffing cannot pin an account')
        self.refused(self.call('POST', self.path(wid), {**body, 'tier': 'haiku'}, headers={'X-Orgtree-Agent-Token': self.agent_token}),
                     'agent credential is invalid or expired', code=401)
        self.mode('under_assignee')
        self.refused(self.call('POST', self.path(wid), self.selection(wid)), 'Immediate staffing requires a model.')

    def test_immediate_modes_seat_under_the_assignee_or_at_top_level(self):
        spec = self.spec
        for mode, parent in (('under_assignee', 'mgr'), ('top_level', None)):
            with self.subTest(mode=mode):
                self.mode(mode)
                wid = self.ticket('Repair ' + mode)
                seen = len(self.durable()['mail'].get('mgr', []))
                r, changed, after = self.act(self.call('POST', self.path(wid), self.selection(wid, tier='haiku', effort='low')))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual((sorted(r.json()), changed), (spec['results'][mode], spec['sections']['immediate']))
                node = r.json()['node']
                self.assertEqual(node, wid)                                   # the seat is named from the ticket title
                self.assertEqual((after['nodes'][node]['parent'], after['nodes'][node]['scope'].get('effort')), (parent, 'low'))
                self.assertEqual((self.item(after, wid)['owner']['node'], self.item(after, wid)['status']), (node, 'open'))
                self.assertEqual(self.driven(), [(node, True, spec['ping']['ping_reason'])])
                self.assertEqual(self.notify.call_count, 2)                    # the assignment and the kickoff each spark
                told = [(m['from'], m['kind']) for m in after['mail'].get('mgr', [])[seen:]]
                self.assertIn(('@system', 'notice'), told)                     # the item left mgr
                self.assertEqual(('@user', 'notice') in told, mode == 'under_assignee')

    def test_a_refused_kickoff_undoes_a_request_but_not_a_seat(self):
        self.drive.return_value = {'accepted': False, 'error': 'halted'}
        # request mode, ticket with progress notes: the compensating undo restores it
        wid = self.ticket('Noted ticket', notes=True)
        r, changed, after = self.act(self.call('POST', self.path(wid), self.selection(wid, tier='haiku')))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn('The ticket is back where it was', r.json()['detail'])
        w = self.item(after, wid)
        self.assertEqual((w['status'], w.get('quick_staff_receipts') or {}), ('backlogged', {}))
        self.assertEqual(after['mail'].get('mgr', []), [])                   # the request was retracted
        # recorded legacy defect: with EMPTY progress lists the undo itself is refused
        # ('both empty'), escapes as an unhandled 500, and nothing is undone
        wid = self.ticket('Bare ticket')
        r, _, after = self.act(self.call('POST', self.path(wid), self.selection(wid, tier='haiku')))
        self.assertEqual(r.status_code, 500, r.text)
        self.assertIn('both empty', r.text)
        self.assertEqual(self.item(after, wid)['status'], 'open')
        self.assertEqual([m['kind'] for m in after['mail']['mgr']], ['request'])
        # an immediate mode keeps the seat and reports the failed kickoff
        self.mode('top_level')
        wid = self.ticket('Seat ticket')
        r, _, after = self.act(self.call('POST', self.path(wid), self.selection(wid, tier='haiku')))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('would not accept a turn: halted', r.json()['kickoff_failed'])
        self.assertIn(r.json()['node'], after['nodes'])


if __name__ == '__main__':
    unittest.main()
