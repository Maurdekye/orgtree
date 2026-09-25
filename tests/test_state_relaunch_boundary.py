"""P01 relaunch-cards item: legacy boundary contracts for the desktop relaunch entry points and the deprecated
orgtree_self_update, per product profile.

Disposable SQLite only; the app's lifecycle is not started. Under the desktop-managed profile (the app's own:
engine.launch sets ORGTREE_DESKTOP_MANAGED=1 and installs the desktop maintenance adapter) the REAL adapter runs and
writes its machine-wide request file, <DATA_ROOT>/desktop-maintenance.json, inside this test's temporary data root.
The non-desktop profile is exercised by clearing that flag for the call; there the launch and the quiesce are spies,
because the real launch starts a detached deploy. The doors, the gates, the receipts, save and reload are real. Each
test pins a fact stated in docs/state-system/operation-contracts.json (relaunch.*) against
docs/state-system/relaunch-boundary.json.
"""
from __future__ import annotations

import contextlib
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

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-relaunch-boundary-')
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
from orgtree import agentauth, api, deployment, desktop_maintenance, ledger, opreceipts, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'
assert os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1', 'the desktop-managed profile is the app under test'
assert api.supervisor.launch_self_restart is desktop_maintenance.request, 'the desktop adapter is installed'

NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'receipts', 'profiles',
          'legacy_defects', 'scope'}
MAINT = Path(store.DATA_ROOT) / 'desktop-maintenance.json'
S, P, U = 'orgtree_self_relaunch', 'orgtree_prime_relaunch', 'orgtree_self_update'


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/relaunch-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.relaunch-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('relaunch.')}:
        raise ValueError('every relaunch contract is required')
    return d


def maintenance():
    try:
        return json.loads(MAINT.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(spec['contracts'], {'relaunch.self-relaunch': S, 'relaunch.prime-relaunch-arm': P,
                                             'relaunch.prime-relaunch-cancel': P, 'relaunch.prime-relaunch-status': P,
                                             'relaunch.self-update': U})
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry['facets']['relaunch.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('relaunch.self-update'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_action_selectors_read_the_action_as_the_door_does(self):
        # the door reads str(a.get("action") or "arm") and refuses anything but arm, cancel and status (pinned in
        # test_prime_relaunch_arm_cancel_and_status); the selectors use the same reading (str_or_arm)
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        [card] = {e for c in registry['contracts'].values() if P in c['tools'] for e in c['entry_ids']}
        for act in ('arm', 'cancel', 'status'):
            self.assertEqual(contracts.select(registry, card, {'action': act}), ['relaunch.prime-relaunch-' + act])
        for falsy in ({}, {'action': None}, {'action': ''}, {'action': 0}, {'action': False}, {'action': []}):
            with self.subTest(args=falsy):
                self.assertEqual(contracts.select(registry, card, falsy), ['relaunch.prime-relaunch-arm'])
        for unknown in ('bogus', 'ARM', ' arm', 1, True):
            with self.subTest(action=unknown):
                self.assertEqual(contracts.select(registry, card, {'action': unknown}), [])

    def test_the_rows_f2_left_pending_are_mapped_and_the_other_verbs_are_owned(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        source = contracts.inventory.scan(ROOT)
        dispatch = {r['id']: r for r in registry['dispatch']}
        mapped = {}
        for s in source['dispatch_selectors']:
            r = dispatch[contracts.witness_id('dispatch', s)]
            self.assertNotIn('deprecated alias orgtree_self_update', r['reason'])
            if 'P01 relaunch-cards item' in r['reason']:
                self.assertEqual(r['disposition'], 'mapped')
                mapped[(s['source']['symbol'], tuple(s['values']))] = sorted(r['contracts'])
        self.assertEqual(len(mapped), 10)       # eleven rows: the shared self_restart/self_update pair twice
        self.assertEqual(mapped[('Org.prime_restart_gate', ('arm',))],
                         ['control.prime-restart-arm', 'relaunch.prime-relaunch-arm'])
        self.assertEqual(mapped[('agent_call', ('orgtree_self_restart', 'orgtree_self_update'))],
                         ['control.self-restart', 'relaunch.self-update'])
        entries = {r['id']: r for r in registry['entries']}
        verbs = {}
        for s in source['registrations']:
            if s['kind'] == 'tool_verb' or (s['kind'] == 'tool' and s['names'][0] in (S, P)):
                verbs[s['names'][0]] = entries[contracts.witness_id('entries', s)]
        self.assertEqual({n: r['disposition'] for n, r in verbs.items()}, {
            S: 'mapped', P: 'mapped', U: 'mapped', 'orgtree_account_assign': 'pending', 'orgtree_op_call': 'pending',
            'orgtree_op_epoch': 'pending', 'orgtree_op_lookup': 'pending', 'orgtree_operation_census': 'pending',
            'orgtree_send_file_once': 'pending'})
        for n, r in verbs.items():
            if r['disposition'] == 'pending':
                self.assertIn('Owner: ', r['reason'], n)


class RelaunchBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        MAINT.unlink(missing_ok=True)
        self.addCleanup(MAINT.unlink, missing_ok=True)
        org = store.create_org(f'p01-relaunch-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 6, 'mid', **SCOPE)
        org.hire('top', 'mid', 'haiku', 2, 'leaf', **SCOPE)
        org.hire(ledger.USER, None, 'haiku', 5, 'top2', add_dirs=[], tools={}, charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('top', 'mid', 'leaf', 'top2')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        sup = api.supervisor
        spy = lambda target, name, **kw: self.enterContext(patch.object(target, name, **kw))  # noqa: E731
        spy(sup, 'send_message', return_value={'delivered': True})
        spy(sup, 'delivery_note', return_value='fixture carrier')
        spy(api, 'mail_notify')
        self.hub = spy(api, 'hub_changed')
        spy(sup, 'notify')
        spy(sup, 'maybe_storage_check')
        self.quiesce = spy(sup, 'force_quiesce_for_restart',
                           return_value={'ok': True, 'hold_token': 'fixture', 'cut': [], 'not_settled': []})

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def fresh(self):
        self.doCleanups()
        self.setUp()

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    # -- requests --------------------------------------------------------------------------------------------------
    def agent(self, tool, args, actor, client=None):
        return lambda: (client or self.client).post(
            '/api/agent', json=dict(org=self.slug, node=actor, tool=tool, args=args),
            headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def keyed(self, tool, args, actor):
        key = opreceipts.mint_key()

        def go():
            head = {'X-Orgtree-Agent-Token': self.tokens[actor]}
            epoch = self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=opreceipts.OP_EPOCH,
                                                             args={}), headers=head).json()['epoch']
            return self.client.post('/api/agent', json=dict(
                org=self.slug, node=actor, tool=opreceipts.OP_CALL,
                args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch)), headers=head)
        return go

    @staticmethod
    def twice(request):
        def go():
            request()
            return request()
        return go

    @contextlib.contextmanager
    def non_desktop(self):
        """The non-desktop profile for the duration of one request, with the launch functions spied (the launch spy
        stays on self.launch for the assertions after the call)."""
        sup = api.supervisor
        saved = os.environ.pop('ORGTREE_DESKTOP_MANAGED')
        try:
            with patch.object(sup, 'launch_self_restart', return_value={'launched': 'spy'}) as self.launch, \
                    patch.object(sup, 'arm_prime_restart', return_value={'armed': 'spy'}), \
                    patch.object(sup, 'cancel_prime_restart', return_value={'cancelled': 'spy'}), \
                    patch.object(sup, 'primed_restart', return_value=None):
                yield
        finally:
            os.environ['ORGTREE_DESKTOP_MANAGED'] = saved

    @contextlib.contextmanager
    def frozen(self):
        """The frozen deployment profile for the duration of one request."""
        with patch.object(api.deployment, 'current_policy', return_value=deployment.FROZEN):
            yield

    @contextlib.contextmanager
    def frozen_non_desktop(self):
        with self.frozen(), self.non_desktop():
            yield

    # -- fixture states --------------------------------------------------------------------------------------------
    def pending(self):
        return desktop_maintenance.request(self.slug, 'top2', 'org', 'fixture pending')['maintenance']

    def acknowledged(self):
        v = self.pending()
        MAINT.write_text(json.dumps({**v, 'state': 'acknowledged', 'execution_boot': 'fixture'}), encoding='utf-8')

    def retire_mid(self):
        org = store.load_org(self.slug)
        org.retire('top', 'mid')
        store.save_org(org)

    # -- observation -----------------------------------------------------------------------------------------------
    def observe(self, request):
        self.hub.reset_mock()
        before, m_before = self.durable(), maintenance()
        r = request()
        after, m_after = self.durable(), maintenance()
        body = r.json()
        return r, after, {
            'status': r.status_code, 'results': sorted(body) if r.status_code == 200 else None,
            'detail': body.get('detail') if isinstance(body, dict) else None,
            'sections': sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k)),
            'events': [[e.get('op'), e.get('detail')] for e in after.get('events', [])
                       if e not in before.get('events', [])],
            'maintenance': None if m_after == m_before else
            {k: m_after.get(k) for k in ('action', 'target', 'state')} if m_after else None}

    def case(self, name, request, pre=None, wrap=contextlib.nullcontext):
        """One fixtured case on a fresh org and an empty maintenance file; `wrap` (a profile) covers the request
        only, never the setup."""
        self.fresh()
        if pre:
            pre()
        with wrap():
            r, after, seen = self.observe(request)
        self.assertEqual(seen, self.spec['cases'][name], name)
        return r, after

    # -- desktop-managed profile -----------------------------------------------------------------------------------
    def test_self_relaunch_records_a_restart_request_and_drops_its_reason(self):
        r, after = self.case('d_self_relaunch', self.agent(S, {}, 'top'))
        self.assertEqual((maintenance()['by_org'], maintenance()['by_node']), (self.slug, 'top'))
        self.assertEqual(self.hub.call_count, 1)
        # recorded legacy defect: the one option self_relaunch accepts is kept nowhere
        r, after = self.case('d_self_relaunch_reason', self.agent(S, {'reason': 'why-marker'}, 'top'))
        self.assertEqual(maintenance()['reason'], 'agent requested desktop maintenance')
        self.assertNotIn('why-marker', json.dumps(after))
        self.assertIn('orgtree_self_relaunch accepts a reason and records none of it',
                      ' '.join(self.spec['legacy_defects']))
        self.case('d_self_relaunch_top2', self.agent(S, {}, 'top2'))

    def test_relaunch_options_are_refused_before_the_gate(self):
        for name, args in (('d_self_relaunch_target', {'target': 'both'}),
                           ('d_self_relaunch_force', {'force': True, 'reason': 'r'}),
                           ('d_self_relaunch_action', {'action': 'update'})):
            self.case(name, self.agent(S, args, 'top'))
        self.case('d_prime_target', self.agent(P, {'action': 'arm', 'target': 'org'}, 'top'))
        self.case('d_prime_deadline', self.agent(P, {'action': 'arm', 'deadline_minutes': 10, 'reason': 'r'}, 'top'))

    def test_the_machine_wide_gate(self):
        self.case('d_self_relaunch_mid', self.agent(S, {}, 'mid'))
        self.case('d_prime_mid', self.agent(P, {'action': 'arm'}, 'mid'))
        self.case('d_prime_cancel_mid', self.agent(P, {'action': 'cancel'}, 'mid'), pre=self.pending)
        self.assertEqual(maintenance()['state'], 'pending')
        self.case('d_update_mid', self.agent(U, {}, 'mid'))
        # status takes no gate: any live caller may read it, an archived seat may not
        r, _ = self.case('d_prime_status', self.agent(P, {'action': 'status'}, 'mid'), pre=self.pending)
        self.assertIn('primed by ' + self.slug + '/top2', r.json()['status'])
        self.case('d_prime_status_retired', self.agent(P, {'action': 'status'}, 'mid'), pre=self.retire_mid)

    def test_an_armed_request_is_returned_not_replaced(self):
        for name, request, pre in (('d_self_relaunch_pending', self.agent(S, {'reason': 'second'}, 'top'), self.pending),
                                   ('d_self_relaunch_acked', self.agent(S, {}, 'top'), self.acknowledged),
                                   ('d_prime_arm_pending', self.agent(P, {'action': 'arm'}, 'top'), self.pending),
                                   ('d_update_pending', self.agent(U, {}, 'top'), self.pending)):
            r, _ = self.case(name, request, pre=pre)
            # the caller is handed the request that was already there, another node's reason and all
            got = r.json()['maintenance']
            self.assertEqual((got['by_node'], got['reason'], got['action']), ('top2', 'fixture pending', 'restart'))
        r, _ = self.case('d_self_relaunch_twice', self.twice(self.agent(S, {}, 'top')))
        self.assertTrue(r.json()['already_armed'])

    def test_prime_relaunch_arm_cancel_and_status(self):
        self.case('d_prime_arm', self.agent(P, {'action': 'arm', 'reason': 'r'}, 'top'))
        self.assertEqual(maintenance()['reason'], 'r')
        self.case('d_prime_default', self.agent(P, {}, 'top'))
        self.case('d_prime_null', self.agent(P, {'action': None}, 'top'))
        self.case('d_prime_cancel', self.agent(P, {'action': 'cancel'}, 'top'), pre=self.pending)
        self.assertEqual(maintenance()['cancelled_by'], {'org': self.slug, 'node': 'top'})
        r, _ = self.case('d_prime_cancel_none', self.agent(P, {'action': 'cancel'}, 'top'))
        self.assertFalse(r.json()['cancelled'])
        # an acknowledged request is not pending, so cancel leaves it alone but still records the event
        r, _ = self.case('d_prime_cancel_acked', self.agent(P, {'action': 'cancel'}, 'top'), pre=self.acknowledged)
        self.assertEqual((r.json()['cancelled'], maintenance()['state']), (False, 'acknowledged'))
        r, _ = self.case('d_prime_status_none', self.agent(P, {'action': 'status'}, 'top'))
        self.assertEqual(r.json(), {'primed': None, 'status': 'no relaunch is primed on this machine'})
        self.assertEqual(self.hub.call_count, 1)
        self.case('d_prime_bad', self.agent(P, {'action': 'nope'}, 'top'))
        self.case('d_prime_upper', self.agent(P, {'action': 'ARM'}, 'top'))

    def test_self_update_records_an_update_request_on_the_desktop_profile(self):
        # recorded legacy defect: the deprecated alias is not refused as renamed, and it records the old
        # deployment-shaped request (action update, the caller's target) the renamed V2 verbs refuse
        self.case('d_self_restart', self.agent('orgtree_self_restart', {}, 'top'))
        self.assertEqual(self.spec['profiles']['legacy_restart_refusal'],
                         self.spec['cases']['d_self_restart']['detail'])
        self.case('d_update', self.agent(U, {}, 'top'))
        self.case('d_update_target_both', self.agent(U, {'target': 'both'}, 'top'))
        self.case('d_update_target_mailhub', self.agent(U, {'target': 'mailhub', 'reason': 'x'}, 'top'))
        self.case('d_update_target_bad', self.agent(U, {'target': 'nope'}, 'top'))
        self.case('d_update_force', self.agent(U, {'force': True, 'reason': 'r'}, 'top'))
        self.quiesce.assert_not_called()

    # -- non-desktop profile ---------------------------------------------------------------------------------------
    def test_non_desktop_profile_refuses_the_relaunch_tools_and_launches_self_update(self):
        nd = self.non_desktop
        self.case('nd_self_relaunch', self.agent(S, {}, 'top'), wrap=nd)
        self.case('nd_self_relaunch_mid', self.agent(S, {'bogus': 1}, 'mid'), wrap=nd)
        self.case('nd_prime_status', self.agent(P, {'action': 'status'}, 'top'), wrap=nd)
        self.assertEqual(self.spec['profiles']['desktop_only'],
                         {S: self.spec['cases']['nd_self_relaunch']['detail'],
                          P: self.spec['cases']['nd_prime_status']['detail']})
        # self_update launches exactly as self_restart does: no action argument on this profile
        for name, tool, args, target in (('nd_update', U, {}, 'org'), ('nd_restart', 'orgtree_self_restart', {}, 'org'),
                                         ('nd_update_target', U, {'target': 'both'}, 'both')):
            self.case(name, self.agent(tool, args, 'top'), wrap=nd)
            [call] = self.launch.call_args_list
            self.assertEqual((call.args, call.kwargs), ((self.slug, 'top', target), {}), name)
        self.case('nd_update_force', self.agent(U, {'force': True, 'reason': 'r'}, 'top'), wrap=nd)
        self.assertEqual(self.quiesce.call_args.kwargs, {'exclude': (self.slug, 'top')})
        self.assertEqual((self.launch.call_args.kwargs['force'],
                          self.launch.call_args.kwargs['quiesced']['hold_token']), (True, 'fixture'))
        for name, args, actor in (('nd_update_force_noreason', {'force': True}, 'top'), ('nd_update_mid', {}, 'mid')):
            self.case(name, self.agent(U, args, actor), wrap=nd)
            self.launch.assert_not_called()

    def test_frozen_profile_refuses_before_any_write(self):
        # the frozen profile serves the admin API to loopback clients only, so these calls come from 127.0.0.1
        # (never entered, so it starts no second app lifespan, and never closed by the per-case reset)
        loop = TestClient(app, raise_server_exceptions=False, client=('127.0.0.1', 50000))
        self.case('df_self_relaunch', self.agent(S, {}, 'top', loop), wrap=self.frozen)
        self.case('df_prime_status', self.agent(P, {'action': 'status'}, 'top', loop), wrap=self.frozen)
        self.case('df_update', self.agent(U, {}, 'top', loop), wrap=self.frozen)
        self.case('ndf_update', self.agent(U, {}, 'top', loop), wrap=self.frozen_non_desktop)
        self.launch.assert_not_called()
        self.assertEqual(self.spec['profiles']['frozen_refusal'], self.spec['cases']['df_update']['detail'])

    # -- receipts --------------------------------------------------------------------------------------------------
    def test_receipt_classes_and_what_they_keep(self):
        for name, key, request in (('dk_self_relaunch', S, self.keyed(S, {}, 'top')),
                                   ('dk_prime_arm', P, self.keyed(P, {'action': 'arm'}, 'top')),
                                   ('dk_prime_status', P + ':status', self.keyed(P, {'action': 'status'}, 'top')),
                                   ('dk_update', U, self.keyed(U, {}, 'top'))):
            _, after = self.case(name, request)
            rc = after['op_receipts'][-1]
            self.assertEqual([rc['cls'], sorted(rc['result'] or {})], self.spec['receipts'][key], name)
        # a replay answers from the first receipt and does not run the call again (one event, one request)
        r, after = self.case('dk_self_relaunch_replay', self.twice(self.keyed(S, {}, 'top')))
        self.assertEqual((r.json()['replayed'], r.json()['outcome']), (True, 'applied'))


if __name__ == '__main__':
    unittest.main()
