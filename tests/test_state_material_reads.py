"""P01 read-material contracts: real HTTP authority, selected wire/sidecar paths.

All data and credentials are disposable. No ASGI lifespan or provider is started.
Characterizations of legacy gaps are explicitly not native acceptance tests.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

_temp = tempfile.TemporaryDirectory(prefix='p01-material-reads-')
_data = Path(_temp.name) / 'data'
_home = Path(_temp.name) / 'home'
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
import httpx  # noqa: E402
from orgtree import agentauth, api, ledger, opreceipts, store, supervisor  # noqa: E402

TOOLS = {'orgtree_read_scratch':'material.scratch',
         'orgtree_read_transcript':'material.transcript'}
SCRATCH, TRANSCRIPT = TOOLS
NATIVE = {'effective_output_fence','immutable_identity','exclude_returning_current_holder',
          'closed_item_policy','indexed_item_predicates','full_wire_parity','complete_contacts'}


def boundary(document=None):
    """Reject missing tools, shapes, obligations, source drift and false gates."""
    d = document if document is not None else contracts.load(
        ROOT / 'docs/state-system/material-read-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != {'schema','source_contract_sha256','qualification','tools','shapes','limits',
                  'last_cases','invalid_last','native_obligations','observed_sidecars','scope'}:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.material-read-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale registry binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if d['tools'] != TOOLS or {k for k in registry['contracts'] if k.startswith('material.')} != set(TOOLS.values()):
        raise ValueError('material tool/contract coverage')
    expected_shapes = {'scratch_directory','scratch_file','scratch_missing','transcript','message','item_access'}
    if set(d['shapes']) != expected_shapes:
        raise ValueError('response shape coverage')
    for values in d['shapes'].values():
        if not isinstance(values,list) or not values or len(set(values)) != len(values) or not all(isinstance(v,str) and v for v in values):
            raise ValueError('response fields')
    if d['limits'] != dict(directory_entries=200,file_characters=20000,message_characters=1200,last_default=30,last_min=1,last_max=80):
        raise ValueError('wire limits')
    names = {r['name'] for r in d['last_cases']}
    if len(names) != len(d['last_cases']) or names != {'absent','null','empty','zero','negative','large','fraction','numeric_text','boolean'}:
        raise ValueError('last case coverage')
    if not isinstance(d['invalid_last'],list) or not d['invalid_last']:
        raise ValueError('malformed last coverage')
    if set(d['native_obligations']) != NATIVE or len(d['native_obligations']) != len(NATIVE):
        raise ValueError('native gaps cannot disappear')
    if d['observed_sidecars'] != ['transcript-records.sqlite3','chat-window-index.sqlite3','reply-events.sqlite3']:
        raise ValueError('sidecar surface coverage')
    return d


class MaterialBinding(unittest.TestCase):
    def test_current_registry_and_boundary_have_closed_gates(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry,contracts.inventory.scan(ROOT),ROOT)
        self.assertTrue(result['valid'],result['errors'])
        self.assertFalse(result['contract_coverage_complete'])
        self.assertEqual(result['qualification'],contracts.GATES)
        self.assertEqual(result['summary']['entries']['mapped'],7)
        self.assertEqual(result['summary']['dispatch']['mapped'],31)
        self.assertEqual(result['summary']['storage']['mapped'],0)
        self.assertEqual(registry['contracts']['material.transcript']['domain_mode'],'conditional_write')
        self.assertEqual(registry['contracts']['material.scratch']['domain_mode'],'read')

    def test_omissions_and_false_closure_refuse(self):
        for mutation in [lambda d:d['tools'].pop(SCRATCH),
                         lambda d:d['shapes'].pop('item_access'),
                         lambda d:d['last_cases'].pop(),
                         lambda d:d['native_obligations'].remove('effective_output_fence'),
                         lambda d:d['observed_sidecars'].pop(),
                         lambda d:d.update(source_contract_sha256='0'*64),
                         lambda d:d['qualification'].update(conversion_authorized=True),
                         lambda d:d['qualification'].update(runtime_census=True),
                         lambda d:d['limits'].update(file_characters=20001)]:
            with self.subTest(mutation=mutation):
                d = copy.deepcopy(boundary())
                mutation(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class MaterialFixture:
    seq = 0

    def setUp(self):
        MaterialFixture.seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-material-{MaterialFixture.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER,None,'haiku',20,'boss')
        for name in ('first','reader','peer','outsider'):
            org.hire(ledger.USER,'boss','haiku',2,name)
        org.hire(ledger.USER,'first','haiku',0,'deep')
        self.item = org.work_create(ledger.USER,'Material contract','Preserve handover material',owner='first')['slug']
        org.work_assign(ledger.USER,self.item,'reader')
        org.work_participants(ledger.USER,self.item,add=['peer'])
        org.d['mail'] = {}
        store.save_org(org)
        self.tokens = {n:agentauth.child_env(self.slug,n)['ORGTREE_AGENT_TOKEN']
                       for n in ('boss','first','reader','peer','outsider','deep')}
        self.client = TestClient(app,raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        # Prevent a scratch creation path from invoking any container command.
        self.chown = self.enterContext(patch.object(supervisor.sbx,'chown_agent'))
        self.enterContext(patch.object(supervisor.sbx,'on_disk',return_value=False))
        self.base = Path(supervisor.scratch_dir(self.slug,'first'))
        (self.base/'notes.txt').write_text('private handover material',encoding='utf-8')
        self.chown.reset_mock()

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT),self.slug)
        with supervisor._state_lock:
            for key in list(supervisor._state):
                if key[0] == self.slug:
                    supervisor._state.pop(key)

    def mutate(self, change):
        with store.write_org(self.slug) as org:
            change(org)
            store.save_org(org)

    def call(self, tool=SCRATCH, args=None, *, actor='reader', target='first', token=None, key=None, epoch=None, envelope=None):
        values = {'node':target,'path':'notes.txt'}
        if args is not None:
            values.update(args)
        body = dict(org=self.slug,node=actor,tool=tool,args=values)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL,args=dict(tool=tool,args=values,op_key=key,op_epoch=epoch))
        if envelope:
            body.update(envelope)
        return self.client.post('/api/agent',json=body,
            headers={'X-Orgtree-Agent-Token':self.tokens[actor] if token is None else token})

    def okay(self,response):
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def refused(self,response,text,code=422):
        self.assertEqual(response.status_code,code,response.text)
        self.assertEqual(set(response.json()),{'detail'})
        self.assertIn(text,response.json()['detail'])

    def chat(self, rows=None):
        return dict(messages=rows if rows is not None else [{'role':'assistant','text':'private transcript'}],
                    busy=False,occupancy=None)

    def shape(self, value, name):
        self.assertEqual(set(value),set(self.spec['shapes'][name]))


class MaterialReads(MaterialFixture,unittest.TestCase):
    def test_all_three_access_routes_and_listed_roles_both_tools(self):
        with patch.object(supervisor,'read_chat',return_value=self.chat()):
            for tool in TOOLS:
                for actor,target,via in [('first','first','self'),('boss','deep','chart'),('reader','first','item'),('peer','first','item')]:
                    with self.subTest(tool=tool,actor=actor,target=target):
                        got = self.okay(self.call(tool,actor=actor,target=target,args={'path':''}))
                        self.assertEqual(got['access']['via'],via)
                        if via == 'item':
                            self.shape(got['access'],'item_access')
                            self.assertEqual(got['access']['item'],self.item)
                            self.assertEqual(got['access']['standing'],'holder' if actor == 'reader' else 'participant')
            self.mutate(lambda o:o.work_update(ledger.USER,self.item,status='review',reviewer='outsider',
                owner='reader',done_so_far=['fixture review'],working_on_next=[]))
            for tool in TOOLS:
                self.assertEqual(self.okay(self.call(tool,actor='outsider'))['access']['standing'],'reviewer')

    def test_unrelated_peer_upward_and_missing_targets_refuse_before_content(self):
        with patch.object(supervisor,'read_chat') as chat, patch.object(supervisor,'scratch_dir') as scratch:
            for tool in TOOLS:
                for actor,target in [('outsider','first'),('reader','boss'),('reader','outsider'),('reader','missing')]:
                    response = self.call(tool,actor=actor,target=target)
                    self.assertEqual(response.status_code,422,response.text)
            chat.assert_not_called()
            scratch.assert_not_called()

    def assert_revoked_read_refuses(self,tool):
        self.okay(self.call(tool,actor='peer'))
        self.mutate(lambda o:o.work_participants(ledger.USER,self.item,remove=['peer']))
        self.refused(self.call(tool,actor='peer'),'DOWNWARD')

    def test_current_membership_is_checked_on_every_read(self):
        with patch.object(supervisor,'read_chat',return_value=self.chat()):
            for tool in TOOLS:
                self.mutate(lambda o:o.work_participants(ledger.USER,self.item,add=['peer']))
                self.assert_revoked_read_refuses(tool)

    def test_unsafe_cached_authority_fails_the_same_revocation_assertion(self):
        original = api._agent_read_access
        for tool in TOOLS:
            self.mutate(lambda o:o.work_participants(ledger.USER,self.item,add=['peer']))
            cached, hits = {}, []
            def unsafe(org,reader,target):
                key = (reader,target)
                if key in cached:
                    hits.append(key)
                    return cached[key]
                cached[key] = original(org,reader,target)
                return cached[key]
            with patch.object(supervisor,'read_chat',return_value=self.chat()), patch.object(api,'_agent_read_access',side_effect=unsafe):
                with self.assertRaises(AssertionError):
                    self.assert_revoked_read_refuses(tool)
            self.assertEqual(hits,[('peer','first')],'unsafe cached branch must actually execute')

    def test_archived_target_is_readable_but_archived_item_is_not(self):
        self.mutate(lambda o:o.retire(ledger.USER,'first'))
        with patch.object(supervisor,'read_chat',return_value=self.chat()):
            for tool in TOOLS:
                self.assertEqual(self.okay(self.call(tool))['access']['via'],'item')
            self.mutate(lambda o:o.work_update('reader',self.item,status='done',done_so_far=['done'],working_on_next=[]))
            # Legacy placement, not a native policy endorsement: the grace-window
            # done item is still in work_items, so it still grants until archive.
            for tool in TOOLS:
                self.assertEqual(self.okay(self.call(tool))['access']['via'],'item')
            self.mutate(lambda o:o.work_archive_now('reader',self.item))
            for tool in TOOLS:
                self.refused(self.call(tool),'DOWNWARD')

    def test_legacy_returning_current_holder_gap_is_explicit(self):
        self.mutate(lambda o:o.work_assign(ledger.USER,self.item,'first'))
        with patch.object(supervisor,'read_chat',return_value=self.chat()):
            # first -> reader -> first: the earlier first still matches. Native
            # exclusion of the CURRENT holder must not copy this legacy hole.
            for tool in TOOLS:
                self.assertEqual(self.okay(self.call(tool,actor='peer'))['access']['via'],'item')
        self.assertIn('exclude_returning_current_holder',self.spec['native_obligations'])

    def test_item_is_authority_witness_not_content_filter(self):
        (self.base/'other-project.txt').write_text('target-wide namespace',encoding='utf-8')
        got = self.okay(self.call(args={'path':'other-project.txt'}))
        self.assertEqual(got['access']['item'],self.item)
        self.assertEqual(got['content'],'target-wide namespace')

    def test_legacy_roster_born_mismatch_is_not_checked(self):
        def mismatch(org):
            item,_ = org._work_find(self.item)
            item['holders'][0]['born'] = 'a-different-seat-mint'
        self.mutate(mismatch)
        with patch.object(supervisor,'read_chat',return_value=self.chat()):
            for tool in TOOLS:
                self.assertEqual(self.okay(self.call(tool))['access']['via'],'item')
        # Deliberate stored-reference mismatch, not a claimed full delete/rehire.
        self.assertIn('immutable_identity',self.spec['native_obligations'])

    def test_authentication_generation_and_halt_precede_content(self):
        with patch.object(supervisor,'read_chat') as chat, patch.object(supervisor,'scratch_dir') as scratch:
            for tool in TOOLS:
                self.refused(self.call(tool,actor='peer',token=self.tokens['reader']),'identity mismatch',403)
                self.mutate(lambda o:o.node('reader').update(halt={'state':'halted'}))
                self.refused(self.call(tool),'halted',409)
                self.mutate(lambda o:o.node('reader').pop('halt',None))
                self.mutate(lambda o:o.d.update(killswitch={'at':'fixture'}))
                self.refused(self.call(tool),'killswitch',409)
                self.mutate(lambda o:o.d.pop('killswitch',None))
            self.mutate(lambda o:o.node('reader').update(generation=1))
            for tool in TOOLS:
                self.refused(self.call(tool),'stale',403)
            chat.assert_not_called()
            scratch.assert_not_called()

    def test_archived_caller_refuses_even_if_item_still_lists_it(self):
        self.mutate(lambda o:o.retire(ledger.USER,'reader'))
        for tool in TOOLS:
            self.refused(self.call(tool),'archived',403)

    def test_scratch_shapes_missing_path_and_character_entry_limits(self):
        text = 'Ω🙂' * 10002
        (self.base/'wide.txt').write_text(text,encoding='utf-8')
        got = self.okay(self.call(args={'path':'wide.txt'}))
        self.shape(got,'scratch_file')
        self.assertEqual(got['content'],text[:20000])
        directory = self.base/'many'
        directory.mkdir()
        for i in range(204):
            (directory/f'{203-i:03d}').touch()
        got = self.okay(self.call(args={'path':'many'}))
        self.shape(got,'scratch_directory')
        self.assertEqual(got['entries'],[f'{i:03d}' for i in range(200)])
        got = self.okay(self.call(args={'path':'missing.txt'}))
        self.shape(got,'scratch_missing')
        self.assertIn('no such path',got['error'])

    def test_scratch_utf8_replacement_and_text_normalization(self):
        (self.base/'broken').write_bytes(b'a\xffz')
        self.assertEqual(self.okay(self.call(args={'path':' /broken '}))['content'],'a\ufffdz')
        (self.base/'123').write_text('numeric path',encoding='utf-8')
        self.assertEqual(self.okay(self.call(args={'path':123}))['content'],'numeric path')
        for value in (None,'',' / '):
            got = self.okay(self.call(args={'path':value}))
            self.shape(got,'scratch_directory')
            self.assertEqual(got['dir'],'.')
        for value in ([],{}):
            self.refused(self.call(args={'path':value}),'path must be text')
            self.refused(self.call(args={'node':value}),'node must be text')

    def test_path_escape_and_nul_refuse(self):
        for path in ('../outside','../first-sibling/private','..\\outside'):
            self.refused(self.call(args={'path':path}),'path escapes')
        response = self.call(args={'path':'bad\x00name'})
        self.assertEqual(response.status_code,422,response.text)

    def test_resolved_link_escape_is_checked_before_file_open(self):
        # Resolve-to-outside seam avoids requiring OS symlink privileges; real
        # symlink/junction replacement races remain a separate native gate.
        original = os.path.realpath
        def resolved(path,*args,**kwargs):
            if Path(path).name == 'link':
                return str(self.base.parent/'first-sibling'/'secret')
            return original(path,*args,**kwargs)
        with patch.object(api.os.path,'realpath',side_effect=resolved):
            self.refused(self.call(args={'path':'link'}),'path escapes')

    def test_first_scratch_read_can_create_directory_and_attempt_ownership(self):
        target = Path(store.scratch_root(self.slug))/'outsider'
        self.assertFalse(target.exists())
        seq = store.org_seq(self.slug)
        got = self.okay(self.call(actor='outsider',target='outsider',args={'path':''}))
        self.shape(got,'scratch_directory')
        self.assertTrue(target.is_dir())
        self.chown.assert_called_once()
        self.assertEqual(store.org_seq(self.slug),seq)

    def test_lineage_scratch_resolves_to_shared_successor_directory(self):
        org = store.load_org(self.slug)
        pred = org.compact_split('first','fixture-new-session')
        store.save_org(org)
        got = self.okay(self.call(actor='boss',target=pred))
        self.assertEqual(got['content'],'private handover material')
        self.assertEqual(Path(supervisor.scratch_dir(self.slug,pred)),self.base)

    def test_filesystem_failure_is_not_disguised_as_missing_success(self):
        with patch.object(api.os,'listdir',side_effect=OSError('fixture unreadable directory')):
            response = self.call(args={'path':''})
        self.assertEqual(response.status_code,500,response.text)
        self.assertNotIn('no such path',response.text)

    def test_transcript_last_cases_and_local_field_projection(self):
        rows = [{'role':'assistant','text':'Ω'*1202,'tools':[{'name':'fixture'}],
                 'event_id':'hidden','thinking':'hidden'} for _ in range(95)]
        with patch.object(supervisor,'read_chat',return_value=self.chat(rows)) as read:
            for case in self.spec['last_cases']:
                with self.subTest(case=case['name']):
                    got = self.okay(self.call(TRANSCRIPT,args=case['args']))
                    self.shape(got,'transcript')
                    self.assertEqual(len(got['messages']),case['want'])
                    self.assertEqual(read.call_args.kwargs,{'last':case['want'],'hold_back':False})
                    for row in got['messages']:
                        self.shape(row,'message')
                        self.assertEqual(row['text'],'Ω'*1200)
                    self.assertIs(got['occupancy_estimated'],False)

    def test_transcript_absent_and_null_values_keep_legacy_shapes(self):
        chat = self.chat([{'role':'user'}, {'role':'assistant','text':None,'tools':None}])
        chat.update(busy=True,occupancy={'used':10},occupancy_estimated='estimated')
        with patch.object(supervisor,'read_chat',return_value=chat):
            got = self.okay(self.call(TRANSCRIPT,args={'last':2}))
        self.assertEqual(got['messages'],[{'role':'user','text':'','tools':[]},
                                          {'role':'assistant','text':'','tools':None}])
        self.assertIs(got['occupancy_estimated'],True)
        self.assertIs(got['busy'],True)
        self.assertEqual(got['occupancy'],{'used':10})

    def test_invalid_last_refuses_before_projection(self):
        with patch.object(supervisor,'read_chat') as read:
            for value in self.spec['invalid_last']:
                self.refused(self.call(TRANSCRIPT,args={'last':value}),'last must be a number')
            read.assert_not_called()

    def assert_outer_limit(self):
        result = self.okay(self.call(TRANSCRIPT,args={'last':2}))
        self.assertEqual([r['text'] for r in result['messages']],['row3','row4'])

    def test_outer_slice_has_positive_and_unsafe_controls(self):
        rows = [{'role':'assistant','text':f'row{i}'} for i in range(5)]
        with patch.object(supervisor,'read_chat',return_value=self.chat(rows)):
            self.assert_outer_limit()
        class IgnoreSlice(list):
            def __getitem__(self,key):
                if isinstance(key,slice):
                    hits.append(key)
                    return list(self)
                return super().__getitem__(key)
        hits = []
        with patch.object(supervisor,'read_chat',return_value=self.chat(IgnoreSlice(rows))):
            with self.assertRaises(AssertionError):
                self.assert_outer_limit()
        self.assertEqual(len(hits),1)

    def test_wrapped_reads_reexecute_and_revalidate_without_receipt(self):
        key = opreceipts.mint_key()
        epoch = self.okay(self.call(opreceipts.OP_EPOCH))['epoch']
        seq = store.org_seq(self.slug)
        with patch.object(supervisor,'read_chat',side_effect=[self.chat([{'role':'user','text':'one'}]),
                                                            self.chat([{'role':'user','text':'two'}])]) as read:
            first = self.okay(self.call(TRANSCRIPT,key=key,epoch=epoch))
            second = self.okay(self.call(TRANSCRIPT,args={'last':2},key=key,epoch=epoch))
            self.assertEqual(first['messages'][0]['text'],'one')
            self.assertEqual(second['messages'][0]['text'],'two')
            self.assertEqual(read.call_count,2)
        self.assertEqual(store.org_seq(self.slug),seq)
        self.assertFalse(store.load_org(self.slug).d.get(opreceipts.SECTION))
        for tool in TOOLS:
            self.assertEqual(opreceipts.coverage(tool,{}),opreceipts.NONE)
        lookup = self.okay(self.call(opreceipts.OP_LOOKUP,args={'op_key':key,'op_epoch':epoch,
            'for_tool':TRANSCRIPT,'for_args':{'node':'first','path':'notes.txt'}}))
        self.assertEqual((lookup['state'],lookup['reason']),('unknown','unsupported_operation'))
        self.assertFalse(store.load_org(self.slug).d.get(opreceipts.SECTION))
        self.okay(self.call(SCRATCH,actor='peer',key=key,epoch=epoch))
        self.mutate(lambda o:o.work_participants(ledger.USER,self.item,remove=['peer']))
        self.refused(self.call(SCRATCH,actor='peer',key=key,epoch=epoch),'DOWNWARD')

    def test_wrapper_refusals_happen_before_content(self):
        with patch.object(supervisor,'read_chat') as read:
            self.refused(self.call(TRANSCRIPT,envelope={'op_key':'x'}),'request envelope')
            self.refused(self.call(TRANSCRIPT,key='x',epoch=''),'op_epoch')
            self.refused(self.call(TRANSCRIPT,envelope={'tool':opreceipts.OP_CALL,
                'args':{'tool':TRANSCRIPT,'args':{},'op_key':'','op_epoch':'x'}}),'needs')
            read.assert_not_called()

    def test_legacy_revocation_during_projection_can_disclose_then_next_call_refuses(self):
        def after_check(org,nid,**kwargs):
            self.mutate(lambda o:o.work_participants(ledger.USER,self.item,remove=['peer']))
            return self.chat()
        with patch.object(supervisor,'read_chat',side_effect=after_check) as read:
            got = self.okay(self.call(TRANSCRIPT,actor='peer'))
            self.assertEqual(got['messages'][0]['text'],'private transcript')
            self.refused(self.call(TRANSCRIPT,actor='peer'),'DOWNWARD')
            self.assertEqual(read.call_count,1)
        self.assertIn('effective_output_fence',self.spec['native_obligations'])

    def test_real_transcript_cold_mints_and_separate_sidecar_commits(self):
        path = Path(_temp.name)/(self.slug+'.jsonl')
        rows = [{'type':'assistant','uuid':f'native-{i}','timestamp':f'2026-09-10T12:00:0{i}Z',
                 'message':{'id':f'm-{i}','role':'assistant','content':f'source message {i}'}}
                for i in range(3)]
        path.write_text(''.join(json.dumps(r)+'\n' for r in rows),encoding='utf-8')
        connect = sqlite3.connect
        contacts = []
        def observe(database,*args,**kwargs):
            conn = connect(database,*args,**kwargs)
            name = Path(database).name
            # Only statement verbs are retained. No SQL arguments or contents
            # are logged. This is a fixture witness, not production telemetry.
            conn.set_trace_callback(lambda sql:contacts.append((name,sql.strip().split()[0].upper())) if sql.strip() else None)
            return conn
        seq = store.org_seq(self.slug)
        save, minters = store.save_org, []
        def observe_save(org,*args,**kwargs):
            caller = sys._getframe(1)
            minters.append((caller.f_globals.get('__name__'),caller.f_code.co_name))
            return save(org,*args,**kwargs)
        # A wraps Mock would put its own frame between the caller and recorder.
        with patch.object(supervisor,'transcript_path_for_node',return_value=str(path)), \
                patch.object(sqlite3,'connect',side_effect=observe), \
                patch.object(store,'save_org',new=observe_save):
            result = self.okay(self.call(TRANSCRIPT,args={'last':2}))
        self.assertEqual([r['text'] for r in result['messages']],['source message 1','source message 2'])
        for name in self.spec['observed_sidecars']:
            verbs = {v for p,v in contacts if p == name}
            if name != 'reply-events.sqlite3':
                self.assertIn('SELECT',verbs,(name,verbs))
            self.assertIn('INSERT',verbs,(name,verbs))
            self.assertIn('COMMIT',verbs,(name,verbs))
        self.assertGreater(store.org_seq(self.slug),seq)
        self.assertIn(('orgtree.reply_events','incarnation'),minters)
        self.assertIn(('orgtree.transcript_records','incarnation'),minters)
        self.assertFalse(store.load_org(self.slug).d.get(opreceipts.SECTION))
        seq = store.org_seq(self.slug)
        minters.clear()
        with patch.object(supervisor,'transcript_path_for_node',return_value=str(path)), \
                patch.object(store,'save_org',new=observe_save):
            warm = self.okay(self.call(TRANSCRIPT,args={'last':2}))
        self.assertEqual(warm['messages'],result['messages'])
        self.assertEqual(store.org_seq(self.slug),seq)
        self.assertEqual(minters,[],'pre-minted warm fixture must not claim cold org writes')


class QueuedMaterialRead(MaterialFixture,unittest.IsolatedAsyncioTestCase):
    async def test_transcript_waiter_checks_membership_after_admission(self):
        release = threading.Event()
        guard = threading.Lock()
        entered = []
        def blocked(org,nid,**kwargs):
            with guard:
                entered.append(nid)
            if not release.wait(10):
                raise RuntimeError('fixture failed to release reader')
            return self.chat()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport,base_url='http://fixture') as client:
            def request(actor,target):
                return client.post('/api/agent',json=dict(org=self.slug,node=actor,tool=TRANSCRIPT,args={'node':target}),
                                   headers={'X-Orgtree-Agent-Token':self.tokens[actor]})
            with patch.object(supervisor,'read_chat',side_effect=blocked):
                tasks = [asyncio.create_task(request('boss','boss')) for _ in range(4)]
                queued = None
                try:
                    deadline = asyncio.get_running_loop().time()+4
                    while len(entered) < 4 and asyncio.get_running_loop().time() < deadline:
                        await asyncio.sleep(.01)
                    self.assertEqual(entered,['boss']*4,'positive control: all admission slots occupied')
                    queued = asyncio.create_task(request('peer','first'))
                    await asyncio.sleep(.04)
                    self.assertFalse(queued.done())
                    self.mutate(lambda o:o.work_participants(ledger.USER,self.item,remove=['peer']))
                finally:
                    release.set()
                    results = await asyncio.gather(*tasks,*([queued] if queued else []))
                self.assertEqual([r.status_code for r in results],[200]*4+[422])
                self.assertIn('DOWNWARD',results[-1].json()['detail'])
                self.assertEqual(entered,['boss']*4,'refused waiter must never project the protected target')


# -- legacy transcript projector at the public door (p01-transcript-projector-legacy-fixtures)
# Each case writes one provider transcript for `first` and reads it through the
# real orgtree_read_transcript door, which returns only role, text (<=1200) and
# tools. Legacy defects are pinned as recorded behaviour, never as approved.
_TS = '2026-09-10T12:00:{:02d}Z'
def _a(i, content, **extra):
    row = {'type':'assistant','uuid':f'a{i}','timestamp':_TS.format(i),
           'message':{'id':f'm{i}','role':'assistant','content':content}}
    row.update(extra)
    return row
def _u(i, content, **extra):
    row = {'type':'user','uuid':f'u{i}','timestamp':_TS.format(i),'message':{'role':'user','content':content}}
    row.update(extra)
    return row
def _s(i, subtype, **extra):
    row = {'type':'system','subtype':subtype,'uuid':f's{i}','timestamp':_TS.format(i)}
    row.update(extra)
    return row
def _use(name, arg, tid='t1'):
    return {'type':'tool_use','id':tid,'name':name,'input':arg}
def _res(body, tid='t1', **extra):
    return {'type':'tool_result','tool_use_id':tid,'content':body,**extra}
def _think(sig):
    return [{'type':'thinking','thinking':'','signature':sig}]
_NOID_TEXT = {'type':'assistant','timestamp':_TS.format(1),'message':{'role':'assistant','content':'same'}}
_NOID_TOOL = {'type':'assistant','timestamp':_TS.format(1),
              'message':{'role':'assistant','content':[{'type':'tool_use','id':'t1','name':'Bash','input':{'command':'ls'}}]}}
# P08b: the Codex app-server's echo of a manual-inbox call carries a top-level origin marker
_ECHO = {'type':'user','timestamp':_TS.format(2),'orgtree_origin':{'kind':'provider_echo','runtime':'codex_app_server'},
         'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'c1',
                                              'content':json.dumps({'id':'abc','delivered':'boss'}),'is_error':False}]}}
# supervisor._late_tool_result: journaled to the turn with an id no tool_use carries
_LATE = {'type':'user','timestamp':_TS.format(2),'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'codex-late-7',
         'content':'[late tool result — the turn ended before the tool returned]\nout','is_error':True}]}}
_ENVELOPE = ('[ORG STATE — current as of 2026-09-10T12:00:00Z]\nprivate org state line\n'
             '[END ORG STATE]\n\nhuman words')

# name -> (transcript lines, expected). expected is ('500', exception type) or a
# list of (role, text, [tool chip subset]); a chip subset lists only the keys it pins.
PROJECTOR_CASES = {
    'plain_assistant':([_a(1,'hello')],[('assistant','hello',[])]),
    'text_blocks_join_and_drop_blank':([_a(1,[{'type':'text','text':'one'},{'type':'text','text':'  '},{'type':'text','text':'two'}])],
                                       [('assistant','one\n\ntwo',[])]),
    'text_cut_to_1200':([_a(1,'x'*1500)],[('assistant','x'*1200,[])]),
    'unparseable_and_non_record_lines_skipped':(['{not json','null','42','[1,2]','"s"',_a(1,'kept')],[('assistant','kept',[])]),
    'sidechain_and_meta_skipped':([_a(1,'side',isSidechain=True),_a(2,'meta',isMeta=True),_a(3,'kept')],[('assistant','kept',[])]),
    'codex_plan_is_an_empty_assistant_row':([{'type':'codex_plan_updated','uuid':'p1','timestamp':_TS.format(1),
                                              'plan':[{'step':'a','status':'done'}],'threadId':'t','turnId':'u'}],
                                            [('assistant','',[])]),
    'compact_boundary_and_summary':([_s(1,'compact_boundary',compactMetadata={'preTokens':12345}),
                                     _u(2,'summary text',isCompactSummary=True),_a(3,'after')],
                                    [('system','— context compacted — · 12.3k tokens',[]),('assistant','after',[])]),
    'compact_boundary_malformed_metadata':([_s(1,'compact_boundary',compactMetadata='bad')],
                                           [('system','— context compacted —',[])]),
    'api_error_cut_to_300':([_s(1,'api_error',error='E'*400)],[('system','⚠ API error — '+'E'*300,[])]),
    'local_command_output_is_an_empty_system_row':([_s(1,'local_command',content='<local-command-stdout>ctx</local-command-stdout>'),
                                                    _s(2,'local_command',content='')],[('system','',[])]),
    'other_system_subtypes_and_types_skipped':([_s(1,'informational'),{'type':'summary','summary':'s'},{'type':'progress'},_a(2,'kept')],
                                              [('assistant','kept',[])]),
    'non_mapping_message_skipped':([{'type':'assistant','uuid':'x','message':'str'},_a(2,'kept')],[('assistant','kept',[])]),
    'visible_in_transcript_only_skipped':([_u(1,'vis',isVisibleInTranscriptOnly=True),_a(2,'kept')],[('assistant','kept',[])]),
    'slash_command_echo':([_u(1,'<command-name>/context</command-name><command-args> full </command-args>')],[('user','/context full',[])]),
    'old_cli_command_stdout':([_u(1,'<local-command-stdout>old out</local-command-stdout>')],[('system','',[])]),
    'no_response_requested_skipped':([_u(1,'No response requested.'),_a(2,'kept')],[('assistant','kept',[])]),
    'synthetic_model_speaks_as_system':([_a(1,'synthetic words',message={'id':'m1','role':'assistant','model':'<synthetic>','content':'synthetic words'})],
                                        [('system','⚠ synthetic words',[])]),
    'api_error_message_speaks_as_system':([_a(1,[{'type':'text','text':'rate limited'}],isApiErrorMessage=True)],[('system','⚠ rate limited',[])]),
    'user_text_and_text_block':([_u(1,'hi there'),_u(2,[{'type':'text','text':'block prompt'}])],[('user','hi there',[]),('user','block prompt',[])]),
    'thinking_with_text_is_an_empty_row':([_a(1,[{'type':'thinking','thinking':'deep thought'}])],[('assistant','',[])]),
    'sealed_thinking_is_an_empty_row':([_a(1,_think('sig'))],[('assistant','',[])]),
    'two_thinking_records_of_one_message_merge':([_a(1,_think('a'),message={'id':'mm','role':'assistant','content':_think('a')}),
                                                  _a(2,_think('b'),message={'id':'mm','role':'assistant','content':_think('b')})],
                                                 [('assistant','',[])]),
    'tool_use_and_result':([_a(1,[_use('Bash',{'command':'ls -la'})]),_u(2,[_res('line1\nline2')])],
                           [('assistant','',[{'name':'Bash','arg':'ls -la','id':'t1','result':'line1\nline2','result_lines':2,'truncated':False}])]),
    'tool_error':([_a(1,[_use('Bash',{'command':'false'})]),_u(2,[_res('boom happened',is_error=True)])],
                  [('assistant','',[{'name':'Bash','error':'boom happened','result':'boom happened'}])]),
    'tool_result_cut_to_60_lines':([_a(1,[_use('Read',{'file_path':'/a/b.py'})]),_u(2,[_res('\n'.join(f'l{i}' for i in range(80)))])],
                                   [('assistant','',[{'name':'Read','arg':'/a/b.py','result_lines':80,'truncated':True,
                                                      'result':'\n'.join(f'l{i}' for i in range(60))}])]),
    'tool_result_images_counted':([_a(1,[_use('Read',{'file_path':'/a.png'})]),_u(2,[_res([{'type':'image','source':{}},{'type':'text','text':'img'}])])],
                                  [('assistant','',[{'name':'Read','images':1,'result':'img'}])]),
    'todowrite_glyphs':([_a(1,[_use('TodoWrite',{'todos':[{'content':'a','status':'completed'},{'content':'b','status':'pending'}]})])],
                        [('assistant','',[{'name':'TodoWrite','result':'☑ a\n☐ b','result_lines':2}])]),
    'structured_patch_diff':([_a(1,[_use('Edit',{'file_path':'/a.py'})]),
                              _u(2,[_res('ok')],toolUseResult={'structuredPatch':[{'oldStart':3,'lines':['-a','+b','+c']}]})],
                             [('assistant','',[{'name':'Edit','diff':{'plus':2,'minus':1,'lines':['@@ 3','-a','+b','+c']}}])]),
    'subagent_task_totals':([_a(1,[_use('Task',{'description':'sub'})]),
                             _u(2,[_res('done')],toolUseResult={'totalDurationMs':1500,'totalToolUseCount':3,'totalTokens':900})],
                            [('assistant','',[{'name':'Task','task':{'tools':3,'ms':1500,'tokens':900}}])]),
    'send_file_card_from_bare_name':([_a(1,[_use('orgtree_send_file',{'path':'f.txt'})]),
                                      _u(2,[_res(json.dumps({'sent':{'path':'outbox/f.txt','name':'f.txt'}}))])],
                                     [('assistant','',[{'name':'orgtree_send_file','file':{'path':'outbox/f.txt','name':'f.txt'}}])]),
    'mail_link_from_prefixed_name':([_a(1,[_use('mcp__orgtree__orgtree_message',{'to':'boss'})]),
                                     _u(2,[_res(json.dumps({'id':'abc','delivered':'boss'}))])],
                                    [('assistant','',[{'name':'mcp__orgtree__orgtree_message','mail':{'id':'abc','to':'boss'}}])]),
    'work_link_from_record_result':([_a(1,[_use('orgtree_work',{'action':'get'})]),_u(2,[_res(json.dumps({'item':{'slug':'the-item'}}))])],
                                    [('assistant','',[{'name':'orgtree_work','work':{'slug':'the-item'}}])]),
    'presentation_card':([_a(1,[_use('orgtree_present',{'title':'T'})]),
                          _u(2,[_res(json.dumps({'presented':'p1','title':'Doc','format':'html'}))])],
                         [('assistant','',[{'name':'orgtree_present','presentation':{'id':'p1','title':'Doc','format':'html'}}])]),
    'text_and_tool_in_one_message':([_a(1,[{'type':'text','text':'running'},_use('Bash',{'command':'echo'})])],
                                    [('assistant','running',[{'name':'Bash','arg':'echo','id':'t1'}])]),
    'missing_content_is_an_empty_row':([{'type':'assistant','uuid':'a1','timestamp':_TS.format(1),'message':{'id':'m1'}}],
                                       [('assistant','',[])]),
    'empty_transcript':([],[]),
    # user prompts with image blocks: the text block is the prompt; an image-only prompt shows nothing
    'user_image_and_text':([_u(1,[{'type':'image','source':{}},{'type':'text','text':'look'}])],[('user','look',[])]),
    'user_image_only_projects_nothing':([_u(1,[{'type':'image','source':{}}]),_a(2,'kept')],[('assistant','kept',[])]),
    # legacy records with no provider id (no uuid, no message.id): byte-identical twins stay two rows
    'no_provider_id_text_twins':([_NOID_TEXT,_NOID_TEXT],[('assistant','same',[]),('assistant','same',[])]),
    'no_provider_id_tool_twins':([_NOID_TOOL,_NOID_TOOL],[('assistant','',[{'name':'Bash','arg':'ls','id':'t1'}]),
                                                           ('assistant','',[{'name':'Bash','arg':'ls','id':'t1'}])]),
    # Codex/Antigravity journal shapes
    'codex_provider_echo_marker_is_ignored':([_a(1,[_use('orgtree_message',{'to':'boss'},tid='c1')]),_ECHO],
                                             [('assistant','',[{'name':'orgtree_message','mail':{'id':'abc','to':'boss'}}])]),
    'codex_think_is_an_empty_row':([{'type':'assistant','timestamp':_TS.format(1),'uuid':'th1',
                                     'message':{'id':'codex-think-1','role':'assistant','model':'gpt-5',
                                                'content':[{'type':'thinking','thinking':'codex body','signature':'codex'}]}}],
                                   [('assistant','',[])]),
    'codex_late_tool_result_without_its_call_projects_nothing':([_a(1,'before'),_LATE],[('assistant','before',[])]),
    'tool_result_cut_to_2000_characters':([_a(1,[_use('Read',{'file_path':'/big'})]),_u(2,[_res('\n'.join('y'*299 for _ in range(10)))])],
                                          [('assistant','',[{'name':'Read','result_lines':10,'truncated':True,
                                                             'result':'\n'.join('y'*299 for _ in range(10))[:2000]}])]),
    # recorded legacy defects: a malformed record fails the whole read
    'non_mapping_content_block_is_a_500':([_a(1,['bare string block'])],('500','AttributeError')),
    'non_iterable_content_is_a_500':([_a(1,42)],('500','TypeError')),
}


class TranscriptProjector(MaterialFixture,unittest.TestCase):
    def read(self, name, rows):
        path = Path(_temp.name)/f'{self.slug}-{name}.jsonl'
        path.write_text(''.join((r if isinstance(r,str) else json.dumps(r))+'\n' for r in rows),encoding='utf-8')
        with patch.object(supervisor,'transcript_path_for_node',return_value=str(path)):
            return self.call(TRANSCRIPT,args={'last':80})

    def check(self, name):
        rows, expected = PROJECTOR_CASES[name]
        response = self.read(name,rows)
        if isinstance(expected,tuple):
            self.assertEqual(response.status_code,500,response.text)
            self.assertEqual(response.json()['error']['type'],expected[1])
            return
        msgs = self.okay(response)['messages']
        self.assertEqual([(m['role'],m['text']) for m in msgs],[(r,t) for r,t,_ in expected])
        for m,(_,_,chips) in zip(msgs,expected):
            self.assertEqual(set(m),{'role','text','tools'})     # nothing else reaches an agent
            self.assertEqual(len(m['tools']),len(chips))
            for got,want in zip(m['tools'],chips):
                self.assertEqual({k:got.get(k) for k in want},want)
                # the reply-target identity every chip carries on the way out,
                # plus a second one for its result once the result has arrived
                self.assertTrue(got['event_id'].startswith('reply_'))
                self.assertIn('reply_quote',got)
                if 'result' in got:
                    self.assertTrue(got['result_event_id'].startswith('reply_'))
                    self.assertIn('result_reply_quote',got)
        # rows with no provider id never alias one reply target
        ids = [c['event_id'] for m in msgs for c in m['tools']]
        self.assertEqual(len(ids),len(set(ids)))

    def test_envelope_prompt_without_view_is_shown_raw_to_the_reader(self):
        # recorded legacy disclosure: D-229 fails open, so a reader sees the
        # author's raw [ORG STATE] envelope when no prompt-view row exists
        msgs = self.okay(self.read('envelope_raw',[_u(1,_ENVELOPE)]))['messages']
        self.assertEqual(msgs,[{'role':'user','text':_ENVELOPE,'tools':[]}])

    def write_view(self, session, visible, segments=None):
        import hashlib
        self.mutate(lambda o:o.node('first').update(session_id=session))
        path = supervisor._prompt_view_path(self.slug,session)
        os.makedirs(os.path.dirname(path),exist_ok=True)
        row = {'sha256':hashlib.sha256(_ENVELOPE.encode()).hexdigest(),'visible':visible,
               'at':_TS.format(1),'chars':len(_ENVELOPE)}
        if segments is not None:
            row['segments'] = segments
        with open(path,'w',encoding='utf-8') as f:
            f.write(json.dumps(row)+'\n')

    def test_envelope_prompt_with_view_shows_only_the_human_words(self):
        self.write_view('fixture-session-a','human words')
        self.assertEqual(self.okay(self.read('envelope_view',[_u(1,_ENVELOPE)]))['messages'],
                         [{'role':'user','text':'human words','tools':[]}])

    def test_machine_only_view_hides_the_prompt(self):
        self.write_view('fixture-session-b','')
        self.assertEqual(self.okay(self.read('envelope_machine',[_u(1,_ENVELOPE),_a(2,'reply')]))['messages'],
                         [{'role':'assistant','text':'reply','tools':[]}])

    def test_machine_only_view_with_a_visible_wake_card_keeps_an_empty_row(self):
        # the wake-card exception: an automatic wake has no human text, but its
        # composition carries a reminder the desk draws, so the row survives empty
        self.write_view('fixture-session-c','',segments=[{'kind':'drive','event':{'variant':'reminder.working_checkup'}}])
        self.assertEqual(self.okay(self.read('envelope_wake',[_u(1,_ENVELOPE)]))['messages'],
                         [{'role':'user','text':'','tools':[]}])

    def test_steered_turn_error_and_fold_rows_interleave_by_time(self):
        def change(o):
            o.d.setdefault('steered_log',{})['first'] = [
                {'at':_TS.format(2),'text':'steered mail body','level':'recorded'},
                {'at':_TS.format(4),'fold':True,'text':'missed the window'}]
            o.d.setdefault('turn_error_log',{})['first'] = [{'at':_TS.format(3),'text':'CLI died'}]
        self.mutate(change)
        msgs = self.okay(self.read('merged',[_a(1,'one'),_a(5,'five')]))['messages']
        self.assertEqual([(m['role'],m['text']) for m in msgs],
                         [('assistant','one'),('user','steered mail body'),('system','⚠ CLI died'),
                          ('system','— missed the window —'),('assistant','five')])

    def test_preserving_bearer_oracle_exchanges_follow_the_transcript(self):
        self.mutate(lambda o:o.node('first').update(
            bearer_state='preserving',oracle_exchanges=[{'q':'oracle question','a':'oracle answer','at':_TS.format(9)}]))
        msgs = self.okay(self.read('oracle',[_a(1,'one')]))['messages']
        self.assertEqual([(m['role'],m['text']) for m in msgs],
                         [('assistant','one'),('user','oracle question'),('assistant','oracle answer')])


for _name in PROJECTOR_CASES:
    setattr(TranscriptProjector,f'test_projects_{_name}',lambda self,_n=_name:self.check(_n))


def tearDownModule():
    store._POOL.close_all('p01-material-cleanup')
    _temp.cleanup()


if __name__ == '__main__':
    unittest.main()
