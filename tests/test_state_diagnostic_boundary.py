"""P01 structural diagnostics: authenticated legacy contracts, no native gate.

All organizations, credentials and SQL contacts are disposable. No app lifespan
or provider is started. Legacy gaps are characterizations, not native goldens.
"""
from __future__ import annotations

import contextlib
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import state_operation_contracts as contracts

_temp = tempfile.TemporaryDirectory(prefix='p01-state-diagnostic-')
_data, _home = Path(_temp.name)/'data', Path(_temp.name)/'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data),HOME=str(_home),USERPROFILE=str(_home),
    ORGTREE_V2_TOKEN='diagnostic-operator',ORGTREE_STORE_BACKEND='sqlite',
    ORGTREE_DEPLOYMENT_PROFILE='standard',ORGTREE_DESKTOP_MANAGED='0')
for _key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT',
             'ORGTREE_AGENT_PARENT_DATA','ORGTREE_AGENT_LEGACY_DATA'):
    os.environ.pop(_key,None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, mcptool, opreceipts, statepreview, store, supervisor  # noqa: E402

INSPECT, CAPABILITIES = 'orgtree_state_inspect','orgtree_capabilities'
TOOLS = {INSPECT:'diagnostic.inspect',CAPABILITIES:'diagnostic.capabilities'}
SHAPES = {
    'inspection':{'actor','visibility','nodes'},
    'node':{'id','title','state','parent','generation','model','provider','grant','seat_cost','free',
        'archived_at','bearer_state','account_binding','scope','frozen','pending_switch','last_status','mail_blocked'},
    'account_binding':{'present','missing','provider'},'scope':{'org_visibility','permission_mode','tools','mcp'},
    'tools':{'bash','web','edit','subagents'},'frozen':{'provider','cause','pool','until_ts'},
    'pending_switch':{'from','tier','crossing','at'},'last_status':{'status','at'},
    'mail_blocked':{'reason','since','queued'},
    'capabilities':{'actor','surface','operations','operator_only','agent_only','scope'},
    'capability_scope':{'org_visibility','permission_mode'},
}
NATIVE = {'effective_output_fence','generation_revalidation','invalid_visibility_refusal',
          'indexed_visibility_and_funding_reads','complete_contacts','full_wire_parity','receipt_classification'}

def boundary(document=None):
    d = document if document is not None else contracts.load(ROOT/'docs/state-system/state-diagnostic-boundary.json')
    registry = contracts.load(ROOT/'docs/state-system/operation-contracts.json')
    if set(d) != {'schema','source_contract_sha256','qualification','tools','shapes','visibility',
                  'false_flags','true_flags','operator_only','agent_only','receipt_coverage','native_obligations','scope'}:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.state-diagnostic-boundary/v1' or d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('schema or stale registry')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('qualification cannot be elevated')
    if d['tools'] != TOOLS or {k for k in registry['contracts'] if k.startswith('diagnostic.')} != set(TOOLS.values()):
        raise ValueError('tool contract coverage')
    if set(d['shapes']) != set(SHAPES):
        raise ValueError('shape coverage')
    for key,fields in d['shapes'].items():
        if not isinstance(fields,list) or len(fields) != len(set(fields)) or set(fields) != SHAPES[key]:
            raise ValueError('projection fields')
    if d['visibility'] != ['self','team','subtree','full']:
        raise ValueError('visibility coverage')
    if d['operator_only'] != ['rescind','delete','reseed'] or d['agent_only'] != ['orgtree_swap','orgtree_self_subjugate','orgtree_move']:
        raise ValueError('surface asymmetry')
    if d['receipt_coverage'] != '':
        raise ValueError('legacy unknown receipt class cannot be invented')
    if len(d['native_obligations']) != len(NATIVE) or set(d['native_obligations']) != NATIVE:
        raise ValueError('native gaps cannot disappear')
    if contracts.digest(d['false_flags']) != contracts.digest([False,None,0,'',' false ','0','NO','null','None',[]]) \
            or contracts.digest(d['true_flags']) != contracts.digest([True,1,'true','yes','anything',[1]]):
        raise ValueError('flag cases missing')
    return d

class DiagnosticBinding(unittest.TestCase):
    def test_registry_valid_without_native_or_census_claim(self):
        boundary()
        registry = contracts.load(ROOT/'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry,contracts.inventory.scan(ROOT),ROOT)
        self.assertTrue(result['valid'],result['errors'])
        self.assertFalse(result['contract_coverage_complete'])
        self.assertEqual(result['qualification'],contracts.GATES)
        self.assertEqual(result['summary']['entries']['mapped'],7)
        self.assertEqual(result['summary']['dispatch']['mapped'],31)
        self.assertEqual(result['summary']['storage']['mapped'],0)
        self.assertEqual(result['contracts'],16)

    def test_omissions_private_fields_stale_binding_and_gate_forgery_refuse(self):
        for edit in [lambda d:d['tools'].pop(CAPABILITIES),lambda d:d['visibility'].pop(),
                     lambda d:d['shapes']['node'].append('session_id'),lambda d:d['shapes'].pop('frozen'),
                     lambda d:d['native_obligations'].remove('effective_output_fence'),
                     lambda d:d.update(receipt_coverage='none'),lambda d:d.update(source_contract_sha256='0'*64),
                     lambda d:d['qualification'].update(runtime_census=True),
                     lambda d:d['qualification'].update(conversion_authorized=True),lambda d:d['false_flags'].pop()]:
            with self.subTest(edit=edit):
                data = copy.deepcopy(boundary())
                edit(data)
                with self.assertRaises(ValueError):
                    boundary(data)

class DiagnosticFixture:
    seq = 0

    def setUp(self):
        DiagnosticFixture.seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-diagnostic-{DiagnosticFixture.seq}')
        self.slug = org.d['slug']
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER,None,'haiku',30,'boss')
        org.hire(ledger.USER,'boss','haiku',8,'reader')
        org.hire(ledger.USER,'boss','haiku',1,'peer')
        org.hire(ledger.USER,'reader','haiku',1,'deep')
        org.hire(ledger.USER,'deep','haiku',0,'leaf')
        org.hire(ledger.USER,'reader','haiku',0,'old')
        org.hire(ledger.USER,None,'haiku',3,'outside')
        org.retire(ledger.USER,'old')
        org.node('reader')['scope']['org_visibility'] = 'subtree'
        for order,name in enumerate(('boss','reader','deep','leaf','old','peer','outside')):
            org.node(name)['ui_order'] = order
        org.d['mail'] = {}
        store.save_org(org)
        self.token = agentauth.child_env(self.slug,'reader')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app,raise_server_exceptions=False,client=('127.0.0.1',41000))
        self.addCleanup(self.client.close)

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT),self.slug)
        with supervisor._state_lock:
            for key in list(supervisor._state):
                if key[0] == self.slug:
                    supervisor._state.pop(key)

    def mutate(self,change):
        with store.write_org(self.slug) as org:
            change(org)
            store.save_org(org)

    def visibility(self,mode):
        self.mutate(lambda o:o.node('reader')['scope'].update(org_visibility=mode))

    def call(self,tool=INSPECT,args=None,*,token=None,envelope=None,key=None,epoch=None):
        body = dict(org=self.slug,node='reader',tool=tool,args=args or {})
        if key is not None:
            body.update(tool=opreceipts.OP_CALL,args=dict(tool=tool,args=args or {},op_key=key,op_epoch=epoch))
        if envelope:
            body.update(envelope)
        return self.client.post('/api/agent',json=body,headers={'X-Orgtree-Agent-Token':self.token if token is None else token})

    def okay(self,response):
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def refused(self,response,text,code=422):
        self.assertEqual(response.status_code,code,response.text)
        self.assertEqual(set(response.json()),{'detail'})
        self.assertIn(text,response.json()['detail'])

    def ids(self,args=None):
        return [r['id'] for r in self.okay(self.call(args=args))['nodes']]

class DiagnosticBoundary(DiagnosticFixture,unittest.TestCase):
    def test_visibility_matrix_and_archived_universe(self):
        expected = {'self':['reader'],'team':['reader','peer'],'subtree':['reader','deep','leaf'],
                    'full':['boss','reader','deep','leaf','peer','outside']}
        for mode in self.spec['visibility']:
            with self.subTest(mode=mode):
                self.visibility(mode)
                self.assertEqual(self.ids(),expected[mode])
                archived = list(expected[mode])
                if mode in ('subtree','full'):
                    archived.insert(archived.index('leaf')+1,'old')
                self.assertEqual(self.ids({'include_archived':True}),archived)

    def test_team_contains_siblings_not_parent_or_descendants(self):
        self.visibility('team')
        self.assertEqual(self.ids(),['reader','peer'])
        for target in ('boss','deep','outside'):
            self.refused(self.call(args={'node':target}),'outside your visible scope')
        # Parent id remains an operational reference in an allowed row.
        self.assertEqual(self.okay(self.call())['nodes'][0]['parent'],'boss')

    def test_item_membership_does_not_expand_structural_visibility(self):
        self.visibility('self')
        def membership(org):
            slug = org.work_create(ledger.USER,'Diagnostic scope','Read witness',owner='outside')['slug']
            org.work_assign(ledger.USER,slug,'reader')
        self.mutate(membership)
        self.refused(self.call(args={'node':'outside'}),'outside your visible scope')

    def test_targets_preserve_order_duplicates_and_nodes_precedence(self):
        self.assertEqual(self.ids({'nodes':['leaf','reader','leaf']}),['leaf','reader','leaf'])
        self.assertEqual(self.ids({'node':'outside','nodes':['deep']}),['deep'])
        self.assertEqual(self.ids({'node':'outside','nodes':[]}),['reader','deep','leaf'])
        self.assertEqual(self.ids({'nodes':['','']}),['reader','deep','leaf'])
        self.assertEqual(self.ids({'node':'deep','nodes':None}),['deep'])
        self.assertEqual(self.ids({'node':None}),['reader','deep','leaf'])

    def test_hidden_target_rejects_whole_batch_before_projection(self):
        with patch.object(statepreview,'_safe_node',side_effect=AssertionError('private projection ran')) as project:
            for targets in (['reader','outside'],['missing'],['old']):
                self.refused(self.call(args={'nodes':targets}),'outside your visible scope')
            project.assert_not_called()
        self.assertEqual(self.ids({'nodes':['old'],'include_archived':True}),['old'])

    def test_nodes_container_and_element_coercions_have_explicit_refusals(self):
        for raw in ('reader',1,True,{}):
            self.refused(self.call(args={'nodes':raw}),'nodes must be a list')
        for raw in ([None],[1],[True],[{}],[[]]):
            self.refused(self.call(args={'nodes':raw}),'outside your visible scope')
        for raw in ({},[]):
            self.refused(self.call(args={'node':raw}),'node must be text')
        for raw in (123,True):
            self.refused(self.call(args={'node':raw}),'outside your visible scope')
        self.refused(self.call(args={'node':' deep '}),'outside your visible scope')

    def test_archive_flag_string_and_scalar_normalization(self):
        for raw in self.spec['false_flags']:
            with self.subTest(raw=raw):
                self.assertNotIn('old',self.ids({'include_archived':raw}))
        for raw in self.spec['true_flags']:
            with self.subTest(raw=raw):
                self.assertIn('old',self.ids({'include_archived':raw}))

    def test_structural_and_nested_allowlists_exclude_private_payloads(self):
        marker = 'fixture-private-never-return'
        def populate(org):
            n = org.node('reader')
            n.update(account='missing:'+marker,charter=marker,team_charter=marker,session_id=marker,
                transcript=marker,credentials={'secret':marker},resume_texts=[marker],
                pending_account={'account':marker},
                frozen={'provider':'claude','cause':'usage','pool':'weekly','until_ts':123,'token':marker},
                pending_switch={'from':'haiku','tier':'sonnet','crossing':False,'at':'fixture-at','account':marker},
                last_status={'status':'working','at':'fixture-at','summary':marker},
                mail_drain={'held_reason':'native-context','held_since':'fixture-at','ids':['m1','m2'],'body':marker})
            n['scope'].update(add_dirs=[{'path':marker,'mode':'rw'}])
            n['scope']['tools'].update(bash=False,web=False,edit=False,subagents=False,mcp=['fixture-server'])
        self.mutate(populate)
        out = self.okay(self.call(args={'node':'reader'}))
        self.assertEqual(set(out),SHAPES['inspection'])
        row = out['nodes'][0]
        self.assertEqual(set(row),SHAPES['node'])
        for key in ('account_binding','scope','frozen','pending_switch','last_status','mail_blocked'):
            self.assertEqual(set(row[key]),SHAPES[key])
        self.assertEqual(set(row['scope']['tools']),SHAPES['tools'])
        self.assertEqual(row['account_binding'],dict(present=True,missing=True,provider='claude'))
        self.assertEqual(row['mail_blocked'],dict(reason='native-context',since='fixture-at',queued=2))
        self.assertNotIn(marker,json.dumps(out))
        self.assertNotIn('summary',row['last_status'])
        self.assertNotIn('pending_account',row)

    def test_optional_projection_defaults_and_partial_maps(self):
        row = self.okay(self.call(args={'node':'deep'}))['nodes'][0]
        self.assertEqual(row['account_binding'],dict(present=False,missing=False,provider='claude'))
        for key in ('frozen','pending_switch','mail_blocked'):
            self.assertIsNone(row[key])
        self.assertEqual(row['last_status']['status'],'idle')
        self.assertEqual(set(row['last_status']),SHAPES['last_status'])
        def partial(org):
            org.node('deep').update(frozen={'provider':'claude'},pending_switch={},last_status={},mail_drain={})
        self.mutate(partial)
        row = self.okay(self.call(args={'node':'deep'}))['nodes'][0]
        self.assertEqual(row['frozen'],{'provider':'claude'})
        self.assertEqual(row['pending_switch'],{})
        self.assertEqual(row['last_status'],{})
        self.assertIsNone(row['mail_blocked'])

    def test_free_reads_unreturned_child_obligations_and_current_tier_price(self):
        self.visibility('self')
        row = self.okay(self.call())['nodes'][0]
        self.assertEqual(row['grant'],8)
        self.assertEqual(row['seat_cost'],1)
        self.assertEqual(row['free'],6)  # deep grant 1 + haiku seat 1; old archived.
        self.mutate(lambda o:o.d['tiers'].update(haiku=2))
        row = self.okay(self.call())['nodes'][0]
        self.assertEqual(row['seat_cost'],2)
        self.assertEqual(row['free'],5)
        self.visibility('subtree')
        old = self.okay(self.call(args={'node':'old','include_archived':True}))['nodes'][0]
        self.assertIsNone(old['free'])

    def test_capabilities_are_catalogue_not_authority_or_operator_access(self):
        self.visibility('self')
        self.mutate(lambda o:o.node('reader')['scope']['tools'].update(bash=False,web=False,edit=False,subagents=False,mcp=[]))
        got = self.okay(self.call(CAPABILITIES,args={'node':'outside','operation':'delete'}))
        self.assertEqual(set(got),SHAPES['capabilities'])
        self.assertEqual(set(got['scope']),SHAPES['capability_scope'])
        self.assertEqual((got['actor'],got['surface']),('reader','agent'))
        self.assertEqual(got['operator_only'],self.spec['operator_only'])
        self.assertEqual(got['agent_only'],self.spec['agent_only'])
        self.assertIn('orgtree_reallocate',got['operations'])
        self.assertIn(INSPECT,got['operations'])
        self.assertNotIn('orgtree_delete',got['operations'])
        self.assertEqual(len(got['operations']),len(set(got['operations'])))
        self.refused(self.call('orgtree_reallocate',args={'node':'outside','delta':1}),'authority')
        self.refused(self.call(CAPABILITIES,envelope={'node':ledger.USER}),'identity',403)

    def test_capability_install_policy_and_desktop_alias_matrix(self):
        for profile in ('standard','frozen'):
            for desktop in ('0','1'):
                with self.subTest(profile=profile,desktop=desktop), patch.dict(os.environ,
                        ORGTREE_DEPLOYMENT_PROFILE=profile,ORGTREE_DESKTOP_MANAGED=desktop):
                    names = self.okay(self.call(CAPABILITIES))['operations']
                    self.assertEqual(names,[t['name'] for t in mcptool.available_tools() if t['name'].startswith('orgtree_')])
                    self.assertNotIn('orgtree_move_batch',names)
                    for first,second in [('orgtree_self_restart','orgtree_self_relaunch'),('orgtree_prime_restart','orgtree_prime_relaunch')]:
                        self.assertEqual(first in names,profile=='standard' and desktop=='0')
                        self.assertEqual(second in names,profile=='standard' and desktop=='1')
                    self.assertIn('orgtree_move',names)

    def test_invalid_deployment_profile_cannot_return_permissive_catalogue(self):
        with patch.dict(os.environ,ORGTREE_DEPLOYMENT_PROFILE='typo-permissive'):
            response = self.call(CAPABILITIES)
        self.assertEqual(response.status_code,500,response.text)
        self.assertNotIn('operations',response.text)

    def test_frozen_profile_refuses_non_loopback_before_diagnostic(self):
        client = TestClient(app,raise_server_exceptions=False,client=('192.0.2.20',41000))
        self.addCleanup(client.close)
        with patch.dict(os.environ,ORGTREE_DEPLOYMENT_PROFILE='frozen'), \
                patch.object(statepreview,'inspect_state',side_effect=AssertionError('projected')) as project:
            response = client.post('/api/agent',json=dict(org=self.slug,node='reader',tool=INSPECT,args={}),
                headers={'X-Orgtree-Agent-Token':self.token})
            self.refused(response,'loopback',403)
            project.assert_not_called()

    def test_missing_visibility_is_backfilled_full_but_empty_uses_team(self):
        def missing(org):
            org.node('reader')['scope'].pop('org_visibility',None)
        self.mutate(missing)
        got = self.okay(self.call())
        self.assertEqual(got['visibility'],'full')
        self.assertEqual([r['id'] for r in got['nodes']],['boss','reader','deep','leaf','peer','outside'])
        self.visibility('')
        got = self.okay(self.call())
        self.assertEqual(got['visibility'],'')
        self.assertEqual([r['id'] for r in got['nodes']],['reader','peer'])

    def test_legacy_unknown_visibility_falls_through_to_full_not_native_rule(self):
        # Deliberately corrupt stored data, not a valid scope-setting request.
        self.visibility('invalid-fixture-value')
        self.assertIn('outside',self.ids())
        self.assertIn('invalid_visibility_refusal',self.spec['native_obligations'])

    # Legacy malformed stored state (S2 candidate 3, diagnostic.wire). One
    # corrupt node can fail the WHOLE-org inspection; these are recorded legacy
    # behaviours, not an approved native fallback.
    CORRUPT_NODE = [
        # (field path, stored value, status for node=deep, status for the whole org, projected value or 500 type)
        ('generation','x',500,500,'ValueError'),
        ('generation',[1],500,500,'TypeError'),
        ('generation',None,200,200,0),
        ('grant','x',500,500,'TypeError'),
        ('grant',None,500,500,'TypeError'),
        ('grant',-5,200,200,-5),
        ('model',None,500,500,'KeyError'),
        ('model',5,500,500,'KeyError'),
        ('scope','bad',500,500,'AttributeError'),
        ('scope.tools','bad',500,500,'AttributeError'),
        ('scope.org_visibility',5,200,200,5),
        ('state','weird',422,200,None),     # an unknown state leaves the visible universe
        ('parent','ghost',422,200,None),    # so does a dangling parent
        ('frozen','bad',200,200,None),      # malformed optional maps project as null
        ('frozen',[1],200,200,None),
        ('pending_switch','bad',200,200,None),
        ('last_status','bad',200,200,None),
        ('title',5,200,200,'5'),
    ]

    def test_malformed_stored_node_fields_pin_legacy_projection_or_failure(self):
        for path,value,one,whole,expected in self.CORRUPT_NODE:
            with self.subTest(field=path,value=value):
                saved = {}
                def corrupt(org):
                    node = org.node('deep')
                    saved['node'] = copy.deepcopy(dict(node))
                    *parents,leaf = path.split('.')
                    target = node
                    for part in parents:
                        target = target[part]
                    target[leaf] = value
                self.mutate(corrupt)
                try:
                    response = self.call(args={'node':'deep'})
                    self.assertEqual(response.status_code,one,response.text)
                    self.assertEqual(self.call().status_code,whole)
                    if one == 500:
                        self.assertEqual(response.json()['error']['type'],expected)
                    elif one == 422:
                        self.refused(response,'state inspection is outside your visible scope: deep')
                        self.assertNotIn('deep',self.ids())   # silently absent from the whole org
                    else:
                        row = response.json()['nodes'][0]
                        key = path.split('.')[0]
                        shown = row[key] if path.count('.') == 0 else row['scope']['org_visibility']
                        self.assertEqual(shown,expected)
                finally:
                    def restore(org):
                        node = org.node('deep')
                        node.clear()
                        node.update(saved['node'])
                    self.mutate(restore)

    def test_repeated_diagnostics_use_fresh_scope_without_receipt_replay(self):
        epoch = self.okay(self.call(opreceipts.OP_EPOCH))['epoch']
        key = opreceipts.mint_key()
        for tool in TOOLS:
            self.assertEqual(opreceipts.coverage(tool),self.spec['receipt_coverage'])
            self.assertFalse(opreceipts.receipted(tool))
            self.visibility('subtree')
            before = self.okay(self.call(tool,key=key,epoch=epoch))
            self.visibility('self')
            after = self.okay(self.call(tool,key=key,epoch=epoch))
            if tool == INSPECT:
                self.assertEqual(len(before['nodes']),3)
                self.assertEqual([r['id'] for r in after['nodes']],['reader'])
            else:
                self.assertEqual(before['scope']['org_visibility'],'subtree')
                self.assertEqual(after['scope']['org_visibility'],'self')
            lookup = self.okay(self.call(opreceipts.OP_LOOKUP,args={'for_tool':tool,'for_args':{},'op_key':key,'op_epoch':epoch}))
            self.assertEqual((lookup['state'],lookup['reason'],lookup['coverage']),('unknown','unsupported_operation',''))
            self.assertFalse(store.load_org(self.slug).d.get(opreceipts.SECTION))

    def test_wrapped_diagnostic_still_rejects_missing_key_and_nested_wrapper(self):
        self.refused(self.call(opreceipts.OP_CALL,args={'tool':INSPECT,'args':{},'op_epoch':'fixture'}),'op_key')
        self.refused(self.call(opreceipts.OP_CALL,args={'tool':opreceipts.OP_CALL,'args':{},'op_key':'fixture','op_epoch':'fixture'}),'cannot carry')

    def test_authentication_identity_generation_and_halt_precede_projection(self):
        with patch.object(statepreview,'inspect_state',side_effect=AssertionError('projected')) as inspect, \
                patch.object(api,'_agent_capability_payload',side_effect=AssertionError('catalogued')) as capabilities:
            for tool in TOOLS:
                self.assertEqual(self.call(tool,token='invalid').status_code,401)
                self.refused(self.call(tool,envelope={'node':'peer'}),'identity',403)
            self.mutate(lambda o:o.node('reader').update(generation=1))
            for tool in TOOLS:
                self.refused(self.call(tool),'stale',403)
            self.token = agentauth.child_env(self.slug,'reader')['ORGTREE_AGENT_TOKEN']
            self.mutate(lambda o:o.node('reader').update(halt={'state':'halted'}))
            for tool in TOOLS:
                self.refused(self.call(tool),'halted',409)
            self.mutate(lambda o:o.node('reader').pop('halt',None))
            self.mutate(lambda o:o.d.update(killswitch={'at':'fixture'}))
            for tool in TOOLS:
                self.refused(self.call(tool),'killswitch',409)
            inspect.assert_not_called()
            capabilities.assert_not_called()

    def test_archived_caller_cannot_read_even_with_include_archived(self):
        self.mutate(lambda o:o.node('reader').update(state='archived'))
        for tool in TOOLS:
            self.refused(self.call(tool,args={'include_archived':True}),'archived',403)

    def assert_restriction_observed_next_call(self):
        self.visibility('subtree')
        self.assertEqual(self.ids(),['reader','deep','leaf'])
        self.visibility('self')
        self.assertEqual(self.ids(),['reader'])

    def test_restriction_is_observed_by_next_call(self):
        self.assert_restriction_observed_next_call()

    def test_unsafe_cached_visibility_fails_normal_restriction_assertion(self):
        original,cache,ran = statepreview._visible_ids,{},[]
        def unsafe(org,actor,include_archived=False):
            ran.append(True)
            if actor not in cache:
                cache[actor] = original(org,actor,include_archived)
            return cache[actor]
        with patch.object(statepreview,'_visible_ids',new=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_restriction_observed_next_call()
        self.assertGreaterEqual(len(ran),2)

    def assert_no_account_identity(self):
        row = self.okay(self.call(args={'node':'reader'}))['nodes'][0]
        self.assertEqual(set(row),SHAPES['node'])
        self.assertNotIn('account',row)

    def test_unsafe_extra_private_field_fails_normal_projection_assertion(self):
        self.assert_no_account_identity()
        original,ran = statepreview._safe_node,[]
        def unsafe(org,nid):
            ran.append(True)
            return dict(original(org,nid),account='fixture-leak')
        with patch.object(statepreview,'_safe_node',new=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_no_account_identity()
        self.assertTrue(ran)

    def test_legacy_restriction_during_projection_does_not_fence_response(self):
        original,ran = statepreview._safe_node,[]
        def after_check(org,nid):
            if not ran:
                ran.append(True)
                self.visibility('self')
            return original(org,nid)
        with patch.object(statepreview,'_safe_node',new=after_check):
            self.assertEqual(self.ids(),['reader','deep','leaf'])
        self.assertTrue(ran)
        self.assertEqual(self.ids(),['reader'])
        self.assertIn('effective_output_fence',self.spec['native_obligations'])

    def test_legacy_generation_change_between_identity_and_leaf_is_not_rechecked(self):
        original,ran = store.load_org,[]
        def changed(slug):
            if slug==self.slug and not ran:
                ran.append(True)
                self.mutate(lambda o:o.node('reader').update(generation=1))
            return original(slug)
        with patch.object(store,'load_org',new=changed):
            self.okay(self.call(CAPABILITIES))
        self.assertTrue(ran)
        self.refused(self.call(CAPABILITIES),'stale',403)
        self.assertIn('generation_revalidation',self.spec['native_obligations'])

    def test_real_pooled_sql_witness_separates_small_output_from_eager_load(self):
        # Existing migrated fixture only: never invoke native service or migration.
        self.okay(self.call(CAPABILITIES))
        acquire,contacts = store._POOL.acquire,[]
        @contextlib.contextmanager
        def observed(slug):
            with acquire(slug) as conn:
                def trace(sql):
                    words = sql.strip().split()
                    if not words:
                        return
                    # The only retained fields are controlled labels; never SQL values.
                    contacts.append({'verb':words[0].upper(),
                        'tables':sorted(t for t in ('meta','doc','nodes','log_d','log_l')
                            if re.search(r'\b(?:FROM|INTO|UPDATE|JOIN)\s+["`\[]?'+t+r'\b',sql,re.I)),
                        'all_nodes':bool(re.fullmatch(r'\s*SELECT id, val FROM nodes ORDER BY ord\s*',sql,re.I))})
                conn.set_trace_callback(trace)
                try:
                    yield conn
                finally:
                    conn.set_trace_callback(None)
        before = store.org_seq(self.slug)
        with patch.object(store._POOL,'acquire',new=observed), \
                patch.object(store,'save_org',side_effect=AssertionError('diagnostic domain save')), \
                patch.object(subprocess,'Popen',side_effect=AssertionError('provider launch')), \
                patch.object(supervisor,'read_chat',side_effect=AssertionError('transcript contact')):
            for tool in TOOLS:
                contacts.clear()
                got = self.okay(self.call(tool,args={'node':'reader'}))
                if tool == INSPECT:
                    self.assertEqual([r['id'] for r in got['nodes']],['reader'])
                self.assertTrue(any(row['all_nodes'] for row in contacts),contacts)
                verbs = {row['verb'] for row in contacts}
                self.assertTrue({'SELECT','BEGIN','COMMIT'} <= verbs,verbs)
                self.assertFalse(verbs & {'INSERT','UPDATE','DELETE','REPLACE'},verbs)
                self.assertTrue(any('doc' in r['tables'] for r in contacts),contacts)
                print(json.dumps({'p01_diagnostic_contact_witness':tool,'statements':len(contacts),
                    'verbs':sorted(verbs),'tables':sorted({t for r in contacts for t in r['tables']}),
                    'all_node_selects':sum(r['all_nodes'] for r in contacts),'runtime_census':False}))
        self.assertEqual(store.org_seq(self.slug),before)

def tearDownModule():
    # Every fixture closes its own pooled connections before deleting its org.
    _temp.cleanup()

if __name__ == '__main__':
    unittest.main()
