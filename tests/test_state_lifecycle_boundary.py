"""P01 F1 legacy boundary contracts for the org lifecycle and catalogue entry points.

Disposable SQLite only; the app's lifecycle is not started. The provider gate, turn
delivery, the pre-archive interrupt, the remote reap, the transcript copy, manual
compaction, provider discovery, the mail hub roster and the broadcasts are patched
(spies); the agent door, the operator routes, the ledger, the receipts, save and
reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (lifecycle.*) against
docs/state-system/lifecycle-boundary.json.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-lifecycle-boundary-')
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

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'told',
          'receipts', 'legacy_defects', 'scope'}
TOOL_CONTRACTS = {'lifecycle.rename': 'orgtree_rename', 'lifecycle.retool': 'orgtree_retool',
                  'lifecycle.retire': 'orgtree_retire', 'lifecycle.dissolve': 'orgtree_dissolve',
                  'lifecycle.cheap-compact': 'orgtree_cheap_compact', 'lifecycle.rehire': 'orgtree_rehire',
                  'lifecycle.move': 'orgtree_move', 'lifecycle.swap': 'orgtree_swap',
                  'lifecycle.self-subjugate': 'orgtree_self_subjugate',
                  'lifecycle.switch-model': 'orgtree_switch_model', 'catalogue.list-orgs': 'orgtree_list_orgs',
                  'catalogue.list-tiers': 'orgtree_list_tiers'}
ROUTE_CONTRACTS = {'lifecycle.account-assign', 'lifecycle.reorder', 'lifecycle.compact', 'lifecycle.dissolve-all',
                   'lifecycle.lineage-recover', 'lifecycle.lineage-drop-phantom', 'lifecycle.repair-rename'}
NAMES = set(TOOL_CONTRACTS) | ROUTE_CONTRACTS


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/lifecycle-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.lifecycle-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every lifecycle contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # conflicts, wire and instrumentation stay open (P03/P05, the native conversion, P02 after landing);
        # the other six are specified from source and the pins below
        for name in ('conflicts', 'wire', 'instrumentation'):
            self.assertEqual(registry['facets']['lifecycle.' + name]['status'], 'unresolved', name)
        for name in ('authority', 'reads', 'writes', 'predicates', 'receipt', 'effects'):
            self.assertEqual(registry['facets']['lifecycle.' + name]['status'], 'specified', name)
        for name in NAMES:
            c = registry['contracts'][name]
            self.assertEqual(c['dimensions'], {d: ['lifecycle.' + d] for d in contracts.DIMENSIONS})
            self.assertEqual(c['tools'], [TOOL_CONTRACTS[name]] if name in TOOL_CONTRACTS else [])

    def test_every_entry_is_mapped_and_the_extern_listing_is_not_in_this_family(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        source = contracts.inventory.scan(ROOT)
        rows = {r['id']: r for r in registry['entries']}
        for name in NAMES:
            [entry] = registry['contracts'][name]['entry_ids']
            with self.subTest(contract=name):
                self.assertEqual((rows[entry]['disposition'], rows[entry]['contracts']), ('mapped', [name]))
        # GET /api/orgs is a different handler: P01 F4 contracts it in the exchange family (exchange.orgs-list), not
        # here. The external-chat server whose orgtree_list_orgs card called it is retired (docket
        # the-external-chat-mcp-server-cannot-reach-the-v2), so no externtool registration remains.
        self.assertEqual([s for s in source['registrations'] if s['source']['path'].endswith('externtool.py')], [])
        [orgs_list] = registry['contracts']['exchange.orgs-list']['entry_ids']
        self.assertEqual((rows[orgs_list]['disposition'], rows[orgs_list]['contracts']),
                         ('mapped', ['exchange.orgs-list']))

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('lifecycle.retire'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_each_entry_selects_exactly_its_contract(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        for name in NAMES:
            [entry] = registry['contracts'][name]['entry_ids']
            with self.subTest(contract=name):
                self.assertEqual(contracts.select(registry, entry, {}), [name])
                self.assertEqual(contracts.select(registry, entry, {'node': 'x', 'action': 'y'}), [name])


class LifecycleBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-lifecycle-{self.seq}')
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
        self.enterContext(patch.object(api, 'provider_hire_gate', lambda *a, **k: None))
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.interrupt = self.enterContext(patch.object(api.supervisor, 'interrupt_before_archive', return_value=[]))
        self.reap = self.enterContext(patch.object(api.supervisor, 'remote_reap'))
        self.export = self.enterContext(patch.object(api.supervisor, 'export_predecessor_transcript'))
        self.compact = self.enterContext(patch.object(api.supervisor, 'manual_compact'))
        self.sup_notify = self.enterContext(patch.object(api.supervisor, 'notify'))
        self.enterContext(patch.object(api, '_tier_discovery_payload', return_value={'tiers': ['fixture']}))
        self.enterContext(patch.object(api.net, 'remote_peers', return_value=[]))
        self.spies = (self.drive, self.notify, self.hub, self.interrupt, self.reap, self.export, self.compact,
                      self.sup_notify)

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

    def keyed(self, tool, args, actor, key=None):
        key = key or opreceipts.mint_key()

        def go():
            head = {'X-Orgtree-Agent-Token': self.tokens[actor]}
            epoch = self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=opreceipts.OP_EPOCH,
                                                             args={}), headers=head).json()['epoch']
            return self.client.post('/api/agent', json=dict(
                org=self.slug, node=actor, tool=opreceipts.OP_CALL,
                args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch)), headers=head)
        return go

    def route(self, path, body=None, headers=OP):
        return lambda: self.client.post(path.format(slug=self.slug), json=body, headers=headers)

    def act(self, request):
        for spy in self.spies:
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after, self.told(before, after)

    def ok(self, request, case):
        """Status 200, the fixtured result keys and changed sections (and notices when fixtured)."""
        r, changed, after, told = self.act(request)
        self.assertEqual(r.status_code, 200, r.text)
        if case in self.spec['results']:
            self.assertEqual(sorted(r.json()), self.spec['results'][case])
        if case in self.spec['sections']:
            self.assertEqual(changed, self.spec['sections'][case])
        if case in self.spec['told']:
            self.assertEqual(told, self.spec['told'][case])
        return r, changed, after

    def refused(self, request, detail, code=422):
        r, changed, _, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        self.drive.assert_not_called()
        self.hub.assert_not_called()
        return r

    def receipt(self, after, tool):
        [row] = [x for x in after.get('op_receipts') or [] if x.get('tool') == tool][-1:]
        return row['cls'], row['result']

    # -- rename ---------------------------------------------------------------------------------------------------
    def test_rename_rekeys_the_seat_and_broadcasts_through_notify_only(self):
        r, _, after = self.ok(self.agent('orgtree_rename', {'node': 'leaf', 'name': 'leafy'}, 'mid'), 'rename_ok')
        self.assertEqual((r.json()['node'], r.json()['was']), ('leafy', 'leaf'))
        self.assertIn('leafy', after['nodes'])
        self.assertNotIn('leaf', after['nodes'])
        self.assertEqual([c.args[1:3] for c in self.sup_notify.call_args_list], [('leafy', 'renamed')])
        # no hub_changed, and (recorded legacy defect) no remote reap although the post-save reap names rename
        self.hub.assert_not_called()
        self.reap.assert_not_called()

    def test_rename_refusals_write_nothing(self):
        self.refused(self.agent('orgtree_rename', {'node': 'leaf', 'name': 'x'}, 'leaf'),
                     'leaf has no authority over leaf')
        self.refused(self.agent('orgtree_rename', {'node': 'top', 'name': 'x'}, 'mid'), 'mid has no authority over top')
        self.refused(self.agent('orgtree_rename', {'node': 'leaf', 'name': 'sib'}, 'top'), "the name 'sib' is already taken")
        self.sup_notify.assert_not_called()

    def test_a_keyed_rename_skips_admission(self):
        # recorded legacy behaviour: rename returns before admission, so a malformed key is not refused and no
        # receipt is filed either way
        for key, name in (('not-a-key', 'leafy'), (None, 'leafz')):
            with self.subTest(key=key):
                node = 'leaf' if name == 'leafy' else 'leafy'
                r, changed, after, _ = self.act(self.keyed('orgtree_rename', {'node': node, 'name': name}, 'mid', key))
                self.assertEqual((r.status_code, r.json()['node']), (200, name), r.text)
                self.assertNotIn('op_receipts', changed)
                self.assertFalse([x for x in after.get('op_receipts') or [] if x.get('tool') == 'orgtree_rename'])

    # -- retool ---------------------------------------------------------------------------------------------------
    def test_retool_writes_the_scope_and_tells_the_target(self):
        _, _, after = self.ok(self.agent('orgtree_retool', {'node': 'leaf', 'charter': 'new charter'}, 'mid'),
                              'retool_ok')
        self.assertEqual(after['nodes']['leaf']['charter'], 'new charter')
        self.assertEqual(self.hub.call_count, 1)
        # a self-retool sets the team charter only, and tells nobody
        self.ok(self.agent('orgtree_retool', {'node': 'mid', 'team_charter': 'tc'}, 'mid'), 'retool_self_team')

    def test_retool_refusals_write_nothing(self):
        self.refused(self.agent('orgtree_retool', {'node': 'mid', 'charter': 'x'}, 'mid'),
                     'you may not rewrite your OWN charter')
        self.refused(self.agent('orgtree_retool', {'node': 'top', 'charter': 'x'}, 'mid'), 'mid has no authority over top')
        self.refused(self.agent('orgtree_retool', {'node': 'leaf', 'tools': {**NO_TOOLS, 'bash': True}}, 'mid'),
                     "does not hold 'bash'; cannot grant it")

    # -- retire and dissolve --------------------------------------------------------------------------------------
    def test_retire_interrupts_first_then_archives_and_reaps(self):
        _, _, after = self.ok(self.agent('orgtree_retire', {'node': 'leaf'}, 'mid'), 'retire_leaf')
        self.assertEqual(after['nodes']['leaf']['state'], 'archived')
        self.assertEqual([(c.args[0], c.args[2]) for c in self.interrupt.call_args_list], [(self.slug, 'leaf')])
        self.assertEqual((self.reap.call_count, self.hub.call_count), (1, 1))

    def test_retiring_an_archived_node_is_a_no_op(self):
        self.retire_leaf()
        r, changed, _, _ = self.act(self.agent('orgtree_retire', {'node': 'leaf'}, 'mid'))
        self.assertEqual((r.status_code, r.json()['freed'], changed), (200, 0, []), r.text)
        self.assertIn('leaf was already archived — nothing to do', r.json()['warnings'][0])

    def test_a_leaf_may_retire_itself_and_its_parent_is_told(self):
        _, _, after = self.ok(self.agent('orgtree_retire', {'node': 'leaf'}, 'leaf'), 'retire_self_leaf')
        self.assertEqual(after['nodes']['leaf']['state'], 'archived')

    def test_a_superior_retiring_a_node_with_reports_dissolves_it(self):
        r, _, after = self.ok(self.agent('orgtree_retire', {'node': 'mid'}, 'top'), 'retire_with_kids')
        self.assertTrue(any('retire became dissolve' in w for w in r.json()['warnings']))
        self.assertEqual((after['nodes']['mid']['state'], after['nodes']['leaf']['state']), ('archived', 'archived'))

    def test_a_refused_retire_has_already_interrupted_its_target(self):
        # recorded legacy defect: the interrupt runs before the ledger's refusal and before admission
        self.refused(self.agent('orgtree_retire', {'node': 'mid'}, 'mid'), 'you have live reports')
        self.assertEqual([c.args[2] for c in self.interrupt.call_args_list], ['mid'])
        self.refused(self.keyed('orgtree_retire', {'node': 'leaf'}, 'mid', 'not-a-key'),
                     'op_key refused (malformed_key)')
        self.assertEqual([c.args[2] for c in self.interrupt.call_args_list], ['leaf'])
        # the authority pre-guard alone refuses before the interrupt
        self.refused(self.agent('orgtree_retire', {'node': 'mid'}, 'leaf'), 'leaf has no authority over mid')
        self.interrupt.assert_not_called()

    def test_dissolve_archives_the_subtree_and_tells_the_peers(self):
        self.refused(self.agent('orgtree_dissolve', {'node': 'mid'}, 'mid'), 'mid has no authority over mid')
        r, _, after = self.ok(self.agent('orgtree_dissolve', {'node': 'mid'}, 'top'), 'dissolve_mid')
        self.assertEqual(sorted(r.json()['nodes']), ['leaf', 'mid'])
        self.assertEqual((self.interrupt.call_count, self.reap.call_count, self.hub.call_count), (1, 1, 1))
        # the archived seats can no longer call the door
        self.refused(self.agent('orgtree_list_orgs', {}, 'leaf'), 'authenticated seat is archived or replaced',
                     code=403)

    # -- cheap compact --------------------------------------------------------------------------------------------
    def test_cheap_compact_archives_the_session_as_a_bearer_and_copies_the_transcript(self):
        self.refused(self.agent('orgtree_cheap_compact', {'node': 'mid'}, 'mid'), 'mid has no authority over mid')
        before = self.durable()
        r, _, after = self.ok(self.agent('orgtree_cheap_compact', {'node': 'mid'}, 'top'), 'cheap_compact_ok')
        self.assertEqual(r.json()['bearer'], 'mid@0')
        self.assertEqual((after['nodes']['mid@0']['state'], after['nodes']['mid@0']['successor']), ('archived', 'mid'))
        self.assertEqual(after['nodes']['mid']['generation'], 1)
        self.assertNotEqual(after['nodes']['mid']['session_id'], before['nodes']['mid']['session_id'])
        [call] = self.export.call_args_list
        self.assertEqual((call.args[1], call.kwargs['reason']), ('mid', 'cheap_compact'))
        self.assertEqual((self.reap.call_count, self.hub.call_count), (1, 1))
        # the seat's pre-compaction credential names the old session generation and is refused
        self.refused(self.agent('orgtree_list_orgs', {}, 'mid'), 'agent credential is stale', code=403)

    # -- rehire ---------------------------------------------------------------------------------------------------
    def retire_leaf(self, mail=False):
        org = store.load_org(self.slug)
        org.retire('mid', 'leaf')
        if mail:
            org.post_mail('mid', 'leaf', 'waiting work')
        store.save_org(org)

    def test_rehire_idle_without_mail_and_driven_once_with_it(self):
        self.retire_leaf()
        r, _, _ = self.ok(self.agent('orgtree_rehire', {'node': 'leaf'}, 'mid'), 'rehire_ok')
        self.assertEqual(r.json()['started'], False)
        self.assertIn('IDLE', r.json()['next_step'])
        self.drive.assert_not_called()
        # already live: a no-op that writes nothing but still broadcasts
        r, changed, _, _ = self.act(self.agent('orgtree_rehire', {'node': 'leaf'}, 'mid'))
        self.assertEqual((r.status_code, changed, self.hub.call_count), (200, [], 1))
        self.assertIn('already live', r.json()['warnings'][0])
        # mail waiting: driven exactly once after the save
        self.retire_leaf(mail=True)
        r, _, _, _ = self.act(self.agent('orgtree_rehire', {'node': 'leaf'}, 'mid'))
        self.assertEqual((r.json()['started'], 'RUNNING' in r.json()['next_step']), (True, True))
        self.assertEqual([(c.args[1], c.kwargs.get('mail_ping'), c.kwargs.get('ping_reason'))
                          for c in self.drive.call_args_list], [('leaf', True, None)])

    def test_rehire_with_a_name_renames_first(self):
        self.retire_leaf()
        r, _, after = self.ok(self.agent('orgtree_rehire', {'node': 'leaf', 'name': 'leaf2'}, 'mid'), 'rehire_rename')
        self.assertEqual((r.json()['renamed_to'], after['nodes']['leaf2']['state']), ('leaf2', 'live'))

    # -- move, swap, self_subjugate --------------------------------------------------------------------------------
    def test_move_single_batch_and_no_op(self):
        _, _, after = self.ok(self.agent('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'top'), 'move_ok')
        self.assertEqual(after['nodes']['leaf']['parent'], 'sib')
        r, changed, _, _ = self.act(self.agent('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'top'))
        self.assertEqual((r.json()['moved'], r.json()['changed'], changed, self.hub.call_count), (False, False, [], 1))
        _, _, after = self.ok(self.agent('orgtree_move', {'moves': [{'node': 'leaf', 'new_parent': 'mid'}]}, 'top'),
                              'move_batch')
        self.assertEqual(after['nodes']['leaf']['parent'], 'mid')
        self.refused(self.agent('orgtree_move', {'moves': ['leaf']}, 'top'), 'moves[0] must be an object')
        self.refused(self.agent('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'mid'),
                     'mid has no authority over sib')

    def test_a_same_parent_move_answers_any_caller_before_authority(self):
        # recorded legacy defect 7 (lifecycle-tool-receipts-and-admission-keyed-rena, point 6): Org.move returns the
        # same-parent no-op before promote/demote check authority, so an unrelated agent gets an accepted write cycle
        # whose answer confirms the node's parent
        for caller in ('top2', 'leaf'):
            with self.subTest(caller=caller):
                r, changed, _, _ = self.act(self.agent('orgtree_move', {'node': 'leaf', 'new_parent': 'mid'}, caller))
                self.assertEqual((r.status_code, r.json()['moved'], r.json()['changed']), (200, False, False), r.text)
                self.assertIn('leaf already reports to mid', r.json()['warnings'][0])
                self.assertEqual((changed, self.hub.call_count), ([], 1))
        r, changed, _, _ = self.act(self.keyed('orgtree_move', {'node': 'leaf', 'new_parent': 'mid'}, 'top2'))
        self.assertEqual((r.status_code, set(changed)), (200, {'op_receipts', 'op_receipts_meta'}))
        # the control: a real move by the same caller is refused
        self.refused(self.agent('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'top2'), 'has no authority over')

    def test_swap_exchanges_the_seats(self):
        _, _, after = self.ok(self.agent('orgtree_swap', {'a': 'mid', 'b': 'sib'}, 'top'), 'swap_ok')
        self.assertEqual(after['nodes']['leaf']['parent'], 'sib')         # the report stays with the seat
        self.refused(self.agent('orgtree_swap', {'a': 'mid', 'b': 'sib'}, 'mid'), 'mid has no authority over sib')

    def test_swap_rules_of_its_own(self):
        self.refused(self.agent('orgtree_swap', {'a': 'mid', 'b': 'mid'}, 'top'), 'a seat swap needs two different agents')
        # a top-level party needs the user, even when the caller is that party
        self.refused(self.agent('orgtree_swap', {'a': 'top', 'b': 'mid'}, 'top'), 'only the user reseats the top level')
        # both parties must be live
        org = store.load_org(self.slug)
        org.retire('top', 'sib')
        store.save_org(org)
        self.refused(self.agent('orgtree_swap', {'a': 'mid', 'b': 'sib'}, 'top'), 'sib is archived, not live')
        # both parties are checked with allow_self: an agent may swap itself with its own descendant
        r, _, after, _ = self.act(self.agent('orgtree_swap', {'a': 'mid', 'b': 'leaf'}, 'mid'))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((after['nodes']['leaf']['parent'], after['nodes']['mid']['parent']), ('top', 'leaf'))

    def test_self_subjugation_promotes_the_target_with_its_team(self):
        r, _, after = self.ok(self.agent('orgtree_self_subjugate', {'target': 'leaf'}, 'mid'), 'subjugate_ok')
        self.assertEqual((after['nodes']['leaf']['parent'], after['nodes']['mid']['parent']), ('top', 'leaf'))
        self.assertEqual((r.json()['promoted'], r.json()['demoted']), ('leaf', 'mid'))
        self.refused(self.agent('orgtree_self_subjugate', {'target': 'sib'}, 'mid'), 'is not a live descendant')

    # -- switch_model ---------------------------------------------------------------------------------------------
    def test_switch_model_upgrade_no_op_and_refusals(self):
        r, _, after = self.ok(self.agent('orgtree_switch_model', {'node': 'leaf', 'tier': 'sonnet'}, 'mid'), 'switch_up')
        self.assertEqual((after['nodes']['leaf']['model'], r.json()['queued']), ('sonnet', False))
        r, changed, _, _ = self.act(self.agent('orgtree_switch_model', {'node': 'leaf', 'tier': 'sonnet'}, 'mid'))
        self.assertEqual((changed, self.hub.call_count), ([], 1))
        self.assertIn('already runs sonnet', r.json()['warnings'][0])
        self.refused(self.agent('orgtree_switch_model', {'node': 'mid', 'tier': 'sonnet'}, 'mid'),
                     'you cannot switch your OWN model')
        self.refused(self.agent('orgtree_switch_model', {'node': 'leaf', 'tier': 'nope'}, 'mid'),
                     "unknown tier 'nope'; know [")

    # -- catalogue reads ------------------------------------------------------------------------------------------
    def test_catalogue_reads(self):
        r, changed, _ = self.ok(self.agent('orgtree_list_orgs', {}, 'mid'), 'list_orgs')
        self.assertIn(self.slug, [o['slug'] for o in r.json()['orgs']])
        # fence-off S5: a lock-free read now — no write cycle, no broadcast
        # (it used to take the write lock and broadcast, writing nothing)
        self.assertEqual((changed, self.hub.call_count), ([], 0))
        r, changed, _ = self.ok(self.agent('orgtree_list_tiers', {}, 'mid'), 'list_tiers')
        self.assertEqual((r.json(), changed, self.hub.call_count), ({'tiers': ['fixture']}, [], 0))

    # -- receipts -------------------------------------------------------------------------------------------------
    def test_receipt_classes_and_retained_results(self):
        want = self.spec['receipts']
        cases = [('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'top'),
                 ('orgtree_swap', {'a': 'mid', 'b': 'sib'}, 'top'),
                 ('orgtree_self_subjugate', {'target': 'leaf'}, 'mid'),
                 ('orgtree_switch_model', {'node': 'leaf', 'tier': 'sonnet'}, 'mid'),
                 ('orgtree_retool', {'node': 'leaf', 'charter': 'c2'}, 'mid')]
        for tool, args, actor in cases:
            with self.subTest(tool=tool):
                self.setUp_fresh()
                r, changed, after, _ = self.act(self.keyed(tool, args, actor))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertTrue({'op_receipts', 'op_receipts_meta'} <= set(changed))
                self.assertEqual(list(self.receipt(after, tool)), want[tool])

    def test_receipts_of_the_archiving_and_session_tools(self):
        want = self.spec['receipts']
        for tool, args, actor in (('orgtree_retire', {'node': 'leaf'}, 'mid'),
                                  ('orgtree_dissolve', {'node': 'mid'}, 'top')):
            with self.subTest(tool=tool):
                self.setUp_fresh()
                r, _, after, _ = self.act(self.keyed(tool, args, actor))
                self.assertEqual(list(self.receipt(after, tool)), want[tool])
        self.setUp_fresh()
        r, _, after, _ = self.act(self.keyed('orgtree_cheap_compact', {'node': 'mid'}, 'top'))
        cls, kept = self.receipt(after, 'orgtree_cheap_compact')
        self.assertEqual([cls, sorted(kept)], want['orgtree_cheap_compact'])
        for args, label in (({'node': 'leaf'}, 'orgtree_rehire'), ({'node': 'leaf', 'name': 'leaf3'},
                                                                   'orgtree_rehire+name')):
            with self.subTest(case=label):
                self.setUp_fresh()
                self.retire_leaf()
                r, _, after, _ = self.act(self.keyed('orgtree_rehire', args, 'mid'))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(list(self.receipt(after, 'orgtree_rehire')), want[label])
        self.assertIsNone(want['orgtree_rename'])
        self.setUp_fresh()
        r, changed, _, _ = self.act(self.keyed('orgtree_list_orgs', {}, 'mid'))
        self.assertEqual((r.status_code, changed), (200, []))

    def test_a_replay_answers_the_envelope_and_does_nothing(self):
        key = opreceipts.mint_key()
        call = self.keyed('orgtree_move', {'node': 'leaf', 'new_parent': 'sib'}, 'top', key)
        self.act(call)
        r, changed, _, _ = self.act(call)
        self.assertEqual(sorted(r.json()), self.spec['results']['keyed_move_replay'])
        self.assertEqual((r.json()['replayed'], r.json()['outcome'], changed, self.hub.call_count),
                         (True, 'applied', [], 0))

    def setUp_fresh(self):
        self.doCleanups()
        self.setUp()

    # -- routes ---------------------------------------------------------------------------------------------------
    def test_the_routes_refuse_an_agent_credential(self):
        self.refused(self.route('/api/orgs/{slug}/dissolve-all', headers={'X-Orgtree-Agent-Token': self.tokens['top']}),
                     '', code=401)

    def test_reorder_reindexes_the_siblings_only(self):
        self.refused(self.route('/api/orgs/{slug}/nodes/leaf/reorder', {'before': None, 'after': None}),
                     'reorder needs a sibling as before= or after=')
        r, _, after = self.ok(self.route('/api/orgs/{slug}/nodes/sib/reorder', {'before': 'mid'}), 'r_reorder_sib')
        self.assertEqual((after['nodes']['sib']['ui_order'], after['nodes']['mid']['ui_order']), (0.0, 1.0))
        self.assertEqual(self.hub.call_count, 1)

    def test_dissolve_all_in_one_save(self):
        r, _, after = self.ok(self.route('/api/orgs/{slug}/dissolve-all'), 'r_dissolve_all')
        self.assertEqual(r.json(), {'freed': 41.0, 'nodes': 5})
        self.assertEqual({n['state'] for n in after['nodes'].values()}, {'archived'})
        self.assertEqual(self.hub.call_count, 1)

    def test_compact_starts_a_thread_and_writes_nothing_itself(self):
        self.refused(self.route('/api/orgs/{slug}/nodes/mid/compact'), 'no conversation yet')
        org = store.load_org(self.slug)
        org.node('mid')['occupancy'] = {'used': 1000, 'window': 200000}
        store.save_org(org)
        r, changed, _, _ = self.act(self.route('/api/orgs/{slug}/nodes/mid/compact'))
        self.assertEqual((r.status_code, r.json(), changed), (200, {'started': True}, []))
        deadline = time.monotonic() + 10
        while not self.compact.call_count and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual([c.args for c in self.compact.call_args_list], [(self.slug, 'mid')])
        self.hub.assert_not_called()

    def test_route_refusals_write_nothing(self):
        self.refused(self.route('/api/orgs/{slug}/lineage/mid/recover'), 'mid is not a lost generation')
        self.refused(self.route('/api/orgs/{slug}/lineage/mid/drop-phantom'), 'mid is not a LOST generation')
        self.refused(self.route('/api/orgs/{slug}/repair-rename', {'rename_at': 't', 'documents': [],
                                                                   'work_items': []}),
                     'name the records to repair')
        self.refused(self.route('/api/orgs/{slug}/nodes/leaf/account', {'account': 'nope'}),
                     "no account 'nope' is registered")


if __name__ == '__main__':
    unittest.main()
