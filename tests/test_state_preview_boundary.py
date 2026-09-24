"""Source-bound preview contracts on disposable data, without native claims."""
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

_temp = tempfile.TemporaryDirectory(prefix='p01-preview-')
_data,_home = Path(_temp.name)/'data',Path(_temp.name)/'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data),HOME=str(_home),USERPROFILE=str(_home),
    ORGTREE_V2_TOKEN='preview-operator',ORGTREE_STORE_BACKEND='sqlite',
    ORGTREE_DEPLOYMENT_PROFILE='standard',ORGTREE_DESKTOP_MANAGED='0')
for _key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT',
             'ORGTREE_AGENT_PARENT_DATA','ORGTREE_AGENT_LEGACY_DATA'):
    os.environ.pop(_key,None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app,*_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth,api,ledger,opreceipts,registry,statepreview,store,supervisor  # noqa: E402

OPS = ['reallocate','move','swap','swap_seats','self_subjugate','subjugate',
       'retool','set_scope','retire','dissolve','revoke_dir','switch_model','audience']
DENIED = ['hire','rehire','rename','move_batch','rescind','delete','reseed','promote','demote']
TOP = {'operation','applied','result','before','after','changes'}
NATIVE = {'bounded_snapshot_reads','effective_output_fence','generation_revalidation','provider_preflight_contacts',
          'account_session_parity','complete_transition_predicates','full_wire_parity','receipt_classification'}
PRIVATE = {'account','api_key','credentials','external_handles','inflight','mail','mail_log','user_inbox','user_mail_log',
           'org_inbox','resume_texts','resume_views','halt_sources','session_id','transcript','charter','team_charter','token','secret'}

def boundary(document=None):
    doc = document if document is not None else contracts.load(ROOT/'docs/state-system/preview-boundary.json')
    reg = contracts.load(ROOT/'docs/state-system/operation-contracts.json')
    fields = {'schema','source_contract_sha256','qualification','tool','contract','admitted','denied',
              'shape','change_shape','receipt_coverage','private_keys','result_sequence_limit','operator_preview',
              'native_obligations','scope'}
    if set(doc) != fields or doc['schema'] != 'orgtree.preview-boundary/v1':
        raise ValueError('fixture schema')
    if doc['source_contract_sha256'] != contracts.digest(reg):
        raise ValueError('stale registry')
    if doc['qualification'] != contracts.GATES or any(v is not False for v in doc['qualification'].values()):
        raise ValueError('qualification cannot be elevated')
    if doc['tool'] != 'orgtree_preview' or doc['contract'] != 'preview.agent' or 'preview.agent' not in reg['contracts']:
        raise ValueError('tool binding')
    for key,expected in [('admitted',OPS),('denied',DENIED)]:
        if doc[key] != expected:
            raise ValueError('operation coverage')
    for key,expected in [('shape',TOP),('change_shape',{'path','before','after'}),
                         ('private_keys',PRIVATE),('native_obligations',NATIVE)]:
        if not isinstance(doc[key],list) or len(doc[key]) != len(expected) or set(doc[key]) != expected:
            raise ValueError('shape or obligation coverage')
    if doc['receipt_coverage'] != '' or doc['result_sequence_limit'] != 200:
        raise ValueError('legacy receipt/shape changed')
    if doc['operator_preview'] != ['retire','rescind','delete','dissolve','reallocate','switch_model','promote','demote','move','reseed','revoke_dir']:
        raise ValueError('surface asymmetry')
    return doc

class PreviewBinding(unittest.TestCase):
    def test_source_bound_registry_and_exact_public_allowlist(self):
        boundary()
        reg = contracts.load(ROOT/'docs/state-system/operation-contracts.json')
        checked = contracts.validate(reg,contracts.inventory.scan(ROOT),ROOT)
        self.assertTrue(checked['valid'],checked['errors'])
        self.assertFalse(checked['contract_coverage_complete'])
        self.assertEqual(checked['qualification'],contracts.GATES)
        self.assertEqual(set(api._AGENT_PREVIEW_OPS),set(OPS))
        self.assertEqual(checked['summary']['entries']['mapped'],9)
        self.assertEqual(checked['summary']['dispatch']['mapped'],36)
        self.assertEqual(checked['contracts'],18)

    def test_fixture_omissions_forged_gates_and_stale_binding_refuse(self):
        for change in [lambda d:d['admitted'].pop(),lambda d:d['denied'].remove('delete'),
                       lambda d:d['shape'].append('session_id'),lambda d:d['private_keys'].pop(),
                       lambda d:d['native_obligations'].remove('account_session_parity'),
                       lambda d:d.update(receipt_coverage='none'),lambda d:d.update(source_contract_sha256='0'*64),
                       lambda d:d['qualification'].update(runtime_census=True),
                       lambda d:d['qualification'].update(conversion_authorized=True)]:
            with self.subTest(change=change):
                doc = copy.deepcopy(boundary())
                change(doc)
                with self.assertRaises(ValueError):
                    boundary(doc)

class PreviewFixture:
    seq = 0

    def setUp(self):
        PreviewFixture.seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-preview-{PreviewFixture.seq}')
        self.slug = org.d['slug']
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER,None,'haiku',40,'actor')
        org.hire(ledger.USER,'actor','haiku',8,'a')
        org.hire(ledger.USER,'a','haiku',0,'leaf')
        org.hire(ledger.USER,'actor','haiku',2,'b')
        org.hire(ledger.USER,'actor','haiku',0,'old')
        org.hire(ledger.USER,None,'haiku',5,'foreign')
        org.retire(ledger.USER,'old')
        org.node('actor')['scope']['org_visibility'] = 'full'
        org.node('a')['charter'] = 'fixture-private-charter'
        org.node('a')['account'] = 'fixture-original-account'
        org.d['mail'] = {}
        store.save_org(org)
        self.token = agentauth.child_env(self.slug,'actor')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app,raise_server_exceptions=False,client=('127.0.0.1',42000))
        self.addCleanup(self.client.close)
        # Never execute native provider discovery in a preview boundary fixture.
        gate = patch.object(api,'provider_hire_gate',side_effect=AssertionError('unstubbed provider probe'))
        gate.start()
        self.addCleanup(gate.stop)

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT),self.slug)
        with supervisor._state_lock:
            for key in list(supervisor._state):
                if key[0] == self.slug:
                    supervisor._state.pop(key)

    def mutate(self,fn):
        with store.write_org(self.slug) as org:
            fn(org)
            store.save_org(org)

    def stored(self):
        return json.loads(json.dumps(store.load_org(self.slug).d))

    def call(self,operation='reallocate',args=None,*,extra=None,key=None,epoch=None,token=None):
        outer = {'operation':operation,'args':{'node':'b','delta':1} if args is None else args}
        if extra:
            outer.update(extra)
        body = dict(org=self.slug,node='actor',tool='orgtree_preview',args=outer)
        if key:
            body.update(tool=opreceipts.OP_CALL,args=dict(tool='orgtree_preview',args=outer,op_key=key,op_epoch=epoch))
        return self.client.post('/api/agent',json=body,headers={'X-Orgtree-Agent-Token':self.token if token is None else token})

    def okay(self,response):
        self.assertEqual(response.status_code,200,response.text)
        result = response.json()
        self.assertEqual(set(result),TOP)
        self.assertIs(result['applied'],False)
        self.assertEqual(result['before']['actor'],'actor')
        for change in result['changes']:
            self.assertEqual(set(change),{'path','before','after'})
        return result

    def refused(self,response,text,code=422):
        self.assertEqual(response.status_code,code,response.text)
        self.assertIn(text,response.json()['detail'])

    def row(self,payload,nid,part='after'):
        return next(n for n in payload[part]['nodes'] if n['id']==nid)

    def assert_simulation_only(self,operation='reallocate',args=None):
        before = self.stored()
        out = self.okay(self.call(operation,args))
        self.assertEqual(self.stored(),before)
        return out

class PreviewBoundary(PreviewFixture,unittest.TestCase):
    def test_each_admitted_spelling_reaches_its_real_ledger_transition(self):
        cases = {
            'reallocate':{'node':'b','delta':1},'move':{'node':'leaf','new_parent':'b'},
            'swap':{'a':'a','b':'b'},'swap_seats':{'a':'a','b':'b'},
            'self_subjugate':{'target':'a'},'subjugate':{'target':'a'},
            'retool':{'node':'a','org_visibility':'self'},'set_scope':{'node':'a','org_visibility':'self'},
            'retire':{'node':'b'},'dissolve':{'node':'a'},'revoke_dir':{'node':'a','dir':'fixture-unheld'},
            'switch_model':{'node':'b','tier':'sonnet'},'audience':{'action':'grant','from':'leaf'},
        }
        self.assertEqual(set(cases),set(self.spec['admitted']))
        with patch.object(api,'provider_hire_gate') as gate:
            for op,args in cases.items():
                with self.subTest(op=op):
                    out = self.assert_simulation_only(op,args)
                    self.assertEqual(out['operation'],op)
                    self.assertIsInstance(out['result'],dict)
                    self.assertNotIn('warnings',set(out))
                    if op == 'move': self.assertEqual(self.row(out,'leaf')['parent'],'b')
                    if op in ('swap','swap_seats'): self.assertEqual(self.row(out,'leaf')['parent'],'b')
                    if op in ('self_subjugate','subjugate'): self.assertEqual(self.row(out,'actor')['parent'],'a')
                    if op in ('retool','set_scope'): self.assertEqual(self.row(out,'a')['scope']['org_visibility'],'self')
                    if op in ('retire','dissolve'): self.assertEqual(self.row(out,args['node'])['state'],'archived')
                    if op == 'switch_model': self.assertEqual(self.row(out,'b')['model'],'sonnet')
            gate.assert_called_once()

    def test_prefixed_names_normalize_once_without_case_or_space_folding(self):
        self.assertEqual(self.okay(self.call('orgtree_reallocate'))['operation'],'reallocate')
        for op in ('REALLOCATE',' reallocate','reallocate ','orgtree_orgtree_reallocate','',None,'unknown'):
            with self.subTest(op=op):
                self.refused(self.call(op),'not an agent-dispatchable transition')
        for op in ({},[]):
            self.refused(self.call(op),'operation must be text')

    def test_operator_only_and_unsupported_names_refuse_before_shadow(self):
        with patch.object(statepreview,'isolated',side_effect=AssertionError('forbidden simulation')) as clone:
            for op in self.spec['denied']:
                self.refused(self.call(op),'not an agent-dispatchable transition')
            clone.assert_not_called()

    def test_visibility_does_not_grant_management_authority_or_actor_spoofing(self):
        before = self.stored()
        self.refused(self.call(args={'node':'foreign','delta':1,'actor':'@user'}),'authority')
        self.refused(self.call(args={'node':'actor','delta':1}),'authority')
        self.assertEqual(self.stored(),before)

    def test_scope_ceiling_and_own_charter_rules_still_run(self):
        self.refused(self.call('retool',{'node':'actor','charter':'override'}),'OWN charter')
        self.mutate(lambda o:o.node('actor')['scope'].update(org_visibility='self'))
        self.refused(self.call('retool',{'node':'a','org_visibility':'full'}),'exceeds your own')
        result = self.assert_simulation_only('retool',{'node':'actor','team_charter':'private-new-text'})
        self.assertNotIn('private-new-text',json.dumps(result))

    def test_live_reports_prevent_self_retirement_and_credit_overdraw_refuses(self):
        before = self.stored()
        self.refused(self.call('retire',{'node':'actor'}),'live reports')
        response = self.call(args={'node':'b','delta':-100})
        self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.stored(),before)

    def test_fractional_delta_rounds_target_and_no_credit_is_reserved(self):
        out = self.assert_simulation_only(args={'node':'b','delta':0.2})
        self.assertEqual(out['result']['grant'],3)
        self.assertEqual(self.row(out,'b')['grant'],3)
        self.assertEqual(self.stored()['nodes']['b']['grant'],2)

    def test_batch_move_and_refusal_leave_entire_source_unchanged(self):
        out = self.assert_simulation_only('move',{'moves':[{'node':'leaf','new_parent':'b'}]})
        self.assertEqual(self.row(out,'leaf')['parent'],'b')
        before = self.stored()
        bad = self.call('move',{'moves':[{'node':'leaf','new_parent':'b'},{'node':'b','new_parent':'leaf'}]})
        self.assertEqual(bad.status_code,422,bad.text)
        self.assertEqual(self.stored(),before)
        self.refused(self.call('move',{'moves':[{'node':'leaf'}]}),'new_parent')
        self.refused(self.call('move',{'moves':['leaf']}),'must be an object')

    def test_audience_grant_mail_and_revoke_are_shadow_only(self):
        original,captured = statepreview._apply,[]
        def observed(org,*args,**kw):
            result = original(org,*args,**kw)
            captured.append(copy.deepcopy(org.d))
            return result
        with patch.object(statepreview,'_apply',new=observed):
            out = self.assert_simulation_only('audience',{'action':'grant','from':'leaf'})
        self.assertEqual(out['result']['drive'],['leaf'])
        self.assertTrue(captured[-1]['mail'].get('leaf'))
        self.assertTrue(captured[-1]['audiences'])
        self.assertFalse(self.stored()['mail'].get('leaf'))
        self.mutate(lambda o:o.audience_grant('actor','leaf'))
        self.assert_simulation_only('audience',{'action':'revoke','grantee':'leaf'})
        for action in ('request','GRANT',' grant','deny'):
            self.refused(self.call('audience',{'action':action,'from':'leaf'}),'grant or revoke only')

    def test_plain_bool_archive_flag_differs_from_inspection_flags(self):
        for flag,has_old in [('missing',True),(True,True),(False,False),(None,False),('',False),('false',True),('0',True)]:
            with self.subTest(flag=flag):
                extra = {} if flag=='missing' else {'include_archived':flag}
                out = self.okay(self.call(extra=extra))
                self.assertEqual('old' in {r['id'] for r in out['before']['nodes']},has_old)
                self.assertEqual('old' in {r['id'] for r in out['after']['nodes']},has_old)

    def test_falsy_args_default_before_type_check_and_nested_text_normalizes(self):
        for arg in (None,False,0,'',[],{}):
            # Explicitly force the nested wire value; call's None default is useful elsewhere.
            response = self.call(extra={'args':arg})
            self.assertEqual(response.status_code,422,response.text)
            self.assertNotIn('args must be an object',response.text)
        for arg in (1,True,'a',[{}]):
            self.refused(self.call(extra={'args':arg}),'args must be an object')
        for node in ({},[]):
            self.refused(self.call(args={'node':node,'delta':1}),'node must be text')
        self.refused(self.call(args={'node':None,'delta':1}),'no such node')

    def test_selected_numeric_malformed_args_remain_legacy_500_gaps(self):
        for value in (None,'not-numeric',{},[]):
            with self.subTest(value=value):
                response = self.call(args={'node':'b','delta':value})
                self.assertEqual(response.status_code,500,response.text)
        self.assertIn('full_wire_parity',self.spec['native_obligations'])

    # Legacy per-operation malformed-input parity (S2 candidate 3, preview.wire).
    # Every node-naming field is a shared _norm_args text field; `dir` is not.
    MALFORMED_OPS = {
        'reallocate':{'node':'b','delta':1},'move':{'node':'leaf','new_parent':'b'},
        'swap':{'a':'a','b':'b'},'self_subjugate':{'target':'a'},
        'retool':{'node':'a','org_visibility':'self'},'retire':{'node':'b'},'dissolve':{'node':'a'},
        'revoke_dir':{'node':'a','dir':'fixture-unheld'},'switch_model':{'node':'b','tier':'sonnet'},
        'audience':{'action':'grant','from':'leaf'},
    }
    ENUMS = {('retool','org_visibility'):"org_visibility must be one of ('self', 'team', 'subtree', 'full')",
             ('switch_model','tier'):'unknown tier',
             ('audience','action'):'preview supports audience grant or revoke only'}

    def test_per_operation_malformed_arguments_pin_legacy_refusals(self):
        before = self.stored()
        with patch.object(api,'provider_hire_gate'):
            for op,args in self.MALFORMED_OPS.items():
                for field in args:
                    for label,bad in (('dict',{}),('list',[1]),('unknown','ghost'),('empty',''),('number',7)):
                        with self.subTest(op=op,field=field,bad=label):
                            response = self.call(op,{**args,field:bad})
                            if field == 'dir':
                                # recorded gap: revoke_dir's dir is never validated in the shadow
                                self.okay(response)
                            elif field == 'delta':
                                if label == 'number':
                                    self.okay(response)
                                else:
                                    self.assertEqual(response.status_code,500,response.text)
                                    self.assertEqual(set(response.json()),{'detail','error'})
                            elif label in ('dict','list'):
                                self.refused(response,f'{field} must be text, not {type(bad).__name__}')
                            elif (op,field) in self.ENUMS:
                                self.refused(response,self.ENUMS[(op,field)])
                            else:
                                self.refused(response,"no such node: '"+str(bad)+"'")
        self.assertEqual(self.stored(),before)

    def test_retool_account_checks_precede_clone_but_binding_is_not_simulated(self):
        before = self.stored()
        with patch.object(registry,'validate_selection',wraps=registry.validate_selection) as checked:
            out = self.assert_simulation_only('retool',{'node':'a','account':'claude/primary'})
        checked.assert_called_once_with(self.slug,'haiku','claude/primary')
        self.assertEqual(self.row(out,'a')['account_binding']['present'],True)
        self.assertEqual(out['changes'],[])
        self.assertEqual(self.stored(),before)
        with patch.object(statepreview,'isolated',side_effect=AssertionError('clone after refused account')) as clone:
            self.refused(self.call('retool',{'node':'actor','account':'primary'}),'own account',403)
            self.refused(self.call('retool',{'node':'foreign','account':'primary'}),'subordinates',403)
            self.refused(self.call('retool',{'node':'a','account':'openai/primary'}),'does not match')
            clone.assert_not_called()

    def test_retool_current_model_gate_does_not_follow_queued_destination(self):
        self.mutate(lambda o:o.node('a').update(pending_switch={'tier':'luna','from':'haiku','seq':1}))
        self.refused(self.call('retool',{'node':'a','account':'openai/primary'}),'does not match')
        self.assertIn('account_session_parity',self.spec['native_obligations'])

    def test_directory_translation_runs_but_its_warnings_are_not_returned(self):
        with patch.object(supervisor,'sandbox_dirs_to_host',return_value=([],['dropped-fixture-dir'])) as translated:
            out = self.assert_simulation_only('retool',{'node':'a','add_dirs':[{'path':'/fixture/scratch'}]})
        translated.assert_called_once()
        self.assertEqual(translated.call_args.args[1],[{'path':'/fixture/scratch'}])
        self.assertNotIn('dropped-fixture-dir',json.dumps(out))

    def test_unknown_retool_fields_and_private_charter_do_not_appear_in_projection(self):
        baseline = self.assert_simulation_only('retool',{'node':'a','not_a_field':True})
        out = self.assert_simulation_only('retool',{'node':'a','charter':'new-private-body','not_a_field':True})
        self.assertEqual(baseline['changes'],[])
        self.assertEqual(out['changes'],[])
        self.assertNotIn('new-private-body',json.dumps(out))

    def test_provider_and_account_refusals_precede_shadow(self):
        before = self.stored()
        with patch.object(api,'provider_hire_gate',side_effect=ledger.LedgerError('fixture-provider-refused')) as gate, \
                patch.object(statepreview,'isolated',side_effect=AssertionError('gate bypass')) as clone:
            self.refused(self.call('switch_model',{'node':'b','tier':'sonnet'}),'fixture-provider-refused')
            gate.assert_called_once()
            clone.assert_not_called()
        with patch.object(api,'provider_hire_gate'),patch.object(statepreview,'isolated',side_effect=AssertionError('account bypass')) as clone:
            self.refused(self.call('switch_model',{'node':'a','tier':'luna'}),'needs the account')
            clone.assert_not_called()
        self.assertEqual(self.stored(),before)

    def test_busy_and_durable_inflight_switches_only_queue_in_shadow(self):
        for busy,inflight in [(True,False),(False,True)]:
            with self.subTest(busy=busy,inflight=inflight):
                self.mutate(lambda o:o.node('b').update(inflight={'id':'fixture-turn'} if inflight else None))
                with patch.object(api,'provider_hire_gate'),patch.object(supervisor,'state',return_value={'busy':busy}):
                    out = self.assert_simulation_only('switch_model',{'node':'b','tier':'sonnet'})
                self.assertTrue(out['result']['queued'])
                self.assertEqual(self.row(out,'b')['model'],'haiku')
                self.assertEqual(self.row(out,'b')['pending_switch']['tier'],'sonnet')
                self.assertNotIn('pending_switch',self.stored()['nodes']['b'])

    def test_switch_of_current_tier_simulates_cancel_without_persisting_it(self):
        self.mutate(lambda o:o.node('b').update(pending_switch={'tier':'sonnet','from':'haiku','seq':1}))
        with patch.object(api,'provider_hire_gate'):
            out = self.assert_simulation_only('switch_model',{'node':'b','tier':'haiku'})
        self.assertEqual(out['result']['cancelled'],'sonnet')
        self.assertIsNone(self.row(out,'b')['pending_switch'])
        self.assertEqual(self.stored()['nodes']['b']['pending_switch']['tier'],'sonnet')

    def test_result_redacts_keys_recursively_but_not_arbitrary_values(self):
        raw = {k:'SECRET' for k in PRIVATE}
        raw.update(Secret='hidden',rows=[{'token':'hidden','ok':1}],tuple_rows=({'charter':'hidden','ok':2},),
                   label='SECRET-IN-VALUE',session_id_hint='unlisted-key',long='x'*5000)
        with patch.object(statepreview,'_apply',return_value=raw):
            out = self.assert_simulation_only()
        self.assertFalse(PRIVATE & {k.lower() for k in out['result']})
        self.assertEqual(out['result']['rows'],[{'ok':1}])
        self.assertEqual(out['result']['tuple_rows'],[{'ok':2}])
        self.assertEqual(out['result']['label'],'SECRET-IN-VALUE')
        self.assertEqual(len(out['result']['long']),5000)
        self.assertIn('session_id_hint',out['result'])

    def test_result_list_limit_is_not_a_before_after_or_diff_limit(self):
        with patch.object(statepreview,'_apply',return_value={'values':list(range(240))}):
            out = self.assert_simulation_only()
        self.assertEqual(out['result']['values'],list(range(200)))
        projected = {'actor':'actor','visibility':'full','nodes':[{'id':str(i)} for i in range(240)]}
        changed = copy.deepcopy(projected)
        for row in changed['nodes']: row['value']=1
        with patch.object(statepreview,'inspect_state',side_effect=[projected,changed]),patch.object(statepreview,'_apply',return_value={}):
            out = self.assert_simulation_only()
        self.assertEqual(len(out['before']['nodes']),240)
        self.assertEqual(len(out['after']['nodes']),240)
        self.assertEqual(len(out['changes']),240)

    def test_diff_uses_positional_paths_and_null_for_absent_fields(self):
        self.assertEqual(statepreview._diff({'a':[{'x':1}]},{'a':[{'x':2},{'y':3}]}),[
            {'path':'a[0].x','before':1,'after':2},{'path':'a[1]','before':None,'after':{'y':3}}])
        self.assertEqual(statepreview._diff({'a':None},{}),[{'path':'a','before':None,'after':None}])

    def test_retries_recompute_and_legacy_lookup_cannot_create_a_fence(self):
        response = self.client.post('/api/agent',json=dict(org=self.slug,node='actor',tool=opreceipts.OP_EPOCH,args={}),
            headers={'X-Orgtree-Agent-Token':self.token})
        self.assertEqual(response.status_code,200,response.text)
        epoch = response.json()['epoch']
        preview_key,lookup_key = opreceipts.mint_key(),opreceipts.mint_key()
        first = self.okay(self.call(key=preview_key,epoch=epoch))
        self.assertEqual(first['result']['grant'],3)
        self.mutate(lambda o:o.node('b').update(grant=4))
        again = self.okay(self.call(key=preview_key,epoch=epoch))
        self.assertEqual(again['result']['grant'],5)
        self.assertEqual(opreceipts.coverage('orgtree_preview',{}),'')
        response = self.client.post('/api/agent',json=dict(org=self.slug,node='actor',tool=opreceipts.OP_LOOKUP,
            args=dict(for_tool='orgtree_preview',for_args={'operation':'reallocate','args':{'node':'b','delta':1}},
                      op_key=lookup_key,op_epoch=epoch)),headers={'X-Orgtree-Agent-Token':self.token})
        self.assertEqual(response.status_code,200,response.text)
        result = response.json()
        self.assertEqual((result['state'],result['reason']),('unknown','unsupported_operation'))
        self.assertEqual(result['coverage'],'')
        self.assertEqual(self.okay(self.call(key=lookup_key,epoch=epoch))['result']['grant'],5)
        self.assertFalse(store.load_org(self.slug).d.get(opreceipts.SECTION))

    def test_authentication_and_generation_fail_before_simulation(self):
        with patch.object(statepreview,'preview',side_effect=AssertionError('simulation before admission')) as preview:
            self.refused(self.call(token='bad-credential'),'credential',401)
            self.mutate(lambda o:o.node('actor').update(generation=1))
            self.refused(self.call(),'stale',403)
            preview.assert_not_called()

    def test_operator_route_requires_operator_auth_and_keeps_surface_allowlist(self):
        path = f'/api/orgs/{self.slug}/ops'
        body = {'op':'reallocate','preview':True,'node':'b','delta':1}
        response = self.client.post(path,json=body,headers={'X-Orgtree-Agent-Token':self.token})
        self.assertEqual(response.status_code,401,response.text)
        headers = {'X-Orgtree-Desktop-Token':'preview-operator'}
        before = self.stored()
        out = self.client.post(path,json=body,headers=headers)
        self.assertEqual(out.status_code,200,out.text)
        self.assertEqual(out.json()['before']['actor'],ledger.USER)
        self.assertFalse(out.json()['applied'])
        self.assertEqual(self.stored(),before)
        for op in ('swap','self_subjugate','move_batch','retool','audience'):
            response = self.client.post(path,json=dict(body,op=op),headers=headers)
            self.refused(response,'preview does not support operator operation')

    def test_public_operator_preview_is_refused_even_with_admin_credential(self):
        with patch.object(api,'_public_slug',return_value=self.slug):
            response = self.client.post(f'/api/orgs/{self.slug}/ops',json={'op':'reallocate','preview':True,'node':'b','delta':1},
                                       headers={'X-Orgtree-Desktop-Token':'preview-operator'})
        self.refused(response,'operator previews',403)

    def assert_detached_input(self):
        org = store.load_org(self.slug)
        original = json.loads(json.dumps(org.d))
        statepreview.preview(org,'actor','reallocate',{'node':'b','delta':1})
        self.assertEqual(json.loads(json.dumps(org.d)),original)

    def test_unsafe_shared_clone_fails_same_input_immutability_assertion(self):
        self.assert_detached_input()
        ran = []
        def unsafe(org):
            ran.append(True)
            return org
        with patch.object(statepreview,'isolated',new=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_detached_input()
        self.assertTrue(ran)

    def test_unsafe_preview_save_fails_same_persisted_immutability_assertion(self):
        self.assert_simulation_only()
        original,ran = statepreview.preview,[]
        def unsafe(org,*args,**kw):
            out = original(org,*args,**kw)
            org.reallocate('actor','b',1)
            store.save_org(org)
            ran.append(True)
            return out
        with patch.object(statepreview,'preview',new=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_simulation_only()
        self.assertTrue(ran)

    def test_real_clone_materializes_unrelated_history_without_domain_commit(self):
        self.mutate(lambda o:o.d.setdefault('mail_log',{}).update(foreign=[{'id':'history-fixture','body':'private-unrelated-history'}]))
        self.call()  # warm the already-created SQLite fixture only
        acquire,contacts = store._POOL.acquire,[]
        materialize,sections = store.LazyDoc.materialize_all,[]
        def observed_materialize(doc):
            before = set(doc._unmaterialized())
            result = materialize(doc)
            sections.extend(sorted(before-set(doc._unmaterialized())))
            return result
        @contextlib.contextmanager
        def observed(slug):
            with acquire(slug) as conn:
                def trace(sql):
                    words = sql.strip().split()
                    if words:
                        contacts.append({'verb':words[0].upper(),'tables':sorted(t for t in ('meta','doc','nodes','log_d','log_l')
                            if re.search(r'\b(?:FROM|INTO|UPDATE|JOIN)\s+["`\[]?'+t+r'\b',sql,re.I))})
                conn.set_trace_callback(trace)
                try: yield conn
                finally: conn.set_trace_callback(None)
        before = self.stored()
        with patch.object(store._POOL,'acquire',new=observed),patch.object(store.LazyDoc,'materialize_all',new=observed_materialize), \
                patch.object(store,'save_org',side_effect=AssertionError('preview save')), \
                patch.object(subprocess,'Popen',side_effect=AssertionError('process launch')), \
                patch.object(supervisor,'read_chat',side_effect=AssertionError('transcript read')):
            out = self.okay(self.call())
        self.assertEqual(self.stored(),before)
        self.assertIn('mail_log',sections)
        self.assertNotIn('private-unrelated-history',json.dumps(out))
        verbs = {r['verb'] for r in contacts}
        self.assertFalse(verbs & {'INSERT','UPDATE','DELETE','REPLACE'})
        self.assertTrue({'SELECT','BEGIN','COMMIT'} <= verbs)
        print(json.dumps({'p01_preview_contact_witness':True,'statements':len(contacts),'verbs':sorted(verbs),
            'tables':sorted({t for r in contacts for t in r['tables']}),'materialized_sections':sorted(set(sections)),
            'runtime_census':False,'provider_preflight':'not part of this reallocate fixture'}))

def tearDownModule():
    _temp.cleanup()

if __name__ == '__main__':
    unittest.main()
