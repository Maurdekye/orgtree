"""P01 F2 legacy boundary contracts for the run-control entry points, per product profile.

Disposable SQLite only; the app's lifecycle is not started. EVERY process effect is a
spy: halt's process cut, turn interrupts, the killswitch sweep, the warm-pool process
control, remote control, the restart launch, the prime arm/cancel and continue-on's
live provider read. The doors, the ledger, the halt record, the killswitch latch, the
restart-wake sidecar, the receipts, save and reload are real. The desktop-managed
profile is the app's own (engine.launch sets ORGTREE_DESKTOP_MANAGED=1); the
non-desktop profile is exercised by clearing that flag for the call. Each test pins a
fact stated in docs/state-system/operation-contracts.json (control.*) against
docs/state-system/control-boundary.json.
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

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-control-boundary-')
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
from orgtree import agentauth, api, halt, ledger, opreceipts, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'
assert os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1', 'the desktop-managed profile is the app under test'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'receipts', 'profiles',
          'legacy_defects', 'scope'}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/control-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.control-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('control.')}:
        raise ValueError('every control contract is required')
    return d


class NoDesktop:
    """The non-desktop profile for the duration of one call."""
    def __enter__(self):
        self.saved = os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)

    def __exit__(self, *exc):
        if self.saved is not None:
            os.environ['ORGTREE_DESKTOP_MANAGED'] = self.saved


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 26)
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry['facets']['control.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('control.halt'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_action_selectors_read_the_action_as_the_door_does(self):
        # the door reads str(a.get("action") or "arm") and refuses anything but arm, cancel and status; the
        # selectors use the same reading (str_or_arm; F2 review, rev 11), so every falsy action selects arm and an
        # unknown action selects nothing (the door's 422 is pinned in test_restart_wake_lives_in_its_own_sidecar and
        # test_non_desktop_profile_gates_and_launches)
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        for tool, fam in (('orgtree_prime_restart', 'control.prime-restart-'),
                          ('orgtree_restart_wake', 'control.restart-wake-')):
            [card] = {e for c in registry['contracts'].values() if tool in c['tools'] for e in c['entry_ids']}
            for act in ('arm', 'cancel', 'status'):
                self.assertEqual(contracts.select(registry, card, {'action': act}), [fam + act])
            for falsy in ({}, {'action': None}, {'action': ''}, {'action': 0}, {'action': False}, {'action': []}):
                with self.subTest(tool=tool, args=falsy):
                    self.assertEqual(contracts.select(registry, card, falsy), [fam + 'arm'])
            for unknown in ('bogus', 'ARM', ' arm', 1, True):
                with self.subTest(tool=tool, action=unknown):
                    self.assertEqual(contracts.select(registry, card, {'action': unknown}), [])

    def test_the_door_arms_on_a_falsy_action(self):
        # the other half of the selector case above, observed at the door: an empty action arms the wake
        r = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(r.close)
        org = store.create_org('p01-control-falsy')
        self.addCleanup(lambda: (store._POOL.close_all(org.d['slug']), store.delete_org(org.d['slug'])))
        org.hire(ledger.USER, None, 'haiku', 5, 'solo', add_dirs=[], tools={}, charter='fixture')
        store.save_org(org)
        token = agentauth.child_env(org.d['slug'], 'solo')['ORGTREE_AGENT_TOKEN']
        with patch.object(api, 'hub_changed'):
            out = r.post('/api/agent', json=dict(org=org.d['slug'], node='solo', tool='orgtree_restart_wake',
                                                 args={'action': ''}), headers={'X-Orgtree-Agent-Token': token})
        self.assertEqual((out.status_code, out.json().get('armed')), (200, True), out.text)

    # the relaunch and self_update-alias branches this family left pending are mapped by the relaunch-cards item:
    # tests/test_state_relaunch_boundary.py, test_the_rows_f2_left_pending_are_mapped_and_the_other_verbs_are_owned


class ControlBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-control-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 6, 'mid', **SCOPE)
        org.hire('top', 'mid', 'haiku', 2, 'leaf', **SCOPE)
        org.hire('top', 'top', 'haiku', 3, 'sib', **SCOPE)
        org.hire(ledger.USER, None, 'haiku', 5, 'top2', add_dirs=[], tools={}, charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('top', 'mid', 'leaf', 'sib', 'top2')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        sup = api.supervisor
        spy = lambda target, name, **kw: self.enterContext(patch.object(target, name, **kw))  # noqa: E731
        self.drive = spy(sup, 'send_message', return_value={'delivered': True})
        spy(sup, 'delivery_note', return_value='fixture carrier')
        self.hub = spy(api, 'hub_changed')
        self.notify = spy(sup, 'notify')
        self.launch = spy(sup, 'launch_self_restart', return_value={'launched': 'spy'})
        self.arm = spy(sup, 'arm_prime_restart', return_value={'armed': True})
        self.cancel = spy(sup, 'cancel_prime_restart', return_value={'cancelled': True})
        spy(sup, 'primed_restart', return_value=None)
        self.remote = spy(sup, 'remote_control_start', return_value={'started': True})
        spy(sup, 'remote_control_stop', return_value={'stopped': True})
        self.interrupt = spy(sup, 'interrupt_turn', return_value={'interrupted': False, 'reason': 'spy'})
        self.sweep = spy(sup, 'interrupt_all', return_value={'interrupted': []})
        spy(sup, 'maybe_storage_check')
        self.cont = spy(api, '_continue_on_account', return_value={'switched': True})
        self.process = spy(api.warmpool, 'process_control', return_value={'process': 'spy'})
        self.cut = spy(halt, '_cut')
        self.spies = (self.drive, self.hub, self.notify, self.launch, self.arm, self.cancel, self.remote,
                      self.interrupt, self.sweep, self.cont, self.process, self.cut)

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

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    @staticmethod
    def told(before, after):
        out = {}
        for n, rows in after.get('notices', {}).items():
            new = [x for x in rows if x not in before.get('notices', {}).get(n, [])]
            if new:
                out[n] = [[(x.get('ev') or {}).get('variant'),
                           (x.get('ev') or {}).get('relation') or (x.get('ev') or {}).get('role')] for x in new]
        return out

    def agent(self, tool, args, actor):
        return lambda: self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=tool, args=args),
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

    def route(self, method, path, body=None, headers=OP):
        return lambda: self.client.request(method, path.format(slug=self.slug), json=body, headers=headers)

    def act(self, request):
        for s in self.spies:
            s.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after, self.told(before, after)

    def case(self, request, name):
        r, changed, after, told = self.act(request)
        self.assertEqual(r.status_code, 200, r.text)
        want = self.spec['cases'][name]
        self.assertEqual((sorted(r.json()), changed, told), (want['results'], want['sections'], want['told']))
        return r, after

    def refused(self, request, detail, code=422):
        r, changed, _, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        return r

    def halt_mid(self):
        self.route('POST', '/api/orgs/{slug}/nodes/mid/halt')()

    def freeze_mid(self):
        org = store.load_org(self.slug)
        org.node('mid')['frozen'] = {'limit': 'weekly', 'at': '2026-01-01T00:00:00Z', 'reason': 'fixture'}
        store.save_org(org)

    # -- interrupt, unstick, continue_on -------------------------------------------------------------------------
    def test_interrupt_signals_the_turn_and_writes_nothing(self):
        self.case(self.agent('orgtree_interrupt', {'node': 'mid'}, 'top'), 't_interrupt')
        self.assertEqual(([c.args[1] for c in self.interrupt.call_args_list], self.hub.call_count), (['mid'], 1))
        self.refused(self.agent('orgtree_interrupt', {'node': 'mid'}, 'mid'), 'mid has no authority over mid')
        self.refused(self.agent('orgtree_interrupt', {'node': 'top'}, 'mid'), 'mid has no authority over top')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/interrupt'), 'r_interrupt')
        self.assertEqual(self.hub.call_count, 0)

    def test_unstick_releases_a_frozen_node_and_is_a_no_op_otherwise(self):
        self.case(self.agent('orgtree_unstick', {'node': 'mid'}, 'top'), 't_unstick_noop')
        self.freeze_mid()
        self.case(self.agent('orgtree_unstick', {'node': 'mid'}, 'top'), 't_unstick_frozen')
        [call] = self.drive.call_args_list
        self.assertEqual((call.args[1], call.kwargs.get('sender')), ('mid', 'top'))
        self.assertEqual([c.args[1:3] for c in self.notify.call_args_list], [('mid', 'turn_started')])
        self.refused(self.agent('orgtree_unstick', {'node': 'top'}, 'mid'), 'mid has no authority over top')
        self.freeze_mid()
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/unstick'), 'r_unstick')
        self.assertEqual(self.hub.call_count, 1)

    def test_continue_on_hands_off_to_the_shared_switch_and_release(self):
        self.case(self.agent('orgtree_continue_on', {'node': 'mid', 'account': 'acct-x'}, 'top'), 't_continue')
        [call] = self.cont.call_args_list
        self.assertEqual((call.args[:3], call.kwargs['actor'], call.kwargs['via']),
                         ((self.slug, 'mid', 'acct-x'), 'top', 'agent_continue'))
        self.assertEqual(self.hub.call_count, 0)
        self.refused(self.agent('orgtree_continue_on', {'node': 'mid', 'account': 'a'}, 'mid'),
                     'you cannot choose your own account', code=403)
        self.refused(self.agent('orgtree_continue_on', {'node': 'top', 'account': 'a'}, 'mid'),
                     'mid has no authority over top')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/continue-on', {'account': 'acct-x'}), 'r_continue')
        self.assertEqual((self.cont.call_args.kwargs['actor'], self.cont.call_args.kwargs['via']),
                         ('@user', 'manual_continue'))

    # -- halt, unhalt ---------------------------------------------------------------------------------------------
    def test_halt_records_the_halt_cuts_and_broadcasts_nothing(self):
        r, after = self.case(self.agent('orgtree_halt', {'node': 'mid'}, 'top'), 't_halt')
        self.assertEqual(after['nodes']['mid']['halt']['phase'], 'halted')
        self.assertEqual([c.args[2] for c in self.notify.call_args_list], ['halting', 'halted'])
        self.assertTrue(self.cut.called)
        self.assertEqual(self.hub.call_count, 0)
        # a halted caller cannot run any tool
        self.refused(self.agent('orgtree_list_orgs', {}, 'mid'), 'agent is halted', code=409)
        self.case(self.agent('orgtree_unhalt', {'node': 'mid'}, 'top'), 't_unhalt')
        self.assertEqual(self.hub.call_count, 0)
        self.refused(self.agent('orgtree_halt', {'node': 'top'}, 'mid'), 'mid has no authority over top')
        # a batch is authorised for EVERY target in one lock pass before any process is cut: one target outside
        # the caller's subtree refuses the whole batch and nothing is cut
        self.refused(self.agent('orgtree_halt', {'nodes': ['leaf', 'top']}, 'mid'), 'mid has no authority over top')
        self.cut.assert_not_called()
        self.fresh()
        r, _ = self.case(self.agent('orgtree_halt', {'nodes': ['mid', 'sib']}, 'top'), 't_halt_batch')
        self.assertEqual(sorted(r.json()['nodes']), ['mid', 'sib'])

    def test_halt_routes(self):
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/halt'), 'r_halt')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/interrupt'), 'r_interrupt_halted')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/unhalt'), 'r_unhalt')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/unhalt'), 'r_unhalt_not')
        self.assertEqual(self.hub.call_count, 0)

    # -- restart tools, per profile -------------------------------------------------------------------------------
    def test_desktop_profile_refuses_the_standard_restart_tools(self):
        want = self.spec['profiles']['desktop_refusal']
        for tool, args in (('orgtree_self_restart', {}), ('orgtree_prime_restart', {'action': 'arm'}),
                           ('orgtree_prime_restart', {'action': 'status'})):
            with self.subTest(tool=tool, args=args):
                r = self.refused(self.agent(tool, args, 'top'), 'desktop-managed V2 renamed')
                self.assertEqual(r.json()['detail'], want[tool])
        for s in (self.launch, self.arm, self.cancel):
            s.assert_not_called()

    def test_non_desktop_profile_gates_and_launches(self):
        with NoDesktop():
            self.case(self.agent('orgtree_self_restart', {}, 'top'), 'nd_self_restart')
            self.assertEqual(self.launch.call_args.args[:2], (self.slug, 'top'))
            self.case(self.agent('orgtree_prime_restart', {'action': 'arm', 'reason': 'r'}, 'top'), 'nd_prime_arm')
            self.assertEqual(self.arm.call_count, 1)
            self.case(self.agent('orgtree_prime_restart', {'action': 'cancel'}, 'top'), 'nd_prime_cancel')
            self.case(self.agent('orgtree_prime_restart', {'action': 'status'}, 'top'), 'nd_prime_status')
            self.refused(self.agent('orgtree_self_restart', {}, 'leaf'),
                         'a self-restart restarts the shared orgtree install for EVERY org')
            self.refused(self.agent('orgtree_prime_restart', {'action': 'arm'}, 'leaf'),
                         'a primed restart restarts the shared orgtree install for EVERY org')
            self.refused(self.agent('orgtree_prime_restart', {'action': 'nope'}, 'top'),
                         'action must be arm|cancel|status')

    def test_restart_wake_lives_in_its_own_sidecar(self):
        self.case(self.agent('orgtree_restart_wake', {'action': 'arm', 'reason': 'r'}, 'mid'), 't_wake_arm')
        self.case(self.agent('orgtree_restart_wake', {'action': 'status'}, 'mid'), 't_wake_status')
        self.case(self.agent('orgtree_restart_wake', {'action': 'cancel'}, 'mid'), 't_wake_cancel')
        r, changed, _, _ = self.act(self.agent('orgtree_restart_wake', {'action': 'arm', 'target': 'leaf'}, 'mid'))
        self.assertEqual((r.status_code, changed), (200, []))
        self.refused(self.agent('orgtree_restart_wake', {'action': 'arm', 'target': 'top'}, 'mid'),
                     'you can only manage restart wake for yourself or your subordinates', code=403)
        self.refused(self.agent('orgtree_restart_wake', {'action': 'arm', 'mode': 'every'}, 'mid'),
                     'only one-shot restart wakes are supported')
        self.refused(self.agent('orgtree_restart_wake', {'action': 'nope'}, 'mid'), 'action must be arm|cancel|status')

    # -- receipts -------------------------------------------------------------------------------------------------
    def test_receipt_classes_and_what_they_keep(self):
        want = self.spec['receipts']
        cases = [('orgtree_interrupt', {'node': 'mid'}, 'top', None),
                 ('orgtree_unstick', {'node': 'mid'}, 'top', self.freeze_mid),
                 ('orgtree_halt', {'node': 'mid'}, 'top', None),
                 ('orgtree_unhalt', {'node': 'mid'}, 'top', self.halt_mid),
                 ('orgtree_restart_wake', {'action': 'arm'}, 'mid', None)]
        for tool, args, actor, pre in cases:
            with self.subTest(tool=tool):
                self.fresh()
                if pre:
                    pre()
                r, changed, after, _ = self.act(self.keyed(tool, args, actor))
                self.assertEqual(r.status_code, 200, r.text)
                [row] = [x for x in after['op_receipts'] if x.get('tool') == tool][-1:]
                self.assertEqual([row['cls'], sorted(row['result'])], want[tool])
        with NoDesktop():
            self.fresh()
            r, _, after, _ = self.act(self.keyed('orgtree_prime_restart', {'action': 'arm'}, 'top'))
            [row] = [x for x in after['op_receipts'] if x.get('tool') == 'orgtree_prime_restart'][-1:]
            self.assertEqual([row['cls'], sorted(row['result'])], want['orgtree_prime_restart'])

    # -- the org-wide routes --------------------------------------------------------------------------------------
    def test_killswitch_latch_blocks_tools_and_resume_until_released(self):
        self.case(self.route('POST', '/api/orgs/{slug}/killswitch'), 'r_kill')
        self.assertEqual(self.sweep.call_count, 1)
        self.refused(self.agent('orgtree_list_orgs', {}, 'mid'), 'the org killswitch is latched', code=409)
        self.refused(self.route('POST', '/api/orgs/{slug}/resume'), 'release it before resuming', code=409)
        self.case(self.route('POST', '/api/orgs/{slug}/killswitch/release'), 'r_release')
        self.case(self.route('POST', '/api/orgs/{slug}/killswitch/release'), 'r_release_not')
        self.case(self.route('POST', '/api/orgs/{slug}/resume'), 'r_resume')
        self.assertEqual(self.hub.call_count, 0)

    def test_process_remote_control_and_steering(self):
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/process', {'action': 'stop'}), 'r_process')
        self.assertEqual(self.process.call_args.args[1:], ('mid', 'stop'))
        self.refused(self.route('POST', '/api/orgs/{slug}/nodes/nobody/process', {'action': 'stop'}),
                     "no such node: 'nobody'", code=404)
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/remote-control', {'action': 'start'}), 'r_remote_start')
        self.assertEqual((self.remote.call_args.args, self.hub.call_count), ((self.slug, 'mid'), 1))
        self.refused(self.route('POST', '/api/orgs/{slug}/nodes/mid/remote-control', {'action': 'nope'}),
                     'action must be start or stop')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/steer', {}), 'r_steer')
        self.case(self.route('POST', '/api/orgs/{slug}/nodes/mid/steer/ack', {'delivery_id': 'd', 'tool_use_id': 't'}),
                  'r_steer_ack')
        self.case(self.route('GET', '/api/orgs/{slug}/nodes/mid/steer-state'), 'r_steer_state')

    def test_routes_refuse_an_agent_credential(self):
        self.refused(self.route('POST', '/api/orgs/{slug}/killswitch',
                                headers={'X-Orgtree-Agent-Token': self.tokens['top']}),
                     'agent credential is invalid or expired', code=401)

    # -- kiosk, per profile ---------------------------------------------------------------------------------------
    def test_kiosk_route_is_stripped_in_the_desktop_profile_and_served_otherwise(self):
        r, changed, _, _ = self.act(self.route('POST', '/api/orgs/{slug}/kiosk', {'enabled': True}))
        self.assertEqual((r.status_code, changed), (405, []))
        self.assertIn('POST /api/orgs/{slug}/kiosk', self.spec['profiles']['desktop_stripped_routes'])
        # the handler itself (non-desktop profile): a non-kiosk org is refused; a kiosk org is configured
        with self.assertRaises(api.HTTPException) as ctx:
            api.org_kiosk(self.slug, api.KioskCfg(enabled=True))
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('not a kiosk org', ctx.exception.detail)
        org = store.load_org(self.slug)
        org.d['kiosk'] = {'enabled': False, 'credits': 0, 'spend_limit': 0.0, 'storage_limit_mb': 0}
        store.save_org(org)
        before = self.durable()
        out = api.org_kiosk(self.slug, api.KioskCfg(enabled=True))
        after = self.durable()
        self.assertEqual((sorted(out), after['kiosk']['enabled'], 'kiosk' in self.changed(before, after)),
                         (['freezes_cleared', 'kiosk', 'share_url'], True, True))
        with self.assertRaises(api.HTTPException) as ctx:
            api.org_kiosk(self.slug, api.KioskCfg(credits=1))
        self.assertIn('cap below current holdings', ctx.exception.detail)


if __name__ == '__main__':
    unittest.main()
